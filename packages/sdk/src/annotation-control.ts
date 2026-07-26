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

// ── Standalone FAB visibility via URL QUERY PARAM (mark / unmark) ─────────────────────────
//
// ┌─ THE INVARIANT THIS SECTION EXISTS UNDER (owner ruling, 2026-07-26) ──────────────────────────────┐
// │ 标注控制面对宿主页面必须是隐形的：不把宿主的路由状态当输入读、不改写它、不派发导航事件。          │
// │ 我们唯一拥有的网址表面，是 Show Page 网址自己的 query string。                                    │
// │                                                                                                   │
// │ The annotation control plane must be INVISIBLE to the host page: it does not read the host's       │
// │ routing state as input, does not rewrite it, and does not dispatch navigation events. The only URL │
// │ surface we own is the Show Page URL's own query string.                                           │
// └───────────────────────────────────────────────────────────────────────────────────────────────────┘
//
// Everything after `#` is the host router's territory — the fragment is where an SPA keeps its route, and
// a route is not ours to parse, to claim a word inside, or to rewrite. Earlier rounds of this branch did
// all three: they read a flag out of `#/route?…`, stripped it back out, and then hand-dispatched
// `popstate`/`hashchange` because `replaceState` fires neither and the host's router would otherwise serve
// a URL we had already changed. That last step is the tell — code that hand-drives someone else's router
// is not a compatibility measure, it is a second author of the host's navigation. All of it is gone.
//
// Default: FAB visible. `?unmark` hides it, `?mark` shows it — read from `location.search` and nowhere
// else. The flag is a ONE-TIME switch: read at overlay BOOT, persisted per session, then stripped from the
// search via `history.replaceState` (the fragment passes through byte-for-byte) so the URL returns clean and
// a later flag-free load honors the stored choice. Standalone host only; coexists with `?vibe-embed=1`
// (the embedded host ignores these entirely).
//
// The words are bare `mark` / `unmark` and stay that way: they are typed by humans into an address bar, so
// the shortest thing that works is the right thing. Round 14 namespaced them to `vibe-mark`/`vibe-unmark`
// to make a generic word safe to claim inside the host's fragment; that safety is now bought by not being
// in the fragment at all, which is cheaper and total. In our OWN query string, `mark` is ours by the same
// prior reservation that `vibe-embed` sits on.
//
// The price, accepted explicitly by the owner: on a hash-routed page (`/p/x#/route`, the ordinary Show Page
// shape) a user who appends `?mark` to the END of the address bar lands in the fragment, where we no longer
// look — so that append does nothing and they cannot recover that way. There is no compensating mechanism
// and there must not be one; every mechanism that made the tail-append work is what this section deleted.
// Instead, the moment a user hides the chrome we hand them the WHOLE restore URL with the flag in its real
// query position (`/p/x?mark#/route`) — see {@link formatMarkUrl}. People copy links; they do not
// transcribe suffixes, and asking them to was what put us in the host's fragment in the first place.
//
// Visibility (Lane U) records TWO things in one value: what is on screen, and — when nothing is — WHICH
// exit the user was told about. `visible` (FAB/toolbar) and `handle` (collapsed to the draggable edge
// grabber) are their own exit: they are on screen, so the way back is visible. The two hidden flavors show
// nothing, so their exit lives outside the page and the state has to carry which one was promised:
// `hidden-key` (the shortcut named in the hide row) and `hidden-url` (the link named in it).
//
// Folding the exit into the state is the whole point. A hidden chrome whose promised exit doesn't exist on
// this device is a screen with no way back, and the promise used to live only in a toast that expires in a
// few seconds. Now the state names it, so the two can't drift apart. See {@link fabVisibilityForDevice}.
export const ANNOTATION_FAB_PARAM_SHOW = "mark"
export const ANNOTATION_FAB_PARAM_HIDE = "unmark"
export const ANNOTATION_FAB_VISIBLE_STORAGE_PREFIX = "avibe:fab-visible:"

/**
 * What the standalone annotation chrome shows — and, when it shows nothing, which exit the user was told
 * about. The two hidden flavors render IDENTICALLY (nothing); they differ only in the way back they promise.
 */
export type FabVisibility = "visible" | "handle" | "hidden-key" | "hidden-url"

