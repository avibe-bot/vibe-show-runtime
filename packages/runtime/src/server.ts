import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { parse } from "node:url"
import type { AddressInfo } from "node:net"
import { isAgentOnlyShowEventType, isShowEventType, type AgentMark, type MarkAnchor, type ShowEvent, type ShowEventInput } from "@avibe/show-sdk"
import type { ShowRuntimeOptions } from "./types.js"
import { createShowRuntime } from "./runtime.js"
import { handleApiRequest } from "./handlers.js"
import { isVendorAssetPath, serveVendorAsset } from "./vendor-runtime.js"
import { isAnnotationBootstrapPath, serveAnnotationBootstrap } from "./annotation-bootstrap.js"

const SLOW_TIMING_MS = Number(process.env.VIBE_SHOW_RUNTIME_SLOW_TIMING_MS ?? "1000")

export async function startShowRuntimeServer(options: ShowRuntimeOptions = { workspaceRoot: ".show" }) {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0

  const server = createServer(async (request, response) => {
    try {
      await routeRequest(runtime, request, response, eventStreams)
    } catch (error) {
      response.statusCode = 500
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Runtime error" }))
    }
  })
  const runtime = createShowRuntime({ ...options, server })
  const eventStreams = new ShowEventStreamBroker()

  await new Promise<void>((resolve) => server.listen(port, host, resolve))

  return {
    runtime,
    server,
    url: `http://${host}:${(server.address() as AddressInfo).port}`,
    async close() {
      eventStreams.close()
      await runtime.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
}

async function routeRequest(
  runtime: ReturnType<typeof createShowRuntime>,
  request: IncomingMessage,
  response: ServerResponse,
  eventStreams: ShowEventStreamBroker
) {
  const parsed = parse(request.url ?? "/", true)
  const pathname = parsed.pathname ?? "/"

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, { ok: true })
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
    sendJson(response, 200, await runtime.suspendSession(suspendMatch[1]))
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

    if (appPath.startsWith("/__show/events")) {
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

    if (appPath.startsWith("/__show/messages")) {
      sendJson(response, 200, { messages: runtime.listSessionMessages(sessionId) })
      return
    }

    if (appPath.startsWith("/api")) {
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
    vite.middlewares(request, response, (error?: unknown) => {
      if (error) {
        response.statusCode = 500
        response.end(error instanceof Error ? error.message : String(error))
        return
      }
      response.statusCode = 404
      response.end("Not found")
    })
    return
  }

  sendJson(response, 404, { error: "Not found" })
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
