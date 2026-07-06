import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { build, type BuildOptions, type Metafile } from "esbuild"

const DEFAULT_UI_PACKAGE_NAME = "@avibe/show-ui"
export const VENDOR_MANIFEST_FILENAME = "vendor-manifest.json"
// v2 records `outputFiles` so a pre-existing bundle can be validated + reused without
// a destructive rescan of `outDir` (which a concurrent process may be publishing into).
// v3 records `depFingerprint` so a reused bundle is invalidated when the installed
// versions of the provided packages change in place at the same `dependencyRoot`
// (a shared cache volume + an in-place dep update would otherwise serve a stale bundle).
const VENDOR_MANIFEST_VERSION = 3

/** Marker recorded in the dependency fingerprint when a provided package isn't installed. */
const ABSENT_PACKAGE_VERSION = "<absent>"

/**
 * Session-independent, absolute URL prefix the shared vendor bundle is served under.
 * Assets live at `${VENDOR_URL_PREFIX}/<hash>/<file>` so they're shared across every
 * session and cacheable as immutable (the content hash is in the path). The avibe
 * proxy must expose this same prefix unprefixed by the per-session base.
 */
export const VENDOR_URL_PREFIX = "/_show-runtime/vendor"

/** Filename of the shared empty JS module that neutralizes bare CSS imports. */
export const VENDOR_EMPTY_MODULE_FILENAME = "__empty.js"

/** The hash-scoped base URL the vendor assets for `hash` are served under. */
export function vendorBaseUrl(hash: string): string {
  return `${VENDOR_URL_PREFIX}/${hash}`
}

export interface BuildVendorOptions {
  /** Directory whose `node_modules` holds the shared, pinned runtime install. */
  dependencyRoot: string
  /**
   * Directory the vendor bundle and manifest are published to. A pre-existing valid
   * bundle here is reused as-is; otherwise the build is staged in a temp dir and
   * published additively (content-hashed files are added, never deleted) so a
   * concurrent process still serving this dir keeps its files.
   */
  outDir: string
  /** Override the UI package name (defaults to `@avibe/show-ui`). */
  uiPackageName?: string
}

export interface VendorManifest {
  /** Schema version for the manifest shape. */
  version: number
  /** UI package the bundle was built against. */
  uiPackageName: string
  /** Content hash spanning every emitted output file (stable for identical inputs). */
  hash: string
  /**
   * Hash of the installed `version` of every provided package (react, react-dom, the UI
   * package, motion, lucide-react) read from `<dependencyRoot>/node_modules/<pkg>/package.json`.
   * Folded into the cache identity so an in-place dep change at the same `dependencyRoot`
   * invalidates a reused bundle even though `outDir` and the output hash are unchanged.
   */
  depFingerprint: string
  /** Every provided specifier, sorted, that the import map must resolve. */
  specifiers: string[]
  /** Specifier -> output file path relative to `outDir`. */
  imports: Record<string, string>
  /**
   * Every emitted output file (entries + chunks + assets) for THIS bundle, relative
   * to `outDir`, sorted (excludes the manifest). Lets a restart validate + reuse the
   * bundle by name even when `outDir` also holds another process's content-hashed
   * files from a different build.
   */
  outputFiles: string[]
}

export interface BuildVendorResult {
  outDir: string
  manifestPath: string
  manifest: VendorManifest
  /** Emitted output files relative to `outDir`, sorted (excludes the manifest). */
  outputFiles: string[]
}

/** The browser-facing wiring a served Show Page needs to resolve the vendor bundle. */
export interface VendorBrowserAssets {
  /** Specifier -> absolute vendor URL, for the `<script type="importmap">` block. */
  importMap: Record<string, string>
  /** Absolute vendor URLs for the hashed stylesheets, injected as `<link rel="stylesheet">`. */
  styleHrefs: string[]
}

export interface VendorBrowserAssetsOptions {
  /**
   * Session-independent, hash-scoped path the bundle files are served under
   * (e.g. `/_show-runtime/vendor/<hash>`). The manifest output paths are joined onto it.
   */
  baseUrl: string
  /**
   * Absolute URL of a harmless empty JS module (served with a JS MIME type). The
   * provided CSS specifiers are mapped to it so a bare `import "<pkg>/styles.css"`
   * resolves to a no-op instead of fetching the `.css` as JS (a MIME error). The
   * real stylesheet is delivered via `styleHrefs` as a `<link>`.
   */
  emptyModuleUrl: string
}

/**
 * Split a vendor manifest into the browser wiring: the import map and the stylesheet
 * hrefs.
 *
 * A `.css` URL must never be an import-map target the browser fetches as JS — that
 * fails the module MIME check. So CSS specifiers map to a shared empty JS module
 * (their bare `import` still resolves, to a no-op), while the real hashed stylesheet
 * is returned in `styleHrefs` for a `<link rel="stylesheet">`. JS specifiers map to
 * their hashed bundle output. `providedVendorCssSpecifiers` stays the single source
 * of truth for which manifest entries are stylesheets.
 */
