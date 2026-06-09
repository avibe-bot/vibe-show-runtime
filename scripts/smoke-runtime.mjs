import { access, mkdtemp, mkdir, readFile, readlink, readdir, symlink, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import vm from "node:vm"
import { showHmrTransitionPlugin } from "../packages/runtime/dist/hmr-transition-plugin.js"
import { startShowRuntimeServer } from "../packages/runtime/dist/server.js"
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

const hmrPlugin = showHmrTransitionPlugin({ fallbackDelaySeconds: 10 })
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
  !hmrStyleTag.children.includes("avs-show-fallback-recovery-in 0.22s ease 10s forwards")
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
await symlink(join(staleDependencyRoot, "node_modules"), join(root, "smoke", "node_modules"), "junction")
const runtime = await startShowRuntimeServer({ workspaceRoot: root, cacheRoot, fallbackDelaySeconds: 10 })

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
  const linkedNodeModules = await readlink(join(root, "smoke", "node_modules"))
  if (linkedNodeModules === join(staleDependencyRoot, "node_modules")) {
    throw new Error("Expected runtime to refresh stale session node_modules symlink")
  }

  const handler = await fetch(`${runtime.url}/sessions/smoke/app/api/health`).then((res) => res.json())
  if (!handler.ok || handler.sessionId !== "smoke") {
    throw new Error(`Unexpected handler response: ${JSON.stringify(handler)}`)
  }

  const app = await fetch(`${runtime.url}/sessions/smoke/app/`).then((res) => res.text())
  if (!app.includes("Vibe Show")) {
    throw new Error("Expected app HTML to include Vibe Show")
  }
  if (!app.includes("Loading Show Page") || !app.includes("Ready to visualize") || !app.includes("avs-show-fallback-recovery-in 0.22s ease 10s forwards")) {
    throw new Error("Expected app HTML to include runtime-injected delayed fallback recovery UI")
  }
  if (!app.includes('/show/smoke/@vite/client') || !app.includes('/show/smoke/src/main.tsx')) {
    throw new Error("Expected app HTML asset URLs to stay under /show/<session>/")
  }
  await fetch(`${runtime.url}/sessions/smoke/app/src/main.tsx`).then((res) => {
    if (!res.ok) {
      throw new Error(`Expected session source module to load, got ${res.status}`)
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
  if (projectRootModule.status !== 403 || !projectRootModule.body.includes("outside of Vite serving allow list")) {
    throw new Error(`Expected project root files to stay outside Vite fs.allow, got ${projectRootModule.status}`)
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
import type {} from "missing-export-type-package"
export const stackDepth = stackback().length
export const formattedStack = formatStack([])
export type { SmokeType }
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
  if (!extraDepModule.body.includes("/deps/stackback_formatstack.js")) {
    throw new Error(`Expected deep bare imports to stay optimized by full specifier, got: ${extraDepModule.body.slice(0, 300)}`)
  }
  if (extraDepModule.body.includes("missing-type-only-package") || extraDepModule.body.includes("missing-draft-only-package")) {
    throw new Error(`Expected unreachable and type-only imports to stay out of optimizer output: ${extraDepModule.body.slice(0, 300)}`)
  }
  const updatedCacheDigestDirs = await readdir(cacheRoot)
  if (updatedCacheDigestDirs.length < 2) {
    throw new Error(`Expected extra page dependencies to use a dedicated cache namespace, got ${updatedCacheDigestDirs.join(", ")}`)
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

  console.log("smoke runtime ok")
} finally {
  await runtime.close()
  await rm(root, { recursive: true, force: true })
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
