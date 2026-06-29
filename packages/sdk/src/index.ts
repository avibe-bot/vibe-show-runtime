export const DEFAULT_MARK_SCOPE = "default"
export const MARK_ATTRIBUTE_PREFIX = "mark-"
export const DEFAULT_SHOW_EVENTS_PATH = "__show/events"
export const SHOW_EVENT_WRITE_TOKEN_HEADER = "X-Vibe-Show-Token"
export * from "./local-decisions.js"

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

export type AnchorKind = "mark" | "element" | "text-range" | "area" | "element-group" | "group" | "screenshot"

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
export type ShowAnnotationPrimaryAnchor = "mark" | "element" | "text-range" | "element-group" | "area" | "screenshot"

export type AreaSelectionClassification = {
  confidence: number
  reason: string
  ambiguous?: boolean
}

export type ScreenshotAnnotationItem = {
  id?: string
  label: number
  comment: string
  point?: { x: number; y: number }
  rect?: MarkAnchorRect
}

export type ScreenshotAnnotationPayload = {
  attachmentId: string
  mimeType: "image/png" | "image/webp"
  width: number
  height: number
  capturedRegion: MarkAnchorRect
  viewport?: AnchorViewport
  captured?: boolean
  captureError?: string
  dataUrl?: string
  items: ScreenshotAnnotationItem[]
}

export type ShowAnnotation = {
  id?: string
  scope?: string
  intent?: ShowAnnotationIntent | string
  severity?: ShowAnnotationSeverity | string
  status?: ShowAnnotationStatus | string
  comment?: string
  text?: string
  primaryAnchor?: ShowAnnotationPrimaryAnchor
  anchor?: ShowAnchor
  anchors?: ShowAnchor[]
  userRegion?: MarkAnchorRect
  matchedElements?: ShowAnchor[]
  classification?: AreaSelectionClassification
  screenshot?: ScreenshotAnnotationPayload
  authorId?: string
  createdAt?: string
  updatedAt?: string
  resolvedAt?: string
  resolvedBy?: string
  [key: string]: unknown
}

export type AreaAnnotationInput = ShowAnnotation & {
  primaryAnchor?: "area" | "element-group"
}