export function vendorBrowserAssets(manifest: VendorManifest, options: VendorBrowserAssetsOptions): VendorBrowserAssets {
  const cssSpecifiers = new Set(providedVendorCssSpecifiers(manifest.uiPackageName))
  const prefix = options.baseUrl.endsWith("/") ? options.baseUrl.slice(0, -1) : options.baseUrl
  const importMap: Record<string, string> = {}
  const styleHrefs: string[] = []
  for (const [specifier, file] of Object.entries(manifest.imports)) {
    if (cssSpecifiers.has(specifier)) {
      styleHrefs.push(`${prefix}/${file}`)
      importMap[specifier] = options.emptyModuleUrl
    } else {
      importMap[specifier] = `${prefix}/${file}`
    }
  }
  return { importMap, styleHrefs }
}

/**
 * The "provided" specifier set — the deps the runtime serves as one shared,
 * content-hashed vendor bundle so every Show Page session references the same
 * immutable copy (one React instance) through a browser import map.
 *
 * This is the single source of truth shared with dev externalization
 * (`vendor-externalize-plugin.ts` leaves exactly this set bare for the import
 * map), normalized to the actual specifiers a Show Page app (or `@avibe/show-ui`)
 * can import:
 *   - React core + both JSX runtimes + `react-dom` / `react-dom/client`.
 *   - Every `@avibe/show-ui` subpath that ships a JS build (the shadcn
 *     `@/components/ui/*` and `@/lib/utils` aliases resolve onto these), plus the
 *     bare `@avibe/show-ui` barrel.
 *   - `motion/react` (Vite's `"<pkg> > motion/react"` optimize entries name this
 *     nested dep; the specifier apps actually write is `motion/react`).
 *   - `lucide-react`, imported directly by apps and by `@avibe/show-ui` internals.
 *
 * Keep this as the single source of truth so externalization (leaving these
 * specifiers bare for the import map) and this pre-build agree exactly.
 *
 * `uiSubpaths` are the JS-exporting `@avibe/show-ui` subpath names the bundle was
 * built for (enumerated from the package's `exports` by `buildVendor`). When omitted,
 * the historical default set is used (e.g. callers without a resolved install). The
 * built `vendor-manifest.json` `specifiers` is the authoritative runtime copy, so
 * externalization keys off the manifest, never a re-derived list — this stays the
 * single declaration site for the core (non-UI-subpath) provided deps.
 */
export function providedVendorSpecifiers(
  uiPackageName: string = DEFAULT_UI_PACKAGE_NAME,
  uiSubpaths: string[] = DEFAULT_UI_SUBPATHS
): string[] {
  return [
    "react",
    "react-dom",
    "react-dom/client",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "motion/react",
    "lucide-react",
    uiPackageName,
    ...uiSubpaths.map((subpath) => `${uiPackageName}/${subpath}`)
  ]
}

/**
 * Fallback UI subpath set used only when the package's `exports` cannot be read. The
 * authoritative list at build time comes from `uiPackageJsSubpaths(<exports>)`.
 */
const DEFAULT_UI_SUBPATHS = [
  "animated-text",
  "badge",
  "button",
  "card",
  "dialog",
  "input",
  "metric-card",
  "progress",
  "switch",
  "theme",
  "utils"
]

/**
 * Enumerate the JS-exporting subpath names from a UI package's `exports` map (so the
 * provided set covers EVERY shippable subpath, e.g. a newly added one, not just a
 * hand-maintained list). Skips the bare `.` entry (handled separately) and CSS/asset
 * exports.
 *
 * A subpath is included only if its JS target FILE actually exists under `packageDir`.
 * Some packages declare an `exports` entry whose JS artifact isn't built (e.g. a
 * types-only or runtime-injected subpath like `@avibe/show-ui/hmr-transition`);
 * bundling those would hard-fail, and externalizing them would leave a bare import the
 * browser can't resolve. Skipping them lets such a subpath optimize per-session
 * normally (safe) instead. Falls back to the historical default set when `exports` is
 * absent/unreadable or yields nothing.
 */