const FAB_VISIBILITIES: readonly FabVisibility[] = ["visible", "handle", "hidden-key", "hidden-url"]

/**
 * The states that put nothing on screen. The single predicate every renderer branches on, so a new hidden
 * flavor can never be half-handled: the difference between the two is the exit they promise, never pixels.
 */
export function isFabHidden(visibility: FabVisibility): boolean {
  return visibility === "hidden-key" || visibility === "hidden-url"
}

export function fabVisibleStorageKey(sessionId: string | undefined): string {
  return `${ANNOTATION_FAB_VISIBLE_STORAGE_PREFIX}${sessionId ?? "default"}`
}

/**
 * Where a raw href stops being ours and starts being the host router's: the fragment, in `location.hash`
 * form (leading `#` included), or `undefined` when the href has no fragment at all.
 *
 * This is the boundary function for the whole section. Everything to the LEFT of what it returns is the Show
 * Page URL we own and may read and rewrite; everything from the `#` onward is opaque — carried through
 * untouched by {@link stripFabParamsFromUrl}, never parsed, never searched for our word.
 *
 * The FIRST `#` is the anchor, because that is where the URL spec puts the fragment and therefore where the
 * host's router starts reading. Taking the last one would let a `#` inside a route pull our boundary to the
 * right and put part of the host's fragment inside the string we rewrite.
 */
function hrefFragment(href: string): string | undefined {
  const start = href.indexOf("#")
  return start === -1 ? undefined : href.slice(start)
}

/**
 * Is this `key=value` pair one of ours?
 *
 * Matches the full KEY only, so `?foo=mark` — a parameter whose VALUE happens to be our word — is left
 * alone. Only ever asked about `location.search`, which is the Show Page's own query string; the host's
 * fragment is not parsed at all, so there is no second, stricter reading of this question any more. Round 8
 * needed one (`bareOnly`, tolerant in the search and bare-presence-only in the hash) and round 14 removed it
 * by namespacing both; the invariant removes the seam itself — one concept, one segment, one rule.
 *
 * Tolerant rather than bare-only: {@link formatMarkUrl} only ever prints the bare form, but someone writing
 * `?mark=1` by hand — the shape a flag takes for most people — means the flag, and a bare-only rule would
 * ignore it while leaving it sitting in the address bar forever.
 */
function isFabParamPair(pair: string): boolean {
  const eq = pair.indexOf("=")
  const key = eq === -1 ? pair : pair.slice(0, eq)
  return key === ANNOTATION_FAB_PARAM_SHOW || key === ANNOTATION_FAB_PARAM_HIDE
}

/** Our flag keys in a `location.search`, in the order written, WITH repeats. */
function fabFlagKeys(query: string | undefined): string[] {
  const raw = (query ?? "").replace(/^\?/, "")
  if (!raw) return []
  return raw
    .split("&")
    .filter((pair) => isFabParamPair(pair))
    .map((pair) => pair.split("=")[0])
}

/**
 * The flag a search carries, if any. When BOTH are present the RESCUE wins.
 *
 * That precedence is the opposite of what it was, and deliberately so. Both flags coexist in exactly one
 * situation: the persistence write failed, so we left `?unmark` in the URL as the reload fallback, and the
 * user then opened the restore link, which carries `mark`. If `unmark` still outranked it, the advertised way
 * back would be unreachable for the one state whose entire promise is that its exit always works — this PR's
 * own defect, re-entered through the back door. Being wrongly visible costs a second hide; being wrongly
 * hidden with your rescue outranked is the blank screen we exist to prevent.
 *
 * Presence is the whole of the question, so it takes a SET — a second `mark` does not out-vote a first.
 */
function readFabFlag(flags: Set<string>): FabVisibility | undefined {
  if (flags.has(ANNOTATION_FAB_PARAM_SHOW)) return "visible"
  // `?unmark` → `hidden-url`, never `hidden-key`: whoever typed this flag already holds the URL vocabulary,
  // so the URL is demonstrably an exit they can use — and unlike the shortcut it works on every device.
  if (flags.has(ANNOTATION_FAB_PARAM_HIDE)) return "hidden-url"
  return undefined
}

