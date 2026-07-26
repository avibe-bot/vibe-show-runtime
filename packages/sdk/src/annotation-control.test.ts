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
  readStoredFabVisibility,
  writeStoredFabVisibility,
  fabVisibleStorageKey,
  fabHideOptions,
  fabVisibilityForDevice,
  isFabHidden,
  toggleFabVisibilityByShortcut,
  formatFabShortcut,
  formatMarkParam,
  withParenthetical,
  stripFabParamsFromHash,
  stripFabParamsFromSearch,
  fabFlagToken,
  shouldApplyFabFlag,
  nextAppliedFlag,
  activeFabToast,
  stripFabParamsFromUrl,
  fabUrlChangeEvents,
  isEditableTarget,
  shouldToggleFabShortcut,
  snapToNearestEdge,
  exceedsDragThreshold,
  readStoredFloatPlacement,
  writeStoredFloatPlacement,
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

describe("standalone FAB visibility via ?mark / ?unmark query param (Lane R10/R11, tri-state in U)", () => {
  it("a query param WINS (bare presence) and dictates what to persist (one-time switch)", () => {
    expect(resolveFabVisibility({ search: "?unmark" }, undefined)).toEqual({ visibility: "hidden-url", persist: "hidden-url" })
    expect(resolveFabVisibility({ search: "?mark" }, undefined)).toEqual({ visibility: "visible", persist: "visible" })
    // param overrides a conflicting stored choice AND re-persists it; coexists with other params.
    expect(resolveFabVisibility({ search: "?mark" }, "hidden-url")).toEqual({ visibility: "visible", persist: "visible" })
    expect(resolveFabVisibility({ search: "?mark" }, "handle")).toEqual({ visibility: "visible", persist: "visible" })
    expect(resolveFabVisibility({ search: "?vibe-embed=1&unmark" }, "visible")).toEqual({
      visibility: "hidden-url",
      persist: "hidden-url",
    })
    expect(resolveFabVisibility({ search: "unmark" }, undefined)).toEqual({ visibility: "hidden-url", persist: "hidden-url" }) // no leading '?'
  })

  // A hash route puts the END of the URL inside `location.hash`, and appending to the end is exactly what the
  // hint tells the reader to do. So the flag is read from BOTH places the tail can be — a page on `#/route`
  // has an empty `location.search`, and looking only there strands the one state with no on-screen exit.
  it("the flag is also read from the hash's OWN query segment, since that is where an append lands", () => {
    expect(resolveFabVisibility({ hash: "#/route?mark" }, "hidden-url")).toEqual({
      visibility: "visible",
      persist: "visible",
    })
    expect(resolveFabVisibility({ hash: "#/route?unmark" }, undefined)).toEqual({
      visibility: "hidden-url",
      persist: "hidden-url",
    })
    expect(resolveFabVisibility({ hash: "#section?mark" }, "hidden-url")).toEqual({
      visibility: "visible",
      persist: "visible",
    })
    // Alongside the hash route's own params, and alongside a search string that has no flag of its own.
    expect(resolveFabVisibility({ hash: "#/route?a=1&mark" }, "hidden-url")).toEqual({
      visibility: "visible",
      persist: "visible",
    })
    expect(resolveFabVisibility({ search: "?foo=1", hash: "#/route?mark" }, "hidden-url")).toEqual({
      visibility: "visible",
      persist: "visible",
    })
  })

  // Reading a second place must not widen WHAT counts as the flag. The hash segment goes through the same
  // URLSearchParams parse as the search — no lenient substring search — so a host's legitimate value that
  // merely contains our word stays untouched, on both sides, byte for byte.
  it("the hash is parsed as a query string, not scanned for our word — host params keep their meaning", () => {
    // `redirect=/a?mark` is ONE value per URLSearchParams (no `mark` key). Locked on both sides.
    expect(resolveFabVisibility({ search: "?redirect=/a?mark" }, "hidden-url")).toEqual({
      visibility: "hidden-url",
      persist: null,
    })
    expect(resolveFabVisibility({ hash: "#/route?redirect=/a?mark" }, "hidden-url")).toEqual({
      visibility: "hidden-url",
      persist: null,
    })
    // No '?' in the hash ⇒ no query segment at all: a route PATH named /mark is a route, not our flag.
    expect(resolveFabVisibility({ hash: "#/mark" }, "hidden-url")).toEqual({ visibility: "hidden-url", persist: null })
    expect(resolveFabVisibility({ hash: "#/some/hash-route" }, undefined)).toEqual({
      visibility: "visible",
      persist: null,
    })
    expect(resolveFabVisibility({ hash: "#/route?foo=mark" }, "hidden-url")).toEqual({ visibility: "hidden-url", persist: null })
  })

  // Two places can disagree; that has to be a decision, not an accident of evaluation order.
  it("when both places carry a flag, the SEARCH wins — a fixed, explicitly tested priority", () => {
    expect(resolveFabVisibility({ search: "?unmark", hash: "#/route?mark" }, undefined)).toEqual({
      visibility: "hidden-url",
      persist: "hidden-url",
    })
    expect(resolveFabVisibility({ search: "?mark", hash: "#/route?unmark" }, undefined)).toEqual({
      visibility: "visible",
      persist: "visible",
    })
    // Only a flag outranks the hash — an unrelated search param does not suppress it.
    expect(resolveFabVisibility({ search: "?foo=1", hash: "#/route?unmark" }, undefined)).toEqual({
      visibility: "hidden-url",
      persist: "hidden-url",
    })
  })

  it("no param honors the stored state (including 'handle'), else defaults visible, persisting nothing new", () => {
    expect(resolveFabVisibility({ search: "" }, undefined)).toEqual({ visibility: "visible", persist: null }) // default visible
    expect(resolveFabVisibility({}, "hidden-url")).toEqual({ visibility: "hidden-url", persist: null })
    expect(resolveFabVisibility({}, "handle")).toEqual({ visibility: "handle", persist: null })
    expect(resolveFabVisibility({ search: "?other=1" }, "visible")).toEqual({ visibility: "visible", persist: null }) // unknown param ignored
  })

  it("there is NO third query param — 'handle' is reachable only from the UI, and ?mark still wins over it", () => {
    // Owner-frozen: the URL vocabulary stays two words. `?handle` is just an unknown param.
    expect(resolveFabVisibility({ search: "?handle" }, undefined)).toEqual({ visibility: "visible", persist: null })
    expect(resolveFabVisibility({ search: "?handle" }, "hidden-url")).toEqual({ visibility: "hidden-url", persist: null })
    expect(resolveFabVisibility({ hash: "#/route?handle" }, "hidden-url")).toEqual({ visibility: "hidden-url", persist: null })
  })

  it("persisted visibility round-trips all four states and ignores garbage", () => {
    const storage = memoryStorage()
    for (const state of ["visible", "handle", "hidden-key", "hidden-url"] as const) {
      writeStoredFabVisibility("ses_1", state, storage)
      expect(readStoredFabVisibility("ses_1", false, storage)).toBe(state)
      expect(readStoredFabVisibility("ses_1", true, storage)).toBe(state) // platform only matters for LEGACY values
    }
    expect(readStoredFabVisibility("ses_absent", false, storage)).toBeUndefined()
    expect(readStoredFabVisibility("ses_1", false, memoryStorage({ [fabVisibleStorageKey("ses_1")]: "yes" }))).toBeUndefined()
  })

  it("migrates a LEGACY boolean value per surface, so an already-hidden user keeps a recovery path", () => {
    // Same key prefix as the boolean era: "1"/"0" written by an older build must still mean something.
    const key = fabVisibleStorageKey("ses_1")
    // Legacy truthy → visible, on either surface.
    expect(readStoredFabVisibility("ses_1", false, memoryStorage({ [key]: "1" }))).toBe("visible")
    expect(readStoredFabVisibility("ses_1", true, memoryStorage({ [key]: "1" }))).toBe("visible")
    // Legacy falsy → the platform-appropriate equivalent: a touch user gets the tappable handle back,
    // a keyboard user gets true-hidden (Option/Alt+M is their recovery).
    expect(readStoredFabVisibility("ses_1", true, memoryStorage({ [key]: "0" }))).toBe("handle")
    expect(readStoredFabVisibility("ses_1", false, memoryStorage({ [key]: "0" }))).toBe("hidden-key")
  })

  it("migration does NOT rewrite storage — the same legacy value re-derives per surface on every read", () => {
    // A phone and a laptop can share one synced profile; freezing the first reader's platform into storage
    // would strand the other. Re-deriving keeps both surfaces recoverable.
    const storage = memoryStorage({ [fabVisibleStorageKey("ses_1")]: "0" })
    expect(readStoredFabVisibility("ses_1", true, storage)).toBe("handle")
    expect(readStoredFabVisibility("ses_1", false, storage)).toBe("hidden-key") // unchanged by the first read
  })

  it("writeStoredFabVisibility reports whether the choice was durably stored", () => {
    // The boot effect only strips ?mark/?unmark from the URL when this returns true — a failed write must
    // keep the flag in the URL so a reload still carries the intent.
    expect(writeStoredFabVisibility("ses_1", "hidden-url", memoryStorage())).toBe(true)
    expect(writeStoredFabVisibility("ses_1", "hidden-url", undefined)).toBe(false) // no storage at all
    const throwing: AnnotationModeStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota / private mode")
      }
    }
    expect(writeStoredFabVisibility("ses_1", "hidden-url", throwing)).toBe(false)
  })

  it("stripFabParamsFromSearch removes ONLY our flag, preserving other params byte-for-byte", () => {
    // The lone flag → empty search (URL returns clean).
    expect(stripFabParamsFromSearch("?mark")).toBe("")
    expect(stripFabParamsFromSearch("?unmark")).toBe("")
    expect(stripFabParamsFromSearch("mark")).toBe("") // tolerates a missing leading '?'
    expect(stripFabParamsFromSearch("")).toBe("")
    // A bare sibling flag stays bare (NOT rewritten to `debug=`), and only our key token is dropped.
    expect(stripFabParamsFromSearch("?debug&unmark")).toBe("debug")
    expect(stripFabParamsFromSearch("?vibe-embed=1&unmark")).toBe("vibe-embed=1")
    // Existing escapes are preserved verbatim (no URLSearchParams re-encode).
    expect(stripFabParamsFromSearch("?a=%20b&mark=1")).toBe("a=%20b")
    // Matches the KEY only — `mark`/`unmark` as a value is untouched.
    expect(stripFabParamsFromSearch("?foo=mark")).toBe("foo=mark")
  })

  // The strip has to reach wherever the read reaches: leave `unmark` sitting in the hash and it outlives its
  // one-time switch, so a later `mark` appended to the same tail fights a flag that never left.
  it("stripFabParamsFromHash drops our flag from the hash's query segment, keeping the ROUTE intact", () => {
    // The route path survives; a query segment left empty loses its '?' rather than trailing a bare one.
    expect(stripFabParamsFromHash("#/route?mark")).toBe("/route")
    expect(stripFabParamsFromHash("#/route?unmark")).toBe("/route")
    expect(stripFabParamsFromHash("#section?mark")).toBe("section")
    // Foreign keys and their escapes are preserved byte-for-byte, same discipline as the search side.
    expect(stripFabParamsFromHash("#/route?a=1&unmark")).toBe("/route?a=1")
    expect(stripFabParamsFromHash("#/route?debug&mark")).toBe("/route?debug") // bare flag stays bare
    // A VALUED `mark` in the hash is the host's, not ours (round 8) — it survives untouched, escapes and all.
    expect(stripFabParamsFromHash("#/route?a=%20b&mark=1")).toBe("/route?a=%20b&mark=1")
    // No flag of ours ⇒ the hash comes back exactly as it went in, down to a bare trailing '?' the host wrote.
    // (Reached whenever the flag arrived in the SEARCH: the hash strip still runs, and must be a no-op.)
    expect(stripFabParamsFromHash("#/route")).toBe("/route")
    expect(stripFabParamsFromHash("#/route?")).toBe("/route?")
    expect(stripFabParamsFromHash("#/mark")).toBe("/mark") // a route named /mark is a route
    expect(stripFabParamsFromHash("")).toBe("")
    expect(stripFabParamsFromHash(undefined)).toBe("")
    // Matches the KEY only — the same host value the reader refuses to see is the one it must not corrupt.
    expect(stripFabParamsFromHash("#/route?redirect=/a?mark")).toBe("/route?redirect=/a?mark")
    expect(stripFabParamsFromHash("#/route?foo=mark")).toBe("/route?foo=mark")
  })
})

