import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { parse } from "node:url"
import type { AddressInfo } from "node:net"
import type { AgentMark, MarkAnchor, ShowEvent } from "@avibe/show-sdk"
import type { ShowRuntimeOptions } from "./types.js"
import { createShowRuntime } from "./runtime.js"
import { handleApiRequest } from "./handlers.js"

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

  const ensureMatch = pathname.match(/^\/sessions\/([^/]+)\/ensure$/)
  if (request.method === "POST" && ensureMatch) {
    sendJson(response, 200, await runtime.ensureSession(ensureMatch[1]))
    return
  }

  const statusMatch = pathname.match(/^\/sessions\/([^/]+)\/status$/)
  if (request.method === "GET" && statusMatch) {
    sendJson(response, 200, runtime.getSessionStatus(statusMatch[1]))
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
      if (payload.type !== "assistant.mark.created") {
        sendJson(response, 400, { error: "Unsupported event type" })
        return
      }
      const event = runtime.recordAgentMark(sessionId, payload.mark, payload.anchor)
      eventStreams.publish(sessionId, event)
      sendJson(response, 201, { ok: true, event })
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
    const status = await runtime.ensureSession(sessionId, publicBasePath(request))
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
      if (payload.type !== "assistant.mark.created") {
        sendJson(response, 400, { error: "Unsupported event type" })
        return
      }
      const event = runtime.recordAgentMark(sessionId, payload.mark, payload.anchor)
      eventStreams.publish(sessionId, event)
      sendJson(response, 201, { ok: true, event })
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

    request.url = appPath === "/" ? "/" : appPath
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
