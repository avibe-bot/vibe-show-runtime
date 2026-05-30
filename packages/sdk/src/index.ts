export const DEFAULT_MARK_SCOPE = "default"
export const MARK_ATTRIBUTE_PREFIX = "mark-"
export const DEFAULT_SHOW_EVENTS_PATH = "__show/events"

export type ShowActor = "human" | "assistant"
export type ShowEventType = "assistant.mark.created" | "human.intent.submitted" | "human.annotation.created"
export type MarkRole = ShowActor

export type MarkAnchorRect = {
  x: number
  y: number
  width: number
  height: number
}

export type MarkAnchor = {
  id?: string
  scope?: string
  selector?: string
  text?: string
  rect?: MarkAnchorRect
}

export type AgentMark = {
  id?: string
  role?: "assistant"
  scope?: string
  target: string
  body: string
  createdAt?: string
}

export type HumanIntentPayload = {
  id?: string
  scope?: string
  value?: unknown
  text?: string
  comment?: string
  createdAt?: string
  [key: string]: unknown
}

export type AssistantMarkCreatedEvent = {
  id: string
  type: "assistant.mark.created"
  sessionId?: string
  mark: Required<AgentMark>
  anchor?: MarkAnchor
  message: {
    role: "assistant"
    content: string
  }
  createdAt: string
}

export type HumanIntentSubmittedEvent = {
  id: string
  type: "human.intent.submitted" | "human.annotation.created"
  sessionId?: string
  scope: string
  payload: HumanIntentPayload
  anchor?: MarkAnchor
  createdAt: string
}

export type ShowEvent = AssistantMarkCreatedEvent | HumanIntentSubmittedEvent

export type VibeContext = {
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

export type VibeHandler = (request: Request, context: VibeContext) => Response | Promise<Response>

export type ShowClientOptions = {
  basePath?: string
  eventsPath?: string
  streamPath?: string
  fetch?: typeof fetch
}

export type SubmitShowEventOptions = ShowClientOptions & {
  sessionId?: string
}

export type AgentMarkSubmitOptions = SubmitShowEventOptions & {
  anchor?: MarkAnchor
}

export type RuntimeConfig = {
  sessionId?: string
  basePath?: string
  eventsPath?: string
  streamPath?: string
}

declare global {
  var __AVIBE_SHOW__: RuntimeConfig | undefined
}

export async function callHandler<TResponse = unknown>(path: string, init?: RequestInit): Promise<TResponse> {
  const response = await fetch(path, init)
  if (!response.ok) {
    throw new Error(`Show handler failed: ${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<TResponse>
}

export function markId(id: string, scope = DEFAULT_MARK_SCOPE) {
  const normalizedScope = normalizeMarkPart(scope || DEFAULT_MARK_SCOPE)
  const normalizedId = normalizeMarkPart(id)
  return `${MARK_ATTRIBUTE_PREFIX}${normalizedScope}-${normalizedId}`
}

export function markAttributes(id: string, scope = DEFAULT_MARK_SCOPE) {
  const normalizedScope = normalizeMarkPart(scope || DEFAULT_MARK_SCOPE)
  return {
    [`${MARK_ATTRIBUTE_PREFIX}${normalizedScope}`]: id
  }
}

export async function submitAgentMark(mark: AgentMark, options: AgentMarkSubmitOptions = {}) {
  const normalizedMark = normalizeAgentMark(mark)
  const event = assistantMarkEvent(normalizedMark, options.anchor, options.sessionId)
  return submitShowEvent(event, options)
}

export async function submitShowEvent(event: ShowEvent, options: SubmitShowEventOptions = {}) {
  const fetchImpl = options.fetch ?? fetch
  const sessionId = options.sessionId ?? event.sessionId ?? readSessionId()
  const body = {
    ...event,
    sessionId
  }
  const response = await fetchImpl(eventsUrl(options), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    throw new Error(`Show event submit failed: ${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<unknown>
}

export function showEventsUrl(options: ShowClientOptions = {}) {
  return eventsUrl(options)
}

export function showEventsStreamUrl(options: ShowClientOptions = {}) {
  return streamUrl(options)
}

export function subscribeShowEvents(options: ShowClientOptions & { afterId?: string } = {}) {
  const url = new URL(streamUrl(options), globalThis.location?.href ?? "http://127.0.0.1/")
  if (options.afterId) {
    url.searchParams.set("after_id", options.afterId)
  }
  return new EventSource(url.toString())
}

export function assistantMarkEvent(mark: Required<AgentMark>, anchor?: MarkAnchor, sessionId?: string): AssistantMarkCreatedEvent {
  return {
    id: mark.id,
    type: "assistant.mark.created",
    sessionId,
    mark,
    anchor,
    message: {
      role: "assistant",
      content: formatAgentMarkMessage(mark, anchor)
    },
    createdAt: mark.createdAt
  }
}

export function formatAgentMarkMessage(mark: Required<AgentMark>, anchor?: MarkAnchor) {
  const lines = [`[agent-mark:${mark.scope}] ${mark.target}`, "", mark.body]
  if (anchor?.selector) {
    lines.push("", `Anchor: ${anchor.selector}`)
  }
  if (anchor?.text) {
    lines.push(`Text: ${anchor.text}`)
  }
  return lines.join("\n")
}

export function normalizeAgentMark(mark: AgentMark): Required<AgentMark> {
  const target = (mark.target || "").trim()
  const body = (mark.body || "").trim()
  if (!target) {
    throw new Error("Agent mark target is required")
  }
  if (!body) {
    throw new Error("Agent mark body is required")
  }
  return {
    id: mark.id || randomId("mark"),
    role: "assistant",
    scope: mark.scope || DEFAULT_MARK_SCOPE,
    target,
    body,
    createdAt: mark.createdAt || new Date().toISOString()
  }
}

export function readRuntimeConfig(): RuntimeConfig {
  return globalThis.__AVIBE_SHOW__ ?? {}
}

function eventsUrl(options: ShowClientOptions) {
  const runtime = readRuntimeConfig()
  const basePath = options.basePath ?? runtime.basePath ?? "./"
  const path = options.eventsPath ?? runtime.eventsPath ?? DEFAULT_SHOW_EVENTS_PATH
  return joinPath(basePath, path)
}

function streamUrl(options: ShowClientOptions) {
  const runtime = readRuntimeConfig()
  const basePath = options.basePath ?? runtime.basePath ?? "./"
  const streamPath = options.streamPath ?? runtime.streamPath
  if (streamPath) {
    return joinPath(basePath, streamPath)
  }
  const url = new URL(eventsUrl(options), globalThis.location?.href ?? "http://127.0.0.1/")
  url.searchParams.set("stream", "1")
  return url.toString()
}

function readSessionId() {
  return readRuntimeConfig().sessionId ?? readSessionIdFromLocation()
}

function joinPath(basePath: string, path: string) {
  if (path.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    return path
  }
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`
  return `${base}${path}`
}

function readSessionIdFromLocation() {
  const pathname = globalThis.location?.pathname
  if (!pathname) return undefined
  const showMatch = pathname.match(/\/show\/([^/]+)/)
  if (showMatch) {
    return decodeURIComponent(showMatch[1])
  }
  return undefined
}

function randomId(prefix: string) {
  const cryptoValue = globalThis.crypto?.randomUUID?.()
  if (cryptoValue) {
    return `${prefix}_${cryptoValue}`
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`
}

function normalizeMarkPart(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]+/g, "-")
      .replace(/^-+|-+$/g, "") || DEFAULT_MARK_SCOPE
  )
}