// The '?' popup's hide rows split by PRIMARY input, not by touch capability: a hybrid touchscreen laptop
// has a keyboard, so it gets the desktop treatment (one destructive row, shortcut recovery, no handle).
describe("platform-split hide options (Lane U)", () => {
  it("a keyboard device offers exactly ONE hide row: straight to hidden, with the shortcut as its exit", () => {
    expect(fabHideOptions(false)).toEqual(["hidden-key"])
  })

  it("a touch-primary device offers TWO rows, handle first, then a complete hide the URL can undo", () => {
    // Not `hidden-key`: this device has no keyboard, so the row that promises one would be a dead end.
    expect(fabHideOptions(true)).toEqual(["handle", "hidden-url"])
  })

  it("formatMarkParam picks the separator for the segment the user APPENDS to — the hash when there is one", () => {
    // Same shape as formatFabShortcut one axis over — compute the exact token the user must reproduce
    // instead of making them derive it. There it's the platform's modifier; here it's the URL's separator.
    // The user types at the END of the address bar, so the segment that decides is whichever one ends the URL.
    expect(formatMarkParam({})).toBe("?mark") // no query, no hash
    expect(formatMarkParam({ search: "?foo=1" })).toBe("&mark") // query, no hash → search decides
    expect(formatMarkParam({ hash: "#/route" })).toBe("?mark") // hash route, no query of its own
    expect(formatMarkParam({ hash: "#/route?a=1" })).toBe("&mark") // hash route already carrying a query
    // The one that is easiest to write backwards: the SEARCH has a query, but the append lands past it, in a
    // hash that has none. Reading `search` here would hand out '&mark' and produce `#/route&mark` — no flag.
    expect(formatMarkParam({ search: "?foo=1", hash: "#/route" })).toBe("?mark")
    expect(formatMarkParam({ search: "?foo=1", hash: "#/route?a=1" })).toBe("&mark")
    // Degenerate shapes read as "no segment", per the URL spec's own normalization.
    expect(formatMarkParam({ search: "?", hash: "" })).toBe("?mark")
    expect(formatMarkParam({ search: "foo=1" })).toBe("&mark") // tolerates a missing leading '?'
    // Already carrying the flag → still '&'. A duplicate key keeps has('mark') true, whereas special-casing it
    // back to '?' would emit the broken form for a URL that demonstrably has a query string.
    expect(formatMarkParam({ search: "?mark" })).toBe("&mark")
    expect(formatMarkParam({ hash: "#/route?mark" })).toBe("&mark")
  })

  it("what formatMarkParam hands out parses back on EVERY real URL shape — the whole reason it exists", () => {
    // The bug it closes: a literal '?mark' appended to a URL that already has a query string yields
    // `?foo=1?mark`, which URLSearchParams reads as ONE `foo` value. No `mark` key, so the stored `hidden`
    // survives the reload — on the one hidden state with neither a handle nor a shortcut to fall back on.
    expect(new URLSearchParams("?foo=1?mark").has("mark")).toBe(false)
    // The full loop, exactly as a user drives it: append the token we printed to the end of the address bar,
    // let the URL parser split the result, and require the reader to see it. `new URL()` does the splitting so
    // the test asserts against real browser semantics rather than our own idea of them.
    for (const href of [
      "https://h/p/abc",
      "https://h/p/abc?foo=1",
      "https://h/p/abc#/route",
      "https://h/p/abc#/route?a=1",
      "https://h/p/abc?foo=1#/route", // ← the shape rounds 1–3 kept missing
      "https://h/p/abc?foo=1#/route?a=1",
      "https://h/p/abc#section",
    ]) {
      const appended = new URL(`${href}${formatMarkParam(new URL(href))}`)
      expect(resolveFabVisibility(appended, "hidden-url"), href).toEqual({ visibility: "visible", persist: "visible" })
    }
  })

  it("withParenthetical composes a base action with its recovery clause, and degrades to bare base", () => {
    // Labels stay ADDITIVE: a host overriding only the base action keeps the platform-derived clause.
    expect(withParenthetical("隐藏标注按钮", "Option+M 恢复")).toBe("隐藏标注按钮（Option+M 恢复）")
    expect(withParenthetical("隐藏标注按钮", undefined)).toBe("隐藏标注按钮")
    expect(withParenthetical("隐藏标注按钮", "")).toBe("隐藏标注按钮")
    expect(withParenthetical("", "Alt+M 恢复")).toBe("（Alt+M 恢复）")
  })
})

