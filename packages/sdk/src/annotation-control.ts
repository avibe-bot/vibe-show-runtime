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

/**
 * Whether a control event is LIVE (created at/after this page loaded) vs a replayed stale command
 * (owner ruling, round 2: control is live-only, never applied from replay — a page always boots with
 * annotation disabled and only a genuinely live command may enable it).
 *
 * Avibe is local-first: the agent/CLI that authors the event and the browser share one machine
 * clock, so comparing the event's ISO `createdAt` against the page-load ISO timestamp is reliable
 * (both are UTC `Z`, so lexicographic order is chronological). An event without a `createdAt` is
 * treated as NOT live (safer: never resurrect an ambiguous historical command).
 */
export function isLiveControlEvent(event: ShowEvent, pageLoadedAt: string): boolean {
  if (event.type !== "system.annotation.control") return false
  const createdAt = typeof event.createdAt === "string" ? event.createdAt : undefined
  return createdAt !== undefined && createdAt >= pageLoadedAt
}

/**
 * Whether a control replayed from the initial-events batch (authored at ISO `controlAt`) is
 * chronologically newer than the last intent already applied (`lastCommandAt`), and so should be
 * applied. `undefined lastCommandAt` = the controller is still pristine ⇒ apply. `undefined controlAt`
 * = an undated control ⇒ never apply (safer). This shared-clock ordering is what lets a genuinely-live
 * agent control created *after* a startup window/bridge command survive, while a stale batch control a
 * fresher command already superseded is dropped — the correct model a revision counter cannot express.
 */
export function isBatchControlNewer(controlAt: string | undefined, lastCommandAt: string | undefined): boolean {
  if (controlAt === undefined) return false
  return lastCommandAt === undefined || controlAt > lastCommandAt
}

/** The one intent that submits with no comment text — a one-tap approval. */
export const APPROVE_INTENT = "approve"

/**
 * Whether an annotation draft may be submitted: the `approve` intent is a zero-text fast path (an
 * empty comment is a valid one-tap approval), every other intent requires non-empty comment text.
 * Shared by the send button's disabled state and `submit()` so the gate can never drift between them.
 */
export function canSubmitAnnotation(intent: string, text: string): boolean {
  return intent === APPROVE_INTENT || text.trim().length > 0
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
  options: ShowClientOptions & { url?: string; mePath?: string } = {}
): Promise<AnnotationAuthAccess | undefined> {
  const fetchImpl = options.fetch ?? (typeof fetch !== "undefined" ? fetch : undefined)
  if (!fetchImpl) return undefined
  try {
    const response = await fetchImpl(options.url ?? showAnnotationMeUrl(options))
    if (!response.ok) return undefined
    const body = (await response.json()) as Partial<AnnotationAuthAccess>
    const canAnnotate = Boolean(body.canAnnotate)
    return {
      authenticated: Boolean(body.authenticated),
      canAnnotate,
      // Present iff canAnnotate (contract §5 v2); ignore a stray token on a no-write response.
      writeToken: canAnnotate && typeof body.writeToken === "string" ? body.writeToken : undefined
    }
  } catch {
    return undefined
  }
}

/**
 * Uniform overlay write-token resolution (contract §5 v2): `injected __AVIBE_SHOW__.writeToken ??
 * me.writeToken`. The injected token always wins; a probe with `canAnnotate:false` (or no token)
 * contributes nothing. Returned (not mutated onto a config) so the overlay can thread it through the
 * event client as React state — a custom-config mount must not rely on the global config fallback.
 */
export function resolveWriteToken(config: RuntimeConfig, access: AnnotationAuthAccess | undefined): string | undefined {
  return config.writeToken ?? (access?.canAnnotate ? access.writeToken : undefined)
}

