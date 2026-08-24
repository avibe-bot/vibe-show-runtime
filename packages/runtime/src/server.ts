import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFile, realpath, stat } from "node:fs/promises"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { parse } from "node:url"
import type { AddressInfo } from "node:net"
import { isAgentOnlyShowEventType, isShowEventType, type AgentMark, type MarkAnchor, type ShowEvent, type ShowEventInput } from "@avibe/show-sdk"
import type { ShowRuntimeOptions } from "./types.js"
import { createShowRuntime } from "./runtime.js"
import { handleApiRequest } from "./handlers.js"
import { isVendorAssetPath, serveVendorAsset } from "./vendor-runtime.js"
import { isAnnotationBootstrapPath, serveAnnotationBootstrap } from "./annotation-bootstrap.js"
import {
  createMarkdownRenderer,
  MarkdownRenderError,
  type BrowserLauncher,
  type BrowserProvisioner,
  type MarkdownRenderer,
  type ShowRenderContext
} from "./markdown-renderer.js"
import {
  createRenderSnapshotManager,
  type RenderSnapshot,
  type RenderSnapshotManager
} from "./render-snapshot.js"

const SLOW_TIMING_MS = Number(process.env.VIBE_SHOW_RUNTIME_SLOW_TIMING_MS ?? "1000")

export type ShowRuntimeServerDependencies = {
  launchBrowser?: BrowserLauncher
  renderQuietPeriodMs?: number
  browserDiscoveryDisabled?: boolean
  browserProvisioningDisabled?: boolean
  provisionBrowser?: BrowserProvisioner
}

