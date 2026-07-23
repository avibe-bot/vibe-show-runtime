import { describe, expect, it, vi } from "vitest"
import {
  ANNOTATION_CONTROL_MESSAGE,
  ANNOTATION_QUERY_MESSAGE,
  ANNOTATION_STATE_MESSAGE,
  APPROVE_INTENT,
  canSubmitAnnotation,
  resolveWriteToken,
  annotationControlActionFromEvent,
  annotationControlActionFromMessage,
  annotationControlActionFromPayload,
  annotationModeStorageKey,
  annotationStateMessage,
  attachAnnotationWindowApi,
  connectAnnotationHostBridge,
  createAnnotationController,
  detectAnnotationHost,
  fetchAnnotationAccess,
  isAgentOnlyShowEventType,
  isAnnotationMode,
  isBatchControlNewer,
  isLiveControlEvent,
  isAnnotationQueryMessage,
  reduceAnnotationState,
  readStoredAnnotationMode,
  showAnnotationMeUrl,
  writeStoredAnnotationMode,
  resolveFabVisibility,
  readStoredFabVisible,
  writeStoredFabVisible,
  snapToNearestEdge,
  exceedsDragThreshold,
  readStoredFloatPosition,
  writeStoredFloatPosition,
  floatPositionStorageKey,
  type AnnotationControlState,
  type AnnotationModeStorage,
  type RuntimeConfig,
  type ShowEvent
} from "./index.js"

function memoryStorage(initial: Record<string, string> = {}): AnnotationModeStorage {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value)
    }
  }
}

const INITIAL_STATE: AnnotationControlState = { enabled: false, mode: "smart", available: true }

describe("host detection (contract §6)", () => {
  it("treats vibe-embed=1 as the embedded chat iframe", () => {
    expect(detectAnnotationHost("?vibe-embed=1")).toBe("embedded")
    expect(detectAnnotationHost("vibe-embed=1")).toBe("embedded")
    expect(detectAnnotationHost("?foo=bar&vibe-embed=1")).toBe("embedded")
  })

  it("treats anything else as standalone", () => {
    expect(detectAnnotationHost("")).toBe("standalone")
    expect(detectAnnotationHost(undefined)).toBe("standalone")
    expect(detectAnnotationHost("?vibe-embed=0")).toBe("standalone")
    expect(detectAnnotationHost("?other=1")).toBe("standalone")
  })
})

describe("mode memory (contract §2)", () => {
  it("keys storage by session id", () => {
    expect(annotationModeStorageKey("ses_1")).toBe("avibe:annotation-mode:ses_1")
    expect(annotationModeStorageKey(undefined)).toBe("avibe:annotation-mode:default")
  })

  it("round-trips a valid mode and ignores an invalid stored value", () => {
    const storage = memoryStorage()
    writeStoredAnnotationMode("ses_1", "screenshot", storage)
    expect(readStoredAnnotationMode("ses_1", storage)).toBe("screenshot")
    storage.setItem(annotationModeStorageKey("ses_2"), "nonsense")
    expect(readStoredAnnotationMode("ses_2", storage)).toBeUndefined()
  })

  it("is a no-op (never throws) when storage is unavailable", () => {
    expect(() => writeStoredAnnotationMode("ses_1", "smart", undefined)).not.toThrow()
    expect(readStoredAnnotationMode("ses_1", undefined)).toBeUndefined()
  })

  it("validates modes", () => {
    expect(isAnnotationMode("smart")).toBe(true)
    expect(isAnnotationMode("screenshot")).toBe(true)
    expect(isAnnotationMode("idle")).toBe(false)
    expect(isAnnotationMode(undefined)).toBe(false)
  })
})

describe("state reducer (contract §2)", () => {
  it("enable without a mode falls back to the remembered mode", () => {
    expect(reduceAnnotationState(INITIAL_STATE, { action: "enable" }, { rememberedMode: "screenshot" })).toEqual({
      enabled: true,
      mode: "screenshot",
      available: true
    })
  })

  it("enable with an explicit mode wins over the remembered mode", () => {
    expect(reduceAnnotationState(INITIAL_STATE, { action: "enable", mode: "smart" }, { rememberedMode: "screenshot" })).toEqual({
      enabled: true,
      mode: "smart",
      available: true
    })
  })

  it("disable keeps the mode but turns capture off", () => {
    const enabled: AnnotationControlState = { enabled: true, mode: "screenshot", available: true }
    expect(reduceAnnotationState(enabled, { action: "disable" })).toEqual({ enabled: false, mode: "screenshot", available: true })
  })

  it("set-mode changes only the mode, not enabled/available", () => {
    expect(reduceAnnotationState(INITIAL_STATE, { action: "set-mode", mode: "screenshot" })).toEqual({
      enabled: false,
      mode: "screenshot",
      available: true
    })
  })
})

