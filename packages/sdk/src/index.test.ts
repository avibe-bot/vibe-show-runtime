import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  areaAnnotation,
  captureScreenshotRegion,
  classifyAreaSelection,
  collectElementsInArea,
  formatShowEventMessage,
  humanAnnotationEvent,
  screenshotPointFromViewport,
  screenshotRectFromViewport,
  screenshotAnnotation,
  agentMarkIdentity,
  reduceAgentMarkEvents,
  partitionAgentMarks,
  attributeNoteReadToken,
  hashMarkText,
  isMarkAnchored,
  resolveAgentMarkAnchor,
  normalizeAgentMarkEvent,
  agentMarkOf,
  eventOccurredAt,
  normalizeShowEvent,
  submitShowEvent,
  reconcileReadReceipt,
  type ShowAnchor,
  type ShowEvent
} from "./index.js"

// Minimal assistant.mark.* event factory for the lifecycle-helper tests (pure, no DOM).
function markEvent(opts: {
  target: string
  createdAt: string
  type?: "assistant.mark.created" | "assistant.mark.updated" | "assistant.mark.resolved"
  scope?: string
  body?: string
  markId?: string
  replyTo?: string
  status?: "active" | "resolved"
  // Event-level OCCURRENCE time, distinct from the mark's birth `createdAt`. On the real wire a resolve
  // keeps the version's birth `createdAt` (payload) and carries its own time at the event level; model
  // that here so version-discriminator + occurrence ordering are exercised faithfully. Defaults to birth.
  occurredAt?: string
}): ShowEvent {
  const type = opts.type ?? "assistant.mark.created"
  return {
    id: `evt_${opts.target}_${opts.createdAt}_${opts.occurredAt ?? ""}`,
    type,
    mark: {
      id: opts.markId ?? "m",
      role: "assistant",
      scope: opts.scope ?? "default",
      target: opts.target,
      body: opts.body ?? "",
      status: opts.status ?? (type === "assistant.mark.resolved" ? "resolved" : "active"),
      createdAt: opts.createdAt,
      updatedAt: opts.createdAt,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {})
    },
    message: { role: "assistant", content: opts.body ?? "" },
    createdAt: opts.createdAt,
    // snake_case event-level occurrence, matching the live wire; eventOccurredAt prefers it.
    ...(opts.occurredAt ? { created_at: opts.occurredAt } : {})
  } as unknown as ShowEvent
}

// REAL on-wire assistant.mark.* shape from the live Lane A2 backend: mark fields live in `payload`
// (NOT a top-level `mark`), plain notes have NO `replyTo` key, and `anchor` is often the empty {} with
// the selector carried in `target`. This is the production shape the earlier `mark`-shaped mocks hid.
function payloadMarkEvent(opts: {
  target: string
  createdAt: string
  type?: "assistant.mark.created" | "assistant.mark.updated" | "assistant.mark.resolved"
  scope?: string
  body?: string
  markId?: string
  replyTo?: string
  anchor?: unknown
  // Event-level snake_case occurrence, distinct from the payload birth `createdAt` (see markEvent).
  occurredAt?: string
}): ShowEvent {
  const type = opts.type ?? "assistant.mark.created"
  const occurredAt = opts.occurredAt ?? opts.createdAt
  return {
    id: `evt_${opts.target}_${opts.createdAt}_${opts.occurredAt ?? ""}`,
    type,
    payload: {
      id: opts.markId ?? "m",
      role: "assistant",
      scope: opts.scope ?? "default",
      target: opts.target,
      body: opts.body ?? "",
      status: type === "assistant.mark.resolved" ? "resolved" : "active",
      createdAt: opts.createdAt, // version BIRTH time (stable across create→resolve) — the discriminator
      updatedAt: opts.createdAt,
      resolvedAt: type === "assistant.mark.resolved" ? occurredAt : undefined,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) // plain notes omit replyTo entirely
    },
    anchor: opts.anchor ?? {}, // often empty on the wire — target carries the selector
    created_at: occurredAt // event-level occurrence, snake_case as on the wire
  } as unknown as ShowEvent
}