export async function uiPackageJsSubpaths(exportsMap: unknown, packageDir: string): Promise<string[]> {
  if (!exportsMap || typeof exportsMap !== "object") return [...DEFAULT_UI_SUBPATHS]
  const subpaths: string[] = []
  for (const [key, target] of Object.entries(exportsMap as Record<string, unknown>)) {
    if (!key.startsWith("./") || key === ".") continue
    const subpath = key.slice(2)
    if (!subpath) continue
    const jsTarget = jsExportTargetPath(target)
    if (jsTarget && await fileExists(join(packageDir, ...jsTarget.replace(/^\.\//, "").split("/")))) {
      subpaths.push(subpath)
    }
  }
  return subpaths.length ? subpaths.sort(compareStrings) : [...DEFAULT_UI_SUBPATHS]
}

/**
 * The JS target path of an `exports` entry (`import`/`module`/`default` condition or a
 * bare string), or `undefined` for a CSS/asset-only export.
 */
function jsExportTargetPath(target: unknown): string | undefined {
  if (typeof target === "string") return target.endsWith(".css") ? undefined : target
  if (target && typeof target === "object") {
    const conditions = target as Record<string, unknown>
    for (const condition of ["import", "module", "default"]) {
      const resolved = jsExportTargetPath(conditions[condition])
      if (resolved) return resolved
    }
  }
  return undefined
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * CSS specifiers that ship as side-effect imports. They are bundled as standalone
 * CSS assets (esbuild handles CSS natively) and still appear in the manifest so the
 * loader / import map can serve the hashed stylesheet.
 */
export function providedVendorCssSpecifiers(uiPackageName: string = DEFAULT_UI_PACKAGE_NAME): string[] {
  return [`${uiPackageName}/styles.css`]
}

/**
 * The distinct npm package NAMES the vendor bundle pulls — derived from the provided
 * specifiers so it stays the single source of truth (a new provided specifier carries
 * its package automatically). Subpaths collapse to their root package (e.g.
 * `react/jsx-runtime` -> `react`, `@avibe/show-ui/button` -> `@avibe/show-ui`) because
 * a subpath shares its package's single installed version.
 */
export function providedVendorPackageNames(uiPackageName: string = DEFAULT_UI_PACKAGE_NAME): string[] {
  const names = new Set<string>()
  for (const specifier of [...providedVendorSpecifiers(uiPackageName, []), ...providedVendorCssSpecifiers(uiPackageName)]) {
    names.add(rootPackageName(specifier))
  }
  return [...names].sort(compareStrings)
}

/** Root package name of a specifier (`@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`). */
function rootPackageName(specifier: string): string {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

/**
 * A cheap, deterministic fingerprint of the installed versions of the provided packages
 * at `nodeModules`. Reads each package's `version` from
 * `<nodeModules>/<pkg>/package.json` and hashes the sorted `name@version` list (a missing
 * package contributes `name@<absent>`, so an install/uninstall also moves the fingerprint).
 *
 * Folded into the vendor cache identity (the `outDir` digest in `vendor-runtime` and the
 * manifest-reuse check in `buildVendor`) so a dep change at the same `dependencyRoot`
 * forces a rebuild instead of serving a stale, content-hash-identical bundle.
 */
export async function dependencyFingerprint(nodeModules: string, packageNames: string[]): Promise<string> {
  const entries = await Promise.all(
    [...packageNames].sort(compareStrings).map((name) => installedPackageSignature(nodeModules, name))
  )
  return createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16)
}

// The sentinel version carried by the file:-linked workspace packages (`@avibe/*`): it never
// moves across rebuilds or releases, so version alone cannot identify their content.
const UNSTABLE_PACKAGE_VERSION = "0.0.0"

/**
 * Cache-identity signature for one provided package. Registry packages are immutable per
 * version, so `name@version` is a sound (and cheap) content identity. The vendored workspace
 * packages are permanently `0.0.0` (file:-linked), so a source rebuild changes their CONTENT
 * without moving the version — fold a digest of their shipped code so the vendor/vite cache
 * identity tracks the actual bytes and never reuses a stale bundle after a rebuild.
 */
async function installedPackageSignature(nodeModules: string, packageName: string): Promise<string> {
  const version = await installedPackageVersion(nodeModules, packageName)
  if (version !== UNSTABLE_PACKAGE_VERSION) return `${packageName}@${version}`
  const content = await packageContentDigest(join(nodeModules, ...packageName.split("/")))
  return `${packageName}@${version}#${content}`
}

/** Installed `version` of `<nodeModules>/<pkg>/package.json`, or `ABSENT_PACKAGE_VERSION`. */
async function installedPackageVersion(nodeModules: string, packageName: string): Promise<string> {
  try {
    const manifest = JSON.parse(
      await readFile(join(nodeModules, ...packageName.split("/"), "package.json"), "utf8")
    ) as { version?: unknown }
    return typeof manifest.version === "string" ? manifest.version : ABSENT_PACKAGE_VERSION
  } catch {
    return ABSENT_PACKAGE_VERSION
  }
}

/**
 * Content digest of a package's bundling inputs: its `package.json` (name/version/`exports`/
 * dependencies drive what the vendor bundle resolves) plus its shipped code — a stable hash
 * over each file's label + byte length + bytes (sorted for determinism, nested `node_modules`
 * skipped). Uses the package's `dist` when present (the publish surface) and falls back to the
 * package root. Only called for unstable-version packages, which ship a small `dist`, so
 * reading the bytes stays cheap. The length prefix keeps the framing injective (bytes may
 * contain NUL), and an unreadable file is recorded as changed rather than throwing into warm.
 */
async function packageContentDigest(packageDir: string): Promise<string> {
  const hash = createHash("sha256")
  // Fold `package.json` first: an `exports`/dependency change with unchanged dist bytes must
  // still move the fingerprint, so a reused vendor manifest/import map (invalidated only by
  // this fingerprint — see readReusableManifest) is never served stale after an upgrade.
  await updateHashWithFile(hash, join(packageDir, "package.json"), "package.json")
  const distDir = join(packageDir, "dist")
  const root = (await isDirectory(distDir)) ? distDir : packageDir
  for (const relativePath of (await listFilesRecursive(root, root)).sort(compareStrings)) {
    // Skip the package.json already folded above (only reachable in the package-root fallback).
    if (root === packageDir && relativePath === "package.json") continue
    await updateHashWithFile(hash, join(root, relativePath), relativePath)
  }
  return hash.digest("hex").slice(0, 16)
}

/**
 * Fold one file into `hash` as `label\0<byteLength>\0<bytes>\0`. The length prefix keeps the
 * framing injective (file bytes may contain NUL); a missing/unreadable file is recorded as
 * changed rather than throwing into the warm path.
 */
async function updateHashWithFile(hash: ReturnType<typeof createHash>, path: string, label: string): Promise<void> {
  hash.update(label).update("\0")
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    hash.update("missing\0")
    return
  }
  hash.update(`${bytes.byteLength}\0`)
  hash.update(bytes)
  hash.update("\0")
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Normalized relative paths of every file under `root`, recursively, skipping nested
 * `node_modules`. A symlink to a FILE is followed and included (a change to its target still
 * moves the digest); symlinked directories are NOT recursed into, keeping the walk cycle-safe
 * (the publish surface never ships those).
 */
async function listFilesRecursive(dir: string, root: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { encoding: "utf8", withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name === "node_modules") continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full, root)))
    } else if (entry.isFile()) {
      out.push(normalizeSlashes(relative(root, full)))
    } else if (entry.isSymbolicLink() && (await statOrNull(full))?.isFile()) {
      out.push(normalizeSlashes(relative(root, full)))
    }
  }
  return out
}