describe("control action parsing (contract §3/§4)", () => {
  it("parses SSE event payloads", () => {
    const event = { type: "system.annotation.control", payload: { action: "enable", mode: "screenshot" } } as unknown as ShowEvent
    expect(annotationControlActionFromEvent(event)).toEqual({ action: "enable", mode: "screenshot" })
    const other = { type: "human.annotation.created" } as unknown as ShowEvent
    expect(annotationControlActionFromEvent(other)).toBeUndefined()
  })

  it("drops an invalid mode on enable but keeps the enable action", () => {
    expect(annotationControlActionFromPayload({ action: "enable", mode: "bogus" as never })).toEqual({ action: "enable", mode: undefined })
  })

  it("requires a valid mode for set-mode", () => {
    expect(annotationControlActionFromPayload({ action: "set-mode" })).toBeUndefined()
    expect(annotationControlActionFromPayload({ action: "set-mode", mode: "smart" })).toEqual({ action: "set-mode", mode: "smart" })
  })

  it("parses parent→iframe control/query postMessages and rejects foreign ones", () => {
    expect(annotationControlActionFromMessage({ type: ANNOTATION_CONTROL_MESSAGE, action: "disable" })).toEqual({ action: "disable" })
    expect(annotationControlActionFromMessage({ type: "other", action: "disable" })).toBeUndefined()
    expect(annotationControlActionFromMessage(null)).toBeUndefined()
    expect(isAnnotationQueryMessage({ type: ANNOTATION_QUERY_MESSAGE })).toBe(true)
    expect(isAnnotationQueryMessage({ type: ANNOTATION_CONTROL_MESSAGE })).toBe(false)
  })

  it("builds a state broadcast message", () => {
    expect(annotationStateMessage(INITIAL_STATE)).toEqual({ type: ANNOTATION_STATE_MESSAGE, ...INITIAL_STATE })
  })

  it("flags the control event as agent-only (never client-writable)", () => {
    expect(isAgentOnlyShowEventType("system.annotation.control")).toBe(true)
    expect(isAgentOnlyShowEventType("human.annotation.created")).toBe(false)
    expect(isAgentOnlyShowEventType("assistant.mark.created")).toBe(false)
  })
})

