import { readFile, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ServerResponse } from "node:http"

/**
 * Serve the annotation overlay bootstrap (phase 1 contract §7).
 *
 * The runtime serves a session-independent JS module at `/sessions/<id>/app/__show/annotation.js`
 * for EVERY session workspace (existing ones included — no scaffold change). The module and its
 * lazy code-split chunks are pre-built by `scripts/build-annotation-bootstrap.mjs` into
 * `dist/annotation/`; here we read + cache them and serve them off disk.
 */

const BOOTSTRAP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "annotation")

/** The stable entry filename the injected `<script type="module">` tag points at. */
export const ANNOTATION_BOOTSTRAP_ENTRY = "annotation.js"

// Only the entry + content-hashed chunks are ever served; matching the strict filename shape also
// forecloses path traversal (no slashes, no `..`).
const ANNOTATION_ASSET_PATH = /^\/__show\/([A-Za-z0-9._-]+\.js)$/

let assetCache: Promise<Map<string, Buffer>> | undefined

async function loadAssets(): Promise<Map<string, Buffer>> {
  const assets = new Map<string, Buffer>()
  let files: string[]
  try {
    files = await readdir(BOOTSTRAP_DIR)
  } catch {
    // A runtime built without the bootstrap step (or a partial checkout) simply serves nothing;
    // the injected tag 404s and the host page is unaffected.
    return assets
  }
  await Promise.all(
    files
      .filter((file) => file.endsWith(".js"))
      .map(async (file) => {
        try {
          assets.set(file, await readFile(join(BOOTSTRAP_DIR, file)))
        } catch {
          // Skip an unreadable asset rather than failing the whole load.
        }
      })
  )
  return assets
}

function annotationAssets(): Promise<Map<string, Buffer>> {
  assetCache ??= loadAssets()
  return assetCache
}

function annotationAssetName(appPath: string): string | undefined {
  return ANNOTATION_ASSET_PATH.exec(appPath)?.[1]
}

/** Whether an app path targets the annotation bootstrap entry or one of its code-split chunks. */
export function isAnnotationBootstrapPath(appPath: string): boolean {
  return annotationAssetName(appPath) !== undefined
}

/**
 * Serve the annotation bootstrap entry/chunk for `appPath`. Returns `true` once it has written a
 * response (200 for a known asset, 404 otherwise), `false` if the path is not a bootstrap path.
 * Session-independent, so callers serve it WITHOUT warming the session first.
 */
export async function serveAnnotationBootstrap(appPath: string, response: ServerResponse): Promise<boolean> {
  const name = annotationAssetName(appPath)
  if (!name) return false
  const body = (await annotationAssets()).get(name)
  if (!body) {
    response.statusCode = 404
    response.setHeader("content-type", "text/plain; charset=utf-8")
    response.end("Not found")
    return true
  }
  response.statusCode = 200
  response.setHeader("content-type", "text/javascript; charset=utf-8")
  // The entry filename is STABLE across releases, so ANY positive max-age is a deploy-blindness window:
  // browsers — and Cloudflare on the public tunnel, since the header is `public` — keep serving the old
  // bundle for the whole max-age after a deploy (owner hit this: three deploys, zero visible change).
  // Serve the entry `no-store` (matching the session module's dev-server semantics) so every load fetches
  // the current bundle; restore strong immutable caching once content-addressed chunking (avibe#950) gives
  // the entry a hashed URL. Content-hashed chunks already carry a hash in the name, so they stay immutable.
  response.setHeader(
    "cache-control",
    name === ANNOTATION_BOOTSTRAP_ENTRY ? "no-store" : "public, max-age=31536000, immutable"
  )
  response.end(body)
  return true
}