async function statOrNull(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/** A cache-identity dir name: the 16-hex-char content digest used by the vendor pool and
 * the Vite optimize cache. Matches ONLY those, so temp build dirs (`.avibe-vendor-build-*`)
 * and any Vite lock/metadata files are never swept. */
const CACHE_IDENTITY_RE = /^[0-9a-f]{16}$/

export interface PruneCacheDirsOptions {
  /** Dir names to keep regardless of age (the identities this process knows are in use). */
  keep?: Iterable<string>
  /** Delete only dirs whose mtime is older than this many ms — the liveness margin. */
  maxAgeMs: number
  /** Injectable clock (tests); defaults to now. */
  now?: number
}

/**
 * Best-effort GC of superseded cache-identity dirs under `root` (avibe-bot/vibe-show-runtime#31).
 *
 * Each vendor/Vite identity change lands in a fresh `<16-hex>` dir (~6MB for the vendor pool)
 * and the old ones were never reclaimed. These roots are SHARED and additive by design — a
 * rolling-restart peer or another worker may serve from any dir — so "superseded" cannot be
 * decided by identity alone. Liveness is signalled by mtime: the runtime touches every dir it
 * serves from (on warm and on access), so a dir untouched for longer than `maxAgeMs` (the idle
 * TTL — past which its session is pruned) is provably abandoned. This deletes only those, and
 * never a name in `keep` (the current identities, belt-and-suspenders against clock skew).
 *
 * Every step is best-effort and ENOENT/EBUSY-safe: a missing root, an unreadable entry, or a
 * dir another process holds open is skipped, never thrown — so a live server is never disrupted
 * and a lost race is a no-op. Returns the identity names removed (for logging/tests).
 */
export async function pruneSupersededCacheDirs(root: string, options: PruneCacheDirsOptions): Promise<string[]> {
  const keepNames = new Set(options.keep ?? [])
  const cutoff = (options.now ?? Date.now()) - Math.max(0, options.maxAgeMs)
  const entries = await readdir(root, { encoding: "utf8", withFileTypes: true }).catch(() => [])
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || keepNames.has(entry.name) || !CACHE_IDENTITY_RE.test(entry.name)) continue
    const dir = join(root, entry.name)
    const info = await statOrNull(dir)
    if (!info || info.mtimeMs > cutoff) continue // missing (raced) or recently touched -> in use, keep
    try {
      // Re-check the mtime immediately before deleting: a peer may have started reusing (and thus
      // touched) this identity between the scan above and now. Narrows the TOCTOU window to the gap
      // between this stat and the rm, so we don't remove a dir a concurrent warm just made live.
      const fresh = await statOrNull(dir)
      if (!fresh || fresh.mtimeMs > cutoff) continue
      await rm(dir, { recursive: true, force: true })
      removed.push(entry.name)
    } catch {
      // Best-effort: a concurrent server may hold the dir; leave it for the next GC pass.
    }
  }
  return removed
}

