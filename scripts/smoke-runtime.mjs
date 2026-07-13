import { access, cp, lstat, mkdtemp, mkdir, readFile, readlink, readdir, realpath, symlink, utimes, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { join, relative } from "node:path"
import vm from "node:vm"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { isFileLoadingAllowed } from "vite"
import { showHmrTransitionPlugin } from "../packages/runtime/dist/hmr-transition-plugin.js"
import { startShowRuntimeServer } from "../packages/runtime/dist/server.js"
import { cn } from "../packages/ui/dist/utils.js"
import { dependencyFingerprint, pruneSupersededCacheDirs } from "../packages/runtime/dist/vendor.js"
import {
  assistantMarkEvent,
  formatShowEventMessage,
  humanAnnotationEvent,
  humanIntentEvent,
  normalizeShowEvent,
  showEventsStreamUrl
} from "../packages/sdk/dist/index.js"

globalThis.__AVIBE_SHOW__ = {
  basePath: "/show/smoke/",
  eventsPath: "__show/events",
  streamPath: "__show/events?stream=1",
  writeToken: "smoke-token"
}

const configuredStreamPath = showEventsStreamUrl()
if (configuredStreamPath !== "/show/smoke/__show/events?stream=1") {
  throw new Error(`Expected configured stream path, got ${configuredStreamPath}`)
}

const oldCreatedAt = "2026-01-01T00:00:00.000Z"
const oldUpdatedAt = "2026-01-01T00:01:00.000Z"
const updatedMark = assistantMarkEvent(
  {
    id: "mark_lifecycle",
    role: "assistant",
    scope: "default",
    target: "summary",
    body: "Updated.",
    status: "active",
    createdAt: oldCreatedAt,
    updatedAt: oldUpdatedAt,
    resolvedAt: ""
  },
  undefined,
  "smoke",
  "assistant.mark.updated"
)
if (updatedMark.createdAt === oldCreatedAt || updatedMark.mark.updatedAt === oldUpdatedAt) {
  throw new Error(`Expected mark update event to use the lifecycle time: ${JSON.stringify(updatedMark)}`)
}

const resolvedAnnotation = humanAnnotationEvent(
  "human.annotation.resolved",
  {
    id: "annotation_lifecycle",
    scope: "default",
    status: "pending",
    comment: "Old comment",
    createdAt: oldCreatedAt,
    updatedAt: oldUpdatedAt
  },
  undefined,
  "smoke"
)
if (resolvedAnnotation.createdAt === oldCreatedAt || resolvedAnnotation.annotation.updatedAt === oldUpdatedAt || resolvedAnnotation.annotation.resolvedAt !== resolvedAnnotation.createdAt) {
  throw new Error(`Expected annotation lifecycle event to use the current event time: ${JSON.stringify(resolvedAnnotation)}`)
}

const customIntent = normalizeShowEvent({
  id: "show_evt_custom",
  type: "human.intent.submitted",
  sessionId: "smoke",
  payload: { comment: "Ship it." },
  message: { role: "user", content: "Custom transcript." }
})
if (customIntent.message.content !== "Custom transcript.") {
  throw new Error(`Expected normalizeShowEvent to preserve caller message: ${JSON.stringify(customIntent)}`)
}

const directIntent = humanIntentEvent({ comment: "Direct." }, undefined, "smoke", undefined, { role: "user", content: "Direct custom." })
if (directIntent.message.content !== "Direct custom.") {
  throw new Error(`Expected humanIntentEvent to preserve supplied message: ${JSON.stringify(directIntent)}`)
}

const pageUpdateMessage = formatShowEventMessage(normalizeShowEvent({
  type: "assistant.page.updated",
  sessionId: "smoke",
  message: { role: "assistant", content: "Page custom transcript." }
}))
if (pageUpdateMessage !== "Page custom transcript.") {
  throw new Error(`Expected page updates to preserve supplied transcript message, got ${pageUpdateMessage}`)
}

const defaultHmrPlugin = showHmrTransitionPlugin()
const defaultHmrIndexHtml = defaultHmrPlugin.transformIndexHtml?.('<div id="root"></div><script type="module" src="/src/main.tsx"></script>')
const defaultHmrStyleTag = !Array.isArray(defaultHmrIndexHtml) && typeof defaultHmrIndexHtml === "object"
  ? defaultHmrIndexHtml.tags.find((tag) => tag.tag === "style")
  : undefined
if (!defaultHmrStyleTag?.children?.includes("avs-show-fallback-recovery-in 0.22s ease 5s forwards")) {
  throw new Error("Expected standalone runtime fallback recovery delay to default to 5 seconds")
}

const hmrPlugin = showHmrTransitionPlugin({ fallbackDelaySeconds: 30 })
const hmrClientCode = hmrPlugin.load?.("\0virtual:avibe-show-hmr-transition-client")
if (typeof hmrClientCode !== "string") {
  throw new Error("Expected HMR transition plugin to return client code")
}
const hmrIndexHtml = hmrPlugin.transformIndexHtml?.('<div id="root"></div><script type="module" src="/src/main.tsx"></script>')
const hmrIndexHtmlWithRootAttributes = hmrPlugin.transformIndexHtml?.('<div class="app" id="root"\n  data-app="show"></div><script type="module" src="/src/main.tsx"></script>')
const hmrLegacyAvsFallbackHtml = hmrPlugin.transformIndexHtml?.('<div id="root"></div><main class="avs-fallback">Legacy fallback</main><script type="module" src="/src/main.tsx"></script>')
const hmrStyleTag = !Array.isArray(hmrIndexHtml) && typeof hmrIndexHtml === "object"
  ? hmrIndexHtml.tags.find((tag) => tag.tag === "style")
  : undefined
if (
  Array.isArray(hmrIndexHtml) ||
  typeof hmrIndexHtml !== "object" ||
  !hmrIndexHtml.html.includes("avs-fallback-shell") ||
  !hmrIndexHtml.html.includes("Ready to visualize") ||
  !hmrStyleTag?.children?.includes("Loading Show Page") ||
  !hmrStyleTag.children.includes(".avs-fallback") ||
  hmrStyleTag.children.includes(".fallback-shell {") ||
  !hmrStyleTag.children.includes("avs-show-fallback-recovery-in 0.22s ease 30s forwards")
) {
  throw new Error("Expected runtime HTML transform to inject and delay the fallback recovery screen")
}
if (
  Array.isArray(hmrIndexHtmlWithRootAttributes) ||
  typeof hmrIndexHtmlWithRootAttributes !== "object" ||
  !hmrIndexHtmlWithRootAttributes.html.includes("avs-fallback-shell")
) {
  throw new Error("Expected runtime HTML transform to inject fallback recovery after root elements with attributes")
}
if (
  Array.isArray(hmrLegacyAvsFallbackHtml) ||
  typeof hmrLegacyAvsFallbackHtml !== "object" ||
  hmrLegacyAvsFallbackHtml.html.includes("avs-fallback-shell")
) {
  throw new Error("Expected runtime HTML transform to preserve legacy avs fallback markup without duplicate injection")
}
vm.runInNewContext(
  hmrClientCode.replace("const hot = import.meta.hot;", "const hot = undefined;"),
  {
    URLSearchParams,
    window: undefined,
    document: undefined,
    setTimeout,
    clearTimeout
  }
)

const root = await mkdtemp(join(tmpdir(), "avibe-show-runtime-"))
const cacheRoot = join(root, "runtime-cache")
const staleDependencyRoot = await mkdtemp(join(tmpdir(), "avibe-show-stale-deps-"))
await mkdir(join(staleDependencyRoot, "node_modules"), { recursive: true })
await mkdir(join(root, "smoke"), { recursive: true })
await mkdir(join(root, "smoke", "src"), { recursive: true })
const outsideHostFile = join(staleDependencyRoot, "host-secret")
await writeFile(outsideHostFile, "HOST_SECRET_36\n")
await symlink(outsideHostFile, join(root, "smoke", "src", "linked-outside.js"))
await writeFile(join(root, "smoke", "src", "symlink-import.ts"), `import secret from "./linked-outside.js"
export default secret
`)
await mkdir(join(root, "smoke", ".git"), { recursive: true })
await writeFile(join(root, "smoke", ".git", "HEAD"), "ref: refs/heads/private-history\n")
await mkdir(join(root, "smoke", "public", ".secrets"), { recursive: true })
await writeFile(join(root, "smoke", "public", "visible.txt"), "visible public asset\n")
await writeFile(join(root, "smoke", "public", ".env"), "PUBLIC_TOKEN=do-not-serve\n")
await writeFile(join(root, "smoke", "public", ".env.local"), "LOCAL_TOKEN=do-not-serve\n")
await writeFile(join(root, "smoke", "public", "client.pem"), "do-not-serve-pem\n")
await writeFile(join(root, "smoke", "public", "client.crt"), "do-not-serve-crt\n")
await writeFile(join(root, "smoke", "public", "client.key"), "do-not-serve-key\n")
await writeFile(join(root, "smoke", "public", ".secrets", "token.txt"), "do-not-serve-dot-segment\n")
await symlink("../.git/HEAD", join(root, "smoke", "public", "linked-git-head.txt"))
await symlink(".env", join(root, "smoke", "public", "linked-env.txt"))
await mkdir(join(root, "managed-git"), { recursive: true })
await writeFile(join(root, "managed-git", ".git"), "gitdir: /tmp/private-show-gitdir\n")
await symlink(join(staleDependencyRoot, "node_modules"), join(root, "smoke", "node_modules"), "junction")
const runtime = await startShowRuntimeServer({ workspaceRoot: root, cacheRoot, fallbackDelaySeconds: 30 })

try {
  const apiDir = join(root, "smoke", "api")
  await mkdir(apiDir, { recursive: true })
  await writeFile(join(apiDir, "health.ts"), `export function GET(_request, context) {
  return Response.json({ ok: true, sessionId: context.session.id })
}
`)

  const [ensure, secondEnsure] = await Promise.all([
    fetch(`${runtime.url}/sessions/smoke/ensure`, { method: "POST" }).then((res) => res.json()),
    fetch(`${runtime.url}/sessions/smoke-two/ensure`, { method: "POST" }).then((res) => res.json())
  ])
  if (ensure.state !== "active") {
    throw new Error(`Expected active session, got ${ensure.state}`)
  }
  if (secondEnsure.state !== "active") {
    throw new Error(`Expected second active session, got ${secondEnsure.state}`)
  }
  const smokeVite = runtime.runtime.getSession("smoke")?.vite
  const expectedDenyPatterns = ["**/.git", "**/.git/**", "**/.env", "**/.env.*", "**/*.pem", "**/*.crt", "**/*.key"]
  if (!smokeVite?.config.server.fs.strict || expectedDenyPatterns.some((pattern) => !smokeVite.config.server.fs.deny.includes(pattern))) {
    throw new Error(`Expected Vite fs.strict plus the runtime deny list, got ${JSON.stringify(smokeVite?.config.server.fs)}`)
  }
  const smokeCacheDir = runtime.runtime.getSession("smoke")?.cacheDir
  if (!smokeCacheDir || !isFileLoadingAllowed(smokeVite.config, smokeCacheDir)) {
    throw new Error(`Expected the exact session cache directory in Vite fs.allow, got ${JSON.stringify(smokeVite.config.server.fs.allow)}`)
  }
  if (isFileLoadingAllowed(smokeVite.config, join(root, "smoke", ".git", "HEAD"))) {
    throw new Error("Expected Vite fs.deny to take priority over the workspace fs.allow entry")
  }
  if (!isFileLoadingAllowed(smokeVite.config, join(root, "smoke", "public", "visible.txt"))) {
    throw new Error("Expected Vite fs policy to preserve normal workspace assets")
  }
  if (!isFileLoadingAllowed(smokeVite.config, join(process.cwd(), "packages", "ui", "dist", "button.js"))) {
    throw new Error("Expected dot-directory ancestors outside the workspace not to block allowed runtime dependencies")
  }
  const linkedNodeModules = await readlink(join(root, "smoke", "node_modules"))
  if (linkedNodeModules === join(staleDependencyRoot, "node_modules")) {
    throw new Error("Expected runtime to refresh stale session node_modules symlink")
  }

  const canonicalOutsideHostFile = await realpath(outsideHostFile)
  if (isFileLoadingAllowed(smokeVite.config, canonicalOutsideHostFile)) {
    throw new Error("Expected the resolved outside import to start outside Vite fs.allow")
  }
  const symlinkImporter = await fetch(`${runtime.url}/sessions/smoke/app/src/symlink-import.ts`).then(async (res) => ({
    status: res.status,
    body: await res.text()
  }))
  const emittedOutsideUrl = symlinkImporter.body.match(/["']([^"']*\/@fs\/[^"']*host-secret[^"']*)["']/)?.[1]
  const emittedOutsidePath = emittedOutsideUrl?.replace(/^\/show\/smoke\//, "/sessions/smoke/app/")
  if (symlinkImporter.status !== 200 || !emittedOutsidePath) {
    throw new Error(`Expected Vite to realpath the workspace symlink into an @fs import, got ${symlinkImporter.status}: ${symlinkImporter.body.slice(0, 200)}`)
  }
  if (!isFileLoadingAllowed(smokeVite.config, canonicalOutsideHostFile)) {
    throw new Error("Expected Vite safeModulePaths to trust the resolved outside import after transforming its importer")
  }
  const emittedOutsideResponse = await fetch(`${runtime.url}${emittedOutsidePath}`)
  const emittedOutsideBody = await emittedOutsideResponse.text()
  if (emittedOutsideResponse.status !== 404 || emittedOutsideBody.includes("HOST_SECRET_36")) {
    throw new Error(`Expected the runtime boundary to override Vite safeModulePaths, got ${emittedOutsideResponse.status}: ${emittedOutsideBody.slice(0, 160)}`)
  }
  const directSymlinkResponse = await fetch(`${runtime.url}/sessions/smoke/app${viteFsUrl(join(root, "smoke", "src", "linked-outside.js"))}`)
  const directSymlinkBody = await directSymlinkResponse.text()
  if (directSymlinkResponse.status !== 404 || directSymlinkBody.includes("HOST_SECRET_36")) {
    throw new Error(`Expected the direct workspace-symlink @fs form to stay denied, got ${directSymlinkResponse.status}: ${directSymlinkBody.slice(0, 160)}`)
  }

  const viteEnvPath = await realpath(join(process.cwd(), "node_modules", "vite", "dist", "client", "env.mjs"))
  const viteEnvResponse = await fetch(`${runtime.url}/sessions/smoke/app${viteFsUrl(viteEnvPath)}`)
  const viteEnvBody = await viteEnvResponse.text()
  if (viteEnvResponse.status !== 200 || !viteEnvBody.includes("const defines")) {
    throw new Error(`Expected Vite env.mjs under the discovered dependency root to remain servable, got ${viteEnvResponse.status}: ${viteEnvBody.slice(0, 160)}`)
  }

  const handler = await fetch(`${runtime.url}/sessions/smoke/app/api/health`).then((res) => res.json())
  if (!handler.ok || handler.sessionId !== "smoke") {
    throw new Error(`Unexpected handler response: ${JSON.stringify(handler)}`)
  }

  const app = await fetch(`${runtime.url}/sessions/smoke/app/`).then((res) => res.text())
  if (!app.includes("Vibe Show")) {
    throw new Error("Expected app HTML to include Vibe Show")
  }
  if (!app.includes("Loading Show Page") || !app.includes("Ready to visualize") || !app.includes("avs-show-fallback-recovery-in 0.22s ease 30s forwards")) {
    throw new Error("Expected app HTML to include runtime-injected delayed fallback recovery UI")
  }
  if (!app.includes('/show/smoke/@vite/client') || !app.includes('/show/smoke/src/main.tsx')) {
    throw new Error("Expected app HTML asset URLs to stay under /show/<session>/")
  }
  const visibleAsset = await fetch(`${runtime.url}/sessions/smoke/app/visible.txt`)
  if (visibleAsset.status !== 200 || (await visibleAsset.text()) !== "visible public asset\n") {
    throw new Error(`Expected a normal public asset to remain servable, got ${visibleAsset.status}`)
  }
  const deniedWorkspacePaths = [
    ["self-managed .git directory", "/sessions/smoke/app/.git/HEAD", "private-history"],
    ["managed .git pointer", "/sessions/managed-git/app/.git", "private-show-gitdir"],
    ["public .env", "/sessions/smoke/app/.env", "PUBLIC_TOKEN"],
    ["public .env variant", "/sessions/smoke/app/.env.local", "LOCAL_TOKEN"],
    ["public PEM credential", "/sessions/smoke/app/client.pem", "do-not-serve-pem"],
    ["public certificate", "/sessions/smoke/app/client.crt", "do-not-serve-crt"],
    ["public private key", "/sessions/smoke/app/client.key", "do-not-serve-key"],
    ["public dot-segment", "/sessions/smoke/app/.secrets/token.txt", "do-not-serve-dot-segment"],
    ["public symlink to .git", "/sessions/smoke/app/linked-git-head.txt", "private-history"],
    ["public symlink to .env", "/sessions/smoke/app/linked-env.txt", "PUBLIC_TOKEN"],
    ["real-path @fs dot-segment", `/sessions/smoke/app/@fs/${await realpath(join(root, "smoke"))}/public/.secrets/token.txt`, "do-not-serve-dot-segment"]
  ]
  for (const [label, path, secret] of deniedWorkspacePaths) {
    const response = await fetch(`${runtime.url}${path}`)
    const body = await response.text()
    if (![403, 404].includes(response.status) || body.includes(secret)) {
      throw new Error(`Expected ${label} to be denied, got ${response.status}: ${body.slice(0, 160)}`)
    }
  }
  const encodedTraversal = await rawHttpGet(runtime.url, "/sessions/smoke/app/src/%2e%2e/.git/HEAD")
  if (![403, 404].includes(encodedTraversal.status) || encodedTraversal.body.includes("private-history")) {
    throw new Error(`Expected encoded traversal into .git to be denied, got ${encodedTraversal.status}: ${encodedTraversal.body.slice(0, 160)}`)
  }
  // Shared vendor: the served HTML must inject a JS import map (BEFORE the app module
  // script) mapping the provided specifiers to the session-independent vendor path,
  // plus a <link> for the hashed vendor stylesheet. CSS must NOT be a JS import-map
  // target (it maps to an empty module instead).
  if (!/<script type="importmap">/.test(app)) {
    throw new Error("Expected served HTML to inject a JS import map for the shared vendor bundle")
  }
  if (!/"react"\s*:\s*"\/_show-runtime\/vendor\//.test(app) || !/"@avibe\/show-ui\/button"\s*:\s*"\/_show-runtime\/vendor\//.test(app)) {
    throw new Error(`Expected import map to resolve provided specifiers to /_show-runtime/vendor/, got: ${app.slice(app.indexOf("importmap"), app.indexOf("importmap") + 600)}`)
  }
  if (/"@avibe\/show-ui\/styles\.css"\s*:\s*"\/_show-runtime\/vendor\/[^"]*\.css"/.test(app) || !/"@avibe\/show-ui\/styles\.css"\s*:\s*"[^"]*__empty\.js"/.test(app)) {
    throw new Error("Expected the CSS specifier to map to the empty module, never to a .css URL in the JS import map")
  }
  if (!/<link[^>]+rel="stylesheet"[^>]+href="\/_show-runtime\/vendor\/[^"]+\.css"/.test(app) && !/<link[^>]+href="\/_show-runtime\/vendor\/[^"]+\.css"[^>]+rel="stylesheet"/.test(app)) {
    throw new Error("Expected served HTML to inject a <link rel=stylesheet> for the hashed vendor CSS")
  }
  if (app.indexOf('type="importmap"') > app.indexOf('src="/show/smoke/src/main.tsx"')) {
    throw new Error("Expected the import map to be injected before the app module script")
  }
  // The vendor assets are served at a session-independent, absolute path and are
  // byte-identical for a different session (one shared, cacheable copy).
  const vendorReactUrl = app.match(/"react"\s*:\s*"(\/_show-runtime\/vendor\/[^"]+)"/)[1]
  const vendorReact = await fetch(`${runtime.url}${vendorReactUrl}`)
  if (vendorReact.status !== 200 || !(vendorReact.headers.get("content-type") || "").includes("javascript")) {
    throw new Error(`Expected vendor react asset served as JS, got ${vendorReact.status} ${vendorReact.headers.get("content-type")}`)
  }
  if (!(vendorReact.headers.get("cache-control") || "").includes("immutable")) {
    throw new Error("Expected content-hashed vendor asset to be served with an immutable cache-control")
  }
  const secondVendorApp = await fetch(`${runtime.url}/sessions/smoke-two/app/`).then((res) => res.text())
  if (secondVendorApp.match(/"react"\s*:\s*"(\/_show-runtime\/vendor\/[^"]+)"/)?.[1] !== vendorReactUrl) {
    throw new Error("Expected two sessions to reference the same session-independent vendor react URL")
  }
  await fetch(`${runtime.url}/sessions/smoke/app/src/main.tsx`).then(async (res) => {
    if (!res.ok) {
      throw new Error(`Expected session source module to load, got ${res.status}`)
    }
    const body = await res.text()
    if (!/from\s*"react"/.test(body) || !/from\s*"react-dom\/client"/.test(body)) {
      throw new Error("Expected the externalized session module to keep react / react-dom/client bare for the import map")
    }
    if (!/import\s*"@avibe\/show-ui\/styles\.css"/.test(body) || /styles\.css\?import/.test(body) || /show-ui\.css/.test(body)) {
      throw new Error("Expected the CSS import to stay bare (resolved to the empty module), never fetched as JS")
    }
  })
  const buttonModule = await fetch(`${runtime.url}/sessions/smoke/app/@fs/${process.cwd()}/packages/ui/dist/button.js`).then(async (res) => ({
    status: res.status,
    body: await res.text()
  }))
  if (buttonModule.status !== 200 || !buttonModule.body.includes("animated-text.js")) {
    throw new Error(`Expected @avibe/show-ui workspace modules to load, got ${buttonModule.status}`)
  }
  const animatedTextModule = await fetch(`${runtime.url}/sessions/smoke/app/@fs/${process.cwd()}/packages/ui/dist/animated-text.js`).then(async (res) => ({
    status: res.status,
    body: await res.text()
  }))
  if (animatedTextModule.status !== 200 || !animatedTextModule.body.includes("AnimatedText")) {
    throw new Error(`Expected @avibe/show-ui transitive workspace modules to load, got ${animatedTextModule.status}`)
  }
  const linkedButtonModule = await fetch(`${runtime.url}/sessions/smoke/app/@fs/${process.cwd()}/node_modules/@avibe/show-ui/dist/button.js`).then(async (res) => ({
    status: res.status,
    body: await res.text()
  }))
  if (linkedButtonModule.status !== 200 || !linkedButtonModule.body.includes("animated-text.js")) {
    throw new Error(`Expected @avibe/show-ui package symlink modules to load, got ${linkedButtonModule.status}`)
  }
  const projectRootModule = await fetch(`${runtime.url}/sessions/smoke/app/@fs/${process.cwd()}/package.json`).then(async (res) => ({
    status: res.status,
    body: await res.text()
  }))
  if (projectRootModule.status !== 404 || projectRootModule.body.includes('"name": "vibe-show-runtime"')) {
    throw new Error(`Expected project root files to stay outside the runtime boundary, got ${projectRootModule.status}`)
  }
  await access(cacheRoot)
  const cacheDigestDirs = await readdir(cacheRoot)
  if (cacheDigestDirs.length !== 1) {
    throw new Error(`Expected one dependency cache namespace, got ${cacheDigestDirs.join(", ")}`)
  }
  const sharedCacheDir = join(cacheRoot, cacheDigestDirs[0])
  await access(join(sharedCacheDir, "deps"))
  const cacheEntries = await readdir(sharedCacheDir)
  if (cacheEntries.includes("smoke") || cacheEntries.includes("smoke-two")) {
    throw new Error(`Expected Vite optimized dependency cache to be shared across sessions, got ${cacheEntries.join(", ")}`)
  }
  try {
    await access(join(root, "smoke", "node_modules", ".vite"))
    throw new Error("Expected Vite optimized dependency cache to stay out of the session workspace")
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }
  const generatedIndex = await readFile(join(root, "smoke", "index.html"), "utf8")
  if (generatedIndex.includes("Ready to visualize") || generatedIndex.includes("Loading Show Page") || generatedIndex.includes("avs-fallback-shell")) {
    throw new Error("Expected generated index.html to stay a clean app shell")
  }
  const generatedMain = await readFile(join(root, "smoke", "src", "main.tsx"), "utf8")
  if (!generatedMain.includes('import "./show-runtime-config"') || generatedMain.indexOf('import "./show-runtime-config"') > generatedMain.indexOf('import App from "./App"')) {
    throw new Error("Expected generated client shell to initialize runtime config before importing App")
  }
  const generatedConfig = await readFile(join(root, "smoke", "src", "show-runtime-config.ts"), "utf8")
  if (!generatedConfig.includes("basePath: injected.basePath ?? showBasePath()")) {
    throw new Error("Expected generated client shell to preserve injected runtime config")
  }
  if (!generatedConfig.includes("writeToken: injected.writeToken")) {
    throw new Error("Expected generated client shell to preserve injected write tokens")
  }

  await writeFile(join(root, "smoke", "src", "draft.ts"), `import "missing-draft-only-package"
export const draft = true
`)
  await writeFile(join(root, "smoke", "src", "types.ts"), `import type { MissingType } from "missing-type-only-package"
export type SmokeType = MissingType
`)
  await writeFile(join(root, "smoke", "src", "extra-dep.ts"), `import type { SmokeType } from "./types"
import stackback from "stackback"
import formatStack from "stackback/formatstack"
import { workerDep } from "./worker.ts?worker"
import { absoluteDep } from "/src/root-absolute.ts"
import rawExample from "./raw-example.ts?raw"
import type {} from "missing-export-type-package"
import { type InlineMissingType } from "missing-inline-type-only-package"
export { type InlineMissingExportType } from "missing-inline-export-type-only-package"
const eagerPages = import.meta.glob("./pages/*.tsx", { eager: true })
// import "missing-commented-only-package"
/* import "missing-block-comment-only-package" */
const snippet = 'import "missing-string-only-package"'
const templateSnippet = \`require("missing-template-only-package")\`
export const stackDepth = stackback().length
export const formattedStack = formatStack([])
export const workerDependency = workerDep
export const rootAbsoluteDependency = absoluteDep
export const snippets = [snippet, templateSnippet, rawExample, eagerPages]
export type { SmokeType }
`)
  await writeFile(join(root, "smoke", "src", "worker.ts"), `import { nanoid } from "nanoid/non-secure"

export const workerDep = nanoid
`)
  await writeFile(join(root, "smoke", "src", "root-absolute.ts"), `import pc from "picocolors"

export const absoluteDep = pc.green
`)
  await mkdir(join(root, "smoke", "src", "pages"), { recursive: true })
  await writeFile(join(root, "smoke", "src", "pages", "globbed.tsx"), `import MagicString from "magic-string"

export const globbedDependency = MagicString
`)
  await writeFile(join(root, "smoke", "src", "raw-example.ts"), `import "missing-raw-only-package"

export const rawOnly = true
`)
  await writeFile(join(root, "smoke", "src", "App.tsx"), `import { stackDepth } from "./extra-dep"

export default function App() {
  return <main>Stack depth: {stackDepth}</main>
}
`)
  const extraDepModule = await fetch(`${runtime.url}/sessions/smoke/app/src/extra-dep.ts?t=1`).then(async (res) => ({
    status: res.status,
    body: await res.text()
  }))
  if (extraDepModule.status !== 200 || !extraDepModule.body.includes("/deps/stackback.js")) {
    throw new Error(`Expected extra page dependency to be optimized, got ${extraDepModule.status}: ${extraDepModule.body.slice(0, 200)}`)
  }
  const optimizedStackbackUrl = extraDepModule.body.match(/["']([^"']*\/deps\/stackback\.js[^"']*)["']/)?.[1]
  const optimizedStackbackPath = optimizedStackbackUrl?.replace(/^\/show\/smoke\//, "/sessions/smoke/app/")
  const optimizedStackback = optimizedStackbackPath ? await fetch(`${runtime.url}${optimizedStackbackPath}`) : undefined
  if (!optimizedStackbackUrl || !optimizedStackback || optimizedStackback.status !== 200 || !(await optimizedStackback.text()).includes("stackback")) {
    throw new Error(`Expected optimized dependency URL to remain servable, got ${optimizedStackbackUrl ?? "missing URL"} (${optimizedStackback?.status ?? "no response"})`)
  }
  if (!extraDepModule.body.includes("/deps/stackback_formatstack.js")) {
    throw new Error(`Expected deep bare imports to stay optimized by full specifier, got: ${extraDepModule.body.slice(0, 300)}`)
  }
  if (
    extraDepModule.body.includes("missing-type-only-package") ||
    extraDepModule.body.includes("missing-draft-only-package") ||
    extraDepModule.body.includes("missing-commented-only-package") ||
    extraDepModule.body.includes("missing-block-comment-only-package") ||
    extraDepModule.body.includes("missing-inline-type-only-package") ||
    extraDepModule.body.includes("missing-inline-export-type-only-package")
  ) {
    throw new Error(`Expected unreachable, type-only, and commented imports to stay out of optimizer output: ${extraDepModule.body.slice(0, 300)}`)
  }
  const updatedCacheDigestDirs = await readdir(cacheRoot)
  if (updatedCacheDigestDirs.length < 2) {
    throw new Error(`Expected extra page dependencies to use a dedicated cache namespace, got ${updatedCacheDigestDirs.join(", ")}`)
  }
  const extraCacheDigestDir = updatedCacheDigestDirs.find((dir) => dir !== cacheDigestDirs[0])
  const extraCacheDeps = extraCacheDigestDir ? await readdir(join(cacheRoot, extraCacheDigestDir, "deps")) : []
  if (!extraCacheDeps.some((entry) => entry.startsWith("nanoid_non-secure"))) {
    throw new Error(`Expected Vite query imports to scan reachable worker dependencies, got cache deps: ${extraCacheDeps.join(", ")}`)
  }
  if (!extraCacheDeps.some((entry) => entry.startsWith("picocolors"))) {
    throw new Error(`Expected root-absolute imports to scan reachable source dependencies, got cache deps: ${extraCacheDeps.join(", ")}`)
  }
  if (!extraCacheDeps.some((entry) => entry.startsWith("magic-string"))) {
    throw new Error(`Expected Vite glob imports to scan reachable source dependencies, got cache deps: ${extraCacheDeps.join(", ")}`)
  }
  if (
    extraCacheDeps.some((entry) =>
      entry.startsWith("missing-string-only-package") ||
      entry.startsWith("missing-template-only-package") ||
      entry.startsWith("missing-raw-only-package")
    )
  ) {
    throw new Error(`Expected import-like string literals and raw imports to stay out of optimized deps, got cache deps: ${extraCacheDeps.join(", ")}`)
  }

  await writeFile(join(root, "smoke", "index.html"), `<div id="root"></div><!-- <script type="module" src="/src/commented-demo.tsx"></script> --><script type="module" src="/src/demo.tsx"></script>`)
  await writeFile(join(root, "smoke", "src", "main.tsx"), `import "missing-unused-main-package"
`)
  await writeFile(join(root, "smoke", "src", "demo.tsx"), `import { customAlphabet } from "nanoid"

export const demo = customAlphabet("abc")
`)
  await writeFile(join(root, "smoke", "src", "commented-demo.tsx"), `import "missing-commented-html-entry-package"
`)
  const customEntryEnsure = await fetch(`${runtime.url}/sessions/smoke/ensure`, { method: "POST" }).then((res) => res.json())
  if (customEntryEnsure.state !== "active") {
    throw new Error(`Expected custom HTML entry session to stay active, got ${JSON.stringify(customEntryEnsure)}`)
  }
  const customEntryCacheDigestDirs = await readdir(cacheRoot)
  const customEntryCacheDir = customEntryCacheDigestDirs.find((dir) => !updatedCacheDigestDirs.includes(dir))
  const customEntryCacheDeps = customEntryCacheDir ? await readdir(join(cacheRoot, customEntryCacheDir, "deps")) : []
  if (!customEntryCacheDeps.some((entry) => entry.startsWith("nanoid"))) {
    throw new Error(`Expected customized HTML entries to scan their dependencies, got cache deps: ${customEntryCacheDeps.join(", ")}`)
  }
  if (
    customEntryCacheDeps.some((entry) =>
      entry.startsWith("missing-unused-main-package") ||
      entry.startsWith("missing-commented-html-entry-package")
    )
  ) {
    throw new Error(`Expected custom HTML warmup to ignore unused and commented entries, got cache deps: ${customEntryCacheDeps.join(", ")}`)
  }

  const eventResponse = await fetch(`${runtime.url}/sessions/smoke/app/__show/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "assistant.mark.created",
      mark: {
        target: "mark-default-summary",
        body: "Please review the summary again."
      }
    })
  }).then((res) => res.json())
  const event = eventResponse.event ?? eventResponse
  if (event.type !== "assistant.mark.created" || !event.message?.content.includes("[agent-mark:default] mark-default-summary")) {
    throw new Error(`Unexpected mark event: ${JSON.stringify(event)}`)
  }

  const intentResponse = await fetch(`${runtime.url}/sessions/smoke/app/__show/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "human.intent.submitted",
      payload: {
        component: "decision",
        intent: "choose",
        value: "approve",
        comment: "Ship this direction.",
        dispatch: true
      },
      anchor: {
        kind: "mark",
        scope: "default",
        mark: "summary",
        selector: "[mark-default=\"summary\"]"
      }
    })
  }).then((res) => res.json())
  if (intentResponse.event?.type !== "human.intent.submitted" || !intentResponse.event.message?.content.includes("[show-intent:default] choose")) {
    throw new Error(`Unexpected intent event: ${JSON.stringify(intentResponse)}`)
  }

  const annotationResponse = await fetch(`${runtime.url}/sessions/smoke/app/__show/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "human.annotation.created",
      annotation: {
        intent: "question",
        severity: "important",
        comment: "Clarify this claim.",
        anchor: {
          kind: "text-range",
          scope: "default",
          textQuote: "summary",
          selector: "[mark-default=\"summary\"]",
          rect: { x: 10, y: 20, width: 120, height: 24 }
        }
      }
    })
  }).then((res) => res.json())
  if (annotationResponse.event?.type !== "human.annotation.created" || !annotationResponse.event.message?.content.includes("[show-annotation:default:created] question")) {
    throw new Error(`Unexpected annotation event: ${JSON.stringify(annotationResponse)}`)
  }

  const invalidResponse = await fetch(`${runtime.url}/sessions/smoke/app/__show/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "human.annotation.unknown",
      annotation: { comment: "bad" }
    })
  })
  if (invalidResponse.status !== 400) {
    throw new Error(`Expected invalid show event to return 400, got ${invalidResponse.status}`)
  }

  const messages = await fetch(`${runtime.url}/sessions/smoke/messages`).then((res) => res.json())
  if (!messages.messages?.[0]?.content.includes("Please review the summary again.")) {
    throw new Error(`Expected assistant mark message to be recorded: ${JSON.stringify(messages)}`)
  }
  if (!messages.messages?.some((message) => message.role === "user" && message.content.includes("Clarify this claim."))) {
    throw new Error(`Expected human annotation message to be recorded: ${JSON.stringify(messages)}`)
  }

  const status = await fetch(`${runtime.url}/sessions/smoke/status`).then((res) => res.json())
  if (status.messageCount !== 3 || status.eventCount !== 3) {
    throw new Error(`Expected show event counters in status: ${JSON.stringify(status)}`)
  }

  const idleRoot = await mkdtemp(join(tmpdir(), "avibe-show-runtime-idle-"))
  const idleApiDir = join(idleRoot, "idle", "api")
  const unrelatedIdleApiDir = join(idleRoot, "unrelated-idle", "api")
  await mkdir(idleApiDir, { recursive: true })
  await mkdir(unrelatedIdleApiDir, { recursive: true })
  await writeFile(join(idleApiDir, "slow.ts"), `export async function GET() {
    await new Promise((resolve) => setTimeout(resolve, 300))
    return Response.json({ ok: true })
  }
`)
  await writeFile(join(unrelatedIdleApiDir, "slow.ts"), `export async function GET() {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return Response.json({ ok: true })
  }
`)
  const idleRuntime = await startShowRuntimeServer({ workspaceRoot: idleRoot, idleTtlMs: 100, idlePruneIntervalMs: 0 })
  try {
    const active = await loadAppEntry(idleRuntime.url, "idle")
    const unrelatedActive = await loadAppEntry(idleRuntime.url, "unrelated-idle")
    if (!active.includes("Vibe Show")) {
      throw new Error("Expected idle test app HTML to load")
    }
    if (!unrelatedActive.includes("Vibe Show")) {
      throw new Error("Expected unrelated idle test app HTML to load")
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    const idleStatus = await fetch(`${idleRuntime.url}/sessions/idle/status`).then((res) => res.json())
    if (idleStatus.state !== "idle") {
      throw new Error(`Expected idle session to prune to idle, got ${JSON.stringify(idleStatus)}`)
    }
    const rewarmed = await loadAppEntry(idleRuntime.url, "idle")
    if (!rewarmed.includes("Vibe Show")) {
      throw new Error("Expected idle session to rewarm after prune")
    }
    const activeAgain = await fetch(`${idleRuntime.url}/sessions/idle/status`).then((res) => res.json())
    if (activeAgain.state !== "active") {
      throw new Error(`Expected re-warmed idle session to be active, got ${JSON.stringify(activeAgain)}`)
    }

    const slow = fetch(`${idleRuntime.url}/sessions/idle/app/api/slow`).then((res) => res.json())
    await new Promise((resolve) => setTimeout(resolve, 150))
    const pruning = fetch(`${idleRuntime.url}/sessions/idle/status`).then((res) => res.json())
    await new Promise((resolve) => setTimeout(resolve, 25))
    const concurrentApp = fetch(`${idleRuntime.url}/sessions/idle/app/`).then((res) => res.text())
    const [slowResponse, , concurrentHtml] = await Promise.all([slow, pruning, concurrentApp])
    if (!slowResponse.ok || !concurrentHtml.includes("Vibe Show")) {
      throw new Error("Expected concurrent idle prune access to complete")
    }
    const concurrentStatus = await fetch(`${idleRuntime.url}/sessions/idle/status`).then((res) => res.json())
    if (concurrentStatus.state !== "active") {
      throw new Error(`Expected concurrent access during prune to leave session active, got ${JSON.stringify(concurrentStatus)}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 150))
    const unrelatedSlow = fetch(`${idleRuntime.url}/sessions/unrelated-idle/app/api/slow`).then((res) => res.json())
    await new Promise((resolve) => setTimeout(resolve, 150))
    const scopedStatusStarted = performance.now()
    const scopedStatus = await fetch(`${idleRuntime.url}/sessions/idle/status`).then((res) => res.json())
    const scopedStatusDurationMs = performance.now() - scopedStatusStarted
    if (scopedStatusDurationMs > 500) {
      throw new Error(`Expected scoped idle status pruning not to wait on unrelated sessions, took ${Math.round(scopedStatusDurationMs)}ms`)
    }
    if (scopedStatus.state !== "idle") {
      throw new Error(`Expected scoped idle status to prune the requested session only, got ${JSON.stringify(scopedStatus)}`)
    }
    const unrelatedAfterStatus = await fetch(`${idleRuntime.url}/sessions/unrelated-idle/status`).then((res) => res.json())
    if (unrelatedAfterStatus.state !== "idle") {
      throw new Error(`Expected unrelated session to stay independently prunable, got ${JSON.stringify(unrelatedAfterStatus)}`)
    }
    const unrelatedSlowResponse = await unrelatedSlow
    if (!unrelatedSlowResponse.ok) {
      throw new Error("Expected unrelated slow request to complete")
    }

    const unrelatedSlowForAppRequest = fetch(`${idleRuntime.url}/sessions/unrelated-idle/app/api/slow`).then((res) => res.json())
    await new Promise((resolve) => setTimeout(resolve, 150))
    const scopedAppStarted = performance.now()
    const scopedAppHtml = await fetch(`${idleRuntime.url}/sessions/idle/app/`).then((res) => res.text())
    const scopedAppDurationMs = performance.now() - scopedAppStarted
    if (scopedAppDurationMs > 500) {
      throw new Error(`Expected app requests not to wait on unrelated idle pruning, took ${Math.round(scopedAppDurationMs)}ms`)
    }
    if (!scopedAppHtml.includes("Vibe Show")) {
      throw new Error("Expected scoped app request to complete while unrelated slow request is active")
    }
    const unrelatedSlowForAppResponse = await unrelatedSlowForAppRequest
    if (!unrelatedSlowForAppResponse.ok) {
      throw new Error("Expected unrelated slow request during app request to complete")
    }
  } finally {
    await idleRuntime.close()
  }

  const streamController = new AbortController()
  const stream = await fetch(`${runtime.url}/sessions/smoke/app/__show/events?stream=1`, {
    signal: streamController.signal
  })
  if (!stream.ok || !stream.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error(`Expected SSE stream response, got ${stream.status} ${stream.headers.get("content-type")}`)
  }
  const reader = stream.body.getReader()
  try {
    const firstFrame = await readUntil(reader, "event: show.event")
    if (!firstFrame.includes(`id: ${event.id}`)) {
      throw new Error(`Expected SSE event id for replayed mark: ${firstFrame}`)
    }
    if (!firstFrame.includes("Please review the summary again.")) {
      throw new Error(`Expected replayed mark event in SSE stream: ${firstFrame}`)
    }

    await fetch(`${runtime.url}/sessions/smoke/app/__show/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "assistant.mark.created",
        mark: {
          target: "mark-default-live",
          body: "Live event should reach the stream."
        }
      })
    })
    const liveFrame = await readUntil(reader, "mark-default-live")
    const liveEvent = JSON.parse(liveFrame.split("data: ")[1].split("\n\n")[0])
    if (!liveFrame.includes(`id: ${liveEvent.id}`)) {
      throw new Error(`Expected SSE event id for live mark: ${liveFrame}`)
    }
    if (!liveFrame.includes("Live event should reach the stream.")) {
      throw new Error(`Expected live mark event in SSE stream: ${liveFrame}`)
    }
  } finally {
    streamController.abort()
    try {
      await reader.cancel()
    } catch {
      // the abort above may already close the reader
    }
  }

  const resumeController = new AbortController()
  const resumedStream = await fetch(`${runtime.url}/sessions/smoke/app/__show/events?stream=1`, {
    headers: { "Last-Event-ID": event.id },
    signal: resumeController.signal
  })
  const resumedReader = resumedStream.body.getReader()
  try {
    const resumedFrame = await readUntil(resumedReader, "mark-default-live")
    if (resumedFrame.includes("Please review the summary again.")) {
      throw new Error(`Expected resumed stream to skip prior event: ${resumedFrame}`)
    }
  } finally {
    resumeController.abort()
    try {
      await resumedReader.cancel()
    } catch {
      // the abort above may already close the reader
    }
  }

  const queryResumeController = new AbortController()
  const queryResumedStream = await fetch(`${runtime.url}/sessions/smoke/app/__show/events?stream=1&after_id=${encodeURIComponent(event.id)}`, {
    signal: queryResumeController.signal
  })
  const queryResumedReader = queryResumedStream.body.getReader()
  try {
    const queryResumedFrame = await readUntil(queryResumedReader, "mark-default-live")
    if (queryResumedFrame.includes("Please review the summary again.")) {
      throw new Error(`Expected after_id stream to skip prior event: ${queryResumedFrame}`)
    }
  } finally {
    queryResumeController.abort()
    try {
      await queryResumedReader.cancel()
    } catch {
      // the abort above may already close the reader
    }
  }

  // --- Tailwind built-in capability -------------------------------------------------
  // Tailwind v4 ships as a built-in: `src/styles.css` opts in with `@import "tailwindcss";`
  // and the Vite plugin scans the workspace for utility classes. These are the regression
  // that catches a Show Page rendering silently unstyled (utilities dropped, zero errors).

  // (1) A NEW workspace: the template writes styles.css with the import already at the top,
  // and utilities used in App.tsx must appear in the served/transformed CSS.
  await mkdir(join(root, "tailwind", "src"), { recursive: true })
  await writeFile(join(root, "tailwind", "src", "App.tsx"), `export default function App() {
  return (
    <main className="flex min-h-screen items-center justify-center gap-4 p-6">
      <div className="rounded-xl bg-white p-6 shadow-lg">Tailwind is built in</div>
    </main>
  )
}
`)
  const tailwindEnsure = await fetch(`${runtime.url}/sessions/tailwind/ensure`, { method: "POST" }).then((res) => res.json())
  if (tailwindEnsure.state !== "active") {
    throw new Error(`Expected Tailwind session to warm active, got ${JSON.stringify(tailwindEnsure)}`)
  }
  const tailwindStyles = await readFile(join(root, "tailwind", "src", "styles.css"), "utf8")
  if (!tailwindStyles.startsWith(`@import "tailwindcss";`)) {
    throw new Error(`Expected new workspace styles.css to lead with the Tailwind import, got ${JSON.stringify(tailwindStyles.slice(0, 40))}`)
  }
  const tailwindCss = await fetch(`${runtime.url}/sessions/tailwind/app/src/styles.css?direct`).then((res) => res.text())
  for (const rule of [".flex", ".p-6", ".items-center", ".gap-4", ".rounded-xl"]) {
    if (!tailwindCss.includes(rule)) {
      throw new Error(`Expected served Tailwind CSS to include the "${rule}" utility used by App.tsx (silently unstyled otherwise)`)
    }
  }
  if (!/@layer base\s*\{/.test(tailwindCss)) {
    throw new Error("Expected Tailwind preflight inside @layer base so unlayered @avibe/show-ui component CSS still wins")
  }

  // (2) A PRE-EXISTING workspace whose styles.css predates the built-in pipeline: the
  // runtime idempotently prepends the import on warm so utilities work without a rescaffold.
  await mkdir(join(root, "tailwind-legacy", "src"), { recursive: true })
  await writeFile(join(root, "tailwind-legacy", "src", "styles.css"), ":root { color-scheme: light; }\nbody { margin: 0; }\n")
  await writeFile(join(root, "tailwind-legacy", "src", "App.tsx"), `export default function App() {
  return <main className="grid gap-3 p-8">migrated</main>
}
`)
  const legacyEnsure = await fetch(`${runtime.url}/sessions/tailwind-legacy/ensure`, { method: "POST" }).then((res) => res.json())
  if (legacyEnsure.state !== "active") {
    throw new Error(`Expected legacy Tailwind session to warm active, got ${JSON.stringify(legacyEnsure)}`)
  }
  const legacyStyles = await readFile(join(root, "tailwind-legacy", "src", "styles.css"), "utf8")
  if (!legacyStyles.startsWith(`@import "tailwindcss";`) || !legacyStyles.includes("color-scheme: light")) {
    throw new Error(`Expected legacy styles.css to gain the Tailwind import while preserving prior rules, got ${JSON.stringify(legacyStyles.slice(0, 60))}`)
  }
  if ((legacyStyles.match(/@import "tailwindcss"/g) || []).length !== 1) {
    throw new Error("Expected the migration to insert the Tailwind import exactly once")
  }
  const legacyCss = await fetch(`${runtime.url}/sessions/tailwind-legacy/app/src/styles.css?direct`).then((res) => res.text())
  for (const rule of [".gap-3", ".p-8"]) {
    if (!legacyCss.includes(rule)) {
      throw new Error(`Expected migrated workspace CSS to include the "${rule}" utility`)
    }
  }

  // (3) Migration of a MINIFIED pre-existing styles.css that leads with `@charset`: the
  // import must be inserted right after the `;`, before the rules sharing that line, so it
  // stays a valid leading `@import` (not pushed after a rule, which browsers drop).
  await mkdir(join(root, "tailwind-charset", "src"), { recursive: true })
  await writeFile(join(root, "tailwind-charset", "src", "styles.css"), `@charset "utf-8";body{margin:0}.legacy{padding:2px}`)
  await writeFile(join(root, "tailwind-charset", "src", "App.tsx"), `export default function App() {
  return <main className="mt-4">charset</main>
}
`)
  const charsetEnsure = await fetch(`${runtime.url}/sessions/tailwind-charset/ensure`, { method: "POST" }).then((res) => res.json())
  if (charsetEnsure.state !== "active") {
    throw new Error(`Expected @charset Tailwind session to warm active, got ${JSON.stringify(charsetEnsure)}`)
  }
  const charsetStyles = await readFile(join(root, "tailwind-charset", "src", "styles.css"), "utf8")
  const charsetImportIdx = charsetStyles.indexOf(`@import "tailwindcss";`)
  if (!charsetStyles.startsWith(`@charset "utf-8";`) || charsetImportIdx === -1 || charsetImportIdx > charsetStyles.indexOf("body{")) {
    throw new Error(`Expected the import right after @charset and before any rule, got ${JSON.stringify(charsetStyles)}`)
  }

  // (4) An EXTRAS session (workspace package.json declares deps) gets a private node_modules
  // holding only those extras — Tailwind's own resolver can't see the runtime's shared
  // `tailwindcss`, so the runtime links it in. A local `file:` extra keeps this offline.
  await mkdir(join(root, "tailwind-extras", "src"), { recursive: true })
  await mkdir(join(root, "tailwind-extras", "extra-pkg"), { recursive: true })
  await writeFile(join(root, "tailwind-extras", "extra-pkg", "package.json"), `${JSON.stringify({ name: "show-extra-pkg", version: "1.0.0", type: "module", main: "index.js" })}\n`)
  await writeFile(join(root, "tailwind-extras", "extra-pkg", "index.js"), `export const marker = "extra-ok"\n`)
  await writeFile(join(root, "tailwind-extras", "package.json"), `${JSON.stringify({ name: "tailwind-extras-page", private: true, dependencies: { "show-extra-pkg": "file:./extra-pkg" } })}\n`)
  await writeFile(join(root, "tailwind-extras", "src", "App.tsx"), `import { marker } from "show-extra-pkg"
export default function App() {
  return <main className="flex gap-4 p-6">{marker}</main>
}
`)
  const extrasEnsure = await fetch(`${runtime.url}/sessions/tailwind-extras/ensure`, { method: "POST" }).then((res) => res.json())
  if (extrasEnsure.state !== "active") {
    throw new Error(`Expected extras Tailwind session to warm active, got ${JSON.stringify(extrasEnsure)}`)
  }
  const extrasCssResponse = await fetch(`${runtime.url}/sessions/tailwind-extras/app/src/styles.css?direct`)
  const extrasCss = await extrasCssResponse.text()
  if (extrasCssResponse.status !== 200) {
    throw new Error(`Expected extras session styles.css to resolve (tailwindcss linked into the private node_modules), got ${extrasCssResponse.status}: ${extrasCss.slice(0, 200)}`)
  }
  for (const rule of [".flex", ".p-6", ".gap-4"]) {
    if (!extrasCss.includes(rule)) {
      throw new Error(`Expected extras session CSS to include the "${rule}" utility (Tailwind unresolved in the extras node_modules otherwise)`)
    }
  }

  // (5) Build path (public /p/ pages are served without HMR): the shadcn-alias example
  // builds with the same Tailwind plugin. Assert its built CSS carries the utilities it
  // uses. Requires a prior `npm run build` (CI runs `npm run check` before `npm run smoke`).
  const exampleAssets = join(fileURLToPath(new URL("..", import.meta.url)), "examples", "shadcn-alias", "dist", "assets")
  let builtCssFiles = []
  try {
    builtCssFiles = (await readdir(exampleAssets)).filter((name) => name.endsWith(".css"))
  } catch {
    builtCssFiles = []
  }
  if (!builtCssFiles.length) {
    throw new Error(`Expected built example CSS under ${exampleAssets}; run "npm run build" before "npm run smoke"`)
  }
  const builtCss = await readFile(join(exampleAssets, builtCssFiles[0]), "utf8")
  for (const rule of [".px-3", ".py-1", ".inline-flex"]) {
    if (!builtCss.includes(rule)) {
      throw new Error(`Expected the example's built CSS to include the "${rule}" utility (build path silently unstyled otherwise)`)
    }
  }

  // (6) A legacy styles.css whose Tailwind import is COMMENTED OUT must still migrate:
  // detection ignores comments, so a real import is prepended (else it stays unstyled).
  await mkdir(join(root, "tailwind-commented", "src"), { recursive: true })
  await writeFile(join(root, "tailwind-commented", "src", "styles.css"), `/* @import "tailwindcss"; */\nbody { margin: 0; }\n`)
  await writeFile(join(root, "tailwind-commented", "src", "App.tsx"), `export default function App() {
  return <main className="p-5">commented</main>
}
`)
  const commentedEnsure = await fetch(`${runtime.url}/sessions/tailwind-commented/ensure`, { method: "POST" }).then((res) => res.json())
  if (commentedEnsure.state !== "active") {
    throw new Error(`Expected commented-import session to warm active, got ${JSON.stringify(commentedEnsure)}`)
  }
  const commentedStyles = await readFile(join(root, "tailwind-commented", "src", "styles.css"), "utf8")
  if (!commentedStyles.startsWith(`@import "tailwindcss";`)) {
    throw new Error(`Expected a real Tailwind import prepended over a commented-out one, got ${JSON.stringify(commentedStyles.slice(0, 60))}`)
  }
  const commentedCss = await fetch(`${runtime.url}/sessions/tailwind-commented/app/src/styles.css?direct`).then((res) => res.text())
  if (!commentedCss.includes(".p-5")) {
    throw new Error("Expected utilities to emit after migrating a commented-out Tailwind import")
  }

  // (7) An extra that pulls `tailwindcss` in transitively leaves a (possibly mismatched)
  // real copy in the private node_modules; the runtime must replace it with the shared,
  // runtime-owned package so `@import "tailwindcss";` resolves the matching v4 engine.
  await mkdir(join(root, "tailwind-transitive", "src"), { recursive: true })
  await mkdir(join(root, "tailwind-transitive", "fake-tw"), { recursive: true })
  await writeFile(join(root, "tailwind-transitive", "fake-tw", "package.json"), `${JSON.stringify({ name: "tailwindcss", version: "3.9.9", main: "index.js" })}\n`)
  await writeFile(join(root, "tailwind-transitive", "fake-tw", "index.js"), "module.exports = {}\n")
  await mkdir(join(root, "tailwind-transitive", "extra-pkg"), { recursive: true })
  await writeFile(join(root, "tailwind-transitive", "extra-pkg", "package.json"), `${JSON.stringify({ name: "show-extra-with-tw", version: "1.0.0", type: "module", main: "index.js", dependencies: { tailwindcss: "file:../fake-tw" } })}\n`)
  await writeFile(join(root, "tailwind-transitive", "extra-pkg", "index.js"), `export const marker = "with-tw"\n`)
  await writeFile(join(root, "tailwind-transitive", "package.json"), `${JSON.stringify({ name: "tailwind-transitive-page", private: true, dependencies: { "show-extra-with-tw": "file:./extra-pkg" } })}\n`)
  await writeFile(join(root, "tailwind-transitive", "src", "App.tsx"), `import { marker } from "show-extra-with-tw"
export default function App() {
  return <main className="flex gap-4 p-6">{marker}</main>
}
`)
  const transitiveEnsure = await fetch(`${runtime.url}/sessions/tailwind-transitive/ensure`, { method: "POST" }).then((res) => res.json())
  if (transitiveEnsure.state !== "active") {
    throw new Error(`Expected transitive-tailwindcss session to warm active, got ${JSON.stringify(transitiveEnsure)}`)
  }
  const transitiveLink = await lstat(join(root, "tailwind-transitive", "node_modules", "tailwindcss"))
  if (!transitiveLink.isSymbolicLink()) {
    throw new Error("Expected the transitive tailwindcss copy to be replaced with a symlink to the shared install")
  }
  const transitiveCss = await fetch(`${runtime.url}/sessions/tailwind-transitive/app/src/styles.css?direct`).then((res) => res.text())
  for (const rule of [".flex", ".p-6"]) {
    if (!transitiveCss.includes(rule)) {
      throw new Error(`Expected extras+transitive-tailwindcss CSS to include "${rule}" (drifted copy not replaced otherwise)`)
    }
  }

  // --- shadcn/ui component migration -------------------------------------------------
  // The components are real shadcn/ui: their styling is Tailwind utility classes generated
  // from the theme, and utility overrides win via cn()/tailwind-merge (which closes the
  // "utilities can't override components" gap).

  // (8) Override contract: cn() merges a caller utility over the component default, DROPPING
  // the conflicting default so only the override remains on the element.
  const mergedButtonClass = cn("bg-primary text-primary-foreground shadow-sm", "bg-red-500")
  if (mergedButtonClass.includes("bg-primary") || !mergedButtonClass.includes("bg-red-500")) {
    throw new Error(`Expected cn() to drop the conflicting bg-primary and keep bg-red-500, got "${mergedButtonClass}"`)
  }

  // (9) Component pipeline (new workspace): the scaffolded entry imports the show-ui theme,
  // whose @theme registers the tokens and whose @source generates the component utilities.
  // The served CSS must carry `.bg-primary` mapped to the --avs- palette (default parity)
  // and the agent's own `.bg-red-500` override utility.
  await mkdir(join(root, "shadcn", "src"), { recursive: true })
  await writeFile(join(root, "shadcn", "src", "App.tsx"), `import { Button } from "@/components/ui/button"
export default function App() {
  return <Button className="bg-red-500">Ship</Button>
}
`)
  const shadcnEnsure = await fetch(`${runtime.url}/sessions/shadcn/ensure`, { method: "POST" }).then((res) => res.json())
  if (shadcnEnsure.state !== "active") {
    throw new Error(`Expected shadcn session to warm active, got ${JSON.stringify(shadcnEnsure)}`)
  }
  const shadcnStyles = await readFile(join(root, "shadcn", "src", "styles.css"), "utf8")
  if (!/@import\s+["']tailwindcss["']/.test(shadcnStyles) || !/@import\s+["']@avibe\/show-ui\/theme\.css["']/.test(shadcnStyles)) {
    throw new Error(`Expected the scaffolded entry to import both tailwindcss and the show-ui theme, got ${JSON.stringify(shadcnStyles.slice(0, 90))}`)
  }
  const shadcnCss = await fetch(`${runtime.url}/sessions/shadcn/app/src/styles.css?direct`).then((res) => res.text())
  if (!/\.bg-primary\s*\{[^}]*var\(--avs-primary\)[^}]*\}/.test(shadcnCss)) {
    throw new Error("Expected .bg-primary generated from the @source'd components and mapped to hsl(var(--avs-primary)) (default parity + @theme registration)")
  }
  if (!shadcnCss.includes(".bg-red-500")) {
    throw new Error("Expected the agent's .bg-red-500 override utility to be generated")
  }

  // (10) Legacy workspace (predates the theme import): a styles.css with only the Tailwind
  // entry must gain the show-ui theme import on warm so component tokens/utilities work.
  await mkdir(join(root, "shadcn-legacy", "src"), { recursive: true })
  await writeFile(join(root, "shadcn-legacy", "src", "styles.css"), "@import \"tailwindcss\";\nbody { margin: 0; }\n")
  await writeFile(join(root, "shadcn-legacy", "src", "App.tsx"), `export default function App() {
  return <main className="p-4">legacy</main>
}
`)
  const shadcnLegacyEnsure = await fetch(`${runtime.url}/sessions/shadcn-legacy/ensure`, { method: "POST" }).then((res) => res.json())
  if (shadcnLegacyEnsure.state !== "active") {
    throw new Error(`Expected legacy shadcn session to warm active, got ${JSON.stringify(shadcnLegacyEnsure)}`)
  }
  const shadcnLegacyStyles = await readFile(join(root, "shadcn-legacy", "src", "styles.css"), "utf8")
  if (!/@import\s+["']@avibe\/show-ui\/theme\.css["']/.test(shadcnLegacyStyles) || !shadcnLegacyStyles.includes("margin: 0")) {
    throw new Error(`Expected the legacy entry to gain the show-ui theme import while preserving prior rules, got ${JSON.stringify(shadcnLegacyStyles.slice(0, 90))}`)
  }
  const shadcnLegacyCss = await fetch(`${runtime.url}/sessions/shadcn-legacy/app/src/styles.css?direct`).then((res) => res.text())
  if (!shadcnLegacyCss.includes(".bg-primary")) {
    throw new Error("Expected component utilities to generate in a migrated legacy workspace (theme import + @source)")
  }

  console.log("smoke runtime ok")
} finally {
  await runtime.close()
  await rm(root, { recursive: true, force: true })
  await rm(staleDependencyRoot, { recursive: true, force: true })
}

