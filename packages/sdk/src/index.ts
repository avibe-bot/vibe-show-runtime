export const DEFAULT_MARK_SCOPE = "default"
export const MARK_ATTRIBUTE_PREFIX = "mark-"
export const DEFAULT_SHOW_EVENTS_PATH = "__show/events"
export const SHOW_EVENT_WRITE_TOKEN_HEADER = "X-Vibe-Show-Token"

export type ShowActor = "human" | "assistant" | "system"
export type MarkRole = "human" | "assistant"

export type ShowEventType =
  | "assistant.mark.created"
  | "assistant.mark.updated"
  | "assistant.mark.resolved"
  | "assistant.page.updated"
  | "human.intent.submitted"
  | "human.annotation.created"
  | "human.annotation.updated"
  | "human.annotation.resolved"
  | "human.annotation.dismissed"
  | "system.runtime.status"
  | "system.runtime.error"

export const SHOW_EVENT_TYPES = [
  "assistant.mark.created",
  "assistant.mark.updated",
  "assistant.mark.resolved",
  "assistant.page.updated",
  "human.intent.submitted",
  "human.annotation.created",
  "human.annotation.updated",
  "human.annotation.resolved",
  "human.annotation.dismissed",
  "system.runtime.status",
  "system.runtime.error"
] as const satisfies readonly ShowEventType[]

export type AnchorKind = "mark" | "element" | "text-range" | "area" | "group"

export type MarkAnchorRect = {
  x: number
  y: number
  width: number
  height: number
}

export type AnchorViewport = {
  width: number
  height: number
  scrollX: number
  scrollY: number
}

export type AnchorTextRange = {
  start?: number
  end?: number
}

export type ElementContext = {
  tagName?: string
  id?: string
  className?: string
  role?: string
  ariaLabel?: string
  alt?: string
  href?: string
  text?: string
  nearbyText?: string
  nearbyElements?: Array<{ selector?: string; label?: string; text?: string; rect?: MarkAnchorRect }>
  isFixed?: boolean
  computedStyles?: Record<string, string>
}

export type ShowAnchor = {
  kind?: AnchorKind
  id?: string
  scope?: string
  mark?: string
  selector?: string
  domPath?: string
  text?: string
  textQuote?: string
  textBefore?: string
  textAfter?: string
  textRange?: AnchorTextRange
  rect?: MarkAnchorRect
  viewport?: AnchorViewport
  componentPath?: string[]
  source?: string
  label?: string
  element?: ElementContext
  elements?: ShowAnchor[]
}

export type MarkAnchor = ShowAnchor

export type AnchorResolveResult = {
  anchor: ShowAnchor
  element?: Element
  rect?: MarkAnchorRect
  confidence: "exact" | "selector" | "text" | "area" | "missing"
  reason?: string
}

export type AgentMark = {
  id?: string
  role?: "assistant"
  scope?: string
  target: string
  body: string
  status?: "active" | "resolved"
  createdAt?: string
  updatedAt?: string
  resolvedAt?: string
  [key: string]: unknown
}

export type HumanIntentPayload = {
  id?: string
  scope?: string
  component?: string
  intent?: string
  value?: unknown
  values?: Record<string, unknown>
  text?: string
  comment?: string
  dispatch?: boolean
  createdAt?: string
  [key: string]: unknown
}

export type ShowAnnotationIntent = "fix" | "change" | "question" | "approve" | "comment"
export type ShowAnnotationSeverity = "blocking" | "important" | "suggestion"
export type ShowAnnotationStatus = "pending" | "acknowledged" | "resolved" | "dismissed"

export type ShowAnnotation = {
  id?: string
  scope?: string
  intent?: ShowAnnotationIntent | string
  severity?: ShowAnnotationSeverity | string
  status?: ShowAnnotationStatus | string
  comment?: string
  text?: string
  anchor?: ShowAnchor
  authorId?: string
  createdAt?: string
  updatedAt?: string
  resolvedAt?: string
  resolvedBy?: string
  [key: string]: unknown
}