// Two review rounds found the same bug from opposite ends: a chrome hidden with a keyboard attached, met on a
// device that has none. The state used to record only WHAT is on screen, while the way back out lived in a
// toast that expires in 3.2s — so the two could disagree and strand someone on an empty screen. Splitting
// `hidden` by the exit the user was TOLD about puts the way out inside the state, where it cannot go stale.
describe("hidden carries its own exit: hidden-key vs hidden-url (Lane U, owner ruling round 6)", () => {
  it("isFabHidden groups the two flavors that render nothing, and only those", () => {
    expect(isFabHidden("hidden-key")).toBe(true)
    expect(isFabHidden("hidden-url")).toBe(true)
    expect(isFabHidden("handle")).toBe(false) // a 5px bar IS on screen, and one tap wide
    expect(isFabHidden("visible")).toBe(false)
  })

  it("a keyboard hide degrades to the handle on a device with no keyboard — at boot AND mid-session", () => {
    // The whole point of the split: `hidden-key` promised a shortcut, so it must not outlive one. The old
    // rule had to watch for the LOSS transition (`had one, now doesn't`) because plain `hidden` was ambiguous.
    // The state now says which exit it advertised, so a plain test is safe — and it covers the case the
    // transition watch structurally could not: a laptop-created hide reopened on a tablet, where there is no
    // previous value to have lost because the page is booting for the first time.
    expect(fabVisibilityForDevice("hidden-key", false)).toBe("handle")
    expect(fabVisibilityForDevice("hidden-key", true)).toBe("hidden-key") // keyboard present → honored
  })

  it("a URL hide is NEVER degraded — its exit does not depend on the device", () => {
    // This is what makes the owner's touch-side full-hide row safe to keep. `?mark` works on every device and
    // every URL shape, so a touch user's deliberate `完全隐藏` must survive every reload, keyboard or not.
    // Degrading it would collapse the two touch rows into one and quietly cancel a choice they just made.
    expect(fabVisibilityForDevice("hidden-url", false)).toBe("hidden-url")
    expect(fabVisibilityForDevice("hidden-url", true)).toBe("hidden-url")
  })

  it("leaves the on-screen states alone — they are their own exit", () => {
    for (const shortcut of [true, false]) {
      expect(fabVisibilityForDevice("visible", shortcut)).toBe("visible")
      expect(fabVisibilityForDevice("handle", shortcut)).toBe("handle")
    }
  })

  it("each hide row advertises the exit its own state names — no shortcut/target drift possible", () => {
    expect(fabHideOptions(false)).toEqual(["hidden-key"]) // desktop: one row, recovered by the shortcut
    expect(fabHideOptions(true)).toEqual(["handle", "hidden-url"]) // touch keeps BOTH rows (owner ruling)
  })

  it("the shortcut's own hide records the shortcut as its exit", () => {
    // Pressing the key IS the proof this device has one, and the toast that follows names it.
    expect(toggleFabVisibilityByShortcut("visible")).toBe("hidden-key")
    for (const hidden of ["hidden-key", "hidden-url", "handle"] as const) {
      expect(toggleFabVisibilityByShortcut(hidden)).toBe("visible")
    }
  })

  it("?unmark persists as hidden-url — the reader already typed the URL vocabulary", () => {
    // Getting this backwards would be a silent downgrade for exactly the users who proved they know the way
    // out: a phone opened via ?unmark would store `hidden-key`, and the next boot would demote it to a handle.
    expect(resolveFabVisibility({ search: "?unmark" }, undefined)).toEqual({
      visibility: "hidden-url",
      persist: "hidden-url"
    })
    expect(resolveFabVisibility({ hash: "#/route?unmark" }, "visible")).toEqual({
      visibility: "hidden-url",
      persist: "hidden-url"
    })
    expect(resolveFabVisibility({ search: "?mark" }, "hidden-url")).toEqual({
      visibility: "visible",
      persist: "visible"
    })
  })

  it("storage migrates every earlier vocabulary toward an exit this device can use", () => {
    const store = (value: string): AnnotationModeStorage => ({
      getItem: () => value,
      setItem: () => {},
      removeItem: () => {}
    })
    // The pre-tri-state BOOLEAN, unchanged in spirit: `0` becomes whichever hide the surface can recover from.
    expect(readStoredFabVisibility("s", false, store("0"))).toBe("hidden-key")
    expect(readStoredFabVisibility("s", true, store("0"))).toBe("handle")
    expect(readStoredFabVisibility("s", false, store("1"))).toBe("visible")
    // The tri-state `hidden` this branch briefly wrote in unreleased builds. Read as `hidden-key`, the
    // CONSERVATIVE guess: it degrades to a handle on a keyboard-less device, so the worst case is undoing one
    // unreleased state rather than leaving somebody on a blank screen with no vocabulary to escape it.
    expect(readStoredFabVisibility("s", false, store("hidden"))).toBe("hidden-key")
    expect(fabVisibilityForDevice(readStoredFabVisibility("s", true, store("hidden"))!, false)).toBe("handle")
    // Current vocabulary passes through untouched, on both surfaces.
    for (const value of ["visible", "handle", "hidden-key", "hidden-url"] as const) {
      expect(readStoredFabVisibility("s", false, store(value))).toBe(value)
      expect(readStoredFabVisibility("s", true, store(value))).toBe(value)
    }
  })
})