/**
 * Pre-build the shared vendor bundle: bundle every provided specifier as an ESM
 * entry, splitting shared code (React, the JSX runtime, motion, ...) into common
 * chunks so React resolves to a single instance across every entry. Writes
 * content-hashed outputs plus a `vendor-manifest.json` mapping each specifier to
 * its emitted file.
 *
 * Deterministic and idempotent: identical inputs produce identical hashes, so the
 * outputs are safe to serve as immutable.
 *
 * Publishing is concurrency-safe. `outDir` is keyed by `(dependencyRoot, uiPackageName)`
 * — not by content hash — so two runtime processes that share a vendor cache (rolling
 * restart, multiple workers) target the SAME `outDir`. This never clears it:
 *  - A pre-existing, self-consistent bundle for the same inputs is REUSED as-is (the
 *    build is deterministic, so a rebuild would only reproduce it).
 *  - Otherwise the build is staged in a temp dir and published ADDITIVELY — its
 *    content-hashed files are moved in without removing any existing ones, and the
 *    manifest is swapped in atomically last. A concurrent process still serving the
 *    old bundle keeps its (differently hashed) files, so its import map never 404s.
 */
export async function buildVendor(options: BuildVendorOptions): Promise<BuildVendorResult> {
  const uiPackageName = options.uiPackageName ?? DEFAULT_UI_PACKAGE_NAME
  const dependencyRoot = resolve(options.dependencyRoot)
  const nodeModules = join(dependencyRoot, "node_modules")
  const outDir = resolve(options.outDir)

  // Fingerprint the installed provided-package versions so an in-place dep change at the
  // same `dependencyRoot` invalidates a reused bundle (its outputs would otherwise re-hash
  // to the recorded value and be wrongly reused).
  const depFingerprint = await dependencyFingerprint(nodeModules, providedVendorPackageNames(uiPackageName))

  // Fast path: an intact bundle for the same inputs is already published — reuse it
  // without rebuilding or touching `outDir` (which another process may be serving).
  const reusable = await readReusableManifest(outDir, uiPackageName, depFingerprint)
  if (reusable) {
    return { outDir, manifestPath: join(outDir, VENDOR_MANIFEST_FILENAME), manifest: reusable, outputFiles: reusable.outputFiles }
  }

  // Enumerate provided UI subpaths from the resolved package's `exports`, so EVERY
  // built JS subpath lands in the bundle + import map + externalize set — not a
  // hand-maintained list that silently misses one (and not a subpath whose JS isn't
  // built, which would leave a bare import the browser can't resolve).
  const uiPackageDir = join(nodeModules, ...uiPackageName.split("/"))
  const uiSubpaths = await uiPackageJsSubpaths(await readUiPackageExports(uiPackageDir), uiPackageDir)
  const jsSpecifiers = providedVendorSpecifiers(uiPackageName, uiSubpaths)
  const cssSpecifiers = providedVendorCssSpecifiers(uiPackageName)

  // Stage the build beside `outDir` (under the same vendor cache root), so publishing it
  // is a same-filesystem `rename` (no cross-device `EXDEV`); never clear `outDir` itself.
  const cacheRoot = dirname(outDir)
  await mkdir(cacheRoot, { recursive: true })
  const buildDir = await mkdtemp(join(cacheRoot, ".avibe-vendor-build-"))
  const stubRoot = await mkdtemp(join(tmpdir(), "avibe-vendor-stub-"))
  try {
    const imports: Record<string, string> = {}

    // Bundle all JS specifiers in one pass so esbuild splitting hoists shared code
    // (React, the JSX runtime, motion, ...) into common chunks shared by every
    // entry — this is what guarantees a single React instance.
    Object.assign(imports, await bundleSpecifiers({
      specifiers: jsSpecifiers,
      kind: "js",
      stubRoot,
      dependencyRoot,
      nodeModules,
      outDir: buildDir
    }))

    // CSS specifiers are bundled separately: esbuild treats a `.css` file as its
    // own entry point and emits a hashed stylesheet asset (no JS chunk).
    if (cssSpecifiers.length > 0) {
      Object.assign(imports, await bundleSpecifiers({
        specifiers: cssSpecifiers,
        kind: "css",
        stubRoot,
        dependencyRoot,
        nodeModules,
        outDir: buildDir
      }))
    }

    const outputFiles = await listEmittedFiles(buildDir)
    const hash = await hashOutputs(buildDir, outputFiles)
    const manifest: VendorManifest = {
      version: VENDOR_MANIFEST_VERSION,
      uiPackageName,
      hash,
      depFingerprint,
      specifiers: [...jsSpecifiers, ...cssSpecifiers].sort(compareStrings),
      imports: sortRecord(imports),
      outputFiles
    }
    const manifestPath = await publishVendorBuild(buildDir, outDir, manifest, outputFiles)
    return { outDir, manifestPath, manifest, outputFiles }
  } finally {
    await rm(buildDir, { recursive: true, force: true })
    await rm(stubRoot, { recursive: true, force: true })
  }
}

