import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { build, type BuildOptions, type Metafile } from "esbuild"

const DEFAULT_UI_PACKAGE_NAME = "@avibe/show-ui"
export const VENDOR_MANIFEST_FILENAME = "vendor-manifest.json"
const VENDOR_MANIFEST_VERSION = 1

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
  /** Directory the vendor bundle and manifest are written to. Cleared before each build. */
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
  /** Every provided specifier, sorted, that the import map must resolve. */
  specifiers: string[]
  /** Specifier -> output file path relative to `outDir`. */
  imports: Record<string, string>
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
 */
export function providedVendorSpecifiers(uiPackageName: string = DEFAULT_UI_PACKAGE_NAME): string[] {
  const uiSubpaths = [
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
 * CSS specifiers that ship as side-effect imports. They are bundled as standalone
 * CSS assets (esbuild handles CSS natively) and still appear in the manifest so the
 * loader / import map can serve the hashed stylesheet.
 */
export function providedVendorCssSpecifiers(uiPackageName: string = DEFAULT_UI_PACKAGE_NAME): string[] {
  return [`${uiPackageName}/styles.css`]
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
 */
export async function buildVendor(options: BuildVendorOptions): Promise<BuildVendorResult> {
  const uiPackageName = options.uiPackageName ?? DEFAULT_UI_PACKAGE_NAME
  const dependencyRoot = resolve(options.dependencyRoot)
  const nodeModules = join(dependencyRoot, "node_modules")
  const outDir = resolve(options.outDir)

  const jsSpecifiers = providedVendorSpecifiers(uiPackageName)
  const cssSpecifiers = providedVendorCssSpecifiers(uiPackageName)

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

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
      outDir
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
        outDir
      }))
    }

    const outputFiles = await listEmittedFiles(outDir)
    const hash = await hashOutputs(outDir, outputFiles)
    const manifest: VendorManifest = {
      version: VENDOR_MANIFEST_VERSION,
      uiPackageName,
      hash,
      specifiers: [...jsSpecifiers, ...cssSpecifiers].sort(compareStrings),
      imports: sortRecord(imports)
    }
    const manifestPath = join(outDir, VENDOR_MANIFEST_FILENAME)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

    return { outDir, manifestPath, manifest, outputFiles }
  } finally {
    await rm(stubRoot, { recursive: true, force: true })
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
  // install). A resolver helper physically located there anchors `import.meta.resolve`
  // to that root while still honoring `import`/`exports` conditions (see resolver doc).
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

interface DependencyResolver {
  /** Resolve `specifier` to a file URL anchored at the dependency root. */
  resolve(specifier: string): string
  /** Remove the on-disk resolver helper. Safe to call once after the build. */
  cleanup(): Promise<void>
}

/**
 * Build a resolver anchored at the dependency root so export discovery (and the
 * generated facades) match the *shared install*, never the runtime's own
 * `node_modules`.
 *
 * `import.meta.resolve(specifier, parentUrl)` ignores its 2nd argument for module
 * resolution unless the calling module physically lives at that location, so a
 * synthetic parent URL silently resolves from the runtime's install instead. CJS
 * `createRequire(...).resolve(...)` would anchor correctly but throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` for the `import`-only `@avibe/show-ui/*` subpaths
 * (no `require`/`default` export condition). So we write a tiny ESM helper file
 * INTO the dependency root and import it: its `import.meta.resolve` is anchored at
 * the root *and* honors the `import`/`browser` export conditions.
 */
async function createDependencyResolver(dependencyRoot: string): Promise<DependencyResolver> {
  const helperPath = join(dependencyRoot, `.avibe-vendor-resolver-${randomUUID()}.mjs`)
  await writeFile(helperPath, "export const resolve = (specifier) => import.meta.resolve(specifier)\n", "utf8")
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    await rm(helperPath, { force: true })
  }
  try {
    const helper: { resolve(specifier: string): string } = await import(pathToFileURL(helperPath).href)
    return { resolve: (specifier) => helper.resolve(specifier), cleanup }
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
