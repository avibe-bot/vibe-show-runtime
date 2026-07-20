/**
 * Build the annotation overlay bootstrap module served at `/__show/annotation.js` (phase 1
 * contract §7). It mounts the SDK overlay in its own React root on any Show Page.
 *
 * The SDK overlay + control plane are bundled IN; the React family is left external so the
 * browser resolves it through the page's existing vendor import map — i.e. the overlay shares the
 * ONE runtime-managed React instance instead of forking its own.
 *
 * Emitted as a SINGLE self-contained module so the only served asset is exactly the frozen path
 * `{basePath}__show/annotation.js` (contract §7) — no sibling chunk files, which Lane A's proxy
 * does not guarantee to route. `splitting` is off, so esbuild inlines the SDK's lazy
 * `import("@zumer/snapdom")` into this file as a lazily-EVALUATED module: snapDOM's code is present
 * but its module init (and its heavy work) runs only on the first screenshot capture.
 */
import { build } from "esbuild"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// The built SDK react entry (build order guarantees @avibe/show-sdk is compiled first).
const sdkReactEntry = resolve(packageRoot, "..", "sdk", "dist", "react.js")
const outDir = join(packageRoot, "dist", "annotation")

// React specifiers resolved by the Show Page vendor import map (never bundled into the overlay).
const REACT_EXTERNALS = ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"]

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await build({
  stdin: {
    contents: [
      `import { mountAnnotationOverlay } from ${JSON.stringify(sdkReactEntry)}`,
      // Top-level guard: a mount failure must degrade silently and never break the host page.
      `try { mountAnnotationOverlay() } catch (error) { console.warn("[avibe-show] annotation bootstrap failed", error) }`,
      ""
    ].join("\n"),
    resolveDir: packageRoot,
    sourcefile: "annotation-entry.js",
    loader: "js"
  },
  bundle: true,
  format: "esm",
  splitting: false,
  platform: "browser",
  target: "es2022",
  outfile: join(outDir, "annotation.js"),
  external: REACT_EXTERNALS,
  minify: true,
  legalComments: "none",
  logLevel: "warning"
})

console.log(`Wrote annotation bootstrap to ${join(outDir, "annotation.js")}`)