function rawHttpGet(origin, path) {
  const url = new URL(origin)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      method: "GET",
      path
    }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }))
    })
    request.on("error", reject)
    request.end()
  })
}

function viteFsUrl(filePath) {
  return `/@fs/${filePath.replaceAll("\\", "/").replace(/^\/+/, "")}`
}

const relativeCacheRoot = await mkdtemp(join(tmpdir(), "avibe-show-runtime-relative-cache-"))
const relativeRoot = await mkdtemp(join(tmpdir(), "avibe-show-runtime-relative-root-"))
const relativeRuntime = await startShowRuntimeServer({
  workspaceRoot: relativeRoot,
  cacheRoot: relative(process.cwd(), relativeCacheRoot)
})
try {
  const ensure = await fetch(`${relativeRuntime.url}/sessions/relative/ensure`, { method: "POST" }).then((res) => res.json())
  if (ensure.state !== "active") {
    throw new Error(`Expected relative cache session to be active, got ${ensure.state}`)
  }
  await fetch(`${relativeRuntime.url}/sessions/relative/app/src/main.tsx`).then((res) => {
    if (!res.ok) {
      throw new Error(`Expected relative cache session source module to load, got ${res.status}`)
    }
  })
  const cacheDigestDirs = await readdir(relativeCacheRoot)
  if (cacheDigestDirs.length !== 1) {
    throw new Error(`Expected relative cache root to contain one namespace, got ${cacheDigestDirs.join(", ")}`)
  }
  const sharedRelativeCacheDir = join(relativeCacheRoot, cacheDigestDirs[0])
  const relativeCacheEntries = await readdir(sharedRelativeCacheDir)
  if (relativeCacheEntries.includes("relative")) {
    throw new Error(`Expected relative cacheRoot to share optimized deps across sessions, got ${relativeCacheEntries.join(", ")}`)
  }
  try {
    await access(join(relativeRoot, "relative", ".vite"))
    throw new Error("Expected relative cacheRoot to resolve outside the session workspace")
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
} finally {
  await relativeRuntime.close()
  await rm(relativeRoot, { recursive: true, force: true })
  await rm(relativeCacheRoot, { recursive: true, force: true })
}

const archiveLikeRoot = await mkdtemp(join(tmpdir(), "avibe-show-runtime-archive-like-"))
try {
  await mkdir(join(archiveLikeRoot, "packages"), { recursive: true })
  for (const name of ["runtime", "ui", "sdk"]) {
    await mkdir(join(archiveLikeRoot, "packages", name), { recursive: true })
    await cp(join(process.cwd(), "packages", name, "package.json"), join(archiveLikeRoot, "packages", name, "package.json"))
    await cp(join(process.cwd(), "packages", name, "dist"), join(archiveLikeRoot, "packages", name, "dist"), { recursive: true })
  }
  await cp(join(process.cwd(), "node_modules"), join(archiveLikeRoot, "node_modules"), {
    recursive: true,
    filter: (source) => !source.includes(`${join("node_modules", "@avibe")}`)
  })
  await mkdir(join(archiveLikeRoot, "node_modules", "@avibe"), { recursive: true })
  await symlink("../../packages/runtime", join(archiveLikeRoot, "node_modules", "@avibe", "show-runtime"), "junction")
  await symlink("../../packages/ui", join(archiveLikeRoot, "node_modules", "@avibe", "show-ui"), "junction")
  await symlink("../../packages/sdk", join(archiveLikeRoot, "node_modules", "@avibe", "show-sdk"), "junction")
  await mkdir(join(archiveLikeRoot, "packages", "runtime", "node_modules"), { recursive: true })
  await cp(join(process.cwd(), "node_modules", "esbuild"), join(archiveLikeRoot, "packages", "runtime", "node_modules", "esbuild"), { recursive: true })
  await cp(join(process.cwd(), "node_modules", "@esbuild"), join(archiveLikeRoot, "packages", "runtime", "node_modules", "@esbuild"), { recursive: true })

  const archiveWorkspaceRoot = join(archiveLikeRoot, ".show")
  const archiveCacheRoot = join(archiveLikeRoot, ".cache")
  const { startShowRuntimeServer: startArchiveLikeRuntimeServer } = await import(pathToFileURL(join(archiveLikeRoot, "packages", "runtime", "dist", "server.js")).href)
  const archiveLikeRuntime = await startArchiveLikeRuntimeServer({
    workspaceRoot: archiveWorkspaceRoot,
    cacheRoot: archiveCacheRoot,
    fallbackDelaySeconds: 30
  })
  try {
    const html = await loadAppEntry(archiveLikeRuntime.url, "archive-like")
    if (!html.includes("/_show-runtime/vendor/")) {
      throw new Error("Expected archive-like runtime to inject shared vendor assets")
    }
    const vendorReactUrl = html.match(/"react"\s*:\s*"(\/_show-runtime\/vendor\/[^"]+)"/)?.[1]
    if (!vendorReactUrl) {
      throw new Error("Expected archive-like runtime import map to include react")
    }
    const vendorReact = await fetch(`${archiveLikeRuntime.url}${vendorReactUrl}`)
    if (vendorReact.status !== 200) {
      throw new Error(`Expected archive-like runtime vendor React asset to load, got ${vendorReact.status}`)
    }
    const archiveViteEnv = await realpath(join(archiveLikeRoot, "node_modules", "vite", "dist", "client", "env.mjs"))
    const archiveViteEnvResponse = await fetch(`${archiveLikeRuntime.url}/sessions/archive-like/app${viteFsUrl(archiveViteEnv)}`)
    if (archiveViteEnvResponse.status !== 200) {
      throw new Error(`Expected env.mjs under an auto-discovered custom provider root to load, got ${archiveViteEnvResponse.status}`)
    }
  } finally {
    await archiveLikeRuntime.close()
  }
} finally {
  await rm(archiveLikeRoot, { recursive: true, force: true })
}