describe("real on-wire payload shape (Lane A2 integration, R5)", () => {
  const T = (n: number) => `2026-07-23T03:00:0${n}.000Z`

  it("reduces a mixed payload-shaped stream (reply + note + resolved, notes without replyTo) without throwing", () => {
    const events = [
      payloadMarkEvent({ target: "#card", body: "note A", markId: "m1", createdAt: T(1) }), // note — NO replyTo
      payloadMarkEvent({ target: "ann-target", body: "reply", markId: "m2", replyTo: "evt_ann", createdAt: T(2) }),
      payloadMarkEvent({ target: "#card", type: "assistant.mark.resolved", markId: "m1", createdAt: T(1), occurredAt: T(3) }) // resolve echoes m1's birth, occurs later
    ]
    const reduced = reduceAgentMarkEvents(events) // must NOT throw on notes lacking replyTo / payload shape
    expect(reduced).toHaveLength(2)
    const note = reduced.find((r) => r.identity === "note:default:#card")
    expect(note?.kind).toBe("note")
    expect(note?.resolvedByEvent).toBe(true) // resolve (m1) retires the note version
    const reply = reduced.find((r) => r.identity === "reply:evt_ann")
    expect(reply?.kind).toBe("reply")
    expect(reply?.mark.body).toBe("reply") // reduced.mark exposes the extracted payload
  })

  it("resolves a payload-shaped anchorless note through its target, tolerating an empty anchor", () => {
    const event = payloadMarkEvent({ target: "#revenue-card", body: "note", createdAt: T(1) }) // anchor {}
    expect(resolveAgentMarkAnchor(event as never, [])).toMatchObject({ kind: "element", selector: "#revenue-card" })
  })

  it("agentMarkOf reads the payload; normalizeAgentMarkEvent copies it onto .mark for downstream readers (#275/#282)", () => {
    const event = payloadMarkEvent({ target: "#c", body: "b", markId: "m1", createdAt: T(1) })
    expect((event as { mark?: unknown }).mark).toBeUndefined() // raw payload shape has no top-level mark
    expect(agentMarkOf(event)?.target).toBe("#c")
    const normalized = normalizeAgentMarkEvent(event)
    expect(normalized.mark.target).toBe("#c") // downstream can now read event.mark safely
    expect(normalized.mark.body).toBe("b")
  })

  it("synthesizes the required message so renderMark callbacks reading event.message.content never throw (#3633478191)", () => {
    const event = payloadMarkEvent({ target: "#c", body: "本区块已过时", markId: "m1", createdAt: T(1) })
    expect((event as { message?: unknown }).message).toBeUndefined() // on-wire payload event carries no message
    const normalized = normalizeAgentMarkEvent(event)
    // A custom renderer that reads event.message.content (per the AssistantMarkEvent contract) is now safe.
    expect(() => normalized.message.content.length).not.toThrow()
    expect(normalized.message.role).toBe("assistant")
    expect(normalized.message.content).toContain("本区块已过时")
  })

  it("the reducer returns a mark-shaped event even from a payload-shaped stream (#275)", () => {
    const reduced = reduceAgentMarkEvents([payloadMarkEvent({ target: "#c", body: "b", markId: "m1", createdAt: T(1) })])
    expect(reduced[0].event.mark.body).toBe("b") // reduced.event.mark is populated, not undefined
  })

  it("does not throw formatting a payload-shaped, message-less mark event (#291)", () => {
    const event = payloadMarkEvent({ target: "#c", body: "本区块已切换到新数据源", markId: "m1", createdAt: T(1) })
    const message = formatShowEventMessage(event)
    expect(typeof message).toBe("string")
    expect(message).toContain("本区块已切换到新数据源")
  })

  it("a bare {kind} anchor is not treated as a locator — falls through to the target (#284)", () => {
    const event = payloadMarkEvent({ target: "#chart", body: "b", createdAt: T(1), anchor: { kind: "element" } })
    expect(resolveAgentMarkAnchor(event as never, [])).toMatchObject({ kind: "element", selector: "#chart" })
  })

  it("preserves tag-qualified selector targets via the element fallback (#288)", () => {
    const event = payloadMarkEvent({ target: "main > .card", body: "b", createdAt: T(1) })
    expect(resolveAgentMarkAnchor(event as never, [])).toMatchObject({ kind: "element", selector: "main > .card" })
  })
})

// GOLDEN fixture — the EXACT 7-event stream captured from the live Lane A2 regression (verbatim, not
// retyped). Its defining trait the hand-built mocks missed: the event-level timestamp field is
// `created_at` (snake_case), while the mark's own `createdAt` (camelCase) lives inside `payload`. If the
// reducer keys ordering / resolve-matching on the camelCase event-level field it reads undefined for
// EVERY event, which (a) keeps the oldest #test-block version and (b) never retires a resolved mark.
const GOLDEN_MARK_EVENTS = JSON.parse(
  readFileSync(new URL("./__fixtures__/real-mark-events.json", import.meta.url), "utf8")
).events as ShowEvent[]