describe("Alt+M FAB toggle shortcut guard (Lane R12)", () => {
  it("formatFabShortcut names the modifier ONCE, per platform, and omits it on keyboard-less devices", () => {
    // Apple platforms print the Option key; everything else prints Alt.
    expect(formatFabShortcut({ platform: "macOS", touchPrimary: false })).toBe("Option+M")
    expect(formatFabShortcut({ platform: "MacIntel", touchPrimary: false })).toBe("Option+M") // navigator.platform fallback
    expect(formatFabShortcut({ platform: "Windows", touchPrimary: false })).toBe("Alt+M")
    expect(formatFabShortcut({ platform: "Linux x86_64", touchPrimary: false })).toBe("Alt+M")
    expect(formatFabShortcut({ platform: "", touchPrimary: false })).toBe("Alt+M") // unknown platform → the common label
    // Touch-PRIMARY means no keyboard: the clause is OMITTED entirely, never reworded for a phone.
    expect(formatFabShortcut({ platform: "iPhone", touchPrimary: true })).toBeUndefined()
    expect(formatFabShortcut({ platform: "macOS", touchPrimary: true })).toBeUndefined()
  })

  it("toggleFabVisibilityByShortcut flips visible⇄hidden and rescues a handle state back to visible", () => {
    // Hiding BY the shortcut proves the keyboard exists, so the state it records names the shortcut.
    expect(toggleFabVisibilityByShortcut("visible")).toBe("hidden-key")
    expect(toggleFabVisibilityByShortcut("hidden-key")).toBe("visible")
    expect(toggleFabVisibilityByShortcut("hidden-url")).toBe("visible")
    // A `handle` set on a phone then opened on a laptop: the shortcut must RESTORE, not re-hide.
    expect(toggleFabVisibilityByShortcut("handle")).toBe("visible")
  })

  it("isEditableTarget: true for input / textarea / select / contenteditable, false otherwise", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true)
    expect(isEditableTarget({ tagName: "textarea" })).toBe(true) // case-insensitive
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true)
    expect(isEditableTarget({ isContentEditable: true })).toBe(true) // also true for its descendants
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false)
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(undefined)).toBe(false)
  })

  it("fires only on Alt+M with Alt the SOLE modifier, matched by key OR code, outside editable fields", () => {
    const alt = (over: Record<string, unknown> = {}) => ({ key: "m", code: "KeyM", altKey: true, ...over })
    expect(shouldToggleFabShortcut(alt(), { tagName: "BODY" })).toBe(true)
    expect(shouldToggleFabShortcut(alt({ key: "M" }), null)).toBe(true) // uppercase key
    // macOS ⌥M emits key "µ"; the physical code still identifies the M key
    expect(shouldToggleFabShortcut({ key: "µ", code: "KeyM", altKey: true }, null)).toBe(true)
    expect(shouldToggleFabShortcut(alt(), { tagName: "INPUT" })).toBe(false) // typing in a field
    expect(shouldToggleFabShortcut(alt(), { isContentEditable: true })).toBe(false)
    expect(shouldToggleFabShortcut(alt({ ctrlKey: true }), null)).toBe(false) // extra modifier
    expect(shouldToggleFabShortcut(alt({ metaKey: true }), null)).toBe(false)
    expect(shouldToggleFabShortcut(alt({ shiftKey: true }), null)).toBe(false)
    expect(shouldToggleFabShortcut({ key: "m", code: "KeyM", altKey: false }, null)).toBe(false) // no Alt
    expect(shouldToggleFabShortcut({ key: "k", code: "KeyK", altKey: true }, null)).toBe(false) // wrong key
    expect(shouldToggleFabShortcut(alt({ repeat: true }), null)).toBe(false) // auto-repeat while held
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

  it("float PLACEMENT (edge + top) round-trips per element + session; garbage ⇒ undefined", () => {
    const storage = memoryStorage()
    writeStoredFloatPlacement("fab", "ses_1", { edge: "left", top: 120 }, storage)
    writeStoredFloatPlacement("badge", "ses_1", { edge: "right", top: 400 }, storage)
    expect(readStoredFloatPlacement("fab", "ses_1", storage)).toEqual({ edge: "left", top: 120 })
    expect(readStoredFloatPlacement("badge", "ses_1", storage)).toEqual({ edge: "right", top: 400 }) // independent
    expect(readStoredFloatPlacement("fab", "ses_2", storage)).toBeUndefined() // per session
    storage.setItem(floatPositionStorageKey("fab", "ses_1"), "not json")
    expect(readStoredFloatPlacement("fab", "ses_1", storage)).toBeUndefined()
    storage.setItem(floatPositionStorageKey("fab", "ses_1"), JSON.stringify({ left: 20, top: 5 })) // old shape, no edge
    expect(readStoredFloatPlacement("fab", "ses_1", storage)).toBeUndefined() // rejects malformed / legacy
  })
})