describe("annotation controller", () => {
  it("initializes mode from storage and available from injected auth", () => {
    const storage = memoryStorage({ [annotationModeStorageKey("ses_1")]: "screenshot" })
    const config: RuntimeConfig = { sessionId: "ses_1", annotation: { authenticated: false } }
    const controller = createAnnotationController({ config, host: "standalone", storage })
    expect(controller.getState()).toEqual({ enabled: false, mode: "screenshot", available: false })
    expect(controller.host).toBe("standalone")
  })

  it("defaults available to false when neither an auth hint nor a write token proves writability", () => {
    expect(createAnnotationController({ config: { sessionId: "ses_1" }, storage: null }).getState().available).toBe(false)
  })

  it("defaults available to true when an injected write token proves writability", () => {
    expect(createAnnotationController({ config: { sessionId: "ses_1", writeToken: "tok" }, storage: null }).getState().available).toBe(true)
  })

  it("enable() uses the remembered mode and notifies subscribers", () => {
    const storage = memoryStorage({ [annotationModeStorageKey("ses_1")]: "screenshot" })
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, storage })
    const seen: AnnotationControlState[] = []
    controller.subscribe((state) => seen.push(state))
    controller.enable()
    expect(controller.getState()).toMatchObject({ enabled: true, mode: "screenshot" })
    expect(seen.at(-1)).toMatchObject({ enabled: true, mode: "screenshot" })
  })

  it("defaults mode to smart when nothing is remembered (owner ruling round 2)", () => {
    expect(createAnnotationController({ config: { sessionId: "ses_1" }, storage: memoryStorage() }).getState().mode).toBe("smart")
  })

  it("persists mode memory on a USER set-mode and across a fresh controller (reload)", () => {
    const storage = memoryStorage()
    const first = createAnnotationController({ config: { sessionId: "ses_1" }, storage })
    first.setMode("screenshot")
    expect(readStoredAnnotationMode("ses_1", storage)).toBe("screenshot")
    const second = createAnnotationController({ config: { sessionId: "ses_1" }, storage })
    expect(second.getState().mode).toBe("screenshot")
  })

  it("does NOT persist mode memory from an agent SSE control event (owner ruling round 2)", () => {
    const storage = memoryStorage()
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, storage })
    controller.applyControlEvent({ type: "system.annotation.control", payload: { action: "enable", mode: "screenshot" } } as unknown as ShowEvent)
    expect(controller.getState().mode).toBe("screenshot") // applied to live state…
    expect(readStoredAnnotationMode("ses_1", storage)).toBeUndefined() // …but the user's memory is untouched
  })

  it("applies agent SSE control events", () => {
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, storage: null })
    controller.applyControlEvent({ type: "system.annotation.control", payload: { action: "enable", mode: "screenshot" } } as unknown as ShowEvent)
    expect(controller.getState()).toMatchObject({ enabled: true, mode: "screenshot" })
    controller.applyControlEvent({ type: "system.annotation.control", payload: { action: "disable" } } as unknown as ShowEvent)
    expect(controller.getState().enabled).toBe(false)
  })

  it("enable() uses the persisted user mode, not an agent control's temporary mode (round 2 finding)", () => {
    const storage = memoryStorage()
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, storage })
    controller.setMode("smart") // user picks smart → persisted
    controller.applyControlEvent({ type: "system.annotation.control", payload: { action: "enable", mode: "screenshot" } } as unknown as ShowEvent) // agent → screenshot (live only)
    expect(controller.getState().mode).toBe("screenshot")
    controller.disable()
    controller.enable() // user re-opens via FAB with no mode
    expect(controller.getState().mode).toBe("smart") // the user's remembered preference wins, not the agent's
  })

  it("remembers a user-selected mode IN MEMORY even without storage (round 2 finding)", () => {
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, storage: null })
    controller.setMode("screenshot") // user picks screenshot; no storage to persist to
    controller.disable()
    controller.enable() // re-open via FAB with no mode
    expect(controller.getState().mode).toBe("screenshot") // in-memory preference survives, not reset to smart
  })

  it("persists an explicit user mode even when it already matches the agent-set state (round 2 finding)", () => {
    const storage = memoryStorage()
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, storage })
    // A live agent control puts the state in screenshot while the user's remembered pref is still smart.
    controller.applyControlEvent({ type: "system.annotation.control", payload: { action: "enable", mode: "screenshot" } } as unknown as ShowEvent)
    expect(controller.getState().mode).toBe("screenshot")
    expect(readStoredAnnotationMode("ses_1", storage)).toBeUndefined()
    // The user clicks the already-active screenshot tab — an explicit adoption, even though state is unchanged.
    controller.setMode("screenshot")
    expect(readStoredAnnotationMode("ses_1", storage)).toBe("screenshot") // now remembered…
    controller.disable()
    controller.enable() // …so the next mode-less enable keeps screenshot instead of reverting to smart
    expect(controller.getState().mode).toBe("screenshot")
  })

  it("tracks getLastCommandAt from a clock for local commands, event createdAt for controls, not the auth probe", () => {
    let clock = "2026-07-22T00:00:01.000Z"
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, storage: null, now: () => clock })
    expect(controller.getLastCommandAt()).toBeUndefined() // pristine → the batch replay applies any live control
    controller.setAvailable(true) // auth-probe path must NOT count as an intent
    expect(controller.getLastCommandAt()).toBeUndefined()
    controller.enable("smart") // local command → stamped from the injected clock
    expect(controller.getLastCommandAt()).toBe("2026-07-22T00:00:01.000Z")
    // A control event is stamped with its OWN createdAt (its logical time), not the clock…
    controller.applyControlEvent({ type: "system.annotation.control", createdAt: "2026-07-22T00:00:05.000Z", payload: { action: "disable" } } as unknown as ShowEvent)
    expect(controller.getLastCommandAt()).toBe("2026-07-22T00:00:05.000Z")
    // …and the high-water mark never rolls backwards for an older out-of-order intent.
    clock = "2026-07-22T00:00:03.000Z"
    controller.enable("smart")
    expect(controller.getLastCommandAt()).toBe("2026-07-22T00:00:05.000Z")
  })

  it("reflects auth changes via setAvailable without touching enabled/mode", () => {
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, storage: null, initialAvailable: false })
    expect(controller.getState().available).toBe(false)
    controller.enable("smart")
    controller.setAvailable(true)
    expect(controller.getState()).toMatchObject({ enabled: true, mode: "smart", available: true })
  })

  it("exposes a window API sharing the same state", () => {
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, storage: null })
    const api = controller.api()
    api.setMode("screenshot")
    expect(api.getState().mode).toBe("screenshot")
    expect(controller.getState().mode).toBe("screenshot")
  })

})