export async function startShowRuntimeServer(
  options: ShowRuntimeOptions = { workspaceRoot: ".show" },
  dependencies: ShowRuntimeServerDependencies = {}
) {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0
  const markdownRenderer = createMarkdownRenderer({
    timeoutMs: options.renderTimeoutMs,
    cacheTtlMs: options.renderCacheTtlMs,
    maxOutputBytes: options.renderMaxOutputBytes,
    browserIdleMs: options.renderBrowserIdleMs,
    quietPeriodMs: dependencies.renderQuietPeriodMs,
    browserDiscoveryDisabled: dependencies.browserDiscoveryDisabled,
    browserProvisioningDisabled: dependencies.browserProvisioningDisabled,
    browserProvisionTimeoutMs: options.renderBrowserProvisionTimeoutMs,
    launchBrowser: dependencies.launchBrowser,
    provisionBrowser: dependencies.provisionBrowser
  })
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(
        runtime,
        renderSnapshots,
        request,
        response,
        eventStreams,
        markdownRenderer,
        options.workspaceRoot
      )
    } catch (error) {
      response.statusCode = 500
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Runtime error" }))
    }
  })
  let renderSnapshots!: RenderSnapshotManager
  const runtime = createShowRuntime({
    ...options,
    server
  }, {
    async onSessionIdlePruned(sessionId) {
      if (!renderSnapshots) return
      await markdownRenderer.invalidateSession(
        sessionId,
        () => renderSnapshots.invalidateSession(sessionId)
      )
    }
  })
  renderSnapshots = createRenderSnapshotManager(runtime)
  const eventStreams = new ShowEventStreamBroker()

  await new Promise<void>((resolve) => server.listen(port, host, resolve))

  return {
    runtime,
    renderSnapshots,
    server,
    url: `http://${host}:${(server.address() as AddressInfo).port}`,
    async close() {
      eventStreams.close()
      await markdownRenderer.close()
      await renderSnapshots.close()
      await runtime.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
}

async function routeRequest(
  runtime: ReturnType<typeof createShowRuntime>,
  renderSnapshots: RenderSnapshotManager,
  request: IncomingMessage,
  response: ServerResponse,
  eventStreams: ShowEventStreamBroker,
  markdownRenderer: MarkdownRenderer,
  workspaceRoot: string
) {
  const parsed = parse(request.url ?? "/", true)
  const pathname = parsed.pathname ?? "/"

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, { ok: true })
    return
  }

  if (request.method === "GET" && pathname === "/capabilities") {
    sendJson(response, 200, { render_markdown: true })
    return
  }

  // Shared, content-hashed vendor assets live at a session-independent path so every
  // session's import map references one immutable copy. Served straight off disk (not
  // through any session's Vite). The browser only requests these after a Show Page
  // HTML — which warms the bundle — so it's available; guard defensively anyway.
  if (isVendorAssetPath(pathname)) {
    const bundle = runtime.getVendorBundle()
    if (!bundle) {
      sendJson(response, 503, { error: "Vendor bundle not ready" })
      return
    }
    await serveVendorAsset(bundle, pathname, response)
    return
  }

  const renderMarkdownMatch = pathname.match(/^\/sessions\/([^/]+)\/render-markdown$/)
  if (request.method === "GET" && renderMarkdownMatch) {
    await handleRenderMarkdown({
      renderSnapshots,
      request,
      response,
      renderer: markdownRenderer,
      workspaceRoot,
      sessionId: renderMarkdownMatch[1]
    })
    return
  }

  const ensureMatch = pathname.match(/^\/sessions\/([^/]+)\/ensure$/)
  if (request.method === "POST" && ensureMatch) {
    sendJson(response, 200, await runtime.ensureSession(ensureMatch[1]))
    return
  }

  const statusMatch = pathname.match(/^\/sessions\/([^/]+)\/status$/)
  if (request.method === "GET" && statusMatch) {
    sendJson(response, 200, await runtime.getSessionStatus(statusMatch[1]))
    return
  }

  const eventMatch = pathname.match(/^\/sessions\/([^/]+)\/events$/)
  if (eventMatch) {
    const sessionId = eventMatch[1]
    if (request.method === "GET") {
      if (parsed.query.stream === "1") {
        const stream = eventStreams.subscribe(sessionId, response, streamAfterId(request, parsed.query.after_id))
        sendEventStream(response)
        stream.replay(runtime.listSessionEvents(sessionId))
        return
      }
      sendJson(response, 200, { events: runtime.listSessionEvents(sessionId) })
      return
    }
    if (request.method === "POST") {
      const payload = await readJson<ShowEventRequest>(request)
      const event = recordShowEvent(runtime, sessionId, payload)
      if (!event.ok) {
        sendJson(response, event.status, { error: event.error })
        return
      }
      eventStreams.publish(sessionId, event.value)
      sendJson(response, 201, { ok: true, event: event.value })
      return
    }
  }

  const messageMatch = pathname.match(/^\/sessions\/([^/]+)\/messages$/)
  if (request.method === "GET" && messageMatch) {
    sendJson(response, 200, { messages: runtime.listSessionMessages(messageMatch[1]) })
    return
  }

  const suspendMatch = pathname.match(/^\/sessions\/([^/]+)\/suspend$/)
  if (request.method === "POST" && suspendMatch) {
    const sessionId = suspendMatch[1]
    let status
    await markdownRenderer.invalidateSession(sessionId, async () => {
      await renderSnapshots.invalidateSession(sessionId)
      status = await runtime.suspendSession(sessionId)
    })
    status ??= await runtime.getSessionStatus(sessionId)
    sendJson(response, 200, status)
    return
  }

  const renderAppMatch = pathname.match(/^\/sessions\/([^/]+)\/render-app\/?(.*)$/)
  if (renderAppMatch) {
    await handleRenderAppRequest({
      runtime,
      renderSnapshots,
      request,
      response,
      eventStreams,
      sessionId: renderAppMatch[1],
      appPath: `/${renderAppMatch[2] || ""}`
    })
    return
  }

  const appMatch = pathname.match(/^\/sessions\/([^/]+)\/app\/?(.*)$/)
  if (appMatch) {
    const sessionId = appMatch[1]
    const appPath = `/${appMatch[2] || ""}`

    // The annotation overlay bootstrap is session-independent JS shared by every workspace
    // (contract §7). Serve it straight off disk WITHOUT warming the session — the page requests it
    // after its HTML has already warmed the session, and a static asset should never trigger a warm.
    // Known-by-design (orchestrator ruled (a), see PR ledger): the runtime SERVES this asset; the
    // `<script src=".../__show/annotation.js">` tag is INJECTED by avibe (`_inject_show_runtime_config`,
    // §7). Injecting it here too would double-mount the overlay, so the runtime deliberately doesn't.
    if (request.method === "GET" && isAnnotationBootstrapPath(appPath)) {
      await serveAnnotationBootstrap(appPath, response)
      return
    }

    const requestStarted = performance.now()
    const status = await runtime.ensureSession(sessionId, publicBasePath(request))
    logRequestTiming("ensureSessionForAppRequest", sessionId, appPath, requestStarted, { state: status.state })
    const session = runtime.getSession(sessionId)
    if (!session) {
      sendJson(response, 503, { error: "Session not ready", status })
      return
    }

    if (isShowEndpointPath(appPath, "events")) {
      if (request.method === "GET") {
        if (parsed.query.stream === "1") {
          const stream = eventStreams.subscribe(sessionId, response, streamAfterId(request, parsed.query.after_id))
          sendEventStream(response)
          stream.replay(runtime.listSessionEvents(sessionId))
          return
        }
        sendJson(response, 200, { events: runtime.listSessionEvents(sessionId) })
        return
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed" })
        return
      }
      if (!session.vite) {
        sendJson(response, 503, { error: "Session not ready", status })
        return
      }
      const payload = await readJson<ShowEventRequest>(request)
      const event = recordShowEvent(runtime, sessionId, payload)
      if (!event.ok) {
        sendJson(response, event.status, { error: event.error })
        return
      }
      eventStreams.publish(sessionId, event.value)
      sendJson(response, 201, { ok: true, event: event.value })
      return
    }

    if (isShowEndpointPath(appPath, "messages")) {
      sendJson(response, 200, { messages: runtime.listSessionMessages(sessionId) })
      return
    }

    // Every `__show/*` path is runtime-owned. Known endpoints were handled above;
    // unknown ones must stay 404 instead of falling through to the page router.
    if (appPath === "/__show" || appPath.startsWith("/__show/")) {
      sendNotFound(response)
      return
    }

    if (appPath === "/api" || appPath.startsWith("/api/")) {
      if (!session.vite) {
        sendJson(response, 503, { error: "Session not ready", status })
        return
      }
      await handleApiRequest({
        sessionId,
        workspace: session.workspace,
        apiPath: appPath.slice("/api".length),
        vite: session.vite,
        request,
        response
      })
      return
    }

    const vite = session.vite
    if (!vite) {
      sendJson(response, 503, { error: "Session not ready", status })
      return
    }

    // Preserve the query string when forwarding to Vite: a user-authored import query
    // (`?inline`, `?url`, `?raw`, `?worker`, ...) selects a Vite transform, so dropping it
    // here would make Vite fall back to the default handling (e.g. CSS injected as a style
    // tag instead of returned as an inline string). `parsed.search` keeps the leading `?`.
    const appSearch = parsed.search ?? ""
    request.url = appPath === "/" ? `/${appSearch}` : `${appPath}${appSearch}`
    const middlewareStarted = performance.now()
    response.once("finish", () => {
      logRequestTiming("viteMiddlewareResponse", sessionId, appPath, middlewareStarted, {
        statusCode: response.statusCode
      })
      logRequestTiming("appRequestTotal", sessionId, appPath, requestStarted, {
        statusCode: response.statusCode,
        state: session.state
      })
    })
    vite.middlewares(request, response, async (error?: unknown) => {
      if (error) {
        response.statusCode = 500
        response.end(error instanceof Error ? error.message : String(error))
        return
      }
      if (!isSpaRoutePath(appPath, request)) {
        sendNotFound(response)
        return
      }

      // Vite already had first refusal, so extensionless public files and other
      // real assets keep priority. Only a route-shaped miss gets the transformed
      // entry document; `appType: custom` intentionally leaves this decision here.
      try {
        const source = await readFile(join(session.workspace, "index.html"), "utf8")
        const html = await vite.transformIndexHtml(`${appPath}${appSearch}`, source)
        response.statusCode = 200
        response.setHeader("content-type", "text/html; charset=utf-8")
        response.setHeader("cache-control", "no-cache")
        response.end(request.method === "HEAD" ? undefined : html)
      } catch (fallbackError) {
        response.statusCode = 500
        response.end(fallbackError instanceof Error ? fallbackError.message : String(fallbackError))
      }
    })
    return
  }

  sendJson(response, 404, { error: "Not found" })
}