export type AnnotationController = {
  readonly host: AnnotationHost
  readonly sessionId: string | undefined
  getState(): AnnotationControlState
  /**
   * ISO time of the most recent intent applied since creation — a local window/bridge command (stamped
   * when dispatched) or a control event (its `createdAt`) — or `undefined` if none. A consumer
   * replaying a low-priority control (e.g. the one carried in the initial-events fetch) applies it only
   * if its `createdAt` is newer than this ({@link isBatchControlNewer}); the shared-clock ordering that
   * a plain counter cannot provide, so a genuinely-live control created after a startup command still
   * lands while a stale batch control a fresher command superseded is skipped.
   */
  getLastCommandAt(): string | undefined
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
  /** Injectable clock for stamping local-command intent times (default: system clock). */
  now?: () => string
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
  const now = deps.now ?? (() => new Date().toISOString())
  // The USER's remembered mode preference, held IN MEMORY (seeded from storage) so it survives a
  // session with no storage too. Updated only on an explicit user mode selection, never by an agent
  // control event; `enable()` with no mode resolves through this, not the live `state.mode`.
  let rememberedMode = readStoredAnnotationMode(sessionId, storage) ?? DEFAULT_ANNOTATION_MODE

  let state: AnnotationControlState = {
    enabled: false,
    mode: rememberedMode,
    // Default to writable only when we can prove it: the server-known auth hint, else an injected
    // write token (private page). Absent both (e.g. an anonymous public viewer, or a scaffold that
    // dropped the annotation block), start gated off — the auth probe upgrades it if canAnnotate.
    available: deps.initialAvailable ?? config.annotation?.authenticated ?? Boolean(config.writeToken)
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

  // ISO time of the most recent intent applied since creation, used to chronologically order the
  // async initial-fetch control replay against any command that raced it (see
  // {@link AnnotationController.getLastCommandAt} and {@link isBatchControlNewer}).
  let lastCommandAt: string | undefined

  function dispatch(action: AnnotationControlAction, options: { fromControlEvent?: boolean; at?: string } = {}) {
    // Stamp WHEN this intent occurred so an in-flight initial-events fetch can order its replayed batch
    // control against it: a local window/bridge command is stamped `now()`; a control event carries its
    // own `createdAt` via `options.at`. (Local-first: the agent that authors events and this browser
    // share one wall clock, so the ISO strings are comparable.) Keep the MAX so an out-of-order apply
    // never rolls the high-water mark backwards.
    const at = options.at ?? now()
    if (lastCommandAt === undefined || at > lastCommandAt) lastCommandAt = at
    // Remember the mode on an explicit USER mode selection, keyed on the ACTION SOURCE — not a state
    // delta. A user picking the already-active (e.g. agent-set) mode is still an explicit choice and
    // must be remembered, else the next mode-less `enable()` reverts it (round 2 review). Agent
    // control events (`fromControlEvent`) never update it. Held in memory AND persisted best-effort,
    // so the preference survives both an agent's temporary `--mode X` and a storageless session.
    if (!options.fromControlEvent && (action.action === "set-mode" || action.action === "enable")) {
      if (action.mode !== undefined) {
        rememberedMode = action.mode
        writeStoredAnnotationMode(sessionId, action.mode, storage)
      }
    }
    // `enable()` with no mode resolves to the USER's remembered preference — NOT the live `state.mode`,
    // which an agent control event can have temporarily changed.
    const next = reduceAnnotationState(state, action, { rememberedMode })
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
    getLastCommandAt: () => lastCommandAt,
    subscribe: api.subscribe,
    enable: api.enable,
    disable: api.disable,
    setMode: api.setMode,
    dispatch,
    applyControlEvent(event) {
      const action = annotationControlActionFromEvent(event)
      // Order this control by its own createdAt (its logical time), not "now": a control replayed
      // from the initial batch must compare against commands using the moment it was authored.
      if (action) dispatch(action, { fromControlEvent: true, at: typeof event.createdAt === "string" ? event.createdAt : undefined })
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
  options: ShowClientOptions & { url?: string; mePath?: string } = {}
): Promise<AnnotationAuthAccess | undefined> {
  const access = await fetchAnnotationAccess(options)
  if (access) {
    controller.setAvailable(access.canAnnotate)
  }
  return access
}
