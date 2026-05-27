import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { parse } from "node:url"
import type { AddressInfo } from "node:net"
import type { ShowRuntimeOptions } from "./types.js"
import { createShowRuntime } from "./runtime.js"
import { handleApiRequest } from "./handlers.js"

export async function startShowRuntimeServer(options: ShowRuntimeOptions = { workspaceRoot: ".show" }) {
  const runtime = createShowRuntime(options)
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0

  const server = createServer(async (request, response) => {
    try {
      await routeRequest(runtime, request, response)
    } catch (error) {
      response.statusCode = 500
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Runtime error" }))
    }
  })

  await new Promise<void>((resolve) => server.listen(port, host, resolve))

  return {
    runtime,
    server,
    url: `http://${host}:${(server.address() as AddressInfo).port}`,
    async close() {
      await runtime.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
}

async function routeRequest(runtime: ReturnType<typeof createShowRuntime>, request: IncomingMessage, response: ServerResponse) {
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

  const suspendMatch = pathname.match(/^\/sessions\/([^/]+)\/suspend$/)
  if (request.method === "POST" && suspendMatch) {
    sendJson(response, 200, await runtime.suspendSession(suspendMatch[1]))
    return
  }

  const appMatch = pathname.match(/^\/sessions\/([^/]+)\/app\/?(.*)$/)
  if (appMatch) {
    const sessionId = appMatch[1]
    const appPath = `/${appMatch[2] || ""}`
    const status = await runtime.ensureSession(sessionId)
    const session = runtime.getSession(sessionId)
    if (!session) {
      sendJson(response, 503, { error: "Session not ready", status })
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

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(body))
}