describe("live-only control events (owner ruling round 2)", () => {
  const PAGE_LOAD = "2026-07-21T10:00:00.000Z"
  function controlEvent(createdAt?: string): ShowEvent {
    return { id: "e1", type: "system.annotation.control", payload: { action: "enable", mode: "screenshot" }, createdAt } as unknown as ShowEvent
  }

  it("treats a control event created at/after page load as live", () => {
    expect(isLiveControlEvent(controlEvent("2026-07-21T10:00:01.000Z"), PAGE_LOAD)).toBe(true)
    expect(isLiveControlEvent(controlEvent(PAGE_LOAD), PAGE_LOAD)).toBe(true)
  })

  it("treats a control event created before page load (replay) as stale", () => {
    expect(isLiveControlEvent(controlEvent("2026-07-20T09:00:00.000Z"), PAGE_LOAD)).toBe(false)
  })

  it("treats a control event with no createdAt as not live", () => {
    expect(isLiveControlEvent(controlEvent(undefined), PAGE_LOAD)).toBe(false)
  })

  it("ignores non-control events", () => {
    expect(isLiveControlEvent({ id: "m", type: "assistant.mark.created", createdAt: "2026-07-21T10:00:01.000Z" } as unknown as ShowEvent, PAGE_LOAD)).toBe(false)
  })
})

describe("initial-batch control ordering (isBatchControlNewer, round 4)", () => {
  const T1 = "2026-07-22T00:00:01.000Z" // batch control authored earliest
  const T2 = "2026-07-22T00:00:02.000Z" // a startup command
  const T3 = "2026-07-22T00:00:03.000Z" // batch control authored latest

  it("applies the batch control when the controller is pristine (control-only: no prior command)", () => {
    expect(isBatchControlNewer(T1, undefined)).toBe(true)
  })

  it("skips the batch control when a later command already superseded it (local-then-batch-older)", () => {
    expect(isBatchControlNewer(T1, T2)).toBe(false) // control@T1 older than command@T2 → local wins
  })

  it("applies a genuinely-live batch control authored after the command (batch-newer)", () => {
    expect(isBatchControlNewer(T3, T2)).toBe(true) // control@T3 newer than command@T2 → still live, must apply
  })

  it("never applies an undated batch control", () => {
    expect(isBatchControlNewer(undefined, undefined)).toBe(false)
    expect(isBatchControlNewer(undefined, T2)).toBe(false)
  })
})

describe("annotation submit gating (canSubmitAnnotation, round 3 approve fast path)", () => {
  it("allows the approve intent to submit with empty / whitespace-only text (one-tap approve)", () => {
    expect(canSubmitAnnotation(APPROVE_INTENT, "")).toBe(true)
    expect(canSubmitAnnotation(APPROVE_INTENT, "   ")).toBe(true)
    expect(canSubmitAnnotation(APPROVE_INTENT, "looks good")).toBe(true) // an optional note is fine too
  })

  it("requires non-empty text for every other intent", () => {
    for (const intent of ["comment", "change", "question"]) {
      expect(canSubmitAnnotation(intent, "")).toBe(false)
      expect(canSubmitAnnotation(intent, "   ")).toBe(false) // whitespace-only is not enough
      expect(canSubmitAnnotation(intent, "needs work")).toBe(true)
    }
  })
})

describe("window API attachment (contract §2)", () => {
  it("attaches the api under __AVIBE_SHOW__.annotation, creating config if absent", () => {
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, storage: null })
    const target: { __AVIBE_SHOW__?: RuntimeConfig } = {}
    attachAnnotationWindowApi(controller, target)
    expect(target.__AVIBE_SHOW__?.annotation?.api).toBe(controller.api())
  })
})