export type AssistantMarkEvent = {
  id: string
  type: "assistant.mark.created" | "assistant.mark.updated" | "assistant.mark.resolved"
  sessionId?: string
  mark: Required<AgentMark>
  anchor?: ShowAnchor
  message: {
    role: "assistant"
    content: string
  }
  createdAt: string
}

export type HumanIntentSubmittedEvent = {
  id: string
  type: "human.intent.submitted"
  sessionId?: string
  scope: string
  payload: HumanIntentPayload
  anchor?: ShowAnchor
  message?: {
    role: "user"
    content: string
  }
  createdAt: string
}

export type HumanAnnotationEvent = {
  id: string
  type: "human.annotation.created" | "human.annotation.updated" | "human.annotation.resolved" | "human.annotation.dismissed"
  sessionId?: string
  scope: string
  annotation: Required<Pick<ShowAnnotation, "id" | "scope" | "status" | "createdAt">> & ShowAnnotation
  anchor?: ShowAnchor
  message?: {
    role: "user"
    content: string
  }
  createdAt: string
}

export type AssistantPageUpdatedEvent = {
  id: string
  type: "assistant.page.updated"
  sessionId?: string
  summary?: string
  message?: {
    role: "assistant"
    content: string
  }
  createdAt: string
  [key: string]: unknown
}

export type SystemRuntimeEvent = {
  id: string
  type: "system.runtime.status" | "system.runtime.error"
  sessionId?: string
  status?: string
  error?: string
  details?: unknown
  createdAt: string
  [key: string]: unknown
}

export type ShowEvent =
  | AssistantMarkEvent
  | HumanIntentSubmittedEvent
  | HumanAnnotationEvent
  | AssistantPageUpdatedEvent
  | SystemRuntimeEvent

export type ShowEventInput = {
  type: ShowEventType
  id?: string
  sessionId?: string
  createdAt?: string
  mark?: AgentMark | Required<AgentMark>
  annotation?: ShowAnnotation
  payload?: HumanIntentPayload | Record<string, unknown>
  anchor?: ShowAnchor
  message?: { role: "assistant" | "user"; content: string }
  summary?: string
  status?: string
  error?: string
  details?: unknown
  [key: string]: unknown
}

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
  writeToken?: string
  fetch?: typeof fetch
}

export type SubmitShowEventOptions = ShowClientOptions & {
  sessionId?: string
}

export type AgentMarkSubmitOptions = SubmitShowEventOptions & {
  anchor?: ShowAnchor
}

export type IntentSubmitOptions = SubmitShowEventOptions & {
  anchor?: ShowAnchor
}

export type AnnotationSubmitOptions = SubmitShowEventOptions & {
  anchor?: ShowAnchor
}

export type RuntimeConfig = {
  sessionId?: string
  basePath?: string
  eventsPath?: string
  streamPath?: string
  writeToken?: string
}