describe("the address bar is a live input, not a boot-time constant (Lane U, round 7)", () => {
  // The `?mark` exit is advertised as "type it at the end of the address bar". On a hash-routed page that
  // edit is a same-document fragment change: no reload, no remount, so a boot-only read never sees it and
  // the one state whose exit is supposed to work everywhere — `hidden-url` — is the one that strands.
  // These pin the two pure halves the effect leans on: what the cleaned URL is, and who must be told.

  it("rebuilds the whole URL after dropping our flag, wherever it sat", () => {
    // hash query only — the ordinary Show Page shape, where `location.search` is empty
    expect(stripFabParamsFromUrl({ pathname: "/p/x", search: "", hash: "#/route?mark" })).toBe("/p/x#/route")
    // search only
    expect(stripFabParamsFromUrl({ pathname: "/p/x", search: "?mark", hash: "" })).toBe("/p/x")
    // both segments carry it; both get cleaned in one rewrite
    expect(stripFabParamsFromUrl({ pathname: "/p/x", search: "?mark", hash: "#/route?unmark" })).toBe("/p/x#/route")
  })

  it("keeps every byte that is not ours", () => {
    expect(stripFabParamsFromUrl({ pathname: "/p/x", search: "?a=1&mark&b=2", hash: "#/r?c=3" })).toBe(
      "/p/x?a=1&b=2#/r?c=3"
    )
    // a hash ROUTE that merely looks like a query is not touched
    expect(stripFabParamsFromUrl({ pathname: "/p/x", search: "?mark", hash: "#/redirect=/a?mark" })).toBe(
      "/p/x#/redirect=/a"
    )
  })

  it("returns null when there is nothing of ours to strip, so the caller skips the rewrite entirely", () => {
    expect(stripFabParamsFromUrl({ pathname: "/p/x", search: "?a=1", hash: "#/route" })).toBeNull()
    expect(stripFabParamsFromUrl({ pathname: "/p/x", search: "", hash: "" })).toBeNull()
  })

  it("tells hash routers only when the hash actually moved", () => {
    // replaceState fires neither event; we re-issue what the browser withheld. `hashchange` is a claim about
    // the fragment, so it may only be made when the fragment really changed — otherwise it is a lie a
    // subscriber will act on.
    expect(fabUrlChangeEvents({ search: "?mark", hash: "#/route" }, { search: "", hash: "#/route" })).toEqual([
      "popstate",
    ])
    expect(fabUrlChangeEvents({ search: "", hash: "#/route?mark" }, { search: "", hash: "#/route" })).toEqual([
      "popstate",
      "hashchange",
    ])
  })

  it("stays silent when nothing moved, so our own rewrite cannot echo forever", () => {
    expect(fabUrlChangeEvents({ search: "?a=1", hash: "#/r" }, { search: "?a=1", hash: "#/r" })).toEqual([])
  })

  it("is idempotent, which is what BOUNDS the echo rather than any timing assumption", () => {
    // The handler re-issues the events replaceState withheld, and those wake the handler again. What stops
    // that is not a guard or a debounce: a second pass finds no flag left to strip, so it rewrites nothing
    // and therefore dispatches nothing. Depth is bounded by the flag's own disappearance.
    const first = stripFabParamsFromUrl({ pathname: "/p/x", search: "?a=1&mark", hash: "#/r?unmark" })
    expect(first).toBe("/p/x?a=1#/r")
    const url = new URL(`https://h${first}`)
    expect(stripFabParamsFromUrl({ pathname: url.pathname, search: url.search, hash: url.hash })).toBeNull()
  })
})