/**
 * The status message that is still TRUE. Every toast this chrome raises is `fabToastFor(state, …)` — it
 * narrates exactly one visibility and the way out of it — so the instant the visibility moves on, the
 * message is describing somewhere the user no longer is. Deriving it from the current state rather than
 * clearing it at each restore site means no path can forget: not the shortcut, not the edge handle, not the
 * restore link (which reloads the page, so no handler here runs at all), and not whichever path is added next.
 */
export function activeFabToast(
  toast: { message: string; state: FabVisibility } | null | undefined,
  current: FabVisibility
): string | null {
  return toast && toast.state === current ? toast.message : null
}

/**
 * How long a state's toast stays on screen — a property of WHAT IT SAYS, not one number for all of them.
 *
 * Every other toast confirms a transition whose way back is still on the device (a key to press, a strip to
 * tap); it is read once and wants to get out of the way. The `hidden-url` toast is the only delivery of the
 * only exit from the only state with nothing on screen, and since this round it carries a whole URL rather
 * than a five-character suffix — something to select and copy, not to memorize. On the old 3.2s it would
 * hand the user their way back and take it away before they could use it.
 *
 * It still expires, which is a bounded race rather than a guarantee, and that is deliberate: a toast that
 * waited for a dismissal would need a document-level listener to hear one, and this control plane's whole
 * invariant is that it attaches nothing to the host it does not have to. A dwell needs no listener.
 */
export function fabToastDurationMs(visibility: FabVisibility): number {
  return visibility === "hidden-url" ? 15000 : 3200
}

/**
 * Resolve the standalone chrome's visibility from `location.search` — the Show Page's own query string, and
 * the only URL surface this control plane reads. Precedence: an explicit `unmark` / `mark` WINS and dictates
 * what to persist (`persist` = the state to write, so the switch survives a later flag-free load); else honor
 * the stored state; else default visible (`persist: null` ⇒ write nothing).
 *
 * `available` — can THIS viewer annotate — gates the whole flag path, and it lives here rather than as a
 * guard at the call site because `persist` is the reason it matters. Annotation is an author's tool: a public
 * Show Page renders no chrome for an anonymous visitor at all. But the storage key is
 * {@link fabVisibleStorageKey}, keyed by session with no viewer identity in it, so an anonymous visitor
 * opening a shared `?unmark` link on a shared browser used to WRITE `hidden-url` under the author's own key —
 * and the author would come back to a page whose chrome was gone with no memory of hiding it. Someone else's
 * click changing the author's state is the failure; it is not the annotation feature merely misbehaving for
 * the clicker.
 *
 * Returning the stored value with `persist: null` is what makes that one decision cover all three behaviors:
 * the flag is not adopted, not persisted, and — because the caller strips only when there is something to
 * persist — not removed from the URL either. Leaving it in the URL is the load-bearing half. `available`
 * starts from the config's guess and is flipped by an auth probe a moment later, so the author's own first
 * paint can be "not available yet"; the flag has to still be sitting there when the answer arrives. The
 * caller re-resolves on that transition and the flag is honored then — exactly once, because that pass is
 * the one that finally strips it.
 *
 * Pure; the caller reads `location`, persists, and strips.
 */
export function resolveFabVisibility(
  search: string | undefined,
  stored: FabVisibility | undefined,
  available: boolean
): { visibility: FabVisibility; persist: FabVisibility | null } {
  const flag = available ? readFabFlag(new Set(fabFlagKeys(search))) : undefined
  if (flag) return { visibility: flag, persist: flag }
  return { visibility: stored ?? "visible", persist: null }
}

/**
 * Read the persisted visibility, migrating every earlier vocabulary under the same key toward an exit THIS
 * surface can actually use.
 *
 * Legacy `"1"` → `visible`. Legacy `"0"` → the hidden flavor this surface can recover from: `handle` when
 * the primary input is touch (tap the grabber), `hidden-key` on a keyboard device (Option/Alt+M). Legacy
 * `"hidden"` (written by early builds of this branch, before the flavor split) → `hidden-key`: the exit it
 * was told is unknowable, so we take the conservative branch, because `hidden-key` is the one that
 * {@link fabVisibilityForDevice} will rescue on a keyboardless device. Undoing one unreleased build's state
 * beats leaving somebody on a blank screen.
 *
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
    if (value === "0") return touchPrimary ? "handle" : "hidden-key"
    if (value === "hidden") return "hidden-key" // pre-split builds of this branch; see the doc comment
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
 * The hide targets the '?' popup offers, in row order — each one named for the exit it promises, so the row
 * the user reads and the state it produces cannot drift apart.
 *
 * Split by PRIMARY input, not touch capability: a hybrid touchscreen laptop has a keyboard, so it gets the
 * desktop treatment — one row straight to `hidden-key`, recoverable by the shortcut. A touch-primary device
 * has no keyboard, so its full hide is `hidden-url`, whose exit works everywhere; it also gets the edge
 * handle, the only recovery that costs a single tap.
 */