export type CollectElementContextOptions = {
  scope?: string
  includeNearby?: boolean
  includeComputedStyles?: boolean
  source?: string
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

export function markAttributeName(scope = DEFAULT_MARK_SCOPE) {
  return `${MARK_ATTRIBUTE_PREFIX}${normalizeMarkPart(scope || DEFAULT_MARK_SCOPE)}`
}

export function markAttributes(id: string, scope = DEFAULT_MARK_SCOPE) {
  return {
    [markAttributeName(scope)]: id
  }
}

export function markSelector(id: string, scope = DEFAULT_MARK_SCOPE) {
  return `[${cssEscape(markAttributeName(scope))}="${cssEscape(id)}"]`
}

export function isShowEventType(value: unknown): value is ShowEventType {
  return typeof value === "string" && (SHOW_EVENT_TYPES as readonly string[]).includes(value)
}

export async function submitAgentMark(mark: AgentMark, options: AgentMarkSubmitOptions = {}) {
  const event = assistantMarkEvent(normalizeAgentMark(mark), options.anchor, options.sessionId)
  return submitShowEvent(event, options)
}

export async function submitIntent(payload: HumanIntentPayload, options: IntentSubmitOptions = {}) {
  return submitShowEvent(humanIntentEvent(payload, options.anchor, options.sessionId), options)
}

export async function submitAnnotation(annotation: ShowAnnotation, options: AnnotationSubmitOptions = {}) {
  return submitShowEvent(humanAnnotationEvent("human.annotation.created", annotation, options.anchor, options.sessionId), options)
}

export async function updateAnnotation(annotation: ShowAnnotation, options: AnnotationSubmitOptions = {}) {
  return submitShowEvent(humanAnnotationEvent("human.annotation.updated", annotation, options.anchor, options.sessionId), options)
}

export async function resolveAnnotation(annotation: ShowAnnotation, options: AnnotationSubmitOptions = {}) {
  return submitShowEvent(humanAnnotationEvent("human.annotation.resolved", annotation, options.anchor, options.sessionId), options)
}

export async function dismissAnnotation(annotation: ShowAnnotation, options: AnnotationSubmitOptions = {}) {
  return submitShowEvent(humanAnnotationEvent("human.annotation.dismissed", annotation, options.anchor, options.sessionId), options)
}

export async function submitShowEvent(event: ShowEventInput | ShowEvent, options: SubmitShowEventOptions = {}) {
  const normalizedEvent = normalizeShowEvent(event, options.sessionId)
  const fetchImpl = options.fetch ?? fetch
  const body = {
    ...normalizedEvent,
    sessionId: options.sessionId ?? normalizedEvent.sessionId ?? readSessionId()
  }
  const headers: Record<string, string> = { "content-type": "application/json" }
  const token = options.writeToken ?? readRuntimeConfig().writeToken
  if (token) {
    headers[SHOW_EVENT_WRITE_TOKEN_HEADER] = token
  }
  const response = await fetchImpl(eventsUrl(options), {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    throw new Error(`Show event submit failed: ${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<{ ok?: boolean; event?: ShowEvent } | unknown>
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

export function normalizeShowEvent(event: ShowEventInput | ShowEvent, sessionId?: string): ShowEvent {
  if (!isShowEventType(event.type)) {
    throw new Error(`Unsupported Show event type: ${String(event.type)}`)
  }
  const input = event as ShowEventInput
  const createdAt = typeof event.createdAt === "string" ? event.createdAt : undefined
  if (event.type.startsWith("assistant.mark.")) {
    const mark = input.mark ?? (event as AssistantMarkEvent).mark
    return assistantMarkEvent(
      normalizeAgentMark(mark),
      input.anchor,
      sessionId ?? event.sessionId,
      event.type as AssistantMarkEvent["type"],
      input.id,
      input.message as AssistantMarkEvent["message"] | undefined,
      createdAt
    )
  }
  if (event.type === "human.intent.submitted") {
    return humanIntentEvent(
      (input.payload ?? {}) as HumanIntentPayload,
      input.anchor,
      sessionId ?? event.sessionId,
      input.id,
      input.message as HumanIntentSubmittedEvent["message"] | undefined,
      createdAt
    )
  }
  if (event.type.startsWith("human.annotation.")) {
    return humanAnnotationEvent(
      event.type as HumanAnnotationEvent["type"],
      input.annotation ?? annotationFromPayload(input),
      input.anchor,
      sessionId ?? event.sessionId,
      input.id,
      input.message as HumanAnnotationEvent["message"] | undefined,
      createdAt
    )
  }
  return {
    ...event,
    id: typeof event.id === "string" && event.id ? event.id : randomId(event.type.startsWith("system.") ? "runtime" : "page"),
    sessionId: sessionId ?? event.sessionId,
    createdAt: createdAt ?? new Date().toISOString()
  } as ShowEvent
}

export function assistantMarkEvent(
  mark: Required<AgentMark>,
  anchor?: ShowAnchor,
  sessionId?: string,
  type: AssistantMarkEvent["type"] = "assistant.mark.created",
  eventId?: string,
  message?: AssistantMarkEvent["message"],
  eventCreatedAt?: string
): AssistantMarkEvent {
  const occurredAt = eventCreatedAt || (type === "assistant.mark.created" ? mark.createdAt : undefined) || new Date().toISOString()
  const createdAt = mark.createdAt || occurredAt
  const resolvedAnchor = anchor ?? targetToAnchor(mark.target, normalizeScope(mark.scope))
  const normalized = {
    ...mark,
    id: mark.id,
    role: "assistant" as const,
    scope: normalizeScope(mark.scope),
    target: mark.target.trim(),
    body: mark.body.trim(),
    status: type === "assistant.mark.resolved" ? "resolved" : mark.status ?? "active",
    createdAt,
    updatedAt: type === "assistant.mark.created" ? mark.updatedAt || createdAt : occurredAt,
    resolvedAt: type === "assistant.mark.resolved" ? occurredAt : mark.resolvedAt
  }
  return {
    id: eventId || randomId("show_evt"),
    type,
    sessionId,
    mark: normalized,
    anchor: resolvedAnchor,
    message: message ?? {
      role: "assistant",
      content: formatAgentMarkMessage(normalized, resolvedAnchor)
    },
    createdAt: occurredAt
  }
}

export function humanIntentEvent(
  payload: HumanIntentPayload,
  anchor?: ShowAnchor,
  sessionId?: string,
  eventId?: string,
  message?: HumanIntentSubmittedEvent["message"],
  eventCreatedAt?: string
): HumanIntentSubmittedEvent {
  const createdAt = eventCreatedAt || payload.createdAt || new Date().toISOString()
  const normalizedPayload: HumanIntentPayload = {
    ...payload,
    id: payload.id || randomId("intent"),
    scope: normalizeScope(payload.scope),
    createdAt
  }
  const content = formatHumanIntentMessage(normalizedPayload, anchor)
  return {
    id: eventId || randomId("show_evt"),
    type: "human.intent.submitted",
    sessionId,
    scope: normalizedPayload.scope!,
    payload: normalizedPayload,
    anchor,
    message: message ?? {
      role: "user",
      content
    },
    createdAt
  }
}

export function humanAnnotationEvent(
  type: HumanAnnotationEvent["type"],
  annotation: ShowAnnotation,
  anchor?: ShowAnchor,
  sessionId?: string,
  eventId?: string,
  message?: HumanAnnotationEvent["message"],
  eventCreatedAt?: string
): HumanAnnotationEvent {
  const occurredAt = eventCreatedAt || (type === "human.annotation.created" ? annotation.createdAt : undefined) || new Date().toISOString()
  const createdAt = annotation.createdAt || occurredAt
  const status = type === "human.annotation.resolved" || type === "human.annotation.dismissed"
    ? statusFromAnnotationEventType(type)
    : annotation.status || statusFromAnnotationEventType(type)
  const normalizedAnnotation = {
    ...annotation,
    id: annotation.id || randomId("annotation"),
    scope: normalizeScope(annotation.scope),
    status,
    anchor: anchor ?? annotation.anchor,
    createdAt,
    updatedAt: type === "human.annotation.created" ? annotation.updatedAt || createdAt : occurredAt,
    resolvedAt: type === "human.annotation.resolved" ? occurredAt : annotation.resolvedAt
  }
  const content = formatHumanAnnotationMessage(type, normalizedAnnotation, normalizedAnnotation.anchor)
  return {
    id: eventId || randomId("show_evt"),
    type,
    sessionId,
    scope: normalizedAnnotation.scope,
    annotation: normalizedAnnotation,
    anchor: normalizedAnnotation.anchor,
    message: message ?? {
      role: "user",
      content
    },
    createdAt: occurredAt
  }
}

export function formatShowEventMessage(event: ShowEvent) {
  if (event.type.startsWith("assistant.mark.")) {
    const markEvent = event as AssistantMarkEvent
    return markEvent.message?.content ?? formatAgentMarkMessage(markEvent.mark, markEvent.anchor)
  }
  if (event.type === "human.intent.submitted") {
    return event.message?.content ?? formatHumanIntentMessage(event.payload, event.anchor)
  }
  if (event.type.startsWith("human.annotation.")) {
    const annotationEvent = event as HumanAnnotationEvent
    return annotationEvent.message?.content ?? formatHumanAnnotationMessage(annotationEvent.type, annotationEvent.annotation, annotationEvent.anchor)
  }
  if (event.type === "assistant.page.updated") {
    return event.message?.content ?? (typeof event.summary === "string" && event.summary.trim() ? `[show-page-updated] ${event.summary.trim()}` : undefined)
  }
  if (event.type === "system.runtime.error") {
    return `[show-runtime-error] ${event.error || "Runtime error"}`
  }
  return undefined
}

export function formatAgentMarkMessage(mark: Required<AgentMark>, anchor?: ShowAnchor) {
  const lines = [`[agent-mark:${mark.scope}] ${mark.target}`, "", mark.body]
  if (anchor?.selector) {
    lines.push("", `Anchor: ${anchor.selector}`)
  }
  const text = anchor?.textQuote ?? anchor?.text
  if (text) {
    lines.push(`Text: ${text}`)
  }
  return lines.join("\n")
}

export function formatHumanIntentMessage(payload: HumanIntentPayload, anchor?: ShowAnchor) {
  const label = payload.intent || payload.component || "intent"
  const scope = normalizeScope(payload.scope)
  const lines = [`[show-intent:${scope}] ${label}`]
  const text = payload.comment || payload.text || stringifyIntentValue(payload.value ?? payload.values)
  if (text) {
    lines.push("", text)
  }
  if (anchor?.selector) {
    lines.push("", `Anchor: ${anchor.selector}`)
  }
  return lines.join("\n")
}

export function formatHumanAnnotationMessage(type: HumanAnnotationEvent["type"], annotation: ShowAnnotation, anchor?: ShowAnchor) {
  const scope = normalizeScope(annotation.scope)
  const action = type.split(".").at(-1) || "created"
  const lines = [`[show-annotation:${scope}:${action}] ${annotation.intent || "comment"}`]
  const comment = (annotation.comment || annotation.text || "").trim()
  if (comment) {
    lines.push("", comment)
  }
  const quote = anchor?.textQuote ?? anchor?.text
  if (quote) {
    lines.push("", `Quote: ${quote}`)
  }
  if (anchor?.selector) {
    lines.push(`Anchor: ${anchor.selector}`)
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
  const createdAt = mark.createdAt || new Date().toISOString()
  return {
    ...mark,
    id: mark.id || randomId("mark"),
    role: "assistant",
    scope: normalizeScope(mark.scope),
    target,
    body,
    status: mark.status || "active",
    createdAt,
    updatedAt: mark.updatedAt || createdAt,
    resolvedAt: mark.resolvedAt || ""
  }
}

export function collectElementContext(element: Element, options: CollectElementContextOptions = {}): ShowAnchor {
  const scope = normalizeScope(options.scope)
  const rect = rectFromElement(element)
  const mark = readElementMark(element, scope)
  const selector = mark ? markSelector(mark.value, mark.scope) : selectorForElement(element)
  const label = elementLabel(element)
  const text = elementText(element)
  const context: ElementContext = {
    tagName: element.tagName.toLowerCase(),
    id: element.id || undefined,
    className: element instanceof HTMLElement ? element.className || undefined : undefined,
    role: element.getAttribute("role") || undefined,
    ariaLabel: element.getAttribute("aria-label") || undefined,
    alt: element.getAttribute("alt") || undefined,
    href: element.getAttribute("href") || undefined,
    text,
    nearbyText: options.includeNearby === false ? undefined : nearbyText(element),
    nearbyElements: options.includeNearby === false ? undefined : nearbyElements(element),
    isFixed: isFixedOrSticky(element),
    computedStyles: options.includeComputedStyles ? computedStyles(element) : undefined
  }
  return {
    kind: mark ? "mark" : "element",
    id: mark?.value,
    scope: mark?.scope ?? scope,
    mark: mark?.value,
    selector,
    domPath: domPath(element),
    text: text || undefined,
    textQuote: text || undefined,
    rect,
    viewport: viewport(),
    source: options.source || "element",
    label,
    element: context
  }
}

export function collectTextSelectionAnchor(selection: Selection | null = safeSelection(), options: CollectElementContextOptions = {}): ShowAnchor | undefined {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return undefined
  }
  const range = selection.getRangeAt(0)
  const quote = selection.toString().trim()
  if (!quote) {
    return undefined
  }
  const ancestor = elementFromNode(range.commonAncestorContainer)
  const parentText = ancestor?.textContent || ""
  const quoteIndex = parentText.indexOf(quote)
  const rect = rectFromDomRect(range.getBoundingClientRect())
  const base = ancestor ? collectElementContext(ancestor, options) : undefined
  return {
    ...base,
    kind: "text-range",
    id: randomId("text"),
    scope: normalizeScope(options.scope ?? base?.scope),
    selector: base?.selector,
    domPath: base?.domPath,
    text: quote,
    textQuote: quote,
    textBefore: quoteIndex > 0 ? parentText.slice(Math.max(0, quoteIndex - 80), quoteIndex).trim() : undefined,
    textAfter: quoteIndex >= 0 ? parentText.slice(quoteIndex + quote.length, quoteIndex + quote.length + 80).trim() : undefined,
    textRange: quoteIndex >= 0 ? { start: quoteIndex, end: quoteIndex + quote.length } : undefined,
    rect,
    viewport: viewport(),
    source: "selection"
  }
}

export function collectAreaAnchor(rect: MarkAnchorRect, options: CollectElementContextOptions = {}): ShowAnchor {
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  const element = deepElementFromPoint(centerX, centerY)
  const base = element ? collectElementContext(element, options) : undefined
  return {
    kind: "area",
    id: randomId("area"),
    scope: normalizeScope(options.scope ?? base?.scope),
    selector: base?.selector,
    domPath: base?.domPath,
    rect: normalizeRect(rect),
    viewport: viewport(),
    source: "area",
    element: base?.element
  }
}

export function resolveAnchor(anchor: ShowAnchor, root?: ParentNode): AnchorResolveResult {
  if (anchor.kind === "area" && anchor.rect) {
    return { anchor, rect: anchor.rect, confidence: "area" }
  }
  const resolvedRoot = root ?? (typeof document !== "undefined" ? document : undefined)
  if (!resolvedRoot) {
    return { anchor, rect: anchor.rect, confidence: "missing", reason: "No DOM root available" }
  }
  const byMark = anchor.mark ? queryOne(resolvedRoot, markSelector(anchor.mark, anchor.scope)) : undefined
  if (byMark) {
    return { anchor, element: byMark, rect: rectFromElement(byMark), confidence: "exact" }
  }
  const byId = anchor.id ? queryOne(resolvedRoot, markSelector(anchor.id, anchor.scope)) : undefined
  if (byId) {
    return { anchor, element: byId, rect: rectFromElement(byId), confidence: "exact" }
  }
  const bySelector = anchor.selector ? queryOne(resolvedRoot, anchor.selector) : undefined
  if (bySelector) {
    return { anchor, element: bySelector, rect: rectFromElement(bySelector), confidence: "selector" }
  }
  if (anchor.textQuote) {
    const byText = findElementByText(anchor.textQuote, resolvedRoot)
    if (byText) {
      return { anchor, element: byText, rect: rectFromElement(byText), confidence: "text" }
    }
  }
  return { anchor, rect: anchor.rect, confidence: "missing", reason: "No matching element found" }
}

export function deepElementFromPoint(x: number, y: number, root: Document | ShadowRoot = document): Element | undefined {
  let element = root.elementFromPoint(x, y)
  while (element?.shadowRoot) {
    const next = element.shadowRoot.elementFromPoint(x, y)
    if (!next || next === element) break
    element = next
  }
  return element ?? undefined
}

export function readRuntimeConfig(): RuntimeConfig {
  return globalThis.__AVIBE_SHOW__ ?? {}
}

export function createShowEventId(prefix = "event") {
  return randomId(prefix)
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

function normalizeScope(scope?: string) {
  return normalizeMarkPart(scope || DEFAULT_MARK_SCOPE)
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

function statusFromAnnotationEventType(type: HumanAnnotationEvent["type"]) {
  if (type === "human.annotation.resolved") return "resolved"
  if (type === "human.annotation.dismissed") return "dismissed"
  return "pending"
}

function annotationFromPayload(event: ShowEventInput): ShowAnnotation {
  const payload = event.payload
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as ShowAnnotation
  }
  return {}
}

function targetToAnchor(target: string, scope: string): ShowAnchor | undefined {
  if (target.startsWith(`${MARK_ATTRIBUTE_PREFIX}${scope}-`)) {
    const id = target.slice(`${MARK_ATTRIBUTE_PREFIX}${scope}-`.length)
    return { kind: "mark", id, mark: id, scope, selector: markSelector(id, scope) }
  }
  if (target.startsWith("#") || target.startsWith(".") || target.startsWith("[")) {
    return { kind: "element", scope, selector: target }
  }
  return undefined
}

function stringifyIntentValue(value: unknown) {
  if (value === undefined || value === null || value === "") return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function randomId(prefix: string) {
  const cryptoValue = globalThis.crypto?.randomUUID?.()
  if (cryptoValue) {
    return `${prefix}_${cryptoValue}`
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`
}

function safeSelection() {
  return typeof globalThis.getSelection === "function" ? globalThis.getSelection() : null
}

function elementFromNode(node: Node | null): Element | undefined {
  if (!node) return undefined
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement ?? undefined
}

function rectFromElement(element: Element): MarkAnchorRect {
  const rect = element.getBoundingClientRect()
  if (rect.width || rect.height) {
    return rectFromDomRect(rect)
  }
  return rectFromDomRect(unionContentRect(element) ?? rect)
}

function rectFromDomRect(rect: DOMRect | DOMRectReadOnly): MarkAnchorRect {
  return normalizeRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
}

function normalizeRect(rect: MarkAnchorRect): MarkAnchorRect {
  const x = Math.min(rect.x, rect.x + rect.width)
  const y = Math.min(rect.y, rect.y + rect.height)
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.abs(rect.width)),
    height: Math.round(Math.abs(rect.height))
  }
}

function viewport(): AnchorViewport | undefined {
  if (typeof window === "undefined") return undefined
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  }
}

function readElementMark(element: Element, preferredScope = DEFAULT_MARK_SCOPE) {
  const preferredName = markAttributeName(preferredScope)
  const preferredValue = element.getAttribute(preferredName)
  if (preferredValue) {
    return { scope: preferredScope, value: preferredValue }
  }
  for (const attr of Array.from(element.attributes)) {
    if (attr.name.startsWith(MARK_ATTRIBUTE_PREFIX) && attr.value) {
      return { scope: normalizeScope(attr.name.slice(MARK_ATTRIBUTE_PREFIX.length)), value: attr.value }
    }
  }
  return undefined
}

function selectorForElement(element: Element): string | undefined {
  if (element.id) {
    return `#${cssEscape(element.id)}`
  }
  for (const attr of ["data-testid", "data-test-id", "data-cy", "name", "aria-label"]) {
    const value = element.getAttribute(attr)
    if (value) {
      return `${element.tagName.toLowerCase()}[${attr}="${cssEscape(value)}"]`
    }
  }
  const path: string[] = []
  let current: Element | null = element
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase()
    const parent: Element | null = current.parentElement
    if (!parent) {
      path.unshift(tag)
      break
    }
    const currentTagName = current.tagName
    const siblings = Array.from(parent.children).filter((child): child is Element => child instanceof Element && child.tagName === currentTagName)
    const part = siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag
    path.unshift(part)
    current = parent
    if (path.length >= 5) break
  }
  return path.length ? path.join(" > ") : undefined
}