describe("reduce semantics on the golden live stream (Lane R6)", () => {
  it("supersede keeps the NEWEST same-id version and resolved marks are retired — exactly 2 active", () => {
    const reduced = reduceAgentMarkEvents(GOLDEN_MARK_EVENTS)
    // On a fresh load the badge shows only marks NOT retired by a resolve event.
    const active = reduced.filter((r) => !r.resolvedByEvent)
    const activeBodies = active.map((r) => r.mark.body).sort()

    // Defect #1 (resolved filtering) + Defect #2 (supersede newest): exactly the reply + 第二版说明.
    expect(activeBodies).toEqual(["第二版说明(应替换)", "验收回答:这个占位标题的问题已经处理,渐变和图标都加上了。"].sort())
    expect(active).toHaveLength(2)

    // Defect #2: the two #test-block created events share one payload.id — newest occurrence wins.
    const testBlock = reduced.find((r) => r.mark.target === "#test-block")
    expect(testBlock?.mark.body).toBe("第二版说明(应替换)")
    expect(reduced.filter((r) => r.mark.target === "#test-block")).toHaveLength(1) // collapsed to one identity

    // Defect #1: 临时A / 临时B each have a resolve event with the same payload.id ⇒ retired.
    const tmpA = reduced.find((r) => r.mark.target === "#tmp-a")
    const tmpB = reduced.find((r) => r.mark.target === "#tmp-b")
    expect(tmpA?.resolvedByEvent).toBe(true)
    expect(tmpB?.resolvedByEvent).toBe(true)

    // The reply mark is paired + active.
    const reply = reduced.find((r) => r.kind === "reply")
    expect(reply?.resolvedByEvent).toBe(false)
    expect(reply?.mark.body).toContain("验收回答")
  })

  it("exposes a real event-occurrence timestamp on the reduced mark (not undefined) for ordering/readKey", () => {
    const reduced = reduceAgentMarkEvents(GOLDEN_MARK_EVENTS)
    for (const r of reduced) {
      expect(typeof r.createdAt).toBe("string")
      expect(r.createdAt).not.toBe("") // event-level created_at (snake_case) must be picked up
    }
  })
})