async function handleRenderAppRequest(options: {
  runtime: ReturnType<typeof createShowRuntime>
  renderSnapshots: RenderSnapshotManager
  request: IncomingMessage
  response: ServerResponse
  eventStreams: ShowEventStreamBroker
  sessionId: string
  appPath: string
}) {
  const { runtime, renderSnapshots, request, response, eventStreams, sessionId, appPath } = options
  const parsed = parse(request.url ?? "/", true)

  if (request.method === "GET" && isAnnotationBootstrapPath(appPath)) {
    await serveAnnotationBootstrap(appPath, response)
    return
  }

  const snapshot = renderSnapshots.get(sessionId)
  if (!snapshot) {
    sendNotFound(response)
    return
  }
  const session = runtime.getSession(sessionId)

  if (isShowEndpointPath(appPath, "events")) {
    if (request.method === "GET") {
      if (parsed.query.stream === "1") {
        const stream = eventStreams.subscribe(sessionId, response, streamAfterId(request, parsed.query.after_id))
        sendEventStream(response)
        stream.replay(runtime.listSessionEvents(sessionId))
        return
      }
      sendJson(response, 200, { events: runtime.listSessionEvents(sessionId) })
      return
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed" })
      return
    }
    if (!session?.vite) {
      sendJson(response, 503, { error: "Session not ready" })
      return
    }
    const payload = await readJson<ShowEventRequest>(request)
    const event = recordShowEvent(runtime, sessionId, payload)
    if (!event.ok) {
      sendJson(response, event.status, { error: event.error })
      return
    }
    eventStreams.publish(sessionId, event.value)
    sendJson(response, 201, { ok: true, event: event.value })
    return
  }

  if (isShowEndpointPath(appPath, "messages")) {
    sendJson(response, 200, { messages: runtime.listSessionMessages(sessionId) })
    return
  }

  if (appPath === "/__show" || appPath.startsWith("/__show/")) {
    sendNotFound(response)
    return
  }

  if (appPath === "/api" || appPath.startsWith("/api/")) {
    if (!session?.vite) {
      sendJson(response, 503, { error: "Session not ready" })
      return
    }
    await handleApiRequest({
      sessionId,
      workspace: session.workspace,
      apiPath: appPath.slice("/api".length),
      vite: session.vite,
      request,
      response
    })
    return
  }

  await serveRenderSnapshot(snapshot, appPath, request, response)
}