function domPath(element: Element): string {
  const path: string[] = []
  let current: Element | null = element
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const tag = current.tagName.toLowerCase()
    const parent: Element | null = current.parentElement
    const index = parent ? Array.from(parent.children).indexOf(current) : 0
    path.unshift(`${tag}[${index}]`)
    current = parent
    if (path.length >= 12) break
  }
  return path.join("/")
}

function elementText(element: Element) {
  return normalizeTextContent(element.textContent || "").slice(0, 320)
}

function elementLabel(element: Element) {
  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("alt") ||
    element.getAttribute("title") ||
    elementText(element).slice(0, 80) ||
    element.tagName.toLowerCase()
  )
}

function nearbyText(element: Element) {
  const texts: string[] = []
  const parent = element.parentElement
  for (const node of [element.previousElementSibling, element.nextElementSibling, parent]) {
    if (!node) continue
    const text = elementText(node)
    if (text && !texts.includes(text)) {
      texts.push(text)
    }
  }
  return texts.join(" ").slice(0, 500) || undefined
}

function nearbyElements(element: Element) {
  const parent = element.parentElement
  if (!parent) return undefined
  return Array.from(parent.children)
    .filter((child) => child !== element)
    .slice(0, 6)
    .map((child) => ({
      selector: selectorForElement(child),
      label: elementLabel(child),
      text: elementText(child).slice(0, 120) || undefined,
      rect: rectFromElement(child)
    }))
}