describe("reduce timestamp/version precision (Lane R6)", () => {
  const T = (n: number) => `2026-07-23T05:00:0${n}.000Z`

  it("prefers the snake created_at over a camel createdAt echoed from the mark payload (#3633711620)", () => {
    // A transitional event carrying BOTH: the camel value is the stale echoed mark time, the snake value
    // is the true occurrence. eventOccurredAt must return the snake one.
    const event = {
      id: "evt_both",
      type: "assistant.mark.resolved",
      payload: { id: "m", role: "assistant", scope: "default", target: "#x", body: "b", status: "resolved", createdAt: T(1), updatedAt: T(1), resolvedAt: T(9) },
      anchor: {},
      createdAt: T(1), // stale camel (echoes payload)
      created_at: T(9) // true event occurrence
    } as unknown as ShowEvent
    expect(eventOccurredAt(event)).toBe(T(9))
  })

  it("a resolve for an OLDER same-id version does not retire the newer superseding version (#3633711616)", () => {
    // Backend reuses one mark id across a supersede: v1 then v2 (newer). A resolve TARGETS v1 (its
    // payload createdAt echoes v1's) but is recorded AFTER v2. Id + occurrence alone would wrongly retire
    // v2; the version discriminator (resolve payload createdAt === active version createdAt) keeps v2 live.
    const v1 = payloadMarkEvent({ target: "#blk", body: "v1", markId: "reused", createdAt: T(1) })
    const v2 = payloadMarkEvent({ target: "#blk", body: "v2", markId: "reused", createdAt: T(2) })
    const resolveForV1RecordedLate = {
      id: "evt_resolve_v1",
      type: "assistant.mark.resolved",
      payload: { id: "reused", role: "assistant", scope: "default", target: "#blk", body: "v1", status: "resolved", createdAt: T(1), updatedAt: T(1), resolvedAt: T(3) },
      anchor: {},
      created_at: T(3) // occurs AFTER v2's create, but targets v1
    } as unknown as ShowEvent

    const reduced = reduceAgentMarkEvents([v1, v2, resolveForV1RecordedLate])
    const blk = reduced.find((r) => r.mark.target === "#blk")
    expect(blk?.mark.body).toBe("v2") // newest version is active
    expect(blk?.resolvedByEvent).toBe(false) // the v1-targeted resolve must NOT retire v2

    // Control: a resolve that DOES target v2 retires it.
    const resolveForV2 = {
      id: "evt_resolve_v2",
      type: "assistant.mark.resolved",
      payload: { id: "reused", role: "assistant", scope: "default", target: "#blk", body: "v2", status: "resolved", createdAt: T(2), updatedAt: T(2), resolvedAt: T(4) },
      anchor: {},
      created_at: T(4)
    } as unknown as ShowEvent
    const reduced2 = reduceAgentMarkEvents([v1, v2, resolveForV2])
    expect(reduced2.find((r) => r.mark.target === "#blk")?.resolvedByEvent).toBe(true)
  })

  it("normalizes createdAt from the event occurrence, not a stale camel birth, so supersede orders right (#3633812661)", () => {
    // Both same-id versions; the SECOND has a newer occurrence (snake created_at=T4) but a STALE camel
    // createdAt=T1 echoed from its birth. normalizeAgentMarkEvent must key on the occurrence, so the
    // reducer supersede orders by T4 (v2 wins), not the stale camel T1.
    const v1 = {
      id: "e1", type: "assistant.mark.created",
      payload: { id: "same", role: "assistant", scope: "default", target: "#b", body: "v1", status: "active", createdAt: T(2), updatedAt: T(2) },
      anchor: {}, created_at: T(2)
    } as unknown as ShowEvent
    const v2StaleCamel = {
      id: "e2", type: "assistant.mark.created",
      payload: { id: "same", role: "assistant", scope: "default", target: "#b", body: "v2", status: "active", createdAt: T(1), updatedAt: T(1) },
      anchor: {},
      createdAt: T(1), // STALE camel birth (older)
      created_at: T(4) // true event occurrence (newest)
    } as unknown as ShowEvent

    expect(normalizeAgentMarkEvent(v2StaleCamel).createdAt).toBe(T(4)) // occurrence wins, not camel T(1)
    const reduced = reduceAgentMarkEvents([v1, v2StaleCamel])
    expect(reduced.find((r) => r.mark.target === "#b")?.mark.body).toBe("v2") // ordered by occurrence
  })

  it("recomputes createdAt on the canonical fast path — a stale camel birth can't survive it (#3633873997)", () => {
    // ALREADY mark-shaped WITH a message (fast-path eligible), but camel createdAt=T1 is a stale birth and
    // snake created_at=T4 is the true occurrence. The fast path must recompute to T4, not return T1.
    const canonicalButStale = {
      id: "e_stale", type: "assistant.mark.created",
      mark: { id: "same", role: "assistant", scope: "default", target: "#z", body: "new", status: "active", createdAt: T(1), updatedAt: T(1) },
      message: { role: "assistant", content: "new" },
      createdAt: T(1), // stale camel birth
      created_at: T(4) // true occurrence
    } as unknown as ShowEvent
    expect(normalizeAgentMarkEvent(canonicalButStale).createdAt).toBe(T(4))

    const older = {
      id: "e_old", type: "assistant.mark.created",
      mark: { id: "same", role: "assistant", scope: "default", target: "#z", body: "old", status: "active", createdAt: T(2), updatedAt: T(2) },
      message: { role: "assistant", content: "old" },
      createdAt: T(2), created_at: T(2)
    } as unknown as ShowEvent
    const reduced = reduceAgentMarkEvents([older, canonicalButStale])
    expect(reduced.find((r) => r.mark.target === "#z")?.mark.body).toBe("new") // ordered by occurrence T4, not stale T1

    // A truly-canonical event (createdAt already the occurrence) is still a no-op fast path.
    const canonical = normalizeAgentMarkEvent(older)
    expect(canonical).toBe(older)
  })
})

describe("read-receipt versioning + optimistic rollback (Lane R7)", () => {
  // The stored mark exactly as it arrives on the wire (real values from the golden fixture).
  const storedMark = agentMarkOf(GOLDEN_MARK_EVENTS[0])!

  it("a resolve receipt echoes the stored updatedAt verbatim — it must not bump the version (#R7 fix1)", () => {
    expect(storedMark.updatedAt).toBe("2026-07-22T19:24:36.452502+00:00") // birth time, as stored
    const receipt = normalizeShowEvent({ type: "assistant.mark.resolved", mark: storedMark }, "sess") as Extract<ShowEvent, { type: "assistant.mark.resolved" }>
    // updatedAt is the backend's optimistic-concurrency token — echoed, NOT rewritten to now.
    expect(receipt.mark.updatedAt).toBe(storedMark.updatedAt)
    expect(receipt.mark.createdAt).toBe(storedMark.createdAt) // createdAt unchanged too
    expect(receipt.mark.status).toBe("resolved") // only status flips …
    expect(typeof receipt.mark.resolvedAt).toBe("string") // … and resolvedAt is set (the receipt time)
  })

  it("a genuine update still advances updatedAt (only a receipt echoes)", () => {
    const updated = normalizeShowEvent({ type: "assistant.mark.updated", mark: storedMark }, "sess") as Extract<ShowEvent, { type: "assistant.mark.updated" }>
    expect(updated.mark.updatedAt).not.toBe(storedMark.updatedAt) // an update bumps the version
  })

  it("optimistic read is rolled back to UNREAD when the receipt is rejected (#R7 fix2)", () => {
    const base = new Set<string>(["already-read"])
    const afterRead = reconcileReadReceipt(base, "k1", "read")
    expect(afterRead.has("k1")).toBe(true) // optimistic: marked read immediately
    const afterReject = reconcileReadReceipt(afterRead, "k1", "rollback")
    expect(afterReject.has("k1")).toBe(false) // version conflict ⇒ back to unread for retry
    expect(afterReject.has("already-read")).toBe(true) // unrelated read-state untouched
  })

  it("rollback is a same-ref no-op when the key isn't in the set (idempotent)", () => {
    const base = new Set<string>(["x"])
    expect(reconcileReadReceipt(base, "absent", "rollback")).toBe(base)
    expect(reconcileReadReceipt(base, "x", "read")).toBe(base) // already read ⇒ same ref
  })

  it("submitShowEvent rejects on a non-2xx receipt so the caller can roll back (mark_version_conflict)", async () => {
    const conflict = { ok: false, status: 400, statusText: "Bad Request", json: async () => ({ code: "mark_version_conflict" }) }
    const fetchImpl = (async () => conflict) as unknown as typeof fetch
    await expect(
      submitShowEvent(
        { type: "assistant.mark.resolved", mark: storedMark },
        { fetch: fetchImpl, writeToken: "tok", sessionId: "sess", basePath: "http://test.local/" }
      )
    ).rejects.toThrow()
  })
})