describe("a stale URL flag must not outlive the choice it recorded (Lane U, round 8)", () => {
  // The wound: when the storage write fails we deliberately LEAVE ?unmark in the URL so a reload still
  // carries the intent. Round 7 then made the overlay subscribe to navigation — and those two correct
  // decisions combine into a trap: every later popstate re-reads the same stale token.

  it("lets the RESCUE flag win when both sit in one segment, because being wrongly hidden is the trap", () => {
    // Failed persistence leaves `unmark` behind; the user follows the printed exit and appends `mark` to
    // that same tail. If `unmark` still outranked it, the advertised exit would be unreachable — the exact
    // defect this PR exists to close, reintroduced through the back door.
    expect(resolveFabVisibility({ search: "?unmark&mark" }, undefined).visibility).toBe("visible")
    expect(resolveFabVisibility({ search: "?mark&unmark" }, undefined).visibility).toBe("visible")
    expect(resolveFabVisibility({ hash: "#/r?unmark&mark" }, undefined).visibility).toBe("visible")
  })

  it("still gives the SEARCH the last word across segments — that precedence is unchanged", () => {
    expect(resolveFabVisibility({ search: "?unmark", hash: "#/r?mark" }, undefined).visibility).toBe("hidden-url")
  })

  it("tokenizes what the URL carries, so 'unmark' and 'unmark then mark' are different occurrences", () => {
    expect(fabFlagToken({ search: "?unmark" })).toBe("unmark")
    expect(fabFlagToken({ search: "?unmark&mark" })).toBe("mark+unmark")
    expect(fabFlagToken({ search: "?mark&unmark" })).toBe("mark+unmark") // order-independent identity
    expect(fabFlagToken({ hash: "#/r?mark" })).toBe("mark")
    expect(fabFlagToken({ search: "?a=1", hash: "#/route" })).toBe("")
  })

  it("applies an occurrence once: the same token never fires twice, a changed one always does", () => {
    expect(shouldApplyFabFlag("unmark", undefined)).toBe(true) // boot
    expect(shouldApplyFabFlag("unmark", "unmark")).toBe(false) // the stale re-read that hid a restored FAB
    expect(shouldApplyFabFlag("mark+unmark", "unmark")).toBe(true) // the user just typed the exit
    expect(shouldApplyFabFlag("", "unmark")).toBe(false) // stripped clean — nothing to apply
    expect(shouldApplyFabFlag("", undefined)).toBe(false)
  })
})