export function fabHideOptions(touchPrimary: boolean): FabHideTarget[] {
  return touchPrimary ? ["handle", "hidden-url"] : ["hidden-key"]
}

/**
 * Alt+M semantics: it toggles `visible` ⇄ hidden, and rescues either non-visible state back to `visible` —
 * `handle` is a state a phone can create and a laptop can only recover from. Hiding VIA the shortcut records
 * `hidden-key`, because pressing it is proof the user has the keyboard we are about to name as the exit.
 */
export function toggleFabVisibilityByShortcut(current: FabVisibility): FabVisibility {
  return current === "visible" ? "hidden-key" : "visible"
}

/**
 * Reconcile a stored/current visibility with what THIS device can do — the single rule behind both the boot
 * read and a keyboard detaching mid-session, since the state now names its own exit and no before/after
 * comparison is needed to tell the two hides apart.
 *
 * `hidden-key` promises a shortcut. On a touch-primary device that shortcut does not exist and its document
 * listener never binds, so the state would render nothing with no way back: degrade to `handle`, an exit the
 * device can use. `hidden-url` is NEVER degraded — its exit is a fragment the reader types into the address
 * bar, which does not depend on the device, so a touch user's deliberate full hide is never quietly undone.
 * That is precisely what makes offering the full hide on touch safe. `visible` and `handle` are on screen
 * and are their own exit. Returns the state to be in — same value when nothing needs to change.
 */
export function fabVisibilityForDevice(visibility: FabVisibility, shortcutAvailable: boolean): FabVisibility {
  return visibility === "hidden-key" && !shortcutAvailable ? "handle" : visibility
}

/**
 * Remove ONLY the overlay's own `mark` / `unmark` flag from a raw `location.search`, leaving every
 * other parameter byte-for-byte intact. We split on `&` and drop the tokens whose KEY is ours, rather than
 * round-tripping through `URLSearchParams.toString()` — that round-trip re-encodes existing escapes and
 * rewrites bare flags (`?debug` → `?debug=`), mutating query strings the host app may read raw. Matches a
 * full key token only, so `?foo=mark` is untouched. Returns the search WITHOUT a leading "?" ("" if
 * empty).
 *
 * Strips exactly what {@link isFabParamPair} recognizes, and shares the predicate to say so: a reader and a
 * stripper that disagree about which pairs are ours are worse than either rule alone.
 */
export function stripFabParamsFromSearch(search: string | undefined): string {
  const raw = (search ?? "").replace(/^\?/, "")
  if (!raw) return ""
  return raw
    .split("&")
    .filter((pair) => !isFabParamPair(pair))
    .join("&")
}

/**
 * Did this segment still have a query after the strip — INCLUDING an empty one?
 *
 * The delimiter and its contents are two different facts, and only the second one survives a join: `?` and
 * `?mark` both strip to `""`, but the first page owned a `?` before we arrived and the second did not.
 * Callers that reconstruct from truthiness collapse them and hand the host back a URL it never had. That is
 * the same distinction {@link formatMarkUrl} makes on the way in — an empty query is not the absence of one,
 * so it prints `&mark` for a URL ending in `?`: this is that append, read back off.
 *
 * Shares {@link isFabParamPair} with the strip itself, so the two cannot disagree about which pairs were ours.
 */
function keepsQueryDelimiter(query: string | undefined): boolean {
  const raw = (query ?? "").replace(/^\?/, "")
  if (!raw) return false
  return raw.split("&").some((pair) => !isFabParamPair(pair))
}