describe("show annotation event contract", () => {
  it("preserves both user region and matched elements for element-group annotations", () => {
    const matchedElements: ShowAnchor[] = [
      { kind: "element", selector: "[mark-default='card.a']", label: "Card A" },
      { kind: "element", selector: "[mark-default='card.b']", label: "Card B" }
    ]
    const annotation = areaAnnotation({
      id: "ann_area",
      scope: "review",
      intent: "change",
      comment: "These two cards should be compared as one group.",
      userRegion: { x: 10, y: 20, width: 300, height: 140 },
      matchedElements,
      classification: {
        confidence: 0.86,
        reason: "selection tightly covers two card elements",
        ambiguous: false
      }
    })
    const event = humanAnnotationEvent("human.annotation.created", annotation, undefined, "ses_123", "evt_123", undefined, "2026-06-03T00:00:00.000Z")

    expect(event.annotation.primaryAnchor).toBe("element-group")
    expect(event.annotation.userRegion).toEqual({ x: 10, y: 20, width: 300, height: 140 })
    expect(event.annotation.matchedElements).toHaveLength(2)
    expect(formatShowEventMessage(event)).toContain("[show-annotation:review:created] change")
    expect(formatShowEventMessage(event)).toContain("Anchor kind: element-group")
    expect(formatShowEventMessage(event)).toContain("Matched elements: 2")
  })

  it("classifies multi-element area selections as element groups", () => {
    const matchedElements: ShowAnchor[] = [
      { kind: "element", selector: "[data-card='a']", rect: { x: 12, y: 24, width: 80, height: 40 } },
      { kind: "element", selector: "[data-card='b']", rect: { x: 120, y: 24, width: 80, height: 40 } }
    ]

    const classification = classifyAreaSelection({ x: 10, y: 20, width: 220, height: 80 }, matchedElements)

    expect(classification.reason).toBe("selection contains multiple meaningful elements")
    expect(classification.ambiguous).toBe(true)
  })

  it("collects area elements only inside the caller-provided root", () => {
    const previousElement = globalThis.Element
    const previousHTMLElement = globalThis.HTMLElement
    const previousDocument = globalThis.Document
    const previousDocumentGlobal = globalThis.document
    const previousNode = globalThis.Node
    const root = new FakeElement("div", "Root", { x: 0, y: 0, width: 220, height: 120 })
    const inside = new FakeElement("button", "Inside", { x: 20, y: 20, width: 80, height: 40 })
    const outside = new FakeElement("button", "Outside", { x: 30, y: 30, width: 80, height: 40 })
    root.append(inside)
    const fakeDocument = {
      body: new FakeElement("body", "", { x: 0, y: 0, width: 1000, height: 800 })
    }
    fakeDocument.body.append(root, outside)

    try {
      Object.assign(globalThis, {
        Element: FakeElement,
        HTMLElement: FakeElement,
        Node: { ELEMENT_NODE: 1 },
        Document: FakeDocument,
        document: fakeDocument
      })
      const anchors = collectElementsInArea({ x: 0, y: 0, width: 180, height: 100 }, { root, maxElements: 4 })

      expect(anchors).toHaveLength(1)
      expect(anchors[0].label).toBe("Inside")
    } finally {
      Object.assign(globalThis, {
        Element: previousElement,
        HTMLElement: previousHTMLElement,
        Document: previousDocument,
        Node: previousNode,
        document: previousDocumentGlobal
      })
    }
  })

  it("converts screenshot comment geometry into screenshot-local coordinates", () => {
    const capturedRegion = { x: 100, y: 200, width: 640, height: 360 }

    expect(screenshotPointFromViewport({ x: 140, y: 260 }, capturedRegion)).toEqual({ x: 40, y: 60 })
    expect(screenshotRectFromViewport({ x: 120, y: 230, width: 80, height: 40 }, capturedRegion)).toEqual({
      x: 20,
      y: 30,
      width: 80,
      height: 40
    })
  })

  it("does not fake screenshot pixels when display capture is unavailable", async () => {
    const capture = await captureScreenshotRegion({ x: 10, y: 20, width: 160, height: 90 })

    expect(capture.captured).toBe(false)
    expect(capture.dataUrl).toBeUndefined()
    expect(capture.captureError).toMatch(/Display capture|browser document|Screenshot capture/)
  })

  it("formats one screenshot with multiple numbered comments as a single annotation", () => {
    const annotation = screenshotAnnotation({
      id: "ann_shot",
      scope: "review",
      intent: "question",
      screenshot: {
        attachmentId: "att_123",
        mimeType: "image/png",
        width: 960,
        height: 540,
        capturedRegion: { x: 100, y: 120, width: 960, height: 540 },
        viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 240 },
        items: [
          { label: 1, comment: "The chart and the conclusion disagree.", point: { x: 220, y: 180 } },
          { label: 2, comment: "This empty area looks accidental.", rect: { x: 620, y: 320, width: 180, height: 90 } }
        ]
      }
    })
    const event = humanAnnotationEvent("human.annotation.created", annotation, undefined, "ses_123", "evt_456", undefined, "2026-06-03T00:00:00.000Z")
    const message = formatShowEventMessage(event)

    expect(event.annotation.primaryAnchor).toBe("screenshot")
    expect(event.annotation.screenshot?.items).toHaveLength(2)
    expect(message).toContain("[show-annotation:review:created] question")
    expect(message).toContain("Anchor kind: screenshot")
    expect(message).toContain("Screenshot: att_123")
    expect(message).toContain("1. The chart and the conclusion disagree.")
    expect(message).toContain("2. This empty area looks accidental.")
  })
})