function isFixedOrSticky(element: Element) {
  let current: Element | null = element
  while (current) {
    const style = globalThis.getComputedStyle?.(current)
    if (style?.position === "fixed" || style?.position === "sticky") {
      return true
    }
    current = current.parentElement
  }
  return false
}

function computedStyles(element: Element) {
  const style = globalThis.getComputedStyle?.(element)
  if (!style) return undefined
  return {
    display: style.display,
    position: style.position,
    color: style.color,
    backgroundColor: style.backgroundColor,
    font: style.font,
    zIndex: style.zIndex
  }
}

function queryOne(root: ParentNode, selector: string) {
  try {
    return root.querySelector(selector) ?? undefined
  } catch {
    return undefined
  }
}

function findElementByText(text: string, root: ParentNode) {
  const needle = normalizeTextContent(text)
  if (!needle) return undefined
  const ownerDocument = ownerDocumentForRoot(root)
  if (!ownerDocument || typeof NodeFilter === "undefined") return undefined

  const textWalker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let textNode = textWalker.nextNode()
  while (textNode) {
    const parent = textNode.parentElement
    if (parent && !isTextAnchorContainer(parent) && normalizeTextContent(textNode.textContent || "").includes(needle)) {
      return parent
    }
    textNode = textWalker.nextNode()
  }

  let best: Element | undefined
  if (typeof Element !== "undefined" && root instanceof Element && isTextAnchorCandidate(root, needle)) {
    best = root
  }
  const elementWalker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  let current = elementWalker.nextNode()
  while (current) {
    const element = current as Element
    if (isTextAnchorCandidate(element, needle) && (!best || best.contains(element))) {
      best = element
    }
    current = elementWalker.nextNode()
  }
  return best
}