/**
 * Return the already-published manifest at `outDir` IFF it is a complete, self-consistent
 * bundle for `uiPackageName` + the current `depFingerprint` that can be reused as-is —
 * else `undefined` (rebuild).
 *
 * "Reusable" means: it parses, its schema version + UI package + dependency fingerprint
 * match, every file it lists is present on disk, AND re-hashing exactly those files
 * reproduces its recorded `hash`. The dependency fingerprint guard is what catches an
 * in-place dep change at the same `dependencyRoot`: the bundle on disk re-hashes to its
 * recorded value (it's unchanged), so without comparing the installed versions a stale
 * bundle would be served. Because the build is deterministic, a bundle that passes every
 * check is byte-identical to what a rebuild for the same inputs would emit, so serving it
 * is equivalent — and skipping the rebuild avoids clearing a dir a concurrent process may
 * still be serving from.
 */
async function readReusableManifest(outDir: string, uiPackageName: string, depFingerprint: string): Promise<VendorManifest | undefined> {
  let manifest: VendorManifest
  try {
    manifest = JSON.parse(await readFile(join(outDir, VENDOR_MANIFEST_FILENAME), "utf8")) as VendorManifest
  } catch {
    return undefined
  }
  if (
    manifest.version !== VENDOR_MANIFEST_VERSION ||
    manifest.uiPackageName !== uiPackageName ||
    manifest.depFingerprint !== depFingerprint ||
    !Array.isArray(manifest.outputFiles) ||
    manifest.outputFiles.length === 0
  ) {
    return undefined
  }
  for (const file of manifest.outputFiles) {
    if (!(await fileExists(join(outDir, ...file.split("/"))))) return undefined
  }
  const rehashed = await hashOutputs(outDir, manifest.outputFiles).catch(() => undefined)
  return rehashed === manifest.hash ? manifest : undefined
}

/**
 * Publish a staged vendor build from `buildDir` into the shared `outDir` WITHOUT
 * clearing it. Content-hashed files are moved in additively (an existing file with the
 * same hashed name is byte-identical, so it's left in place), then the manifest is
 * swapped in atomically (write-temp + rename) as the last step. Files belonging to a
 * concurrent process's older bundle keep different hashed names, so they survive and
 * that process's import map keeps resolving. Returns the published manifest path.
 */
async function publishVendorBuild(
  buildDir: string,
  outDir: string,
  manifest: VendorManifest,
  outputFiles: string[]
): Promise<string> {
  await mkdir(outDir, { recursive: true })
  for (const file of outputFiles) {
    const target = join(outDir, ...file.split("/"))
    if (await fileExists(target)) continue
    await mkdir(dirname(target), { recursive: true })
    // `buildDir` is a sibling of `outDir` (same vendor cache root), so this rename stays
    // on one filesystem. Tolerate a lost race: if another process created the (byte-
    // identical, content-hashed) file between the check and the rename, accept it.
    await rename(join(buildDir, ...file.split("/")), target).catch(async (error) => {
      if (await fileExists(target)) return
      throw error
    })
  }
  const manifestPath = join(outDir, VENDOR_MANIFEST_FILENAME)
  const manifestTmp = join(outDir, `.${VENDOR_MANIFEST_FILENAME}.${randomUUID()}.tmp`)
  await writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  await rename(manifestTmp, manifestPath)
  return manifestPath
}

/**
 * Read a UI package's `exports` map from its resolved install dir. Returns `undefined`
 * if the `package.json` is missing/unreadable, so the caller falls back to the
 * historical default subpath set.
 */
async function readUiPackageExports(packageDir: string): Promise<unknown> {
  try {
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as { exports?: unknown }
    return manifest.exports
  } catch {
    return undefined
  }
}

interface BundleSpecifiersArgs {
  specifiers: string[]
  kind: "js" | "css"
  stubRoot: string
  dependencyRoot: string
  nodeModules: string
  outDir: string
}

/**
 * Materialize a tiny stub module per specifier, then run a single esbuild build
 * over all stubs (so splitting/dedupe spans the whole set). Returns a
 * specifier -> output-file (relative to outDir) map derived from the metafile.
 */