export type ScreenshotAnnotationInput = ShowAnnotation & {
  screenshot: ScreenshotAnnotationPayload
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

export type AreaSelectionResult = {
  anchor: ShowAnchor
  primaryAnchor: "area" | "element-group"
  userRegion: MarkAnchorRect
  matchedElements: ShowAnchor[]
  classification: AreaSelectionClassification
}

export type CollectAreaSelectionOptions = CollectElementContextOptions & {
  maxElements?: number
  root?: ParentNode
}

export type ScreenshotCaptureResult = {
  attachmentId: string
  mimeType: "image/png"
  width: number
  height: number
  capturedRegion: MarkAnchorRect
  viewport?: AnchorViewport
  captured: boolean
  captureError?: string
  dataUrl?: string
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

export function areaAnnotation(annotation: AreaAnnotationInput): ShowAnnotation {
  const primaryAnchor = annotation.primaryAnchor ?? (annotation.matchedElements?.length ? "element-group" : "area")
  return {
    ...annotation,
    primaryAnchor,
    anchor: annotation.anchor ?? annotation.anchors?.[0],
    userRegion: annotation.userRegion ?? annotation.anchor?.rect,
    matchedElements: annotation.matchedElements ?? (primaryAnchor === "element-group" ? annotation.anchors : undefined)
  }
}

export function screenshotAnnotation(annotation: ScreenshotAnnotationInput): ShowAnnotation {
  return {
    ...annotation,
    primaryAnchor: "screenshot",
    screenshot: {
      ...annotation.screenshot,
      items: annotation.screenshot.items.map((item, index) => ({
        ...item,
        id: item.id || randomId("shot_item"),
        label: item.label || index + 1
      }))
    }
  }
}

export function annotationFromAreaSelection(annotation: AreaAnnotationInput, selection: AreaSelectionResult): ShowAnnotation {
  return areaAnnotation({
    ...annotation,
    primaryAnchor: annotation.primaryAnchor ?? selection.primaryAnchor,
    anchor: annotation.anchor ?? selection.anchor,
    anchors: annotation.anchors ?? selection.matchedElements,
    userRegion: annotation.userRegion ?? selection.userRegion,
    matchedElements: annotation.matchedElements ?? selection.matchedElements,
    classification: annotation.classification ?? selection.classification
  })
}

export function screenshotAnnotationFromDraft(annotation: Omit<ScreenshotAnnotationInput, "screenshot"> & {
  screenshot: ScreenshotCaptureResult & { items: ScreenshotAnnotationItem[] }
}): ShowAnnotation {
  return screenshotAnnotation(annotation)
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
    primaryAnchor: annotation.primaryAnchor ?? inferAnnotationPrimaryAnchor(annotation, anchor),
    status,
    anchor: anchor ?? annotation.anchor ?? annotation.anchors?.[0],
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
  const primaryAnchor = annotation.primaryAnchor ?? inferAnnotationPrimaryAnchor(annotation, anchor)
  const lines = [`[show-annotation:${scope}:${action}] ${annotation.intent || "comment"}`]
  const comment = (annotation.comment || annotation.text || "").trim()
  if (comment) {
    lines.push("", comment)
  }
  lines.push("", `Anchor kind: ${primaryAnchor}`)
  if (annotation.screenshot?.items.length) {
    lines.push("", `Screenshot: ${annotation.screenshot.attachmentId}`)
    for (const item of annotation.screenshot.items) {
      lines.push(`${item.label}. ${item.comment}`)
    }
  }
  if (annotation.userRegion) {
    lines.push("", `Region: ${formatRect(annotation.userRegion)}`)
  }
  if (annotation.matchedElements?.length) {
    lines.push(`Matched elements: ${annotation.matchedElements.length}`)
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

export function collectAreaSelection(rect: MarkAnchorRect, options: CollectAreaSelectionOptions = {}): AreaSelectionResult {
  const userRegion = normalizeAnchorRect(rect)
  const matchedElements = collectElementsInArea(userRegion, options)
  const classification = classifyAreaSelection(userRegion, matchedElements)
  const primaryAnchor = classification.reason === "selection contains multiple meaningful elements" ? "element-group" : "area"
  const baseAnchor = collectAreaAnchor(userRegion, options)
  const anchor: ShowAnchor = {
    ...baseAnchor,
    kind: primaryAnchor,
    id: primaryAnchor === "element-group" ? randomId("element_group") : baseAnchor.id,
    rect: userRegion,
    source: primaryAnchor === "element-group" ? "area-selection" : "area",
    elements: matchedElements.length ? matchedElements : undefined
  }
  return {
    anchor,
    primaryAnchor,
    userRegion,
    matchedElements,
    classification
  }
}

export function classifyAreaSelection(userRegion: MarkAnchorRect, matchedElements: ShowAnchor[]): AreaSelectionClassification {
  if (matchedElements.length >= 2) {
    return {
      confidence: Math.min(0.96, 0.68 + matchedElements.length * 0.08),
      reason: "selection contains multiple meaningful elements",
      ambiguous: matchedElements.length <= 2
    }
  }
  if (matchedElements.length === 1) {
    const elementRect = matchedElements[0].rect
    const coverage = elementRect ? rectIntersectionRatio(userRegion, elementRect) : 0
    return {
      confidence: coverage > 0.72 ? 0.58 : 0.42,
      reason: "selection contains one meaningful element",
      ambiguous: true
    }
  }
  return {
    confidence: 0.82,
    reason: "selection is best represented as a visual area",
    ambiguous: false
  }
}

export function collectElementsInArea(rect: MarkAnchorRect, options: CollectAreaSelectionOptions = {}): ShowAnchor[] {
  const root = options.root ?? (typeof document !== "undefined" ? document : undefined)
  if (!root || typeof Element === "undefined") return []
  const source = areaSelectionSource(root)
  if (!source) return []
  const maxElements = Math.max(1, options.maxElements ?? 8)
  const elements = elementsFromAreaSource(source)
    .filter((element) => isAreaSelectionCandidate(element, rect))
    .sort((left, right) => areaSelectionScore(right, rect) - areaSelectionScore(left, rect))

  const selected: Element[] = []
  for (const element of elements) {
    if (selected.some((existing) => existing.contains(element) || element.contains(existing))) {
      continue
    }
    selected.push(element)
    if (selected.length >= maxElements) break
  }

  return selected.map((element) => collectElementContext(element, { ...options, source: "area-selection" }))
}

export async function captureScreenshotRegion(region: MarkAnchorRect): Promise<ScreenshotCaptureResult> {
  const capturedRegion = normalizeAnchorRect(region)
  const width = Math.max(1, Math.round(capturedRegion.width))
  const height = Math.max(1, Math.round(capturedRegion.height))
  const result: ScreenshotCaptureResult = {
    attachmentId: randomId("screenshot"),
    mimeType: "image/png",
    width,
    height,
    capturedRegion,
    viewport: viewport(),
    captured: false
  }
  try {
    const dataUrl = await captureDisplayRegionDataUrl(capturedRegion, width, height)
    return {
      ...result,
      captured: true,
      dataUrl
    }
  } catch (error) {
    return {
      ...result,
      captureError: error instanceof Error ? error.message : "Screenshot capture unavailable"
    }
  }
}

async function captureDisplayRegionDataUrl(region: MarkAnchorRect, width: number, height: number) {
  const mediaDevices = globalThis.navigator?.mediaDevices as (MediaDevices & {
    getDisplayMedia?: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>
  }) | undefined
  if (!mediaDevices?.getDisplayMedia) {
    throw new Error("Display capture is not available in this browser")
  }
  if (typeof document === "undefined") {
    throw new Error("Display capture requires a browser document")
  }
  const stream = await mediaDevices.getDisplayMedia({ video: true, audio: false })
  try {
    const video = document.createElement("video")
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    await video.play()
    await waitForVideoFrame(video)
    const sourceWidth = video.videoWidth || width
    const sourceHeight = video.videoHeight || height
    const scaleX = sourceWidth / Math.max(1, window.innerWidth)
    const scaleY = sourceHeight / Math.max(1, window.innerHeight)
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) {
      throw new Error("Canvas capture context is unavailable")
    }
    context.drawImage(
      video,
      Math.round(region.x * scaleX),
      Math.round(region.y * scaleY),
      Math.round(region.width * scaleX),
      Math.round(region.height * scaleY),
      0,
      0,
      width,
      height
    )
    return canvas.toDataURL("image/png")
  } finally {
    for (const track of stream.getTracks()) {
      track.stop()
    }
  }
}

function waitForVideoFrame(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Display capture timed out")), 3000)
    const done = () => {
      window.clearTimeout(timeout)
      resolve()
    }
    if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback(() => done())
      return
    }
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      done()
      return
    }
    video.addEventListener("loadeddata", done, { once: true })
  })
}