describe("the hash belongs to the host router; we may only claim the bare flag there (Lane U, round 8)", () => {
  it("ignores a host's own valued parameter that happens to be named mark", () => {
    // `#/review?mark=42` is a route with a row id, not our switch. URLSearchParams.has() cannot tell the
    // difference, which is why recognition is by BARE presence.
    expect(resolveFabVisibility({ hash: "#/review?mark=42" }, undefined).persist).toBeNull()
    expect(resolveFabVisibility({ hash: "#/review?unmark=1" }, undefined).persist).toBeNull()
    expect(fabFlagToken({ hash: "#/review?mark=42" })).toBe("")
  })

  it("still honors the bare flag the recovery flow actually produces", () => {
    expect(resolveFabVisibility({ hash: "#/review?mark" }, undefined).visibility).toBe("visible")
    expect(resolveFabVisibility({ hash: "#/review?a=1&unmark" }, undefined).visibility).toBe("hidden-url")
  })

  it("leaves a host's valued parameter in place when stripping, so route state survives", () => {
    expect(stripFabParamsFromHash("#/review?mark=42")).toBe("/review?mark=42")
    expect(stripFabParamsFromHash("#/review?mark=42&mark")).toBe("/review?mark=42")
  })

  it("keeps location.search tolerant — that namespace was reserved before this PR, the hash was not", () => {
    expect(resolveFabVisibility({ search: "?mark=1" }, undefined).visibility).toBe("visible")
  })
})