async function bundleSpecifiers(args: BundleSpecifiersArgs): Promise<Record<string, string>> {
  const { specifiers, kind, stubRoot, dependencyRoot, nodeModules, outDir } = args
  // Export discovery must resolve from the dependency root (not the runtime's own
  // install), so a resolver anchored at the dependency root's `node_modules` honors its
  // `import`/`exports` conditions. The resolver keeps its writes out of `dependencyRoot`
  // (which can be a read-only installed app); see `createDependencyResolver`.
  const resolver = kind === "js" ? await createDependencyResolver(dependencyRoot) : undefined
  const stubs = new Map<string, string>()
  const entryPoints: Array<{ in: string; out: string }> = []
  for (const specifier of specifiers) {
    const stubPath = join(stubRoot, `${entryName(specifier)}.${kind === "css" ? "css" : "mjs"}`)
    const source = kind === "css" ? cssStubSource(specifier) : await jsStubSource(specifier, resolver!)
    await writeFile(stubPath, source, "utf8")
    stubs.set(specifier, stubPath)
    entryPoints.push({ in: stubPath, out: entryName(specifier) })
  }

  const buildOptions: BuildOptions = {
    entryPoints,
    bundle: true,
    format: "esm",
    splitting: kind === "js",
    platform: "browser",
    target: "es2022",
    outdir: outDir,
    entryNames: "[name]-[hash]",
    chunkNames: "chunks/[name]-[hash]",
    assetNames: "assets/[name]-[hash]",
    metafile: true,
    write: true,
    minify: false,
    // Run from the stub dir so metafile entryPoints stay simple and resolution is
    // explicit; resolve every bare import from the shared install only, with
    // browser/import conditions so package `exports` maps pick the ESM build.
    absWorkingDir: stubRoot,
    nodePaths: [nodeModules],
    conditions: ["import", "module", "browser", "default"],
    mainFields: ["browser", "module", "main"],
    // Bundle the deps IN — this bundle is the shared copy, nothing is external.
    external: [],
    logLevel: "warning",
    // The value-form default (`__ns.default ?? __ns`) is intentional for named-only
    // ESM modules; don't warn that the forwarded `__ns.default` is undefined.
    logOverride: { "import-is-undefined": "silent" },
    loader: { ".css": "css" }
  }

  try {
    const result = await build(buildOptions)
    if (!result.metafile) {
      throw new Error("esbuild did not produce a metafile for the vendor bundle")
    }
    return await mapSpecifierOutputs(specifiers, stubs, result.metafile, stubRoot, outDir)
  } finally {
    await resolver?.cleanup()
  }
}

function cssStubSource(specifier: string): string {
  return `@import ${JSON.stringify(specifier)};\n`
}

/**
 * Build an ESM facade for a JS specifier with *explicit* named re-exports plus a
 * safe default.
 *
 * `export * from "<cjs>"` only forwards what esbuild can statically read, which
 * for many CJS deps (react-dom/client, react/jsx-runtime, ...) is just `default`
 * — so `import { createRoot } from "react-dom/client"` would resolve to
 * `undefined`. We instead discover the real export names the way Vite/Node do
 * (Node's ESM interop runs `cjs-module-lexer`) by importing the specifier from
 * the shared install, then emit explicit named re-exports.
 *
 * The default is forwarded as a value (`__ns.default ?? __ns`) rather than a
 * `export { default } from` binding: dual-package libs (e.g. lucide-react)
 * resolve to a named-only ESM build under esbuild that has no static default, so
 * a default *binding* would hard-fail. The value form mirrors how bundlers expose
 * `import X from "pkg"` — the real default for CJS, the namespace otherwise.
 */
async function jsStubSource(specifier: string, resolver: DependencyResolver): Promise<string> {
  const named = await discoverNamedExports(specifier, resolver)
  const ref = JSON.stringify(specifier)
  const lines: string[] = []
  if (named.length > 0) {
    lines.push(`export {\n${named.map((name) => `  ${name}`).join(",\n")}\n} from ${ref};`)
  }
  lines.push(`import * as __ns from ${ref};`)
  lines.push(`export default (__ns.default !== undefined ? __ns.default : __ns);`)
  return `${lines.join("\n")}\n`
}

/**
 * Import a specifier from the dependency root and read its named exports. Names are
 * sorted so the generated facade — and therefore the content hash — is
 * deterministic across runs and machines. Node's ESM interop (cjs-module-lexer)
 * enumerates CJS named exports; for the few dual-package libs whose CJS/ESM
 * builds differ, esbuild simply re-exports the subset present in the ESM build it
 * bundles, and any name it cannot find is reported as a hard error (so drift is
 * never silently shipped).
 */
async function discoverNamedExports(specifier: string, resolver: DependencyResolver): Promise<string[]> {
  const moduleUrl = resolver.resolve(specifier)
  const namespace: Record<string, unknown> = await import(moduleUrl)
  return Object.keys(namespace)
    .filter((key) => key !== "default" && isValidIdentifier(key))
    .sort(compareStrings)
}

export interface DependencyResolver {
  /** Resolve `specifier` to a file URL anchored at the dependency root. */
  resolve(specifier: string): string
  /** Resolve `specifier` to an absolute filesystem path anchored at the dependency root. */
  resolveToPath(specifier: string): string
  /** Remove the on-disk resolver scratch dir. Safe to call once after use. */
  cleanup(): Promise<void>
}

