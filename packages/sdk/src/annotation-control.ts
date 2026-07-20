/**
 * Annotation control plane (phase 1 contract §2/§3/§4).
 *
 * A single source of truth for `{ enabled, mode, available }` that four surfaces drive:
 *  - the `window` API attached at `__AVIBE_SHOW__.annotation.api` (§2),
 *  - the chat parent ↔ iframe `postMessage` protocol (§3),
 *  - the agent-driven `system.annotation.control` SSE event (§4),
 *  - and the in-page toolbar/FAB/pill (React overlay, which subscribes here).
 *
 * Everything here is framework-agnostic and dependency-injected so it can be unit tested without a
 * DOM. The React overlay and the runtime bootstrap wire these into the browser.
 */
import {
  readRuntimeConfig,
  showAnnotationMeUrl,
  type AnnotationAuthAccess,
  type AnnotationControlAction,
  type AnnotationControlState,
  type AnnotationMode,
  type AnnotationWindowApi,
  type RuntimeConfig,
  type ShowAnnotationControlPayload,
  type ShowClientOptions,
  type ShowEvent
} from "./index.js"

export const ANNOTATION_MODES = ["smart", "screenshot"] as const satisfies readonly AnnotationMode[]
export const DEFAULT_ANNOTATION_MODE: AnnotationMode = "smart"

/** `location.search` flag the chat shell appends to the Show Page iframe src (contract §6). */
export const ANNOTATION_EMBED_QUERY_PARAM = "vibe-embed"
/** `localStorage` key prefix for last-used mode memory (contract §2). */
export const ANNOTATION_MODE_STORAGE_PREFIX = "avibe:annotation-mode:"

/** postMessage `type` values for the same-origin chat host bridge (contract §3). */
export const ANNOTATION_CONTROL_MESSAGE = "avibe:annotation:control"
export const ANNOTATION_QUERY_MESSAGE = "avibe:annotation:query"
export const ANNOTATION_STATE_MESSAGE = "avibe:annotation:state"

/** Which host the overlay runs in: the chat iframe (`embedded`) or a direct/standalone tab. */
export type AnnotationHost = "embedded" | "standalone"

export function isAnnotationMode(value: unknown): value is AnnotationMode {
  return value === "smart" || value === "screenshot"
}

/**
 * Detect the host from a query string: `vibe-embed=1` ⇒ embedded chat iframe (no toolbar, mode
 * pill, postMessage-controlled), otherwise standalone (FAB → toolbar, full local control).
 */
export function detectAnnotationHost(search: string | undefined = globalThis.location?.search): AnnotationHost {
  const raw = search ?? ""
  const normalized = raw.startsWith("?") ? raw.slice(1) : raw
  const params = new URLSearchParams(normalized)
  return params.get(ANNOTATION_EMBED_QUERY_PARAM) === "1" ? "embedded" : "standalone"
}

export function annotationModeStorageKey(sessionId: string | undefined): string {
  return `${ANNOTATION_MODE_STORAGE_PREFIX}${sessionId ?? "default"}`
}

/** Minimal storage surface so tests can inject a fake without a `Storage` instance. */
export type AnnotationModeStorage = Pick<Storage, "getItem" | "setItem">

function safeLocalStorage(): AnnotationModeStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    // Accessing localStorage can throw (disabled cookies / sandboxed iframe); memory is best-effort.
    return undefined
  }
}