// --- Vendor cache identity is content-aware (regression for #28) ----------------------
// The vendor pool + optimizeDeps cache are keyed by a dependency fingerprint. The vendored
// workspace packages are permanently 0.0.0, so a fingerprint that only hashed name@version
// reused a stale bundle across restarts after a source rebuild — the shadcn migration would
// have been invisibly no-op for upgrading users. Assert the fingerprint tracks the CONTENT
// of 0.0.0 packages, while staying version-based (cheap) for immutable registry packages.
const fingerprintRoot = await mkdtemp(join(tmpdir(), "avibe-show-fingerprint-"))
const fingerprintModules = join(fingerprintRoot, "node_modules")
const writeFingerprintPackage = async (name, version, content) => {
  const dir = join(fingerprintModules, ...name.split("/"))
  await mkdir(join(dir, "dist"), { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }))
  await writeFile(join(dir, "dist", "index.js"), content)
}
try {
  const names = ["@fake/ui", "registry-pkg"]
  await writeFingerprintPackage("@fake/ui", "0.0.0", "export const value = 1\n")
  await writeFingerprintPackage("registry-pkg", "1.2.3", "export const value = 1\n")
  const baseFingerprint = await dependencyFingerprint(fingerprintModules, names)
  await writeFingerprintPackage("@fake/ui", "0.0.0", "export const value = 2\n")
  const afterWorkspaceChange = await dependencyFingerprint(fingerprintModules, names)
  if (afterWorkspaceChange === baseFingerprint) {
    throw new Error("Expected the dependency fingerprint to change when a 0.0.0 package's content changes (stale vendor/vite cache across restarts otherwise)")
  }
  await writeFingerprintPackage("registry-pkg", "1.2.3", "export const value = 2\n")
  const afterRegistryChange = await dependencyFingerprint(fingerprintModules, names)
  if (afterRegistryChange !== afterWorkspaceChange) {
    throw new Error("Expected the dependency fingerprint to stay version-based for an immutable registry package (its content is not hashed)")
  }
  // A 0.0.0 package's package.json (exports/deps drive bundling) MUST move the fingerprint
  // even when the dist bytes are unchanged, so the vendor manifest/import map isn't reused stale.
  await writeFile(join(fingerprintModules, "@fake", "ui", "package.json"), JSON.stringify({ name: "@fake/ui", version: "0.0.0", exports: { ".": "./dist/index.js", "./extra": "./dist/extra.js" } }))
  const afterMetadataChange = await dependencyFingerprint(fingerprintModules, names)
  if (afterMetadataChange === afterRegistryChange) {
    throw new Error("Expected the dependency fingerprint to change when a 0.0.0 package's package.json (exports) changes with unchanged dist")
  }
  console.log("vendor fingerprint content-awareness ok")
} finally {
  await rm(fingerprintRoot, { recursive: true, force: true })
}

