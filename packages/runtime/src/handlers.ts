import { access } from "node:fs/promises"
import { join } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ViteDevServer } from "vite"

type Handler = (request: Request, context: HandlerContext) => Response | Promise<Response>

type HandlerContext = {
  session: {
    id: string
    workspace: string
  }
  log: {
    info(message: string, data?: unknown): void
    warn(message: string, data?: unknown): void
    error(message: string, data?: unknown): void
  }
}

export async function handleApiRequest({
  sessionId,
  workspace,
  apiPath,
  vite,
  request,
  response
}: {
  sessionId: string
  workspace: string
  apiPath: string
  vite: ViteDevServer
  request: IncomingMessage
  response: ServerResponse
}) {
  const modulePath = await resolveHandlerModule(workspace, apiPath)
  if (!modulePath) {
    sendJson(response, 404, { error: "Handler not found" })
    return
  }

  const method = (request.method ?? "GET").toUpperCase()
  const handlerModule = await vite.ssrLoadModule(modulePath) as Record<string, unknown>
  const handler = handlerModule[method] as Handler | undefined
  if (typeof handler !== "function") {
    sendJson(response, 405, { error: `Method ${method} not allowed` })
    return
  }

  const webRequest = await toWebRequest(request)
  const webResponse = await handler(webRequest, createHandlerContext(sessionId, workspace))
  await sendWebResponse(response, webResponse)
}

async function resolveHandlerModule(workspace: string, apiPath: string) {
  const normalized = apiPath.replace(/^\/+/, "").replace(/\.\./g, "")
  const candidates = [
    join(workspace, "api", `${normalized || "index"}.ts`),
    join(workspace, "api", normalized, "index.ts"),
    join(workspace, "api", "index.ts")
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // continue
    }
  }
  return null
}

function createHandlerContext(sessionId: string, workspace: string): HandlerContext {
  return {
    session: {
      id: sessionId,
      workspace
    },
    log: {
      info: (message, data) => console.info(`[${sessionId}] ${message}`, data ?? ""),
      warn: (message, data) => console.warn(`[${sessionId}] ${message}`, data ?? ""),
      error: (message, data) => console.error(`[${sessionId}] ${message}`, data ?? "")
    }
  }
}

async function toWebRequest(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
  return new Request(`http://127.0.0.1${request.url ?? "/"}`, {
    method: request.method,
    headers: request.headers as HeadersInit,
    body
  })
}

async function sendWebResponse(response: ServerResponse, webResponse: Response) {
  response.statusCode = webResponse.status
  webResponse.headers.forEach((value, key) => response.setHeader(key, value))
  if (!webResponse.body) {
    response.end()
    return
  }
  const buffer = Buffer.from(await webResponse.arrayBuffer())
  response.end(buffer)
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(body))
}