/**
 * Build a resolver anchored at the dependency root so resolution (export discovery,
 * the generated facades, the dev shared-install fallback) matches the *shared
 * install*, never the runtime's own `node_modules`.
 *
 * `import.meta.resolve` anchors module resolution at the calling module's physical
 * location — its optional `parent` argument is ignored for resolution, so a synthetic
 * parent URL silently resolves from the runtime's install instead. CJS
 * `createRequire(...).resolve(...)` would anchor by path string but throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` for the `import`-only `@avibe/show-ui/*` and
 * `@avibe/show-sdk/*` subpaths (no `require`/`default` export condition).
 *
 * So we anchor an ESM helper at the dependency root WITHOUT writing into it (the
 * dependency root can be a read-only installed app): a throwaway scratch dir gets a
 * `node_modules` junction to `<dependencyRoot>/node_modules`, and the helper imported
 * from that scratch dir resolves every specifier through that junction — i.e. exactly
 * the dependency root's install, honoring `import`/`browser` export conditions —
 * while all generated artifacts live in the (always writable) scratch dir.
 */
export async function createDependencyResolver(dependencyRoot: string): Promise<DependencyResolver> {
  const scratchDir = await mkdtemp(join(tmpdir(), "avibe-vendor-resolver-"))
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    await rm(scratchDir, { recursive: true, force: true })
  }
  try {
    // Anchor resolution at the dependency root's install via a junction, so the helper
    // (and its writes) stay in the scratch dir even when `dependencyRoot` is read-only.
    await symlink(join(resolve(dependencyRoot), "node_modules"), join(scratchDir, "node_modules"), "junction")
    const helperPath = join(scratchDir, `resolver-${randomUUID()}.mjs`)
    await writeFile(helperPath, "export const resolve = (specifier) => import.meta.resolve(specifier)\n", "utf8")
    const helper: { resolve(specifier: string): string } = await import(pathToFileURL(helperPath).href)
    return {
      resolve: (specifier) => helper.resolve(specifier),
      resolveToPath: (specifier) => fileURLToPath(helper.resolve(specifier)),
      cleanup
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

const RESERVED_WORDS = new Set([
  "default",
  "import",
  "export",
  "const",
  "let",
  "var",
  "function",
  "class",
  "return",
  "in",
  "of",
  "new",
  "delete",
  "typeof",
  "void",
  "yield",
  "await",
  "this",
  "super"
])

function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !RESERVED_WORDS.has(name)
}

/**
 * Map each specifier to its emitted output file using the metafile. esbuild
 * records `outputs[file].entryPoint` and the output keys as paths relative to
 * `absWorkingDir` (== the stub root). We match a stub to its output by resolving
 * the recorded entryPoint to an absolute path and comparing realpaths (macOS
 * reports `/private/var/...` realpaths for tmp dirs), then re-relativize the
 * output key against `outDir`.
 */
async function mapSpecifierOutputs(
  specifiers: string[],
  stubs: Map<string, string>,
  metafile: Metafile,
  absWorkingDir: string,
  outDir: string
): Promise<Record<string, string>> {
  const realStubs = new Map<string, string>()
  for (const [specifier, stubPath] of stubs) {
    realStubs.set(specifier, await realpath(stubPath))
  }
  const imports: Record<string, string> = {}
  for (const specifier of specifiers) {
    const stubReal = realStubs.get(specifier)!
    let matchedKey: string | undefined
    for (const [outputKey, output] of Object.entries(metafile.outputs)) {
      if (!output.entryPoint) continue
      const entryAbsolute = await realpath(resolve(absWorkingDir, output.entryPoint)).catch(() => undefined)
      if (entryAbsolute === stubReal) {
        matchedKey = outputKey
        break
      }
    }
    if (!matchedKey) {
      throw new Error(`No vendor output emitted for specifier "${specifier}"`)
    }
    const outputAbsolute = resolve(absWorkingDir, matchedKey)
    imports[specifier] = normalizeSlashes(relative(outDir, outputAbsolute))
  }
  return imports
}

function entryName(specifier: string): string {
  // `react/jsx-runtime` -> `react__jsx-runtime`,
  // `@avibe/show-ui/theme` -> `avibe__show-ui__theme`.
  return specifier
    .replace(/^@/, "")
    .replace(/\//g, "__")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
}

async function listEmittedFiles(outDir: string): Promise<string[]> {
  const files: string[] = []
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(full)
      } else if (entry.isFile() && entry.name !== VENDOR_MANIFEST_FILENAME) {
        files.push(normalizeSlashes(relative(outDir, full)))
      }
    }
  }
  await visit(outDir)
  return files.sort(compareStrings)
}

async function hashOutputs(outDir: string, files: string[]): Promise<string> {
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(file)
    hash.update("\0")
    hash.update(await readFile(join(outDir, ...file.split("/"))))
    hash.update("\0")
  }
  return hash.digest("hex").slice(0, 16)
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => compareStrings(a, b)))
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function normalizeSlashes(path: string): string {
  return path.split(sep).join("/").split("\\").join("/")
}