describe("embedded host bridge (contract §3)", () => {
  function fakeWindow() {
    let listener: ((event: MessageEvent) => void) | undefined
    return {
      target: {
        addEventListener: (_type: "message", handler: (event: MessageEvent) => void) => {
          listener = handler
        },
        removeEventListener: () => {
          listener = undefined
        }
      },
      dispatch: (data: unknown, origin = "https://show.test") => listener?.({ data, origin } as MessageEvent),
      hasListener: () => listener !== undefined
    }
  }

  it("broadcasts initial state, applies control, replies to query, and cleans up", () => {
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, host: "embedded", storage: null })
    const messages: unknown[] = []
    const parent = { postMessage: (message: unknown) => messages.push(message) }
    const win = fakeWindow()

    const disconnect = connectAnnotationHostBridge(controller, { window: win.target, parent, origin: "https://show.test" })

    // Initial broadcast on connect.
    expect(messages.at(-1)).toMatchObject({ type: ANNOTATION_STATE_MESSAGE, enabled: false })

    // Parent → iframe control command flips state and re-broadcasts.
    win.dispatch({ type: ANNOTATION_CONTROL_MESSAGE, action: "enable", mode: "screenshot" })
    expect(controller.getState()).toMatchObject({ enabled: true, mode: "screenshot" })
    expect(messages.at(-1)).toMatchObject({ type: ANNOTATION_STATE_MESSAGE, enabled: true, mode: "screenshot" })

    // Query replies with the current state.
    const before = messages.length
    win.dispatch({ type: ANNOTATION_QUERY_MESSAGE })
    expect(messages.length).toBe(before + 1)

    disconnect()
    expect(win.hasListener()).toBe(false)
  })

  it("ignores control messages from a foreign origin", () => {
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, host: "embedded", storage: null })
    const win = fakeWindow()
    connectAnnotationHostBridge(controller, { window: win.target, parent: { postMessage: () => {} }, origin: "https://show.test" })
    win.dispatch({ type: ANNOTATION_CONTROL_MESSAGE, action: "enable", mode: "screenshot" }, "https://evil.example")
    expect(controller.getState().enabled).toBe(false)
  })
})

describe("auth probe (contract §5 v2)", () => {
  it("maps the me endpoint response including the share-scoped write token", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ authenticated: true, canAnnotate: true, writeToken: "share-tok" }) }) as unknown as Response)
    await expect(fetchAnnotationAccess({ url: "https://show.test/__show/me", fetch: fetchImpl })).resolves.toEqual({
      authenticated: true,
      canAnnotate: true,
      writeToken: "share-tok"
    })
  })

  it("ignores a write token when canAnnotate is false", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ authenticated: false, canAnnotate: false, writeToken: "stray" }) }) as unknown as Response)
    await expect(fetchAnnotationAccess({ url: "https://show.test/__show/me", fetch: fetchImpl })).resolves.toEqual({
      authenticated: false,
      canAnnotate: false,
      writeToken: undefined
    })
  })

  it("returns undefined on a non-ok response or a thrown fetch", async () => {
    const notOk = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response)
    await expect(fetchAnnotationAccess({ url: "https://show.test/__show/me", fetch: notOk })).resolves.toBeUndefined()
    const throws = vi.fn(async () => {
      throw new Error("network")
    })
    await expect(fetchAnnotationAccess({ url: "https://show.test/__show/me", fetch: throws })).resolves.toBeUndefined()
  })
})

describe("auth probe URL (contract §5)", () => {
  it("defaults to {basePath}__show/me", () => {
    expect(showAnnotationMeUrl({ basePath: "/show/x/" })).toBe("/show/x/__show/me")
  })

  it("honors an explicit mePath so a custom mount config probes its own endpoint", () => {
    expect(showAnnotationMeUrl({ basePath: "/p/abc/", mePath: "custom/me" })).toBe("/p/abc/custom/me")
  })
})