/**
 * The URL to hand `replaceState` after removing our flag — or `null` when the href holds nothing of ours and
 * must not be rewritten at all.
 *
 * **The fragment is not touched.** It is sliced off at the first `#`, held aside, and concatenated back
 * verbatim; nothing between here and the return value can parse it, rewrite it, or normalize it. That is the
 * section invariant expressed as code rather than as a promise: the host's route is byte-for-byte identical
 * on both sides of this function because the only thing that ever happens to it is a string concatenation.
 * The previous version cleaned the fragment too, and the discipline required to leave a host's route
 * undisturbed while rewriting the query hanging off it took four review rounds and never fully arrived.
 *
 * The `null` return is the other load-bearing part: it lets the caller distinguish "already clean" from
 * "cleaned to the same string", so an untouched URL never reaches `replaceState` at all. It is decided by
 * comparing the stripped search against the raw one — earlier than a whole-href comparison and stronger,
 * because it cannot be satisfied by a rewrite that happens to reproduce its input.
 *
 * It takes the RAW HREF rather than `{pathname, search, hash}` because `location.search` is `""` for both
 * "no query" and "an empty query", and `location.hash` is `""` for both "no fragment" and "an empty one" —
 * so a decomposed input cannot distinguish `/p/x?#/route` from `/p/x#/route`, and this function's whole job
 * is to hand back THE PAGE'S OWN URL rather than a normalized guess at it. An href loses nothing, so the
 * rule below is total, and printer and stripper read the one source — which is what the round-trip property
 * rests on.
 *
 * Everything left of the first `?` is copied through untouched, so an absolute href stays absolute and a
 * path-relative one stays relative; this function has no opinion about the origin.
 *
 *   no `?` at all             → nothing of ours can be here
 *   nothing of ours was there → `null`, do not rewrite
 *   we removed something      → {@link keepsQueryDelimiter} decides whether the `?` was ours to remove too
 */
export function stripFabParamsFromUrl(href: string): string | null {
  const fragment = hrefFragment(href)
  const head = fragment === undefined ? href : href.slice(0, href.length - fragment.length)
  const cut = head.indexOf("?")
  if (cut === -1) return null
  const search = head.slice(cut + 1)
  const stripped = stripFabParamsFromSearch(search)
  if (stripped === search) return null
  const nextSearch = keepsQueryDelimiter(search) ? `?${stripped}` : ""
  return `${head.slice(0, cut)}${nextSearch}${fragment ?? ""}`
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
 * The WHOLE URL that brings a fully hidden chrome back — the page's own href with our flag added to its
 * search, e.g. `/p/x` → `/p/x?mark` and `/p/x?foo=1#/route` → `/p/x?foo=1&mark#/route`.
 *
 * It hands over a complete link rather than the suffix to type, and that is the correction rather than a
 * nicety. The suffix form asked the reader to append to the END of the address bar, which on a hash-routed
 * page is inside the host's route — so the printed instruction only worked if we then went looking for our
 * word in the host's fragment, which is precisely what we are no longer allowed to do. A full URL puts the
 * flag where it belongs and asks nothing of the reader but a copy. People copy links; they do not transcribe
 * suffixes, and asking them to was what put us in the host's fragment in the first place.
 *
 * The accepted price: a user who ignores the link and appends `?mark` to a hash-routed URL by hand lands the
 * word inside the fragment, where nothing reads it, and does not get the chrome back. There is no
 * compensating mechanism and there must not be one — reaching into the fragment to rescue that user is the
 * exact behavior the invariant at the top of this section forbids.
 *
 * The fragment is sliced off and concatenated back verbatim, so this is the printer half of the same
 * byte-for-byte guarantee {@link stripFabParamsFromUrl} makes on the way out. It takes the RAW HREF for the
 * same reason that one does: `location.search` cannot tell `/p/x?#/route` from `/p/x#/route`, and the two
 * need different separators. One rule covers every shape there is — `&` if there is already a `?` to the
 * left of the fragment, `?` otherwise — and the round-trip property over the shape matrix is what keeps
 * printer and stripper from disagreeing.
 */
export function formatMarkUrl(href: string): string {
  const fragment = hrefFragment(href)
  const head = fragment === undefined ? href : href.slice(0, href.length - fragment.length)
  const sep = head.includes("?") ? "&" : "?"
  return `${head}${sep}${ANNOTATION_FAB_PARAM_SHOW}${fragment ?? ""}`
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
  /**
   * Initial `available` value; defaults to the injected `annotation.authenticated`, else to whether a write
   * token was injected — NOT to `true`. An anonymous viewer starts gated off and is upgraded by the auth probe.
   */
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