function cssEscape(value: string) {
  if (globalThis.CSS?.escape) {
    return globalThis.CSS.escape(value)
  }
  return value.replace(/["\\]/g, "\\$&")
}

function ownerDocumentForRoot(root: ParentNode) {
  if (typeof Document !== "undefined" && root instanceof Document) {
    return root
  }
  return (root as Node).ownerDocument ?? (typeof document !== "undefined" ? document : undefined)
}

function isTextAnchorCandidate(element: Element, needle: string) {
  return !isTextAnchorContainer(element) && normalizeTextContent(element.textContent || "").includes(needle)
}

function isTextAnchorContainer(element: Element) {
  const tagName = element.tagName.toLowerCase()
  if (["html", "body", "head", "script", "style", "template", "noscript"].includes(tagName)) {
    return true
  }
  return Boolean(element.closest("[data-show-annotation-ui], [data-show-annotation-capture], [data-show-agent-mark-layer]"))
}

function normalizeTextContent(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function unionContentRect(element: Element): DOMRect | undefined {
  const rects = Array.from(element.querySelectorAll("*")).flatMap((child) =>
    Array.from(child.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
  )
  const ownerDocument = element.ownerDocument ?? (typeof document !== "undefined" ? document : undefined)
  if (ownerDocument && typeof NodeFilter !== "undefined") {
    const walker = ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      if (normalizeTextContent(node.textContent || "")) {
        const range = ownerDocument.createRange()
        range.selectNodeContents(node)
        const rect = range.getBoundingClientRect()
        if (rect.width > 0 || rect.height > 0) {
          rects.push(rect)
        }
        range.detach()
      }
      node = walker.nextNode()
    }
  }
  if (!rects.length) return undefined
  const left = Math.min(...rects.map((rect) => rect.left))
  const top = Math.min(...rects.map((rect) => rect.top))
  const right = Math.max(...rects.map((rect) => rect.right))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  return new DOMRect(left, top, right - left, bottom - top)
}