async function serveRenderSnapshot(
  snapshot: RenderSnapshot,
  appPath: string,
  request: IncomingMessage,
  response: ServerResponse
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed" })
    return
  }

  const requestedFile = await containedSnapshotFile(snapshot.outDir, appPath)
  const file = requestedFile ?? (
    isSpaRoutePath(appPath, request)
      ? await containedSnapshotFile(snapshot.outDir, "/index.html")
      : undefined
  )
  if (!file) {
    sendNotFound(response)
    return
  }

  const body = await readFile(file)
  response.statusCode = 200
  response.setHeader("content-type", snapshotContentType(file))
  response.setHeader("cache-control", "no-store")
  response.end(request.method === "HEAD" ? undefined : body)
}

async function containedSnapshotFile(root: string, rawPath: string): Promise<string | undefined> {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return undefined
  }
  if (decoded.includes("\0") || decoded.split(/[\\/]/).includes("..")) return undefined

  try {
    const canonicalRoot = await realpath(root)
    const candidate = resolve(canonicalRoot, decoded.replace(/^[/\\]+/, ""))
    const canonicalFile = await realpath(candidate)
    const relativePath = relative(canonicalRoot, canonicalFile)
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath) ||
      !(await stat(canonicalFile)).isFile()
    ) {
      return undefined
    }
    return canonicalFile
  } catch {
    return undefined
  }
}

function snapshotContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8"
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8"
    case ".css": return "text/css; charset=utf-8"
    case ".json":
    case ".map": return "application/json; charset=utf-8"
    case ".svg": return "image/svg+xml"
    case ".png": return "image/png"
    case ".jpg":
    case ".jpeg": return "image/jpeg"
    case ".gif": return "image/gif"
    case ".webp": return "image/webp"
    case ".ico": return "image/x-icon"
    case ".woff": return "font/woff"
    case ".woff2": return "font/woff2"
    case ".ttf": return "font/ttf"
    case ".otf": return "font/otf"
    case ".wasm": return "application/wasm"
    default: return "application/octet-stream"
  }
}

async function handleRenderMarkdown(options: {
  renderSnapshots: RenderSnapshotManager
  request: IncomingMessage
  response: ServerResponse
  renderer: MarkdownRenderer
  workspaceRoot: string
  sessionId: string
}) {
  const { renderSnapshots, request, response, renderer, workspaceRoot, sessionId } = options
  response.setHeader("cache-control", "no-store")
  try {
    const target = markdownRenderTarget(request)
    const workspace = sessionWorkspace(workspaceRoot, sessionId)
    if (!workspace || !await isDirectory(workspace)) {
      throw new MarkdownRenderError(
        "session_unknown",
        404,
        "No Show Page workspace exists for this session."
      )
    }

    const internalBasePath = `/sessions/${sessionId}/render-app/`
    const basePath = markdownBasePath(request, sessionId)
    const result = await renderer.render({
      sessionId,
      context: markdownRenderContext(request),
      basePath,
      target,
      internalBasePath,
      renderUrl: markdownRenderUrl(request, internalBasePath, target),
      workspace,
      async prepare() {
        return await renderSnapshots.prepare(sessionId, workspace, internalBasePath)
      }
    })
    response.statusCode = 200
    response.setHeader("content-type", "text/markdown; charset=utf-8")
    response.setHeader("x-avibe-render-cache", result.cache)
    response.end(result.markdown)
  } catch (error) {
    sendRenderError(
      response,
      error instanceof MarkdownRenderError
        ? error
        : new MarkdownRenderError("render_failed", 502, "Show Page rendering failed.", { cause: error })
    )
  }
}

function sendRenderError(response: ServerResponse, error: MarkdownRenderError) {
  sendJson(response, error.status, {
    error: {
      code: error.code,
      message: error.message
    }
  })
}

function sessionWorkspace(workspaceRoot: string, sessionId: string): string | undefined {
  const root = resolve(workspaceRoot)
  const workspace = resolve(root, sessionId)
  const relativePath = relative(root, workspace)
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativePath)) {
    return undefined
  }
  return workspace
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function markdownRenderContext(request: IncomingMessage): ShowRenderContext {
  return requestHeader(request, "x-avibe-show-context") === "shared" ? "shared" : "private"
}