// --- Superseded cache-dir GC (regression for #31) -------------------------------------
// Each vendor/Vite identity change lands in a fresh <16-hex> dir; the old ones used to pile
// up (~6MB each in the vendor pool). The runtime touches a dir it serves from (on warm/access),
// so GC reclaims only identity dirs untouched for longer than the idle TTL — provably abandoned.
// Simulate a root of identity dirs at staggered ages (via mtime), plus a temp build dir and a
// hex-named FILE that must never be swept, and assert the age + keep rules hold.
const NOW = 1_600_000_000_000
const MAX_AGE_MS = 3_600_000 // 1h liveness margin
const gcRoot = await mkdtemp(join(tmpdir(), "avibe-show-gc-"))
const makeIdentityDir = async (name, ageSeconds) => {
  const dir = join(gcRoot, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "index-abc123.js"), "export const x = 1\n") // ~a real 6MB dir's shape
  const when = new Date(NOW - ageSeconds * 1000)
  await utimes(dir, when, when)
  return name
}
try {
  const current = await makeIdentityDir("0123456789abcdef", 7200) // in use: kept despite 2h age
  const fresh = await makeIdentityDir("1111111111111111", 600)    // touched 10min ago -> live
  const stale = await makeIdentityDir("2222222222222222", 7200)   // untouched 2h > 1h -> abandoned
  const ancient = await makeIdentityDir("3333333333333333", 90000) // 25h -> abandoned
  // Controls: a staging temp dir and a stray file with a hex-looking name — never identity dirs.
  await mkdir(join(gcRoot, ".avibe-vendor-build-xyz"), { recursive: true })
  await writeFile(join(gcRoot, "abcdef0123456789"), "not a dir\n")

  const removed = new Set(await pruneSupersededCacheDirs(gcRoot, { keep: [current], maxAgeMs: MAX_AGE_MS, now: NOW }))
  if (!removed.has(stale) || !removed.has(ancient)) {
    throw new Error(`Expected abandoned (untouched > TTL) identity dirs to be swept, got: ${JSON.stringify([...removed])}`)
  }
  if (removed.has(current) || removed.has(fresh)) {
    throw new Error("GC must keep the in-use identity and any recently-touched (live) dir")
  }
  const survivors = new Set(await readdir(gcRoot))
  for (const kept of [current, fresh, ".avibe-vendor-build-xyz", "abcdef0123456789"]) {
    if (!survivors.has(kept)) throw new Error(`GC wrongly removed ${kept}`)
  }
  for (const gone of [stale, ancient]) {
    if (survivors.has(gone)) throw new Error(`GC failed to remove abandoned ${gone}`)
  }

  // A dir named in `keep` (a live session's cache dir) survives even when old — this is what
  // protects a concurrent peer's live optimize dir that our single process can't see the age of.
  await makeIdentityDir(stale, 7200) // recreate the old dir, now passed as live
  const removed2 = await pruneSupersededCacheDirs(gcRoot, { keep: [current, stale], maxAgeMs: MAX_AGE_MS, now: NOW })
  if (removed2.includes(stale)) throw new Error("GC must never sweep a dir named in `keep`, even an old one")
  console.log("superseded cache-dir GC ok")
} finally {
  await rm(gcRoot, { recursive: true, force: true })
}

