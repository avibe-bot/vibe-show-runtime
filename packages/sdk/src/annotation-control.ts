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

export function safeLocalStorage(): AnnotationModeStorage | undefined {
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

// ── Standalone FAB visibility via URL QUERY PARAM (owner-frozen mark / unmark) ────────────
// Default: FAB visible. `?unmark` hides it, `?mark` shows it (bare-presence). A query param — NOT the
// hash — because the Show Page hash router owns `#/…` routes and a `#unmark` collided with it (404s).
// The param is a ONE-TIME switch: read at overlay boot, persisted per session, then stripped from the URL
// (history.replaceState) so the URL returns clean and a later param-free load honors the stored choice.
// Standalone host only; coexists with `?vibe-embed=1` (the embedded host ignores these entirely).
//
// Visibility is TRI-state (Lane U): `visible` (FAB/toolbar), `handle` (collapsed to the draggable edge
// grabber — a touch-created state) and `hidden` (nothing on screen). The URL vocabulary stays TWO words:
// `?mark` → visible, `?unmark` → hidden. `handle` is reachable only from the '?' popup on a touch device.
export const ANNOTATION_FAB_PARAM_SHOW = "mark"
export const ANNOTATION_FAB_PARAM_HIDE = "unmark"
export const ANNOTATION_FAB_VISIBLE_STORAGE_PREFIX = "avibe:fab-visible:"

/** What the standalone annotation chrome shows: the full FAB/toolbar, just the edge handle, or nothing. */
export type FabVisibility = "visible" | "handle" | "hidden"

const FAB_VISIBILITIES: readonly FabVisibility[] = ["visible", "handle", "hidden"]

export function fabVisibleStorageKey(sessionId: string | undefined): string {
  return `${ANNOTATION_FAB_VISIBLE_STORAGE_PREFIX}${sessionId ?? "default"}`
}

/**
 * The two segments of the current URL a `mark` / `unmark` flag can occupy. Taken as a pair because the user's
 * action is "append to the end of the address bar", and which segment that lands in depends on the page:
 * `location.search` normally, but `location.hash` the moment the page is on a `#/…` route. Structurally
 * satisfied by both `window.location` and `new URL(...)`, so callers hand over the real thing.
 */
export interface FabParamUrl {
  search?: string
  hash?: string
}

/**
 * Split a hash into the router's route and the hash's OWN query segment (everything after its first `?`).
 *
 * The split is positional, never a search for our word somewhere in the hash: `#/route?redirect=/a?mark` has
 * to keep parsing as a single `redirect` value — exactly as it already does on the search side — so that a
 * lenient scan can't invent a flag out of a host's parameter, or corrupt one on the way back out. Everything
 * left of the `?` belongs to the hash router and is never read or rewritten here.
 */
function splitHash(hash: string | undefined): { route: string; query: string } {
  const raw = (hash ?? "").replace(/^#/, "")
  const start = raw.indexOf("?")
  return start === -1 ? { route: raw, query: "" } : { route: raw.slice(0, start), query: raw.slice(start + 1) }
}

/** The flag a single query segment carries, if any. `unmark` outranks `mark` when both are present. */
function readFabFlag(query: string | undefined): FabVisibility | undefined {
  let params: URLSearchParams | undefined
  try {
    params = new URLSearchParams(query ?? "") // tolerates a leading "?" and a bare key (no value)
  } catch {
    return undefined
  }
  if (params.has(ANNOTATION_FAB_PARAM_HIDE)) return "hidden"
  if (params.has(ANNOTATION_FAB_PARAM_SHOW)) return "visible"
  return undefined
}

/**
 * Resolve the standalone chrome's visibility from the URL. Precedence: an explicit `unmark` / `mark` (bare
 * presence) WINS and dictates what to persist (`persist` = the state to write, so the switch survives a later
 * param-free load); else honor the stored state; else default visible (`persist: null` ⇒ write nothing).
 *
 * Read from BOTH the search and the hash's own query segment, because both are places the flag legitimately
 * lands: on a hash-routed page (`/p/x#/route`, the ordinary Show Page shape) `location.search` is empty and an
 * appended `?mark` becomes part of the hash. Looking in one place only would strand `hidden` — the single
 * state with neither an on-screen handle nor a guaranteed keyboard shortcut — on whichever shape wasn't
 * checked. Both segments go through the same `URLSearchParams` parse, so reading twice widens WHERE we look
 * without widening WHAT counts. The search wins when the two disagree: a fixed priority, pinned by a test,
 * rather than an accident of evaluation order.
 *
 * Pure; the caller reads `location`, persists, and strips the flag from whichever segment held it.
 */
export function resolveFabVisibility(
  url: FabParamUrl,
  stored: FabVisibility | undefined
): { visibility: FabVisibility; persist: FabVisibility | null } {
  const flag = readFabFlag(url.search) ?? readFabFlag(splitHash(url.hash).query)
  if (flag) return { visibility: flag, persist: flag }
  return { visibility: stored ?? "visible", persist: null }
}

/**
 * Read the persisted visibility, migrating the pre-tri-state BOOLEAN format under the same key.
 *
 * Legacy `"1"` → `visible`. Legacy `"0"` → whichever hidden flavor this surface can recover from:
 * `handle` when the primary input is touch (tap the grabber), `hidden` on a keyboard device (Option/Alt+M).
 * The migration is derived at READ time and never written back, so one synced profile opened on a phone and
 * on a laptop leaves each surface with a working recovery path instead of freezing the first reader's guess.
 */
export function readStoredFabVisibility(
  sessionId: string | undefined,
  touchPrimary: boolean,
  storage: AnnotationModeStorage | undefined = safeLocalStorage()
): FabVisibility | undefined {
  if (!storage) return undefined
  try {
    const value = storage.getItem(fabVisibleStorageKey(sessionId))
    if (FAB_VISIBILITIES.includes(value as FabVisibility)) return value as FabVisibility
    if (value === "1") return "visible"
    if (value === "0") return touchPrimary ? "handle" : "hidden"
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the visibility choice. Returns whether it was actually stored: `false` when no storage exists or
 * `setItem` throws (private-mode / quota). The caller uses this to decide whether the URL flag is now
 * durable enough to strip — if the write failed, `?mark` / `?unmark` must stay in the URL so a reload still
 * carries the intent.
 */
export function writeStoredFabVisibility(
  sessionId: string | undefined,
  visibility: FabVisibility,
  storage: AnnotationModeStorage | undefined = safeLocalStorage()
): boolean {
  if (!storage) return false
  try {
    storage.setItem(fabVisibleStorageKey(sessionId), visibility)
    return true
  } catch {
    // Best-effort — losing the visibility memory must never break the overlay.
    return false
  }
}

/** A state the '?' popup's hide rows can move to — never `visible`, which is what they move away from. */
export type FabHideTarget = Exclude<FabVisibility, "visible">

/**
 * The hide targets the '?' popup offers, in row order. Split by PRIMARY input, not touch capability: a
 * hybrid touchscreen laptop has a keyboard, so it gets the desktop treatment — one destructive row straight
 * to `hidden`, recoverable by the shortcut. Only a touch-primary device is offered the edge handle, because
 * there the handle is the ONLY recovery an unhidden URL can't provide.
 */
export function fabHideOptions(touchPrimary: boolean): FabHideTarget[] {
  return touchPrimary ? ["handle", "hidden"] : ["hidden"]
}

/**
 * Alt+M semantics over the tri-state: it toggles `visible` ⇄ `hidden`, and rescues `handle` back to
 * `visible` — a state a phone can create and a laptop can only recover from.
 */
export function toggleFabVisibilityByShortcut(current: FabVisibility): FabVisibility {
  return current === "visible" ? "hidden" : "visible"
}

/**
 * A `hidden` chrome must not outlive the keyboard that is its on-screen-free exit. Detach a keyboard or
 * trackpad mid-session and the primary pointer flips to touch: the shortcut we PROMISED in the hide row
 * stops existing, its document listener unbinds, and `hidden` renders nothing to tap — a screen with no way
 * back. Degrading to `handle` restores an exit the device can actually use.
 *
 * Keyed on the LOSS (had one, now doesn't), not on `!shortcut`: a touch-primary device never has a shortcut
 * and is still offered the full hide by {@link fabHideOptions}, so a plain state test would flip that
 * deliberate choice back on the very next render and make the row unusable exactly where it is offered.
 * Returns the state to move to, or `null` to stay put.
 */
export function fabVisibilityAfterShortcutLoss(
  current: FabVisibility,
  previousShortcut: string | undefined,
  nextShortcut: string | undefined
): FabVisibility | null {
  if (current !== "hidden") return null // `visible` and `handle` are both recoverable on screen
  return previousShortcut && !nextShortcut ? "handle" : null
}

/**
 * Remove ONLY the overlay's own `mark` / `unmark` flag from a raw `location.search`, leaving every other
 * parameter byte-for-byte intact. We split on `&` and drop the tokens whose KEY is ours, rather than
 * round-tripping through `URLSearchParams.toString()` — that round-trip re-encodes existing escapes and
 * rewrites bare flags (`?debug` → `?debug=`), mutating query strings the host app may read raw. Matches a
 * full key token only, so `?foo=mark` is untouched. Returns the search WITHOUT a leading "?" ("" if empty).
 */
export function stripFabParamsFromSearch(search: string | undefined): string {
  const raw = (search ?? "").replace(/^\?/, "")
  if (!raw) return ""
  return raw
    .split("&")
    .filter((pair) => {
      const key = pair.split("=")[0]
      return key !== ANNOTATION_FAB_PARAM_SHOW && key !== ANNOTATION_FAB_PARAM_HIDE
    })
    .join("&")
}

/**
 * The same strip, one segment over: remove our flag from the hash's own query while leaving the ROUTE and
 * every foreign key byte-for-byte intact. Returns the hash body WITHOUT a leading "#" ("" if empty).
 *
 * The strip has to reach wherever {@link resolveFabVisibility} reads, or the one-time switch stops being
 * one-time: an `unmark` left sitting in the hash outlives its load, and the `mark` the user appends next to
 * that same tail arrives to find the old flag still there. The query segment is handed to the search
 * stripper rather than re-implemented, so both sides drop exactly the same key tokens and re-encode nothing.
 * When there was nothing of ours to remove, the ORIGINAL string is handed back rather than a reassembled
 * one — the common case for a flag that arrived in the search — so a hash we have no business rewriting
 * cannot be perturbed by the round trip. Only when a token really is dropped is the hash rebuilt, and a
 * segment emptied by that drop loses its now-meaningless `?` with it.
 */
export function stripFabParamsFromHash(hash: string | undefined): string {
  const { route, query } = splitHash(hash)
  const rest = stripFabParamsFromSearch(query)
  if (rest === query) return (hash ?? "").replace(/^#/, "")
  return rest ? `${route}?${rest}` : route
}

// ── Standalone FAB visibility keyboard shortcut (Alt+M / ⌥M) ──────────────────────────────
// Alt+M toggles the FAB the same way ?mark/?unmark and the ✕ button do (standalone host only). Alt is the
// SOLE modifier. macOS Option+M emits key "µ" in some layouts, so we match the physical `code === "KeyM"`
// as well as the character — the residual µ-in-a-custom-editor collision is accepted by the owner and, as
// defense in depth, the toggle never fires while an editable element is focused.
export const ANNOTATION_FAB_SHORTCUT_KEY = "m"

/** Apple platforms print the Option key; every other keyboard prints Alt. */
const APPLE_PLATFORM_PATTERN = /mac|iphone|ipad|ipod/i

/**
 * The platform string, preferring the structured `navigator.userAgentData.platform` ("macOS", "Windows")
 * and falling back to the deprecated-but-universal `navigator.platform` ("MacIntel", "iPhone"). Never the
 * full UA string: that is the sniffing this helper exists to avoid.
 */
export function detectPlatformLabel(
  nav: { userAgentData?: { platform?: string }; platform?: string } | undefined = typeof navigator === "undefined"
    ? undefined
    : (navigator as { userAgentData?: { platform?: string }; platform?: string })
): string {
  return nav?.userAgentData?.platform || nav?.platform || ""
}

/**
 * How to NAME the FAB shortcut for this device — the single source for that string, so the modifier is
 * spelled once and every label interpolates it. `"Option+M"` on Apple platforms, `"Alt+M"` elsewhere, and
 * `undefined` on a touch-PRIMARY device: no keyboard means the clause is omitted, not reworded.
 */
export function formatFabShortcut(
  options: { platform?: string; touchPrimary?: boolean } = {}
): string | undefined {
  if (options.touchPrimary) return undefined
  const platform = options.platform ?? detectPlatformLabel()
  return APPLE_PLATFORM_PATTERN.test(platform) ? "Option+M" : "Alt+M"
}

/**
 * The exact URL fragment to APPEND to bring a fully hidden chrome back: `"?mark"` on a URL with no query
 * string, `"&mark"` on one that already has parameters. Same job as `formatFabShortcut` one axis over — that
 * one computes the exact key the user must press, this one the exact text they must paste; platform-derived
 * there, URL-derived here.
 *
 * Prescribing a bare `"?mark"` is a dead end on a page that already has a query string: the result is
 * `?foo=1?mark`, which `URLSearchParams` reads as a single `foo="1?mark"` — no `mark` key, so the stored
 * `hidden` survives the reload. That is the one hidden state with neither an edge handle nor a keyboard
 * shortcut, so its hint has to work on the URL the reader is actually looking at. Callers must read
 * `location` at DISPLAY time, not at mount: the boot strip rewrites it.
 *
 * Which separator is right is decided by the segment the user APPENDS TO — the end of the address bar. On a
 * hash-routed page that is the hash, not the search, and the two can disagree: `/p/x?foo=1#/route` has a
 * query string yet its tail has none, so the answer there is `?mark`, and reading `search` would hand out
 * `&mark` and produce `#/route&mark` — one more shape where the flag silently isn't a flag. Only when there
 * is no hash at all does the search decide.
 */
export function formatMarkParam(url: FabParamUrl): string {
  const hash = (url.hash ?? "").replace(/^#/, "")
  const search = (url.search ?? "").replace(/^\?/, "")
  const tailHasQuery = hash ? hash.includes("?") : search !== ""
  return `${tailHasQuery ? "&" : "?"}${ANNOTATION_FAB_PARAM_SHOW}`
}

/**
 * Compose an action label with its recovery clause: `base（clause）`, or bare `base` when there is none.
 * Keeps the platform copy ADDITIVE — a host that overrides only the base sentence still gets the clause its
 * device earned, instead of freezing one platform's wording into the override.
 */
export function withParenthetical(base: string, clause: string | undefined): string {
  return clause ? `${base}（${clause}）` : base
}

/** Whether an event target is a text-editable element (typing there must not trigger the shortcut). */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false
  const element = target as { tagName?: string; isContentEditable?: boolean }
  if (element.isContentEditable === true) return true // also true for descendants of a contenteditable
  const tag = (element.tagName ?? "").toUpperCase()
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}

/**
 * Whether a keydown should toggle FAB visibility: Alt+M (macOS ⌥M) with Alt as the ONLY modifier, matched
 * by character OR physical `code` (macOS ⌥M yields "µ"), not an auto-repeat, and focus not in an editable
 * element. Pure, so the modifier-exclusivity + editable-focus guard is unit-tested without a DOM.
 */
export function shouldToggleFabShortcut(
  event: { key: string; code?: string; altKey: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; repeat?: boolean },
  target: unknown
): boolean {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false // Alt is the ONLY modifier
  if (event.repeat) return false // holding the combo must not flip-flop visibility
  const matchesKey = (event.key ?? "").toLowerCase() === ANNOTATION_FAB_SHORTCUT_KEY || event.code === "KeyM"
  if (!matchesKey) return false
  return !isEditableTarget(target)
}

// ── Draggable edge-snapping floating chrome (FAB / agent badge) ──────────────────────────
export const ANNOTATION_FLOAT_POSITION_STORAGE_PREFIX = "avibe:float-pos:"
/** Movement (px) before a pointer gesture counts as a drag rather than a click. */
export const DRAG_ACTIVATION_THRESHOLD = 6

export type FloatPosition = { left: number; top: number }
/**
 * The PERSISTED placement of a draggable floating element: the snapped edge + a vertical offset — NOT an
 * absolute `left`. Storing the edge keeps a right-snapped element on the right across viewport resizes
 * and lets a wider variant (the expanded toolbar) reuse the same placement width-independently.
 */
export type FloatPlacement = { edge: "left" | "right"; top: number }

export function floatPositionStorageKey(element: string, sessionId: string | undefined): string {
  return `${ANNOTATION_FLOAT_POSITION_STORAGE_PREFIX}${element}:${sessionId ?? "default"}`
}

/** A pointer gesture is a DRAG once it moves past the threshold; below it, it's a click (open/toggle). */
export function exceedsDragThreshold(dx: number, dy: number, threshold: number = DRAG_ACTIVATION_THRESHOLD): boolean {
  return Math.hypot(dx, dy) >= threshold
}

/**
 * Snap a dragged floating element to the NEAREST vertical edge (left/right) at `inset`, keeping its
 * vertical position clamped within `[bounds.top, bounds.bottom]` (defaults to the inset margins). Edge
 * snapping keeps both elements off the bottom-center pill horizontally. Pure — no DOM.
 */
export function snapToNearestEdge(
  pos: FloatPosition,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  inset: number,
  bounds?: { top?: number; bottom?: number }
): FloatPosition & { edge: "left" | "right" } {
  const centerX = pos.left + size.width / 2
  const edge: "left" | "right" = centerX < viewport.width / 2 ? "left" : "right"
  const left = edge === "left" ? inset : Math.max(inset, viewport.width - size.width - inset)
  const minTop = bounds?.top ?? inset
  const maxTop = Math.max(minTop, (bounds?.bottom ?? viewport.height - inset) - size.height)
  const top = Math.min(maxTop, Math.max(minTop, pos.top))
  return { left, top, edge }
}

export function readStoredFloatPlacement(
  element: string,
  sessionId: string | undefined,
  storage: AnnotationModeStorage | undefined = safeLocalStorage()
): FloatPlacement | undefined {
  if (!storage) return undefined
  try {
    const raw = storage.getItem(floatPositionStorageKey(element, sessionId))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<FloatPlacement>
    return (parsed?.edge === "left" || parsed?.edge === "right") && typeof parsed?.top === "number"
      ? { edge: parsed.edge, top: parsed.top }
      : undefined
  } catch {
    return undefined
  }
}

export function writeStoredFloatPlacement(
  element: string,
  sessionId: string | undefined,
  placement: FloatPlacement,
  storage: AnnotationModeStorage | undefined = safeLocalStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(floatPositionStorageKey(element, sessionId), JSON.stringify(placement))
  } catch {
    // Best-effort — losing a saved placement must never break the overlay.
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