describe("the spent-flag memo must not outlive the flag itself (Lane U, round 9)", () => {
  // Round 8 stopped a flag from firing twice. It did not say when the memo STOPS applying — so the memo
  // outlived the flag and swallowed the user's second, genuinely new `?mark`. The memo means "the occurrence
  // currently in the URL that we already answered"; once the URL is flag-free there is no such occurrence.
  it("forgets the answered occurrence as soon as the URL is flag-free", () => {
    expect(nextAppliedFlag("mark")).toBe("mark")
    expect(nextAppliedFlag("")).toBeUndefined()
  })

  it("lets the SAME token apply again after an intervening clean URL — the whole round-9 bug, as a sequence", () => {
    // 1. user appends ?mark on a hash route → fresh, applied, remembered
    let memo: string | undefined = undefined
    const first = fabFlagToken({ hash: "#/route?mark" })
    expect(shouldApplyFabFlag(first, memo)).toBe(true)
    memo = nextAppliedFlag(first)
    // 2. the strip lands and re-issues the navigation; the woken pass sees a clean URL and forgets
    const clean = fabFlagToken({ hash: "#/route" })
    expect(shouldApplyFabFlag(clean, memo)).toBe(false)
    memo = nextAppliedFlag(clean)
    expect(memo).toBeUndefined()
    // 3. the user hides again and appends the SAME advertised token — a new occurrence, so it must apply
    const second = fabFlagToken({ hash: "#/route?mark" })
    expect(second).toBe(first)
    expect(shouldApplyFabFlag(second, memo)).toBe(true)
  })

  it("still refuses a flag that never left, which is what round 8 was about", () => {
    // Persistence failed, so `unmark` stays in the URL on purpose. Every later navigation re-reads the same
    // token with no clean URL in between — the memo survives and keeps swallowing it.
    const token = fabFlagToken({ search: "?unmark" })
    let memo = nextAppliedFlag(token)
    expect(shouldApplyFabFlag(token, memo)).toBe(false)
    memo = nextAppliedFlag(token)
    expect(shouldApplyFabFlag(token, memo)).toBe(false)
  })
})

describe("a toast narrates ONE state, so it expires when that state does (Lane U, round 9)", () => {
  // Every toast here is fabToastFor(state, …) — it describes exactly one visibility. Deriving the visible
  // message from the current state means no restore path can forget to clear it: not the shortcut, not the
  // handle, not a `?mark` typed into the address bar, and not whichever path gets added next.
  it("shows the message only while the state it describes is still the current one", () => {
    const raised = { message: "已完全隐藏，网址末尾加 ?mark 恢复", state: "hidden-url" as const }
    expect(activeFabToast(raised, "hidden-url")).toBe(raised.message)
    // The round-9 report: the URL restore path sets visibility directly, never touching the toast.
    expect(activeFabToast(raised, "visible")).toBeNull()
    // A mid-session device degrade moves hidden-key → handle; the old exit is wrong there too.
    expect(activeFabToast({ message: "按 Option+M 恢复", state: "hidden-key" }, "handle")).toBeNull()
  })

  it("is null when nothing was raised", () => {
    expect(activeFabToast(null, "visible")).toBeNull()
    expect(activeFabToast(undefined, "hidden-url")).toBeNull()
  })
})