// --- Parent-death backstop (regression for avibe#813) ---------------------------------
// avibe spawns the runtime server as a child; if avibe is killed without reaping it, the
// orphan would keep serving stale in-memory code. The server exits when it is reparented to
// init (ppid=1). Spawn cli.js under a throwaway wrapper, SIGKILL the wrapper (no cleanup, like
// a hard avibe death), and assert the orphaned server self-exits. UNIX-only (Windows doesn't
// reparent to pid 1).
if (process.platform !== "win32") {
  const cliPath = fileURLToPath(new URL("../packages/runtime/dist/cli.js", import.meta.url))
  const parentDeathRoot = await mkdtemp(join(tmpdir(), "avibe-show-parent-death-"))
  const wrapperSource = [
    `import { spawn } from "node:child_process"`,
    `const child = spawn(process.execPath, [process.argv[1], "--workspace-root", process.argv[2], "--port", "0"], {`,
    `  env: { ...process.env, VIBE_SHOW_RUNTIME_PARENT_DEATH_POLL_MS: "150" }, stdio: ["ignore", "pipe", "ignore"] })`,
    `let childStdout = ""`,
    `let reported = false`,
    `child.stdout.on("data", (data) => {`,
    `  childStdout += String(data)`,
    `  const match = childStdout.match(/Vibe Show Runtime listening at (\\S+)/)`,
    `  if (!reported && match) {`,
    `    reported = true`,
    `    console.log(JSON.stringify({ childPid: child.pid, url: match[1] }))`,
    `  }`,
    `})`,
    `setInterval(() => {}, 1000)`
  ].join("\n")
  const wrapper = spawn(process.execPath, ["--input-type=module", "-e", wrapperSource, cliPath, parentDeathRoot], {
    stdio: ["ignore", "pipe", "ignore"]
  })
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0)
    } catch {
      return false // no such process
    }
    // A zombie (exited but not yet reaped) still passes kill(0). Under a container/PID 1 that
    // doesn't promptly reap adopted children, a correctly-exited orphan lingers as a zombie; on
    // Linux /proc/<pid>/stat field 3 is the state, and 'Z' (defunct) means it has exited.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      return stat[stat.lastIndexOf(")") + 2] !== "Z"
    } catch {
      return true // no /proc (e.g. macOS) or the entry vanished — trust the kill(0) result
    }
  }
  try {
    const { childPid, url: cliRuntimeUrl } = await new Promise((resolveRuntime, rejectRuntime) => {
      const timeout = setTimeout(() => rejectRuntime(new Error("runtime server never reported listening")), 20000)
      wrapper.stdout.on("data", (data) => {
        const lines = String(data).trim().split(/\n+/).filter(Boolean)
        for (const line of lines) {
          let payload
          try {
            payload = JSON.parse(line)
          } catch {
            continue
          }
          if (typeof payload.childPid === "number" && typeof payload.url === "string") {
            clearTimeout(timeout)
            resolveRuntime(payload)
            return
          }
        }
      })
      wrapper.on("exit", () => rejectRuntime(new Error("wrapper exited before the runtime server reported listening")))
    })
    if (!isAlive(childPid)) {
      throw new Error("Expected the spawned runtime server to be alive before its parent is killed")
    }
    await waitForRuntimeHealth(cliRuntimeUrl)
    await loadAppEntry(cliRuntimeUrl, "cli-live")
    // Hard-kill the wrapper (SIGKILL runs no shutdown hooks) to orphan the runtime server.
    process.kill(wrapper.pid, "SIGKILL")
    let orphanExited = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((res) => setTimeout(res, 150))
      if (!isAlive(childPid)) {
        orphanExited = true
        break
      }
    }
    if (!orphanExited) {
      try {
        process.kill(childPid, "SIGKILL")
      } catch {
        // already gone
      }
      throw new Error("Expected the orphaned runtime server to self-exit after its parent died (avibe#813 backstop)")
    }
    console.log("parent-death backstop ok")
  } finally {
    try {
      process.kill(wrapper.pid, "SIGKILL")
    } catch {
      // already gone
    }
    await rm(parentDeathRoot, { recursive: true, force: true })
  }
}

async function readUntil(reader, needle) {
  const decoder = new TextDecoder()
  let body = ""
  const deadline = Date.now() + 5000
  while (!body.includes(needle)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${needle}; body so far: ${body}`)
    }
    const { done, value } = await reader.read()
    if (done) {
      throw new Error(`Stream ended before ${needle}; body so far: ${body}`)
    }
    body += decoder.decode(value, { stream: true })
  }
  return body
}

async function loadAppEntry(runtimeUrl, sessionId) {
  const html = await fetch(`${runtimeUrl}/sessions/${sessionId}/app/`).then((res) => res.text())
  const main = await fetch(`${runtimeUrl}/sessions/${sessionId}/app/src/main.tsx`)
  if (!main.ok) {
    throw new Error(`Expected ${sessionId} app entry module to load, got ${main.status}`)
  }
  await main.text()
  return html
}

async function waitForRuntimeHealth(runtimeUrl) {
  const deadline = Date.now() + 5000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${runtimeUrl}/health`)
      if (response.ok) return
      lastError = new Error(`health returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Runtime CLI did not stay healthy after startup: ${lastError?.message || lastError}`)
}