class FakeDocument {}

class FakeElement {
  attributes: { name: string; value: string }[] = []
  children: FakeElement[] = []
  className = ""
  id = ""
  nodeType = 1
  ownerDocument?: unknown
  parent?: FakeElement
  parentElement?: FakeElement

  constructor(
    readonly tagName: string,
    readonly textContent: string,
    private rect: { x: number; y: number; width: number; height: number }
  ) {}

  append(...children: FakeElement[]) {
    for (const child of children) {
      child.parent = this
      child.parentElement = this
      child.ownerDocument = this.ownerDocument
      this.children.push(child)
    }
  }

  querySelectorAll() {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll()])
  }

  contains(element: FakeElement) {
    return element === this || this.children.some((child) => child.contains(element))
  }

  closest() {
    return null
  }

  getAttribute() {
    return null
  }

  getBoundingClientRect() {
    return {
      ...this.rect,
      left: this.rect.x,
      top: this.rect.y,
      right: this.rect.x + this.rect.width,
      bottom: this.rect.y + this.rect.height,
      toJSON: () => this.rect
    } as DOMRect
  }
}

describe("agent-mark identity + supersede/replace (reduceAgentMarkEvents)", () => {
  it("identifies a reply by replyTo and a note by target+scope", () => {
    expect(agentMarkIdentity({ target: "x", replyTo: "show_evt_1" } as never)).toBe("reply:show_evt_1")
    expect(agentMarkIdentity({ target: "#card", scope: "q3" } as never)).toBe("note:q3:#card")
  })

  it("replaces a note on the same target+scope — newest createdAt wins, older dropped", () => {
    const reduced = reduceAgentMarkEvents([
      markEvent({ target: "#card", body: "old", markId: "m1", createdAt: "2026-07-23T00:00:01.000Z" }),
      markEvent({ target: "#card", body: "new", markId: "m2", createdAt: "2026-07-23T00:00:05.000Z" })
    ])
    expect(reduced).toHaveLength(1)
    expect(reduced[0].event.mark.body).toBe("new")
    expect(reduced[0].kind).toBe("note")
  })

  it("pairs reply marks by replyTo (replaces the prior reply) and keeps distinct annotations separate", () => {
    const reduced = reduceAgentMarkEvents([
      markEvent({ target: "a", replyTo: "evt_A", body: "first", createdAt: "2026-07-23T00:00:01.000Z" }),
      markEvent({ target: "a", replyTo: "evt_A", body: "second", createdAt: "2026-07-23T00:00:09.000Z" }),
      markEvent({ target: "b", replyTo: "evt_B", body: "other", createdAt: "2026-07-23T00:00:02.000Z" })
    ])
    expect(reduced).toHaveLength(2)
    const paired = reduced.find((r) => r.identity === "reply:evt_A")
    expect(paired?.event.mark.body).toBe("second")
    expect(paired?.kind).toBe("reply")
  })

  it("retires on read: a resolve newer than the create flags resolvedByEvent (created − resolved on replay)", () => {
    const reduced = reduceAgentMarkEvents([
      markEvent({ target: "#c", createdAt: "2026-07-23T00:00:01.000Z" }),
      // resolve echoes the create's birth createdAt (wire behavior) but occurs later
      markEvent({ target: "#c", type: "assistant.mark.resolved", createdAt: "2026-07-23T00:00:01.000Z", occurredAt: "2026-07-23T00:00:03.000Z" })
    ])
    expect(reduced).toHaveLength(1)
    expect(reduced[0].resolvedByEvent).toBe(true)
  })

  it("re-marking a resolved target after the resolve makes it active again (newest is a create)", () => {
    const reduced = reduceAgentMarkEvents([
      markEvent({ target: "#c", createdAt: "2026-07-23T00:00:01.000Z" }),
      markEvent({ target: "#c", type: "assistant.mark.resolved", createdAt: "2026-07-23T00:00:03.000Z" }),
      markEvent({ target: "#c", body: "re", createdAt: "2026-07-23T00:00:05.000Z" })
    ])
    expect(reduced[0].resolvedByEvent).toBe(false)
    expect(reduced[0].event.mark.body).toBe("re")
  })

  it("scopes: only same-scope marks are reduced when a scope is given", () => {
    const reduced = reduceAgentMarkEvents(
      [
        markEvent({ target: "#c", scope: "q3", createdAt: "2026-07-23T00:00:01.000Z" }),
        markEvent({ target: "#c", scope: "other", createdAt: "2026-07-23T00:00:02.000Z" })
      ],
      "q3"
    )
    expect(reduced).toHaveLength(1)
    expect(reduced[0].identity).toBe("note:q3:#c")
  })

  it("does NOT let a late resolve for an older mark id retire the newer active version (#569)", () => {
    const reduced = reduceAgentMarkEvents([
      markEvent({ target: "#c", markId: "m1", body: "old", createdAt: "2026-07-23T00:00:01.000Z" }),
      markEvent({ target: "#c", markId: "m2", body: "new", createdAt: "2026-07-23T00:00:02.000Z" }),
      // receipt for the OLD m1 arrives late (viewer read m1 before m2 synced)
      markEvent({ target: "#c", markId: "m1", type: "assistant.mark.resolved", createdAt: "2026-07-23T00:00:03.000Z" })
    ])
    expect(reduced).toHaveLength(1)
    expect(reduced[0].event.mark.id).toBe("m2") // newest create is the active version
    expect(reduced[0].event.mark.body).toBe("new")
    expect(reduced[0].resolvedByEvent).toBe(false) // the receipt resolved m1, not the active m2
  })

  it("retires the active version only when the resolve targets its own mark id", () => {
    const reduced = reduceAgentMarkEvents([
      markEvent({ target: "#c", markId: "m2", createdAt: "2026-07-23T00:00:02.000Z" }),
      // resolve echoes m2's birth createdAt (same version) but occurs later
      markEvent({ target: "#c", markId: "m2", type: "assistant.mark.resolved", createdAt: "2026-07-23T00:00:02.000Z", occurredAt: "2026-07-23T00:00:03.000Z" })
    ])
    expect(reduced[0].resolvedByEvent).toBe(true)
  })
})

