import { readFile } from "node:fs/promises"
import { dirname, join, normalize, resolve, sep } from "node:path"
import { createHash } from "node:crypto"
import type { ServerResponse } from "node:http"
import type { Plugin } from "vite"
import {
  VENDOR_EMPTY_MODULE_FILENAME,
  VENDOR_URL_PREFIX,
  buildVendor,
  vendorBaseUrl,
  vendorBrowserAssets,
  type BuildVendorResult,
  type VendorBrowserAssets
} from "./vendor.js"

/**
 * The runtime is self-contained: it pre-builds the shared vendor bundle ONCE per
 * dependency root, serves its content-hashed assets over the runtime HTTP server at
 * a session-independent path, and injects a browser import map (+ stylesheet links)
 * into every served Show Page so a default page resolves `react`, `@avibe/show-ui/*`,
 * etc. to that one shared copy.
 */
export interface VendorBundle {
  result: BuildVendorResult
  /** Session-independent base URL the assets are served under (`/_show-runtime/vendor/<hash>`). */
  baseUrl: string
  /** Absolute URL of the shared empty JS module that neutralizes bare CSS imports. */
  emptyModuleUrl: string
  /** Import map + stylesheet hrefs for HTML injection. */
  assets: VendorBrowserAssets
}

const EMPTY_MODULE_SOURCE = "export default {}\n"

const DEFAULT_UI_PACKAGE_NAME = "@avibe/show-ui"

// One shared bundle per distinct build input set (cached so it builds once, not per
// session). Keyed by every input that affects the manifest/output — dependency root,
// UI package, AND vendor cache root (the on-disk location) — so a second runtime with
// the same root but a different UI package or cache dir doesn't reuse the wrong bundle.
// The promise is cached so concurrent warms await a single build.
const vendorBundles = new Map<string, Promise<VendorBundle>>()

export interface EnsureVendorBundleOptions {
  /** Resolved directory whose `node_modules` holds the shared, pinned install. */
  dependencyRoot: string
  /** Root the vendor output is written under (a hash-namespaced subdir per dependency root). */
  vendorCacheRoot: string
  uiPackageName?: string
}

/**
 * Build (or reuse the cached) shared vendor bundle for a dependency root. The build
 * runs once per dependency root for the lifetime of the process; identical inputs
 * also produce identical content hashes, so the on-disk output is safe to serve
 * immutable.
 */
export function ensureVendorBundle(options: EnsureVendorBundleOptions): Promise<VendorBundle> {
  const dependencyRoot = resolve(options.dependencyRoot)
  const uiPackageName = options.uiPackageName ?? DEFAULT_UI_PACKAGE_NAME
  const vendorCacheRoot = resolve(options.vendorCacheRoot)
  const cacheKey = `${dependencyRoot}\0${uiPackageName}\0${vendorCacheRoot}`
  const cached = vendorBundles.get(cacheKey)
  if (cached) return cached
  const built = buildVendorBundle(dependencyRoot, uiPackageName, vendorCacheRoot).catch((error) => {
    // Don't cache a failed build — let the next warm retry.
    if (vendorBundles.get(cacheKey) === built) vendorBundles.delete(cacheKey)
    throw error
  })
  vendorBundles.set(cacheKey, built)
  return built
}

async function buildVendorBundle(dependencyRoot: string, uiPackageName: string, vendorCacheRoot: string): Promise<VendorBundle> {
  // Namespace the on-disk output by dependency root AND UI package so two UI packages
  // under the same root never share an out dir (their manifests differ).
  const digest = createHash("sha256").update(`${dependencyRoot}\0${uiPackageName}`).digest("hex").slice(0, 16)
  const outDir = join(vendorCacheRoot, digest)
  const result = await buildVendor({ dependencyRoot, outDir, uiPackageName })
  const baseUrl = vendorBaseUrl(result.manifest.hash)
  const emptyModuleUrl = `${baseUrl}/${VENDOR_EMPTY_MODULE_FILENAME}`
  const assets = vendorBrowserAssets(result.manifest, { baseUrl, emptyModuleUrl })
  return { result, baseUrl, emptyModuleUrl, assets }
}

/** Whether `pathname` targets the shared vendor asset namespace. */
export function isVendorAssetPath(pathname: string): boolean {
  return pathname === VENDOR_URL_PREFIX || pathname.startsWith(`${VENDOR_URL_PREFIX}/`)
}