function markdownBasePath(request: IncomingMessage, sessionId: string): string {
  const raw = requestHeader(request, "x-vibe-show-base") ?? `/show/${sessionId}/`
  let pathname: string
  try {
    pathname = new URL(raw, "http://show-runtime.local").pathname
  } catch {
    pathname = `/show/${sessionId}/`
  }
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`
}

function markdownRenderTarget(request: IncomingMessage): string {
  const target = requestHeader(request, "x-vibe-show-target") ?? "/"
  const queryIndex = target.indexOf("?")
  const pathname = queryIndex === -1 ? target : target.slice(0, queryIndex)
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    pathnameHasParentSegment(pathname)
  ) {
    throw invalidMarkdownRenderTarget()
  }
  return target
}

function pathnameHasParentSegment(pathname: string): boolean {
  let decoded = pathname
  while (true) {
    if (decoded.split(/[\\/]/).includes("..")) return true
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return false
      decoded = next
    } catch {
      return true
    }
  }
}

function markdownRenderUrl(
  request: IncomingMessage,
  internalBasePath: string,
  target: string
): string {
  const origin = loopbackOrigin(request)
  const internalBase = new URL(internalBasePath, origin)
  let renderUrl: URL
  try {
    renderUrl = new URL(target.slice(1), internalBase)
  } catch {
    throw invalidMarkdownRenderTarget()
  }
  if (renderUrl.origin !== internalBase.origin || !renderUrl.pathname.startsWith(internalBase.pathname)) {
    throw invalidMarkdownRenderTarget()
  }
  return renderUrl.href
}

function invalidMarkdownRenderTarget(): MarkdownRenderError {
  return new MarkdownRenderError(
    "invalid_target",
    400,
    "The x-vibe-show-target header must resolve to a path within the loopback session app."
  )
}

function requestHeader(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function loopbackOrigin(request: IncomingMessage): string {
  const port = request.socket.localPort
  const address = request.socket.localAddress ?? "127.0.0.1"
  const host = address.includes(":") ? `[${address}]` : address
  return `http://${host}:${port}`
}

function isSpaRoutePath(appPath: string, request: IncomingMessage) {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  let normalized = appPath
  try {
    normalized = decodeURIComponent(normalized)
  } catch {
    // Keep the encoded form. Vite already rejected it, and the conservative
    // last-segment check below will still avoid common asset extensions.
  }
  if (normalized === "/" || normalized === "/index.html") return true
  const segments = normalized.split("/").filter(Boolean)
  const first = segments[0]
  if (first === "api" || first === "__show") return false
  const last = segments.at(-1) ?? ""
  if (!last.includes(".")) return true

  // A dotted final segment can be either an asset or a route parameter (for
  // example an email address). Vite already served real files above. For a miss,
  // the browser's document accept header is the remaining signal that this is a
  // navigation and should receive the entry document; script/style/image fetches
  // keep their non-HTML accept headers and stay 404.
  const accept = Array.isArray(request.headers.accept) ? request.headers.accept[0] : request.headers.accept
  return typeof accept === "string" && accept.toLowerCase().includes("text/html")
}

function isShowEndpointPath(appPath: string, endpoint: "events" | "messages") {
  return appPath === `/__show/${endpoint}`
}

type ShowEventRequest = {
  type?: string
  mark: AgentMark
  anchor?: MarkAnchor
} | ShowEventInput

type RecordShowEventResult =
  | { ok: true; value: ShowEvent }
  | { ok: false; status: number; error: string }

function recordShowEvent(runtime: ReturnType<typeof createShowRuntime>, sessionId: string, payload: ShowEventRequest): RecordShowEventResult {
  if (!payload.type && "mark" in payload && payload.mark) {
    return { ok: true, value: runtime.recordAgentMark(sessionId, payload.mark, payload.anchor) }
  }
  if (!isShowEventType(payload.type)) {
    return { ok: false, status: 400, error: "Unsupported event type" }
  }
  // Agent/CLI-only control events (e.g. system.annotation.control) must never be accepted from this
  // page-client write surface — otherwise a visitor could POST a command every subscriber applies
  // via SSE (contract §4). Known-by-design (orchestrator ruled (a), see PR ledger): the trust
  // boundary is avibe, which owns event persistence + SSE and publishes agent/CLI control on its own
  // stream in production; the runtime's broker is intentionally not the control publish path, so
  // there is no missing trusted publisher here — this rejection is correct defense-in-depth.
  if (isAgentOnlyShowEventType(payload.type)) {
    return { ok: false, status: 403, error: "Event type is not accepted from page clients" }
  }
  try {
    return { ok: true, value: runtime.recordShowEvent(sessionId, payload as ShowEventInput) }
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : "Invalid show event payload" }
  }
}