describe("uniform write-token resolution (contract §5 v2)", () => {
  it("resolves the share token from the probe on a public page", () => {
    expect(resolveWriteToken({ sessionId: "ses_1" }, { authenticated: true, canAnnotate: true, writeToken: "share-tok" })).toBe("share-tok")
  })

  it("keeps the injected token (injected ?? me.writeToken) — injected wins", () => {
    expect(resolveWriteToken({ sessionId: "ses_1", writeToken: "session-tok" }, { authenticated: true, canAnnotate: true, writeToken: "share-tok" })).toBe("session-tok")
  })

  it("resolves no token when writes are not allowed", () => {
    expect(resolveWriteToken({ sessionId: "ses_1" }, { authenticated: false, canAnnotate: false })).toBeUndefined()
    expect(resolveWriteToken({ sessionId: "ses_1" }, undefined)).toBeUndefined()
  })
})

describe("standalone FAB visibility via #mark / #unmark (Lane R10)", () => {
  it("a hash WINS and dictates what to persist (one-time switch)", () => {
    expect(resolveFabVisibility("#unmark", undefined)).toEqual({ visible: false, persist: false })
    expect(resolveFabVisibility("#mark", undefined)).toEqual({ visible: true, persist: true })
    // hash overrides a conflicting stored choice AND re-persists it.
    expect(resolveFabVisibility("#mark", false)).toEqual({ visible: true, persist: true })
    expect(resolveFabVisibility("#UNMARK", true)).toEqual({ visible: false, persist: false }) // case-insensitive
  })

  it("no hash honors the stored choice, else defaults visible, and persists nothing new", () => {
    expect(resolveFabVisibility("", undefined)).toEqual({ visible: true, persist: null }) // default visible
    expect(resolveFabVisibility(undefined, false)).toEqual({ visible: false, persist: null })
    expect(resolveFabVisibility("#other", true)).toEqual({ visible: true, persist: null }) // unknown hash ignored
  })

  it("persisted visibility round-trips as 1/0 and ignores garbage", () => {
    const storage = memoryStorage()
    writeStoredFabVisible("ses_1", false, storage)
    expect(readStoredFabVisible("ses_1", storage)).toBe(false)
    writeStoredFabVisible("ses_1", true, storage)
    expect(readStoredFabVisible("ses_1", storage)).toBe(true)
    expect(readStoredFabVisible("ses_absent", storage)).toBeUndefined()
  })
})

describe("draggable floating chrome: snap + threshold + position storage (Lane R10)", () => {
  const vp = { width: 400, height: 800 }

  it("exceedsDragThreshold: <6px is a click, ≥6px is a drag", () => {
    expect(exceedsDragThreshold(3, 3)).toBe(false) // hypot ~4.24
    expect(exceedsDragThreshold(6, 0)).toBe(true)
    expect(exceedsDragThreshold(0, 8)).toBe(true)
  })

  it("snaps to the NEAREST vertical edge, keeping the FAB off the center pill", () => {
    const size = { width: 52, height: 52 }
    const left = snapToNearestEdge({ left: 40, top: 300 }, size, vp, 20)
    expect(left.edge).toBe("left")
    expect(left.left).toBe(20) // inset from left
    const right = snapToNearestEdge({ left: 300, top: 300 }, size, vp, 20)
    expect(right.edge).toBe("right")
    expect(right.left).toBe(400 - 52 - 20) // inset from right
    expect(left.top).toBe(300) // vertical kept
  })

  it("clamps the vertical position within bounds (never off-screen / into a reserved zone)", () => {
    const size = { width: 52, height: 52 }
    const high = snapToNearestEdge({ left: 10, top: -100 }, size, vp, 20)
    expect(high.top).toBe(20) // clamped to top inset
    const low = snapToNearestEdge({ left: 10, top: 5000 }, size, vp, 20, { bottom: 760 })
    expect(low.top).toBe(760 - 52) // clamped so it fits above the reserved bottom bound
  })

  it("float position round-trips per element + session; garbage ⇒ undefined", () => {
    const storage = memoryStorage()
    writeStoredFloatPosition("fab", "ses_1", { left: 20, top: 120 }, storage)
    writeStoredFloatPosition("badge", "ses_1", { left: 328, top: 400 }, storage)
    expect(readStoredFloatPosition("fab", "ses_1", storage)).toEqual({ left: 20, top: 120 })
    expect(readStoredFloatPosition("badge", "ses_1", storage)).toEqual({ left: 328, top: 400 }) // independent
    expect(readStoredFloatPosition("fab", "ses_2", storage)).toBeUndefined() // per session
    storage.setItem(floatPositionStorageKey("fab", "ses_1"), "not json")
    expect(readStoredFloatPosition("fab", "ses_1", storage)).toBeUndefined()
  })
})