export function readStoredAnnotationMode(
  sessionId: string | undefined,
  storage: AnnotationModeStorage | undefined = safeLocalStorage()
): AnnotationMode | undefined {
  if (!storage) return undefined
  try {
    const value = storage.getItem(annotationModeStorageKey(sessionId))
    return isAnnotationMode(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function writeStoredAnnotationMode(
  sessionId: string | undefined,
  mode: AnnotationMode,
  storage: AnnotationModeStorage | undefined = safeLocalStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(annotationModeStorageKey(sessionId), mode)
  } catch {
    // Best-effort: storage may be unavailable or full. Losing mode memory must never break control.
  }
}

/**
 * Pure state transition. `enable` with no explicit mode falls back to the remembered mode, then the
 * current mode, then the default. `set-mode` never changes `enabled`; `available` is only ever
 * changed by the auth probe (see {@link createAnnotationController}).
 */
export function reduceAnnotationState(
  state: AnnotationControlState,
  action: AnnotationControlAction,
  context: { rememberedMode?: AnnotationMode } = {}
): AnnotationControlState {
  switch (action.action) {
    case "enable": {
      const mode = action.mode ?? context.rememberedMode ?? state.mode ?? DEFAULT_ANNOTATION_MODE
      return { ...state, enabled: true, mode }
    }
    case "disable":
      return { ...state, enabled: false }
    case "set-mode":
      return { ...state, mode: action.mode }
  }
}

export function annotationControlActionFromPayload(
  payload: ShowAnnotationControlPayload | undefined
): AnnotationControlAction | undefined {
  if (!payload) return undefined
  if (payload.action === "enable") {
    return { action: "enable", mode: isAnnotationMode(payload.mode) ? payload.mode : undefined }
  }
  if (payload.action === "disable") return { action: "disable" }
  if (payload.action === "set-mode" && isAnnotationMode(payload.mode)) {
    return { action: "set-mode", mode: payload.mode }
  }
  return undefined
}

/** Extract a control action from a `system.annotation.control` event, or `undefined` for others. */
export function annotationControlActionFromEvent(event: ShowEvent): AnnotationControlAction | undefined {
  if (event.type !== "system.annotation.control") return undefined
  return annotationControlActionFromPayload((event as { payload?: ShowAnnotationControlPayload }).payload)
}

export function annotationControlActionFromMessage(data: unknown): AnnotationControlAction | undefined {
  if (!data || typeof data !== "object") return undefined
  const message = data as { type?: unknown; action?: unknown; mode?: unknown }
  if (message.type !== ANNOTATION_CONTROL_MESSAGE) return undefined
  if (message.action === "enable") {
    return { action: "enable", mode: isAnnotationMode(message.mode) ? message.mode : undefined }
  }
  if (message.action === "disable") return { action: "disable" }
  if (message.action === "set-mode" && isAnnotationMode(message.mode)) {
    return { action: "set-mode", mode: message.mode }
  }
  return undefined
}

export function isAnnotationQueryMessage(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && (data as { type?: unknown }).type === ANNOTATION_QUERY_MESSAGE)
}

export type AnnotationStateMessage = { type: typeof ANNOTATION_STATE_MESSAGE } & AnnotationControlState

export function annotationStateMessage(state: AnnotationControlState): AnnotationStateMessage {
  return { type: ANNOTATION_STATE_MESSAGE, ...state }
}

/** Fetch the auth probe result, or `undefined` when the probe can't run / fails (kept non-fatal). */
export async function fetchAnnotationAccess(
  options: ShowClientOptions & { url?: string } = {}
): Promise<AnnotationAuthAccess | undefined> {
  const fetchImpl = options.fetch ?? (typeof fetch !== "undefined" ? fetch : undefined)
  if (!fetchImpl) return undefined
  try {
    const response = await fetchImpl(options.url ?? showAnnotationMeUrl(options))
    if (!response.ok) return undefined
    const body = (await response.json()) as Partial<AnnotationAuthAccess>
    return { authenticated: Boolean(body.authenticated), canAnnotate: Boolean(body.canAnnotate) }
  } catch {
    return undefined
  }
}

export type AnnotationController = {
  readonly host: AnnotationHost
  readonly sessionId: string | undefined
  getState(): AnnotationControlState
  subscribe(callback: (state: AnnotationControlState) => void): () => void
  enable(mode?: AnnotationMode): void
  disable(): void
  setMode(mode: AnnotationMode): void
  dispatch(action: AnnotationControlAction): void
  applyControlEvent(event: ShowEvent): void
  setAvailable(available: boolean): void
  /** The window API object (contract §2), shared by reference with `__AVIBE_SHOW__.annotation.api`. */
  api(): AnnotationWindowApi
}

export type AnnotationControllerDeps = {
  config?: RuntimeConfig
  host?: AnnotationHost
  /** Injected mode-memory storage. Pass `null` to disable; omit to use `localStorage`. */
  storage?: AnnotationModeStorage | null
  /** Initial `available` value; defaults to the injected `annotation.authenticated`, else `true`. */
  initialAvailable?: boolean
}

/**
 * Build the annotation controller. Holds `{ enabled, mode, available }`, notifies subscribers on
 * change, persists mode memory on every mode change, and exposes the window API (contract §2).
 */
export function createAnnotationController(deps: AnnotationControllerDeps = {}): AnnotationController {
  const config = deps.config ?? readRuntimeConfig()
  const sessionId = config.sessionId
  const host = deps.host ?? detectAnnotationHost()
  const storage = deps.storage === undefined ? safeLocalStorage() : deps.storage ?? undefined
  const rememberedMode = readStoredAnnotationMode(sessionId, storage) ?? DEFAULT_ANNOTATION_MODE

  let state: AnnotationControlState = {
    enabled: false,
    mode: rememberedMode,
    available: deps.initialAvailable ?? config.annotation?.authenticated ?? true
  }
  const subscribers = new Set<(state: AnnotationControlState) => void>()

  function emit() {
    for (const callback of subscribers) {
      try {
        callback(state)
      } catch {
        // A subscriber throwing must not corrupt control state or block other subscribers.
      }
    }
  }

  function set(next: AnnotationControlState) {
    if (next.enabled === state.enabled && next.mode === state.mode && next.available === state.available) {
      return
    }
    state = next
    emit()
  }

  function dispatch(action: AnnotationControlAction) {
    const next = reduceAnnotationState(state, action, { rememberedMode: state.mode })
    if (next.mode !== state.mode) {
      writeStoredAnnotationMode(sessionId, next.mode, storage)
    }
    set(next)
  }

  const api: AnnotationWindowApi = {
    enable: (mode) => dispatch({ action: "enable", mode }),
    disable: () => dispatch({ action: "disable" }),
    setMode: (mode) => dispatch({ action: "set-mode", mode }),
    getState: () => state,
    subscribe: (callback) => {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    }
  }

  return {
    host,
    sessionId,
    getState: () => state,
    subscribe: api.subscribe,
    enable: api.enable,
    disable: api.disable,
    setMode: api.setMode,
    dispatch,
    applyControlEvent(event) {
      const action = annotationControlActionFromEvent(event)
      if (action) dispatch(action)
    },
    setAvailable(available) {
      set({ ...state, available })
    },
    api: () => api
  }
}

/** A window-like object the embedded bridge listens on (subset of `Window`). */
export type AnnotationMessageTarget = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void
}

