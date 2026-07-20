import { describe, expect, it, vi } from "vitest"
import {
  ANNOTATION_CONTROL_MESSAGE,
  ANNOTATION_QUERY_MESSAGE,
  ANNOTATION_STATE_MESSAGE,
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
  isAnnotationQueryMessage,
  reduceAnnotationState,
  readStoredAnnotationMode,
  writeStoredAnnotationMode,
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
})

describe("annotation controller", () => {
  it("initializes mode from storage and available from injected auth", () => {
    const storage = memoryStorage({ [annotationModeStorageKey("ses_1")]: "screenshot" })
    const config: RuntimeConfig = { sessionId: "ses_1", annotation: { authenticated: false } }
    const controller = createAnnotationController({ config, host: "standalone", storage })
    expect(controller.getState()).toEqual({ enabled: false, mode: "screenshot", available: false })
    expect(controller.host).toBe("standalone")
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

  it("persists mode memory on set-mode and across a fresh controller (reload)", () => {
    const storage = memoryStorage()
    const first = createAnnotationController({ config: { sessionId: "ses_1" }, storage })
    first.setMode("screenshot")
    expect(readStoredAnnotationMode("ses_1", storage)).toBe("screenshot")
    const second = createAnnotationController({ config: { sessionId: "ses_1" }, storage })
    expect(second.getState().mode).toBe("screenshot")
  })

  it("applies agent SSE control events", () => {
    const controller = createAnnotationController({ config: { sessionId: "ses_1" }, storage: null })
    controller.applyControlEvent({ type: "system.annotation.control", payload: { action: "enable", mode: "screenshot" } } as unknown as ShowEvent)
    expect(controller.getState()).toMatchObject({ enabled: true, mode: "screenshot" })
    controller.applyControlEvent({ type: "system.annotation.control", payload: { action: "disable" } } as unknown as ShowEvent)
    expect(controller.getState().enabled).toBe(false)
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
      dispatch: (data: unknown) => listener?.({ data } as MessageEvent),
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
})

describe("auth probe (contract §5)", () => {
  it("maps the me endpoint response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ authenticated: true, canAnnotate: true }) }) as unknown as Response)
    await expect(fetchAnnotationAccess({ url: "https://show.test/__show/me", fetch: fetchImpl })).resolves.toEqual({
      authenticated: true,
      canAnnotate: true
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
