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
// Visibility (Lane U) records TWO things in one value: what is on screen, and — when nothing is — WHICH
// exit the user was told about. `visible` (FAB/toolbar) and `handle` (collapsed to the draggable edge
// grabber) are their own exit: they are on screen, so the way back is visible. The two hidden flavors show
// nothing, so their exit lives outside the page and the state has to carry which one was promised:
// `hidden-key` (the shortcut named in the hide row) and `hidden-url` (the `?mark` fragment named in it).
//
// Folding the exit into the state is the whole point. A hidden chrome whose promised exit doesn't exist on
// this device is a screen with no way back, and the promise used to live only in a toast that expires in a
// few seconds. Now the state names it, so the two can't drift apart. See {@link fabVisibilityForDevice}.
//
// The URL vocabulary stays TWO words: `?mark` → visible, `?unmark` → hidden-url.
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
 *
 * `hasQuery` is reported separately from `query` because an empty query is not the absence of one:
 * `#/route?` already carries the `?` that decides the next separator. Reader and writer share this one split
 * precisely so they cannot answer that question differently — see {@link formatMarkParam}.
 */
function splitHash(hash: string | undefined): { route: string; query: string; hasQuery: boolean } {
  const raw = (hash ?? "").replace(/^#/, "")
  const start = raw.indexOf("?")
  if (start === -1) return { route: raw, query: "", hasQuery: false }
  return { route: raw.slice(0, start), query: raw.slice(start + 1), hasQuery: true }
}

/**
 * The fragment of a raw href in `location.hash` form — leading `#` included — or `undefined` when the href has
 * no fragment at all.
 *
 * The FIRST `#` is the anchor, because that is where the URL spec puts the fragment and therefore where the
 * reader's parser starts. On `#/route?a=1#x` the last `#` would name a different string, one with no `?` in
 * it, and the two answers diverge: we would print `?mark`, the reader would split at the fragment's first `?`
 * and hand `URLSearchParams` the value `1#x?mark` — a single `a` key, no flag.
 */
function hrefFragment(href: string): string | undefined {
  const start = href.indexOf("#")
  return start === -1 ? undefined : href.slice(start)
}

/**
 * Is this `key=value` pair one of ours?
 *
 * `bareOnly` is the difference between a namespace we own and one we borrow. In `location.search` the two
 * names have been reserved since before the flavor split, so any shape counts. In the HASH they have not:
 * that segment belongs to the host's router, and `#/review?mark=42` is a route carrying a row id, not our
 * switch. `URLSearchParams.has()` cannot tell those apart, so hash recognition is by BARE presence — which
 * is all the recovery flow ever produces (`formatMarkParam` emits `?mark` / `&mark`, and the printed copy
 * says exactly that). The asymmetry tracks ownership, not tidiness: claim the least in someone else's space.
 */
function isFabParamPair(pair: string, bareOnly: boolean): boolean {
  const eq = pair.indexOf("=")
  const key = eq === -1 ? pair : pair.slice(0, eq)
  if (key !== ANNOTATION_FAB_PARAM_SHOW && key !== ANNOTATION_FAB_PARAM_HIDE) return false
  return bareOnly ? eq === -1 || eq === pair.length - 1 : true // "mark" / "mark=" are bare; "mark=42" is not
}

/** Which of our flags a single query segment carries, deduped, in no particular order. */
function presentFabFlags(query: string | undefined, bareOnly: boolean): Set<string> {
  const raw = (query ?? "").replace(/^\?/, "")
  const found = new Set<string>()
  if (!raw) return found
  for (const pair of raw.split("&")) {
    if (isFabParamPair(pair, bareOnly)) found.add(pair.split("=")[0])
  }
  return found
}

/**
 * Every flag this URL carries, across BOTH segments one can legitimately land in — the search (tolerant, the
 * names were ours before the flavor split) and the hash's own query (bare presence only, because that segment
 * belongs to the host's router). One set, so nothing downstream has to know there were ever two places.
 */
function urlFabFlags(url: FabParamUrl): Set<string> {
  const flags = presentFabFlags(url.search, false)
  for (const flag of presentFabFlags(splitHash(url.hash).query, true)) flags.add(flag)
  return flags
}

/**
 * The flag a set carries, if any. When BOTH are present the RESCUE wins.
 *
 * That precedence is the opposite of what it was, and deliberately so. Both flags coexist in exactly one
 * situation: the persistence write failed, so we left `?unmark` in the URL as the reload fallback, and the
 * user then followed the printed exit and appended `mark`. If `unmark` still outranked it, the advertised way
 * back would be unreachable for the one state whose entire promise is that its exit always works — this PR's
 * own defect, re-entered through the back door. Being wrongly visible costs a second hide; being wrongly
 * hidden with your rescue outranked is the blank screen we exist to prevent.
 *
 * It takes a SET rather than a segment, so that argument decides the case it was made for. Ruling on one
 * segment at a time and then ranking the segments meant `/page?unmark#/route?mark` — a page linked with
 * `unmark`, a failed write, and then the exact append the copy prints, since "the end of the address bar" is
 * the hash on a hash-routed page — still resolved to `hidden`: rescue-wins twice, over nothing, and then a
 * coin-flip between segments overrode both. The segment a flag landed in was never part of the argument.
 */
function readFabFlag(flags: Set<string>): FabVisibility | undefined {
  if (flags.has(ANNOTATION_FAB_PARAM_SHOW)) return "visible"
  // `?unmark` → `hidden-url`, never `hidden-key`: whoever typed this flag already holds the URL vocabulary,
  // so the URL is demonstrably an exit they can use — and unlike the shortcut it works on every device.
  if (flags.has(ANNOTATION_FAB_PARAM_HIDE)) return "hidden-url"
  return undefined
}

/**
 * A stable identity for "the flags this URL carries right now" — `""` when it carries none.
 *
 * The caller keeps the last token it ACTED on, so a flag is consumed once per occurrence instead of once per
 * read. That distinction only became load-bearing when the overlay started subscribing to navigation: if the
 * write failed we leave the flag in the URL on purpose (the reload fallback), and without an identity to
 * compare against, every later `popstate` re-applies the same stale token — silently undoing a restore the
 * user just performed. Order-independent, so `?unmark&mark` and `?mark&unmark` are one occurrence, while
 * `?unmark` → `?unmark&mark` is genuinely a new one.
 */
export function fabFlagToken(url: FabParamUrl): string {
  return [...urlFabFlags(url)].sort().join("+")
}

/**
 * Should this pass act on the URL flag? Only when there IS one and it is not the one we already applied.
 *
 * Deliberately in-memory and per page load: a reload starts with no memory, re-reads the URL, and the
 * failed-persistence fallback still works. What it cannot survive is a stale token firing twice.
 */
export function shouldApplyFabFlag(token: string, lastApplied: string | undefined): boolean {
  return token !== "" && token !== lastApplied
}

/**
 * What the "already answered" memo becomes after observing `token` — the other half of the rule above, and
 * the half round 8 left unsaid. The memo means "the occurrence currently in the URL that we have already
 * acted on", so a flag-free URL must erase it: otherwise the memo outlives the flag, and the SECOND time the
 * user follows the printed hint the token matches a spent one and their rescue is silently swallowed
 * (round 9). Set on every pass, not only on the ones that apply something — that is what makes it self-heal
 * instead of needing a clearing call at each early return.
 */
export function nextAppliedFlag(token: string): string | undefined {
  return token === "" ? undefined : token
}

/**
 * The status message that is still TRUE. Every toast this chrome raises is `fabToastFor(state, …)` — it
 * narrates exactly one visibility and the way out of it — so the instant the visibility moves on, the
 * message is describing somewhere the user no longer is. Deriving it from the current state rather than
 * clearing it at each restore site means no path can forget: not the shortcut, not the edge handle, not a
 * `?mark` typed into the address bar (which restores without going through any handler at all), and not
 * whichever path is added next.
 */
export function activeFabToast(
  toast: { message: string; state: FabVisibility } | null | undefined,
  current: FabVisibility
): string | null {
  return toast && toast.state === current ? toast.message : null
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
 * checked. They are read as ONE set ({@link urlFabFlags}), the same set {@link fabFlagToken} builds its
 * identity from, so the two cannot disagree about what a URL carries; the rescue-wins ruling in
 * {@link readFabFlag} then decides once, over everything present, rather than per segment and then again
 * between segments.
 *
 * Pure; the caller reads `location`, persists, and strips the flag from whichever segment held it.
 */
export function resolveFabVisibility(
  url: FabParamUrl,
  stored: FabVisibility | undefined
): { visibility: FabVisibility; persist: FabVisibility | null } {
  const flag = readFabFlag(urlFabFlags(url))
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
 * Remove ONLY the overlay's own `mark` / `unmark` flag from a raw `location.search`, leaving every other
 * parameter byte-for-byte intact. We split on `&` and drop the tokens whose KEY is ours, rather than
 * round-tripping through `URLSearchParams.toString()` — that round-trip re-encodes existing escapes and
 * rewrites bare flags (`?debug` → `?debug=`), mutating query strings the host app may read raw. Matches a
 * full key token only, so `?foo=mark` is untouched. Returns the search WITHOUT a leading "?" ("" if empty).
 */
export function stripFabParamsFromSearch(search: string | undefined, bareOnly = false): string {
  const raw = (search ?? "").replace(/^\?/, "")
  if (!raw) return ""
  // Strip exactly what we recognize — otherwise the hash reader would ignore a host's `mark=42` while the
  // stripper deleted it, which is worse than either rule alone.
  return raw
    .split("&")
    .filter((pair) => !isFabParamPair(pair, bareOnly))
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
  const rest = stripFabParamsFromSearch(query, true) // host router's namespace: bare flags only
  if (rest === query) return (hash ?? "").replace(/^#/, "")
  return rest ? `${route}?${rest}` : route
}

/**
 * Both strips at once, reassembled into the URL to hand `replaceState` — or `null` when the URL holds
 * nothing of ours and must not be rewritten at all.
 *
 * The two segments are cleaned together because the flag legitimately lands in either and a load can carry
 * one in each; rewriting them in two passes would put a half-cleaned URL in the address bar in between. The
 * `null` return is the load-bearing part: it is what lets the caller distinguish "already clean" from
 * "cleaned to the same string", so an untouched URL never reaches `replaceState` and never fakes a
 * navigation for the host's router.
 */
export function stripFabParamsFromUrl(url: { pathname?: string; search?: string; hash?: string }): string | null {
  const strippedSearch = stripFabParamsFromSearch(url.search)
  const nextSearch = strippedSearch ? `?${strippedSearch}` : ""
  const strippedHash = stripFabParamsFromHash(url.hash)
  const nextHash = strippedHash ? `#${strippedHash}` : ""
  if (nextSearch === (url.search ?? "") && nextHash === (url.hash ?? "")) return null
  return `${url.pathname ?? ""}${nextSearch}${nextHash}`
}

/**
 * Which events the browser owes a subscriber after we rewrite the URL ourselves — and which we must
 * therefore re-issue by hand.
 *
 * `history.replaceState` fires neither `popstate` nor `hashchange`, so a host router that subscribes to
 * either keeps serving a location we have already changed. The scaffold router in `packages/runtime` reads
 * `pathname` and is unaffected, but the SDK's public surface permits a hash router, and that one would keep
 * a stale `mark` in its route query forever.
 *
 * `popstate` covers the history routers (and matches what the scaffold's own `navigate()` hand-dispatches
 * for exactly this reason). `hashchange` is a narrower claim — that the FRAGMENT moved — so it is only made
 * when the fragment really moved; announcing it otherwise sends a hash router chasing a change that did not
 * happen. An unchanged URL yields nothing, which is also what keeps our own re-issued events from echoing:
 * the handler they wake re-reads a URL with no flag left in it and rewrites nothing.
 */
export function fabUrlChangeEvents(
  before: { search?: string; hash?: string },
  after: { search?: string; hash?: string }
): ("popstate" | "hashchange")[] {
  const searchMoved = (before.search ?? "") !== (after.search ?? "")
  const hashMoved = (before.hash ?? "") !== (after.hash ?? "")
  if (!searchMoved && !hashMoved) return []
  return hashMoved ? ["popstate", "hashchange"] : ["popstate"]
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
 * `&mark` and produce `#/route&mark` — one more shape where the flag silently isn't a flag.
 *
 * It takes the RAW HREF, and that is the point rather than a convenience. Four review rounds each found one
 * more URL shape this got wrong, and the reason was never the rule — it was the input. `URL.hash` is `""`
 * for BOTH "there is no fragment" and "there is an empty fragment" (`/page?foo=1#`), and those two demand
 * opposite separators, so no rule reading a decomposed `{search, hash}` can be right about both; every round
 * could only enumerate one more shape. An href loses nothing, so one rule covers every shape there is:
 *
 *   no `#`  → the append lands in the search   → `&` if the href already has a `?`
 *   a `#`   → the append lands in the fragment → `&` if that fragment already has a `?`
 *
 * Both halves go through the reader's own {@link splitHash} and {@link hrefFragment}, so what we print and
 * what we accept cannot disagree — a printed instruction the parser rejects is the whole failure mode here.
 * The property test over the shape matrix is the thing that keeps it that way; prefer adding a row there to
 * adding a branch here.
 */
export function formatMarkParam(href: string): string {
  const fragment = hrefFragment(href)
  const tailHasQuery = fragment === undefined ? href.includes("?") : splitHash(fragment).hasQuery
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