describe("agent-mark render partition (partitionAgentMarks — cap / overflow / anchor-failure)", () => {
  const unreadAnchored = (n: number) => Array.from({ length: n }, () => ({ read: false, anchored: true }))

  it("caps inline unread at 5; the rest overflow to the badge; count is total unread", () => {
    const part = partitionAgentMarks(unreadAnchored(7))
    expect(part.inlineUnread).toHaveLength(5)
    expect(part.overflow).toHaveLength(2)
    expect(part.unreadCount).toBe(7)
    expect(part.showBadge).toBe(true)
  })

  it("does not show the badge when everything fits inline and anchors resolve", () => {
    const part = partitionAgentMarks(unreadAnchored(3))
    expect(part.inlineUnread).toHaveLength(3)
    expect(part.overflow).toHaveLength(0)
    expect(part.showBadge).toBe(false)
  })

  it("routes every anchor-failed mark to the badge list only (never inline) and counts unread ones", () => {
    const part = partitionAgentMarks([
      { read: false, anchored: true },
      { read: false, anchored: false }, // unread anchor-failure
      { read: true, anchored: false } // read anchor-failure (still listed, not counted)
    ])
    expect(part.inlineUnread).toHaveLength(1)
    expect(part.failed).toHaveLength(2)
    expect(part.unreadCount).toBe(2) // 1 inline unread + 1 unread failed
    expect(part.showBadge).toBe(true) // any anchor failure surfaces the badge
  })

  it("read-this-view anchored marks render inline as gray and never count toward the unread cap", () => {
    const part = partitionAgentMarks([...unreadAnchored(5), { read: true, anchored: true }])
    expect(part.inlineUnread).toHaveLength(5)
    expect(part.inlineRead).toHaveLength(1)
    expect(part.overflow).toHaveLength(0)
    expect(part.unreadCount).toBe(5)
  })
})