class ShowEventStreamBroker {
  private readonly subscribers = new Map<string, Set<(event: ShowEvent) => void>>()
  private readonly responses = new Set<ServerResponse>()

  subscribe(sessionId: string, response: ServerResponse, afterId?: string) {
    const seenIds = new Set<string>()
    if (afterId) {
      seenIds.add(afterId)
    }
    const subscribers = this.subscribers.get(sessionId) ?? new Set<(event: ShowEvent) => void>()
    this.subscribers.set(sessionId, subscribers)
    this.responses.add(response)

    const write = (event: ShowEvent) => {
      const eventId = typeof event.id === "string" ? event.id : undefined
      if (eventId && seenIds.has(eventId)) {
        return
      }
      if (eventId) {
        seenIds.add(eventId)
      }
      response.write(showEventSseFrame(event))
    }
    subscribers.add(write)

    const unsubscribe = () => {
      subscribers.delete(write)
      this.responses.delete(response)
      if (subscribers.size === 0) {
        this.subscribers.delete(sessionId)
      }
    }
    response.on("close", unsubscribe)
    response.on("error", unsubscribe)

    return {
      replay(events: ShowEvent[]) {
        const startIndex = afterId ? events.findIndex((event) => event.id === afterId) + 1 : 0
        for (const event of events.slice(Math.max(startIndex, 0))) {
          write(event)
        }
      },
      unsubscribe
    }
  }

  publish(sessionId: string, event: ShowEvent) {
    for (const write of this.subscribers.get(sessionId) ?? []) {
      write(event)
    }
  }

  close() {
    for (const response of this.responses) {
      response.end()
    }
    this.responses.clear()
    this.subscribers.clear()
  }
}

async function readJson<T>(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) {
    return {} as T
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T
}

function publicBasePath(request: IncomingMessage) {
  const value = request.headers["x-vibe-show-base"]
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
}

function lastEventId(request: IncomingMessage) {
  const raw = request.headers["last-event-id"]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function streamAfterId(request: IncomingMessage, queryAfterId: unknown) {
  const headerValue = lastEventId(request)
  if (headerValue) {
    return headerValue
  }
  const value = Array.isArray(queryAfterId) ? queryAfterId[0] : queryAfterId
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(body))
}

function sendNotFound(response: ServerResponse) {
  response.statusCode = 404
  response.setHeader("content-type", "text/plain; charset=utf-8")
  response.end("Not found")
}

function logRequestTiming(
  label: string,
  sessionId: string,
  path: string,
  started: number,
  extra: Record<string, unknown> = {}
) {
  const durationMs = Math.round(performance.now() - started)
  if (durationMs < SLOW_TIMING_MS && process.env.VIBE_SHOW_RUNTIME_TIMING !== "1") return
  console.error(JSON.stringify({
    level: durationMs >= SLOW_TIMING_MS ? "warn" : "info",
    source: "show-runtime",
    event: "timing",
    label,
    sessionId,
    path,
    durationMs,
    ...extra
  }))
}

function sendEventStream(response: ServerResponse) {
  response.statusCode = 200
  response.setHeader("content-type", "text/event-stream")
  response.setHeader("cache-control", "no-cache")
  response.setHeader("connection", "keep-alive")
  response.setHeader("x-accel-buffering", "no")
  response.write(": show events connected\n\n")
}

function showEventSseFrame(event: ShowEvent) {
  return `id: ${event.id}\nevent: show.event\ndata: ${JSON.stringify(event)}\n\n`
}
