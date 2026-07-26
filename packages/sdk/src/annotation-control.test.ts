import { describe, expect, it, vi } from "vitest"
// The module under test is imported by its own path, not through the package root. The root re-exports the
// control plane only (see the named list in `index.ts`); the overlay's own machinery below is internal to this
// package, and a test is not a reason to publish it.
import {
  isAgentOnlyShowEventType,
  showAnnotationMeUrl,
  type AnnotationControlState,
  type RuntimeConfig,
  type ShowEvent
} from "./index.js"
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
  isAnnotationMode,
  isBatchControlNewer,
  isLiveControlEvent,
  isAnnotationQueryMessage,
  reduceAnnotationState,
  readStoredAnnotationMode,
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
  formatMarkUrl,
  withParenthetical,
  stripFabParamsFromSearch,
  activeFabToast,
  copyRestoreLink,
  toastDwellMs,
  settledCopyState,
  mergeCopyState,
  fabToastDurationMs,
  stripFabParamsFromUrl,
  isEditableTarget,
  shouldToggleFabShortcut,
  snapToNearestEdge,
  exceedsDragThreshold,
  readStoredFloatPlacement,
  writeStoredFloatPlacement,
  floatPositionStorageKey,
  type AnnotationModeStorage,
  type ToastCopyState
} from "./annotation-control.js"

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