/** A target the iframe posts state up to (the chat parent frame). */
export type AnnotationBroadcastTarget = {
  postMessage(message: unknown, targetOrigin: string): void
}

/**
 * Attach the window control API to `__AVIBE_SHOW__.annotation.api` (contract §2), creating the
 * config object on the target global if the server didn't inject one (dev/standalone).
 */
export function attachAnnotationWindowApi(
  controller: AnnotationController,
  target: { __AVIBE_SHOW__?: RuntimeConfig } = globalThis as { __AVIBE_SHOW__?: RuntimeConfig }
): void {
  const config = (target.__AVIBE_SHOW__ ??= {})
  const annotation = (config.annotation ??= {})
  annotation.api = controller.api()
}

/**
 * Wire the same-origin chat host bridge (contract §3): apply `control`/`query` messages from the
 * parent, and broadcast `state` up on mount, on every state change, and in reply to a query.
 * Returns a cleanup function. Only meaningful in the embedded host.
 */
export function connectAnnotationHostBridge(
  controller: AnnotationController,
  options: {
    window?: AnnotationMessageTarget
    parent?: AnnotationBroadcastTarget
    /** targetOrigin for state broadcasts; defaults to the current origin (bridge is same-origin). */
    origin?: string
  } = {}
): () => void {
  const target = options.window ?? (typeof window !== "undefined" ? (window as AnnotationMessageTarget) : undefined)
  const parent = options.parent ?? (typeof window !== "undefined" ? window.parent : undefined)
  const origin = options.origin ?? (typeof location !== "undefined" ? location.origin : "*")

  const broadcast = () => {
    try {
      parent?.postMessage(annotationStateMessage(controller.getState()), origin)
    } catch {
      // A cross-origin or detached parent must not throw into the control path.
    }
  }
  const listener = (event: MessageEvent) => {
    // Same-origin bridge (contract §3): reject control/query messages from any other origin so a
    // foreign embedder that holds an iframe reference cannot toggle or probe annotation state.
    if (origin !== "*" && event.origin !== origin) {
      return
    }
    const action = annotationControlActionFromMessage(event.data)
    if (action) {
      controller.dispatch(action)
      return
    }
    if (isAnnotationQueryMessage(event.data)) {
      broadcast()
    }
  }

  target?.addEventListener("message", listener)
  const unsubscribe = controller.subscribe(() => broadcast())
  broadcast()

  return () => {
    target?.removeEventListener("message", listener)
    unsubscribe()
  }
}

/** Run the auth probe and reflect `canAnnotate` into the controller's `available` (contract §5). */
export async function probeAnnotationAccess(
  controller: AnnotationController,
  options: ShowClientOptions & { url?: string } = {}
): Promise<AnnotationAuthAccess | undefined> {
  const access = await fetchAnnotationAccess(options)
  if (access) {
    controller.setAvailable(access.canAnnotate)
  }
  return access
}