export function screenshotPointFromViewport(point: { x: number; y: number }, capturedRegion: MarkAnchorRect) {
  return {
    x: Math.round(point.x - capturedRegion.x),
    y: Math.round(point.y - capturedRegion.y)
  }
}

export function screenshotRectFromViewport(rect: MarkAnchorRect, capturedRegion: MarkAnchorRect): MarkAnchorRect {
  const normalized = normalizeAnchorRect(rect)
  return normalizeAnchorRect({
    x: normalized.x - capturedRegion.x,
    y: normalized.y - capturedRegion.y,
    width: normalized.width,
    height: normalized.height
  })
}

export function normalizeAnchorRect(rect: MarkAnchorRect): MarkAnchorRect {
  return normalizeRect(rect)
}

export function resolveAnchor(anchor: ShowAnchor, root?: ParentNode): AnchorResolveResult {
  if ((anchor.kind === "area" || anchor.kind === "element-group" || anchor.kind === "group" || anchor.kind === "screenshot") && anchor.rect) {
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

function inferAnnotationPrimaryAnchor(annotation: ShowAnnotation, anchor?: ShowAnchor): ShowAnnotationPrimaryAnchor {
  if (annotation.primaryAnchor) return annotation.primaryAnchor
  if (annotation.screenshot) return "screenshot"
  if (annotation.matchedElements?.length || annotation.anchors?.length) return "element-group"
  const anchorKind = anchor?.kind ?? annotation.anchor?.kind
  if (anchorKind === "group") return "element-group"
  if (anchorKind === "mark" || anchorKind === "element" || anchorKind === "text-range" || anchorKind === "area" || anchorKind === "element-group" || anchorKind === "screenshot") {
    return anchorKind
  }
  if (annotation.userRegion) return "area"
  return "element"
}

function formatRect(rect: MarkAnchorRect) {
  return `x:${Math.round(rect.x)}, y:${Math.round(rect.y)}, ${Math.round(rect.width)}x${Math.round(rect.height)}`
}

function isAreaSelectionCandidate(element: Element, userRegion: MarkAnchorRect) {
  if (isTextAnchorContainer(element) || isStructuralContainer(element) || isShowOverlayElement(element)) return false
  const rect = rectFromElement(element)
  if (rect.width < 8 || rect.height < 8) return false
  if (!rectsIntersect(userRegion, rect)) return false
  if (rect.width > userRegion.width * 1.35 && rect.height > userRegion.height * 1.35) return false
  const visibleRatio = rectIntersectionRatio(userRegion, rect)
  if (visibleRatio < 0.45) return false
  return areaSelectionScore(element, userRegion) > 0
}

function areaSelectionScore(element: Element, userRegion: MarkAnchorRect) {
  const rect = rectFromElement(element)
  const visibleRatio = rectIntersectionRatio(userRegion, rect)
  let score = visibleRatio * 4
  if (readElementMark(element)) score += 5
  const tagName = element.tagName.toLowerCase()
  if (["button", "a", "input", "select", "textarea", "li", "tr", "article", "section"].includes(tagName)) score += 2
  if (element.getAttribute("role") || element.getAttribute("aria-label")) score += 1.5
  if (element.getAttribute("data-testid") || element.getAttribute("data-test-id") || element.getAttribute("data-cy")) score += 1.5
  const className = element instanceof HTMLElement ? element.className : ""
  if (typeof className === "string" && /card|item|row|tile|panel|cell|option/i.test(className)) score += 1.25
  if (elementText(element)) score += 0.75
  return score
}

function rectsIntersect(left: MarkAnchorRect, right: MarkAnchorRect) {
  return !(right.x + right.width < left.x || right.x > left.x + left.width || right.y + right.height < left.y || right.y > left.y + left.height)
}

function rectIntersectionRatio(container: MarkAnchorRect, rect: MarkAnchorRect) {
  const x = Math.max(container.x, rect.x)
  const y = Math.max(container.y, rect.y)
  const right = Math.min(container.x + container.width, rect.x + rect.width)
  const bottom = Math.min(container.y + container.height, rect.y + rect.height)
  const width = Math.max(0, right - x)
  const height = Math.max(0, bottom - y)
  const intersection = width * height
  const area = Math.max(1, rect.width * rect.height)
  return intersection / area
}

function isStructuralContainer(element: Element) {
  const tagName = element.tagName.toLowerCase()
  return ["html", "body", "head", "script", "style", "template", "noscript", "svg", "path"].includes(tagName)
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
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
}

function ownerDocumentForRoot(root: ParentNode) {
  if (typeof Document !== "undefined" && root instanceof Document) {
    return root
  }
  return (root as Node).ownerDocument ?? (typeof document !== "undefined" ? document : undefined)
}

function areaSelectionSource(root: ParentNode): ParentNode | undefined {
  if (typeof Document !== "undefined" && root instanceof Document) {
    return root.body
  }
  if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) {
    return root
  }
  if (typeof Element !== "undefined" && root instanceof Element) {
    return root
  }
  return undefined
}

function elementsFromAreaSource(source: ParentNode): Element[] {
  const descendants = Array.from(source.querySelectorAll("*"))
  if (typeof Element !== "undefined" && source instanceof Element) {
    return [source, ...descendants]
  }
  return descendants
}

function isTextAnchorCandidate(element: Element, needle: string) {
  return !isTextAnchorContainer(element) && normalizeTextContent(element.textContent || "").includes(needle)
}

function isTextAnchorContainer(element: Element) {
  const tagName = element.tagName.toLowerCase()
  if (["html", "body", "head", "script", "style", "template", "noscript"].includes(tagName)) {
    return true
  }
  return isShowOverlayElement(element)
}

function isShowOverlayElement(element: Element) {
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