/**
 * Serve a shared vendor asset. Returns `true` once it has written a response (200 for
 * a known asset, 404 otherwise), `false` if the path is not a vendor asset path.
 */
export async function serveVendorAsset(bundle: VendorBundle, pathname: string, response: ServerResponse): Promise<boolean> {
  if (!isVendorAssetPath(pathname)) return false
  const prefix = `${bundle.baseUrl}/`
  if (!pathname.startsWith(prefix)) {
    sendVendor(response, 404, "text/plain; charset=utf-8", "Not found")
    return true
  }
  const relativePath = decodeURIComponent(pathname.slice(prefix.length))
  if (relativePath === VENDOR_EMPTY_MODULE_FILENAME) {
    sendVendor(response, 200, "text/javascript; charset=utf-8", EMPTY_MODULE_SOURCE)
    return true
  }
  // Resolve the file inside the output dir and reject any traversal back out of it.
  const fileOnDisk = resolve(bundle.result.outDir, ...relativePath.split("/"))
  const outDirPrefix = `${normalize(bundle.result.outDir)}${sep}`
  if (!bundle.result.outputFiles.includes(relativePath) || !`${fileOnDisk}`.startsWith(outDirPrefix)) {
    sendVendor(response, 404, "text/plain; charset=utf-8", "Not found")
    return true
  }
  try {
    const body = await readFile(fileOnDisk)
    sendVendor(response, 200, vendorContentType(relativePath), body)
  } catch {
    sendVendor(response, 404, "text/plain; charset=utf-8", "Not found")
  }
  return true
}

function vendorContentType(file: string): string {
  if (file.endsWith(".css")) return "text/css; charset=utf-8"
  return "text/javascript; charset=utf-8"
}

function sendVendor(response: ServerResponse, statusCode: number, contentType: string, body: string | Buffer) {
  response.statusCode = statusCode
  response.setHeader("content-type", contentType)
  if (statusCode === 200) {
    // Content-hashed path -> safe to cache forever.
    response.setHeader("cache-control", "public, max-age=31536000, immutable")
  }
  response.end(body)
}

/**
 * Inject the shared vendor wiring into every served Show Page, BEFORE the app's
 * module scripts: an `<script type="importmap">` so bare `react` / `@avibe/show-ui/*`
 * imports resolve to the shared bundle, and `<link rel="stylesheet">` tags for the
 * hashed vendor CSS. CSS specifiers map to the empty module (never `.css` as JS).
 * Wired in `warmSession` so the map reflects the bundle that session was warmed
 * against.
 */
export function vendorImportMapPlugin(bundle: VendorBundle): Plugin {
  const importMapJson = JSON.stringify({ imports: bundle.assets.importMap }, null, 2)
  return {
    name: "avibe-show-vendor-import-map",
    apply: "serve",
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "importmap" },
          children: importMapJson,
          injectTo: "head-prepend"
        },
        ...bundle.assets.styleHrefs.map((href) => ({
          tag: "link" as const,
          attrs: { rel: "stylesheet", href },
          injectTo: "head" as const
        }))
      ]
    }
  }
}

/**
 * Default vendor cache root for a dependency root.
 *
 * It must mirror where `viteCacheDir` puts the Vite optimize cache:
 *  - **No `cacheRoot`** (default): the Vite cache defaults to `<dependencyRoot>/.vite-cache`
 *    (INSIDE the app root, where the install lives). So the vendor output is its sibling
 *    `<dependencyRoot>/.show-vendor` — also inside the app root, which is writable in
 *    non-root / read-only-parent containers (e.g. an app installed at `/app`). The old
 *    derivation produced `/.show-vendor`, outside the app, which failed there.
 *  - **Explicit `cacheRoot`**: the runtime serves that dir straight to Vibe Remote and it
 *    must hold only per-dependency Vite namespaces, so the immutable vendor output lives
 *    as its sibling (`<cacheRoot-parent>/.show-vendor`), never inside it.
 */
export function defaultVendorCacheRoot(dependencyRoot: string, cacheRoot?: string): string {
  if (cacheRoot) {
    return join(dirname(resolve(cacheRoot)), ".show-vendor")
  }
  return join(resolve(dependencyRoot), ".show-vendor")
}
