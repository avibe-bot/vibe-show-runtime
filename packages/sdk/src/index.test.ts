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
}): ShowEvent {
  const type = opts.type ?? "assistant.mark.created"
  return {
    id: `evt_${opts.target}_${opts.createdAt}`,
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
    createdAt: opts.createdAt
  } as unknown as ShowEvent
}

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
      markEvent({ target: "#c", type: "assistant.mark.resolved", createdAt: "2026-07-23T00:00:03.000Z" })
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
      markEvent({ target: "#c", markId: "m2", type: "assistant.mark.resolved", createdAt: "2026-07-23T00:00:03.000Z" })
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