describe("standalone FAB visibility via the ?mark / ?unmark query param (Lane R10/R11, tri-state in U)", () => {
  it("a query param WINS (bare presence) and dictates what to persist (one-time switch)", () => {
    expect(resolveFabVisibility("?unmark", undefined, true)).toEqual({ visibility: "hidden-url", persist: "hidden-url" })
    expect(resolveFabVisibility("?mark", undefined, true)).toEqual({ visibility: "visible", persist: "visible" })
    // param overrides a conflicting stored choice AND re-persists it; coexists with other params.
    expect(resolveFabVisibility("?mark", "hidden-url", true)).toEqual({ visibility: "visible", persist: "visible" })
    expect(resolveFabVisibility("?mark", "handle", true)).toEqual({ visibility: "visible", persist: "visible" })
    expect(resolveFabVisibility("?vibe-embed=1&unmark", "visible", true)).toEqual({
      visibility: "hidden-url",
      persist: "hidden-url",
    })
    expect(resolveFabVisibility("unmark", undefined, true)).toEqual({ visibility: "hidden-url", persist: "hidden-url" }) // no leading '?'
  })

  // THE INVARIANT, as a test. Everything after `#` is the host router's route, and this control plane does not
  // read it — not to find our word, not to check whether the host squatted on it, not at all. Rounds 7 through
  // 14 all reached into the hash to make "append at the end of the address bar" work on a hash-routed page, and
  // each round found one more way that trespass went wrong. The exit is a whole URL now (see formatMarkUrl), so
  // there is nothing left to look for out there.
  it("reads the SEARCH and nothing else — a flag in the host's fragment is not ours to see", () => {
    // The exact shapes earlier rounds honored. All of them are now invisible: `resolveFabVisibility` never
    // receives them, and the parameter it does receive is `location.search`, which on `/p/x#/route?mark` is "".
    expect(resolveFabVisibility("", "hidden-url", true)).toEqual({ visibility: "hidden-url", persist: null })
    expect(resolveFabVisibility(undefined, undefined, true)).toEqual({ visibility: "visible", persist: null })
    // And the host's own route, whatever it says, cannot reach the resolver through the only input it has.
    expect(resolveFabVisibility("?foo=1", "hidden-url", true)).toEqual({ visibility: "hidden-url", persist: null })
  })

  // The search is parsed as a query string, never scanned for our word, so a host parameter whose VALUE merely
  // contains it keeps its meaning.
  it("matches a full key token — a host value that contains our word is not a flag", () => {
    // `redirect=/a?mark` is ONE value: no `mark` key.
    expect(resolveFabVisibility("?redirect=/a?mark", "hidden-url", true)).toEqual({
      visibility: "hidden-url",
      persist: null,
    })
    expect(resolveFabVisibility("?foo=mark", "hidden-url", true)).toEqual({ visibility: "hidden-url", persist: null })
    // The valued form of our OWN key is a flag, because that is the shape a person types by hand.
    expect(resolveFabVisibility("?mark=1", "hidden-url", true)).toEqual({ visibility: "visible", persist: "visible" })
  })

  // Both flags coexist in exactly one situation: the persistence write failed, so `?unmark` deliberately stayed
  // in the URL as the reload fallback, and the user then opened the restore link, which carries `mark`. If
  // `unmark` still outranked it, the advertised way back would be unreachable for the one state whose entire
  // promise is that its exit always works. Being wrongly visible costs a second hide; being wrongly hidden with
  // your rescue outranked is the blank screen this state exists to avoid.
  it("when both sit in the search, the RESCUE wins", () => {
    expect(resolveFabVisibility("?unmark&mark", undefined, true)).toEqual({ visibility: "visible", persist: "visible" })
    expect(resolveFabVisibility("?mark&unmark", undefined, true)).toEqual({ visibility: "visible", persist: "visible" })
    // Presence is the whole question — a repeat does not out-vote.
    expect(resolveFabVisibility("?unmark&unmark&mark", undefined, true)).toEqual({ visibility: "visible", persist: "visible" })
    // A host key that is not ours cannot rescue — that is what the priority is over.
    expect(resolveFabVisibility("?unmark&id=42", undefined, true)).toEqual({
      visibility: "hidden-url",
      persist: "hidden-url",
    })
  })

  // A viewer who cannot annotate sees no chrome at all — so the URL switch is not theirs to spend. The storage
  // key is keyed by SESSION with no viewer identity in it (fabVisibleStorageKey), so an anonymous visitor
  // opening a shared `?unmark` link on a shared browser used to write `hidden-url` under the author's own key,
  // and the author came back to a page whose chrome was gone with no memory of hiding it. Someone else's click
  // changing the author's state is a different failure from the annotation feature misbehaving for the clicker.
  it("an unauthorized viewer neither consumes nor persists the switch", () => {
    expect(resolveFabVisibility("?unmark", undefined, false)).toEqual({ visibility: "visible", persist: null })
    expect(resolveFabVisibility("?mark", "hidden-url", false)).toEqual({ visibility: "hidden-url", persist: null })
    // `persist: null` is one decision covering all three behaviors: not adopted, not persisted, and — because
    // the caller strips only when there is something to persist — not removed from the URL either. That last
    // one is load-bearing: `available` starts from the config's guess and is corrected by an auth probe a
    // moment later, so the author's own first paint can be "not available yet" and the flag has to still be
    // there when the answer arrives.
    expect(resolveFabVisibility("?unmark", undefined, false).persist).toBeNull()
    expect(resolveFabVisibility("?unmark", undefined, true)).toEqual({ visibility: "hidden-url", persist: "hidden-url" })
  })

  it("no param honors the stored state (including 'handle'), else defaults visible, persisting nothing new", () => {
    expect(resolveFabVisibility("", undefined, true)).toEqual({ visibility: "visible", persist: null }) // default visible
    expect(resolveFabVisibility(undefined, "hidden-url", true)).toEqual({ visibility: "hidden-url", persist: null })
    expect(resolveFabVisibility(undefined, "handle", true)).toEqual({ visibility: "handle", persist: null })
    expect(resolveFabVisibility("?other=1", "visible", true)).toEqual({ visibility: "visible", persist: null }) // unknown param ignored
  })

  it("there is NO third query param — 'handle' is reachable only from the UI, and ?mark still wins over it", () => {
    // Owner-frozen: the URL vocabulary stays two words. `?handle` is just an unknown param.
    expect(resolveFabVisibility("?handle", undefined, true)).toEqual({ visibility: "visible", persist: null })
    expect(resolveFabVisibility("?handle", "hidden-url", true)).toEqual({ visibility: "hidden-url", persist: null })
    expect(resolveFabVisibility("?handle&mark", "hidden-url", true)).toEqual({ visibility: "visible", persist: "visible" })
  })

  it("persisted visibility round-trips all four states and ignores garbage", () => {
    const storage = memoryStorage()
    for (const state of ["visible", "handle", "hidden-key", "hidden-url"] as const) {
      writeStoredFabVisibility("ses_1", state, storage)
      expect(readStoredFabVisibility("ses_1", false, storage)).toBe(state)
      expect(readStoredFabVisibility("ses_1", true, storage)).toBe(state) // the device only matters for LEGACY values
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
    // Legacy falsy → the hidden flavor the surface can actually recover from. The argument is touch
    // CAPABILITY, not the primary pointer: anything with a touchscreen gets the tappable handle back;
    // `hidden-key` is only for a device with no coarse pointer at all, where the shortcut is guaranteed.
    expect(readStoredFabVisibility("ses_1", true, memoryStorage({ [key]: "0" }))).toBe("handle")
    expect(readStoredFabVisibility("ses_1", false, memoryStorage({ [key]: "0" }))).toBe("hidden-key")
  })

  it("a legacy hidden tablet driven by a mouse migrates to the handle, not to a key it cannot press", () => {
    // The hybrid case the primary-pointer split got wrong: `any-pointer: coarse` matches (touchscreen)
    // while `hover: none and pointer: coarse` does not (a mouse is driving). Keying the migration on the
    // primary pointer restored `hidden-key` here — every control gone, and the promised exit a keyboard
    // this device may not have. Capability puts the finger-reachable handle back instead.
    const storage = memoryStorage({ [fabVisibleStorageKey("ses_1")]: "0" })
    expect(readStoredFabVisibility("ses_1", /* touchCapable */ true, storage)).toBe("handle")
  })

  it("migration does NOT rewrite storage — the same legacy value re-derives per surface on every read", () => {
    // A phone and a laptop can share one synced profile; freezing the first reader's device into storage
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
})

// The '?' popup's hide rows split by touch CAPABILITY, not by the primary pointer, because the two
// failures are different sizes: an extra tappable row for someone with a keyboard costs one line in a
// popup; a keyboard-only exit for someone without one costs them the page.
describe("platform-split hide options (Lane U)", () => {
  it("a device with no coarse pointer offers exactly ONE hide row: hidden, with the shortcut as its exit", () => {
    expect(fabHideOptions(false)).toEqual(["hidden-key"])
  })

  it("a touchscreen device offers TWO rows, handle first, then a complete hide the URL can undo", () => {
    // Not `hidden-key`: a finger cannot press Option/Alt+M, so the row that promises one may be a dead end.
    expect(fabHideOptions(true)).toEqual(["handle", "hidden-url"])
  })

  it("a tablet driven by a mouse is a touchscreen device, whatever its primary pointer says", () => {
    // The regression the primary-pointer split produced: `hover: none and pointer: coarse` is FALSE here
    // (a mouse is driving), so the popup offered `hidden-key` as the ONLY row — the user taps the one hide
    // available, every control disappears, and the promised way back is a key they may have no keyboard for.
    // `any-pointer: coarse` is TRUE, so the tappable rows come back.
    expect(fabHideOptions(/* touchCapable */ true)).toContain("handle")
    expect(fabHideOptions(true)).not.toContain("hidden-key")
  })

  it("the one row that promises a key is only offered where the shortcut provably binds", () => {
    // touch-primary ⇒ touch-capable, so !touchCapable ⇒ !touchPrimary — exactly when formatFabShortcut
    // returns a key and the keydown listener binds. The `hidden-key` row can never name a missing key.
    expect(fabHideOptions(false)).toEqual(["hidden-key"])
    expect(formatFabShortcut({ platform: "macOS", touchPrimary: false })).toBeTruthy()
  })

  it("the printed exit is a whole URL, with the flag in the real query position", () => {
    // What the `hidden-url` toast hands over. Users copy links; they do not transcribe suffixes — and a
    // suffix was the whole reason four rounds of this PR were reaching into the host's fragment to find one.
    expect(formatMarkUrl("https://h/p/abc")).toBe("https://h/p/abc?mark")
    expect(formatMarkUrl("https://h/p/abc?foo=1")).toBe("https://h/p/abc?foo=1&mark")
    // On a hash-routed page the flag goes in FRONT of the route, which is where our query string lives.
    expect(formatMarkUrl("https://h/p/abc#/route")).toBe("https://h/p/abc?mark#/route")
    expect(formatMarkUrl("https://h/p/abc?foo=1#/route?a=1")).toBe("https://h/p/abc?foo=1&mark#/route?a=1")
    // The SSR case, where there is no URL to read.
    expect(formatMarkUrl("")).toBe("?mark")
  })

  it("the fragment begins at the FIRST '#', and is carried through untouched", () => {
    // The host's route is opaque: we neither read it to decide the separator nor rewrite it to make room.
    // Anchoring on the LAST '#' would pull our boundary rightward and put part of the host's fragment inside
    // the string we edit — the concrete way "we own the query, they own the fragment" gets violated.
    expect(formatMarkUrl("https://h/p/abc#/route?a=1#x")).toBe("https://h/p/abc?mark#/route?a=1#x")
    // An empty fragment is still a fragment, and still theirs.
    expect(formatMarkUrl("https://h/p/abc#")).toBe("https://h/p/abc?mark#")
    expect(formatMarkUrl("https://h/p/abc?#")).toBe("https://h/p/abc?&mark#") // an empty query keeps its delimiter
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
    // This is what makes the owner's touch-side full-hide row safe to keep. The restore LINK works on every
    // device and every URL shape, so a touch user's deliberate `完全隐藏` must survive every reload, keyboard or not.
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
    expect(fabHideOptions(false)).toEqual(["hidden-key"]) // no touchscreen: one row, recovered by the shortcut
    expect(fabHideOptions(true)).toEqual(["handle", "hidden-url"]) // touchscreen keeps BOTH rows (owner ruling)
  })

  it("the shortcut's own hide records the shortcut as its exit", () => {
    // Pressing the key IS the proof this device has one, and the toast that follows names it.
    expect(toggleFabVisibilityByShortcut("visible")).toBe("hidden-key")
    for (const hidden of ["hidden-key", "hidden-url", "handle"] as const) {
      expect(toggleFabVisibilityByShortcut(hidden)).toBe("visible")
    }
  })

  it("?unmark persists as hidden-url — the reader already holds the URL vocabulary", () => {
    // Getting this backwards would be a silent downgrade for exactly the users who proved they know the way
    // out: a phone opened via ?unmark would store `hidden-key`, and the next boot would demote it to a handle.
    expect(resolveFabVisibility("?unmark", undefined, true)).toEqual({
      visibility: "hidden-url",
      persist: "hidden-url"
    })
    expect(resolveFabVisibility("?a=1&unmark", "visible", true)).toEqual({
      visibility: "hidden-url",
      persist: "hidden-url"
    })
    expect(resolveFabVisibility("?mark", "hidden-url", true)).toEqual({
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

// The invariant, from the rewrite's side. `replaceState` edits the host's address bar, so the only part of it
// we may change is the part we own: everything up to the first `#`. What follows is the host router's route,
// and it comes back byte-for-byte — not "carefully preserved", but never taken apart in the first place. See
// `stripFabParamsFromUrl`, which slices the fragment off and concatenates the original substring back.
describe("the rewrite edits the SEARCH and hands the fragment back byte-for-byte (Lane U)", () => {
  const ORIGIN = "https://h"

  it("drops our flag and leaves the host's own parameters exactly as they were", () => {
    expect(stripFabParamsFromUrl("/p/x?mark")).toBe("/p/x")
    expect(stripFabParamsFromUrl("/p/x?a=1&mark&b=2")).toBe("/p/x?a=1&b=2")
    expect(stripFabParamsFromUrl("/p/x?debug&unmark")).toBe("/p/x?debug") // a bare sibling stays bare
    expect(stripFabParamsFromUrl("/p/x?a=%20b&unmark")).toBe("/p/x?a=%20b") // escapes not re-encoded
    // Everything left of the first '?' is copied through, so a relative href stays relative.
    expect(stripFabParamsFromUrl(`${ORIGIN}/p/x?a=1&mark`)).toBe(`${ORIGIN}/p/x?a=1`)
  })

  it("returns the fragment unchanged, whatever it contains — including our own words", () => {
    // Every shape rounds 7 through 14 reached into is a passthrough now, and the reason is structural rather
    // than careful: nothing between the slice and the return can parse the fragment.
    expect(stripFabParamsFromUrl("/p/x?mark#/route?a=1")).toBe("/p/x#/route?a=1")
    expect(stripFabParamsFromUrl("/p/x?mark#/review?mark")).toBe("/p/x#/review?mark")
    expect(stripFabParamsFromUrl("/p/x?mark#/r?a=1#x")).toBe("/p/x#/r?a=1#x") // the fragment starts at the FIRST '#'
    expect(stripFabParamsFromUrl("/p/x?mark#")).toBe("/p/x#") // an EMPTY fragment is the host's too
  })

  it("a flag sitting only in the fragment is not ours, so there is no rewrite at all", () => {
    // The old exit, and the accepted price of this round: someone who still appends to the tail of a
    // hash-routed URL gets nothing. That is why the printed exit is now a whole URL to copy (formatMarkUrl)
    // rather than a five-character suffix to transcribe.
    expect(stripFabParamsFromUrl("/p/x#/route?mark")).toBeNull()
    expect(stripFabParamsFromUrl("/p/x#/route?unmark")).toBeNull()
  })

  it("returns null when nothing of ours is there, so the caller skips replaceState entirely", () => {
    expect(stripFabParamsFromUrl("/p/x?a=1#/route")).toBeNull()
    expect(stripFabParamsFromUrl("/p/x")).toBeNull()
    expect(stripFabParamsFromUrl("/p/x?#/route")).toBeNull()
    expect(stripFabParamsFromUrl("/p/x?foo=mark")).toBeNull() // our word as a host VALUE
  })

  // `location.search` is "" for both "no query" and "an empty query", and `location.hash` is "" for both "no
  // fragment" and "an empty one" — so no rule reading a decomposed URL can be right about both members of
  // either pair; it can only enumerate one more shape per round. Both halves take the raw href, which is what
  // makes these shapes expressible at all.
  it("keeps a delimiter that was the page's own, and removes only one that was ours", () => {
    expect(stripFabParamsFromUrl("/p/x?&mark")).toBe("/p/x?") // the '?' was there before we appended
    expect(stripFabParamsFromUrl("/p/x?mark")).toBe("/p/x") // this one came with the flag
    expect(stripFabParamsFromUrl("/p/x?&mark#/r")).toBe("/p/x?#/r")
  })

  // Printer and stripper are ONE round trip and are tested as one — pinning each alone is what let the pair
  // drift for four rounds. A new URL shape is one line of data here, not a new expectation to get right.
  const SHAPES = [
    "/p/x",
    "/p/x?",
    "/p/x?foo=1",
    "/p/x#",
    "/p/x#/r",
    "/p/x#/r?",
    "/p/x#/r?a=1",
    "/p/x#/r?a=1#x", // a second '#'
    "/p/x?#",
    "/p/x?#/r",
    "/p/x?foo=1#",
    "/p/x?foo=1#/r?a=1"
  ]

  it("round-trips every shape: stripping what we print returns the page's own URL", () => {
    // No `new URL()` in this round trip. That rebuild reports `search === ""` for a page at `/p/x?` and
    // `hash === ""` for one at `/p/x#`, so it erases the very delimiters under test and would agree with a
    // stripper that is wrong about them.
    for (const shape of SHAPES) {
      const page = ORIGIN + shape
      expect(stripFabParamsFromUrl(formatMarkUrl(page)), `round trip of ${shape}`).toBe(page)
    }
  })

  it("leaves every one of those shapes alone when it carries nothing of ours", () => {
    // The other half of the property, and the one that catches a "fix" preserving delimiters by rewriting
    // URLs it should never have touched: an unflagged page must produce no rewrite whatsoever.
    for (const shape of SHAPES) {
      expect(stripFabParamsFromUrl(ORIGIN + shape), `no-op on ${shape}`).toBeNull()
    }
  })

  it("and what we print lands where the resolver actually looks", () => {
    // The half a strip-only property cannot see: the flag has to end up in `location.search`, which is the
    // one surface `resolveFabVisibility` reads. `new URL(...).search` here is not a normalization — it is
    // precisely what the browser will hand the boot read.
    for (const shape of SHAPES) {
      const search = new URL(formatMarkUrl(ORIGIN + shape)).search
      expect(resolveFabVisibility(search, "hidden-url", true), `rescue via ${shape}`).toEqual({
        visibility: "visible",
        persist: "visible"
      })
    }
  })

  it("rescues a page still carrying the flag a failed write left behind", () => {
    // The one situation in which the printed link is used on a URL that already has a flag: persistence
    // failed, `?unmark` stayed on purpose, and the restore link appends `mark` next to it.
    const page = `${ORIGIN}/p/x?foo=1&unmark#/r`
    const printed = formatMarkUrl(page)
    expect(printed).toBe(`${ORIGIN}/p/x?foo=1&unmark&mark#/r`)
    expect(resolveFabVisibility(new URL(printed).search, undefined, true).visibility).toBe("visible")
    // Both flags leave together on the pass that persists — the stale one has nothing left to record.
    expect(stripFabParamsFromUrl(printed)).toBe(`${ORIGIN}/p/x?foo=1#/r`)
  })
})

describe("a toast narrates ONE state of ONE session, so it expires when either does (Lane U, round 9)", () => {
  // Every toast here is fabToastFor(state, …) — it describes exactly one visibility. Deriving the visible
  // message from the current state means no restore path can forget to clear it: not the shortcut, not the
  // handle, not the restore link (which reloads the page outright), and not whichever path gets added next.
  it("shows the message only while the state it describes is still the current one", () => {
    const raised = { message: "已完全隐藏。网址后面加 ?mark 就能把按钮调回来", link: "https://h/p/x?mark", state: "hidden-url" as const, sessionId: "ses_1" }
    // Hands back what was captured, whole. The guard is about IDENTITY — does this still describe where the
    // user is — so the sentence, the link, and anything added later ride along without touching it.
    expect(activeFabToast(raised, "hidden-url", "ses_1")).toBe(raised)
    expect(activeFabToast(raised, "visible", "ses_1")).toBeNull()
    // A mid-session device degrade moves hidden-key → handle; the old exit is wrong there too.
    expect(activeFabToast({ message: "按 Option+M 恢复", state: "hidden-key", sessionId: "ses_1" }, "handle", "ses_1")).toBeNull()
  })

  it("retires when the SESSION changes under a mounted overlay, even at the identical state", () => {
    // An SPA can swap `sessionId` without unmounting. The new session resolves independently and can land
    // on the same state, so a state-only match kept the previous session's message alive — and for
    // `hidden-url` that message is a whole restore URL for the page the user just left, sitting there as
    // the only thing on screen. The identity is the SESSION: a host route change inside one session does
    // not invalidate the link, a session swap does.
    const raised = { message: "已完全隐藏。网址后面加 ?mark 就能把按钮调回来", link: "https://h/p/OLD?mark", state: "hidden-url" as const, sessionId: "ses_old" }
    expect(activeFabToast(raised, "hidden-url", "ses_new")).toBeNull()
    expect(activeFabToast(raised, "hidden-url", undefined)).toBeNull()
    // …and a session-less overlay (no sessionId at all) still matches itself.
    const sessionless = { ...raised, sessionId: undefined }
    expect(activeFabToast(sessionless, "hidden-url", undefined)).toBe(sessionless)
  })

  it("is null when nothing was raised", () => {
    expect(activeFabToast(null, "visible", "ses_1")).toBeNull()
    expect(activeFabToast(undefined, "hidden-url", "ses_1")).toBeNull()
  })

  // The dwell is a property of what the toast SAYS — and, for the one toast that carries an action, of how
  // long that action takes. Every other toast confirms a transition whose way back is still on the device and
  // wants out of the way; `hidden-url`'s is the only delivery of the only exit from the only state with
  // nothing on screen. It is sized to the gesture, and the gesture is now noticing a button and tapping it,
  // not dragging a text selection across a URL — so it sits above the shared baseline and far below the
  // fifteen seconds the select-by-hand round needed. Overshooting covers the page; undershooting strands the
  // user. That asymmetry is the whole justification for the gap, so the test states it as a RANGE rather than
  // freezing a preference: any value inside it is a legitimate tuning, either edge is a regression.
  it("gives the URL toast time to be tapped without parking a pill over the page", () => {
    const dwell = fabToastDurationMs("hidden-url")
    expect(dwell).toBeGreaterThan(3200) // 3.2s is notice-and-read; there has to be room left to act
    expect(dwell).toBeLessThanOrEqual(8000) // owner feedback: a long dwell blocks the view and is its own bug
    for (const state of ["visible", "handle", "hidden-key"] as const) {
      expect(fabToastDurationMs(state)).toBe(3200)
    }
  })

  // The copy button's whole job, minus the button. A Show Page opened over plain HTTP on a phone has no
  // `navigator.clipboard` at all, and a permissions policy can refuse the write on one that does — for the
  // ONE state with no other way back, so what happens then is the part worth pinning, not the happy path.
  it("reports whether the link actually reached the clipboard, and never throws when it did not", async () => {
    const written: string[] = []
    const ok = { writeText: async (text: string) => void written.push(text) }
    await expect(copyRestoreLink("https://h/p/x?mark", ok)).resolves.toBe(true)
    expect(written).toEqual(["https://h/p/x?mark"])

    // Insecure origin: the API is simply not there. `false`, not a crash — the caller leaves the printed
    // link up, which is the pre-button behavior and still a complete way out.
    await expect(copyRestoreLink("https://h/p/x?mark", undefined)).resolves.toBe(false)

    // Present but refused (permissions policy, or a document that is not focused).
    const refused = { writeText: async () => { throw new Error("NotAllowedError") } }
    await expect(copyRestoreLink("https://h/p/x?mark", refused)).resolves.toBe(false)

    // Some implementations throw synchronously rather than rejecting; a `false` either way is what lets the
    // caller have exactly one failure path instead of a try/catch AND a rejection handler.
    const throwsSync = { writeText: () => { throw new Error("boom") } } as unknown as { writeText(t: string): Promise<void> }
    await expect(copyRestoreLink("https://h/p/x?mark", throwsSync)).resolves.toBe(false)
  })

  // The boolean above only matters because these two dwells differ. A copy that lands ends the interaction; a
  // copy that does not hands back the manual selection the button existed to remove — the slower gesture, in
  // the state with no other exit — so it has to get MORE time than the tap-a-button dwell, not the remainder
  // of it. Stated as relations rather than as two numbers: it is the ordering that is the fix.
  it("re-times the toast around what is left to do, not around the tap", () => {
    const raised = fabToastDurationMs("hidden-url")
    expect(toastDwellMs("hidden-url", "failed")).toBeGreaterThan(raised * 2) // manual selection, from a standing start
    expect(toastDwellMs("hidden-url", "copied")).toBeLessThan(raised) // just long enough to read "已复制"
    expect(toastDwellMs("hidden-url", "copied")).toBeGreaterThan(0) // an instant vanish looks exactly like a timeout
    expect(toastDwellMs("hidden-url", "idle")).toBe(raised) // untouched, it keeps the dwell its message earned
  })

  // The failure this replaces: `writeText` stays unresolved for as long as a permission prompt is open, which
  // is unbounded and routinely longer than the resting dwell — so a clock that kept running underneath it
  // retired the toast mid-prompt, and the refusal then had nothing left to attach the manual-selection dwell
  // to. The user was left in `hidden-url` with no link and no control: the exact state the toast exists to
  // prevent, reachable by using the button as intended. A held-open toast cannot be timed out by anything.
  it("stops the clock entirely while a copy is in flight", () => {
    expect(toastDwellMs("hidden-url", "pending")).toBeNull()
    expect(toastDwellMs("handle", "pending")).toBeNull() // a property of the copy, not of the message
  })

  // Every state answers, and the answer depends only on (visibility, copy). That total-ness is the point of
  // deriving the dwell rather than arming it: there is no ordering of raises and settles that can leave the
  // toast without a deadline, or with two.
  it("gives one answer per state, so no two writers can disagree about the clock", () => {
    for (const visibility of ["visible", "handle", "hidden-key", "hidden-url"] as const) {
      for (const copy of ["idle", "pending", "copied", "failed"] as const) {
        const dwell = toastDwellMs(visibility, copy)
        expect(dwell === null || dwell > 0).toBe(true)
        expect(toastDwellMs(visibility, copy)).toBe(dwell)
      }
    }
  })

  // The button stays enabled while a copy is pending — deliberately, since a `writeText` that never settles
  // would otherwise lock the user out of the only exit `hidden-url` has — so two writes can be in flight and
  // settle in either order. "Newest tap wins" is symmetric; the outcomes are not. A success is a fact about
  // the CLIPBOARD and stays true however many taps followed it. A refusal is a fact about ONE attempt and
  // says nothing about the rest.
  it("lets a success speak even after a newer tap started, and keeps a stale refusal to itself", () => {
    expect(settledCopyState(true, true)).toBe("copied")
    expect(settledCopyState(true, false)).toBe("copied") // overtaken, but the link IS on the clipboard
    expect(settledCopyState(false, true)).toBe("failed")
    expect(settledCopyState(false, false)).toBeNull() // describes an attempt nobody is waiting on any more
  })

  // The other half of the same rule, on the receiving side: a write that succeeded cannot be undone by a
  // write that failed, because a failed `writeText` does not empty the clipboard. Terminal for the life of
  // ONE toast — a fresh raise starts from `idle` again, since it is a fresh link and a fresh clipboard claim.
  it("cannot un-copy a clipboard", () => {
    for (const next of ["idle", "pending", "copied", "failed"] as const) {
      expect(mergeCopyState("copied", next)).toBe("copied")
    }
    expect(mergeCopyState("idle", "pending")).toBe("pending")
    expect(mergeCopyState("pending", "failed")).toBe("failed")
    expect(mergeCopyState("failed", "pending")).toBe("pending") // a retry re-opens the clock
    expect(mergeCopyState("failed", "copied")).toBe("copied")
  })

  // The two rules replayed as the component composes them: tap, tap again, and let the writes settle in each
  // order. Before this, the loser's refusal was applied and the winner's success discarded, so the pill sat
  // on "请手动复制" for 15 seconds over a link the user already had — and the manual selection it asked for
  // was of a link that had scrolled away with the toast.
  it("ends on 已复制 whichever of two overlapping taps reaches the clipboard", () => {
    function overlappingTaps() {
      let attempts = 0
      let copy: ToastCopyState = "idle"
      const report = (next: ToastCopyState) => void (copy = mergeCopyState(copy, next))
      const tap = () => {
        const attempt = (attempts += 1)
        report("pending")
        return (ok: boolean) => {
          const next = settledCopyState(ok, attempt === attempts)
          if (next) report(next)
        }
      }
      return { tap, settled: () => copy }
    }

    // Reported case: the SECOND write rejects first, then the first one lands.
    const late = overlappingTaps()
    const first = late.tap()
    const second = late.tap()
    second(false)
    expect(late.settled()).toBe("failed")
    first(true)
    expect(late.settled()).toBe("copied")

    // Mirror: the newer tap lands and an older refusal arrives afterwards.
    const stale = overlappingTaps()
    const older = stale.tap()
    const newer = stale.tap()
    newer(true)
    older(false)
    expect(stale.settled()).toBe("copied")

    // Both taps refused: nothing reached the clipboard, so the manual-selection dwell is the right answer.
    const refused = overlappingTaps()
    const a = refused.tap()
    const b = refused.tap()
    a(false)
    b(false)
    expect(refused.settled()).toBe("failed")

    // Not an overlap at all — the ordinary "tap again to be sure" within the 900ms the pill is up. The retry
    // reports `pending`, which stops the clock, and can then be refused; neither may take the toast back off
    // a clipboard that already has the link.
    const retry = overlappingTaps()
    const landed = retry.tap()
    landed(true)
    expect(retry.settled()).toBe("copied")
    const again = retry.tap()
    expect(retry.settled()).toBe("copied") // `pending` would have held the toast open with no deadline
    again(false)
    expect(retry.settled()).toBe("copied")
  })
})