describe("attribute-note read token (localStorage hashing)", () => {
  it("is stable for the same anchor+text and changes when the note text changes (⇒ unread again)", () => {
    const a = attributeNoteReadToken("q3", "#card", "改用了新数据源")
    const b = attributeNoteReadToken("q3", "#card", "改用了新数据源")
    const c = attributeNoteReadToken("q3", "#card", "换成了另一个口径")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith("q3:#card#")).toBe(true)
  })

  it("distinguishes different anchors with the same text", () => {
    expect(attributeNoteReadToken("q3", "#a", "same")).not.toBe(attributeNoteReadToken("q3", "#b", "same"))
  })

  it("hashMarkText is deterministic and differs on change", () => {
    expect(hashMarkText("hello")).toBe(hashMarkText("hello"))
    expect(hashMarkText("hello")).not.toBe(hashMarkText("hello!"))
  })
})

describe("mark inline-anchoring trust (isMarkAnchored — area valid, missing routed to list)", () => {
  it("trusts element-backed resolutions (exact/selector/text) with a rect", () => {
    expect(isMarkAnchored("exact", true)).toBe(true)
    expect(isMarkAnchored("selector", true)).toBe(true)
    expect(isMarkAnchored("text", true)).toBe(true)
  })

  it("trusts a valid area/region rect with no DOM element (reply to an area selection, #72)", () => {
    expect(isMarkAnchored("area", true)).toBe(true)
  })

  it("never pins a missing anchor, and never pins without a rect (#69 / D6)", () => {
    expect(isMarkAnchored("missing", true)).toBe(false) // stale fallback rect → badge list only
    expect(isMarkAnchored("area", false)).toBe(false)
    expect(isMarkAnchored("exact", false)).toBe(false)
  })
})

describe("agent-mark anchor resolution (resolveAgentMarkAnchor — canonical, not hand-rolled)", () => {
  it("prefers the event's own anchor", () => {
    const own: ShowAnchor = { kind: "element", selector: "#own", scope: "default" }
    const event = { ...markEvent({ target: "#other", createdAt: "t" }), anchor: own } as unknown as ShowEvent
    expect(resolveAgentMarkAnchor(event as never, [])).toBe(own)
  })

  it("parses the SDK mark-id target form as a mark anchor, not a tag selector (#257)", () => {
    const event = markEvent({ target: "mark-default-summary", createdAt: "t" })
    const anchor = resolveAgentMarkAnchor(event as never, [])
    expect(anchor).toMatchObject({ kind: "mark", id: "summary", mark: "summary" })
  })

  it("parses a plain CSS selector target as an element anchor", () => {
    const anchor = resolveAgentMarkAnchor(markEvent({ target: "#revenue-card", createdAt: "t" }) as never, [])
    expect(anchor).toMatchObject({ kind: "element", selector: "#revenue-card" })
  })

  it("resolves a reply mark through the referenced annotation's anchor in the stream (#283)", () => {
    const referencedAnchor: ShowAnchor = { kind: "element", selector: "#user-picked", scope: "default" }
    const annotation = { id: "evt_ann_1", type: "human.annotation.created", anchor: referencedAnchor, createdAt: "t0" } as unknown as ShowEvent
    const reply = markEvent({ target: "#some-other", replyTo: "evt_ann_1", createdAt: "t1" })
    expect(resolveAgentMarkAnchor(reply as never, [annotation])).toBe(referencedAnchor)
  })

  it("falls back to the target when a reply's referenced event is absent", () => {
    const reply = markEvent({ target: "#fallback", replyTo: "missing_evt", createdAt: "t1" })
    expect(resolveAgentMarkAnchor(reply as never, [])).toMatchObject({ kind: "element", selector: "#fallback" })
  })
})
