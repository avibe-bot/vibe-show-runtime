import * as React from "react"
import { createPortal } from "react-dom"
import { flushSync } from "react-dom"
import {
  annotationFromAreaSelection,
  captureScreenshotRegion,
  collectAreaSelection,
  collectElementContext,
  collectTextSelectionAnchor,
  deepElementFromPoint,
  markAttributes,
  markAttributeName,
  normalizeShowEvent,
  screenshotAnnotationFromDraft,
  screenshotPointFromViewport,
  screenshotRectFromViewport,
  resolveAnchor,
  submitAgentMark,
  submitAnnotation,
  submitIntent,
  submitShowEvent,
  type AreaSelectionResult,
  type AgentMark,
  type AgentMarkSubmitOptions,
  type AnnotationSubmitOptions,
  type HumanIntentPayload,
  type IntentSubmitOptions,
  type MarkAnchorRect,
  type RuntimeConfig,
  type ShowAnchor,
  type SubmitShowEventOptions,
  type ShowAnnotation,
  type ScreenshotAnnotationItem,
  type ShowClientOptions,
  type ShowEvent,
  type ShowEventInput
} from "./index.js"

export type AgentMarkSubmitResult = Awaited<ReturnType<typeof submitShowEvent>>

export type ShowSessionContextValue = {
  config: RuntimeConfig
  events: ShowEvent[]
  connected: boolean
  error: Error | null
  lastEventId?: string
  submitEvent(event: ShowEventInput | ShowEvent, options?: SubmitShowEventOptions): Promise<unknown>
  submitIntent(payload: HumanIntentPayload, options?: IntentSubmitOptions): Promise<unknown>
  submitAnnotation(annotation: ShowAnnotation, options?: AnnotationSubmitOptions): Promise<unknown>
  refresh(): Promise<void>
}

export type ShowSessionProviderProps = ShowClientOptions & {
  sessionId?: string
  children: React.ReactNode
  initialEvents?: ShowEvent[]
  autoConnect?: boolean
  onEvent?: (event: ShowEvent) => void
  onError?: (error: Error) => void
}

export type ShowAgentMarkProps = {
  id: string
  scope?: string
  children: React.ReactNode
}

export type AgentMarkFormProps = AgentMarkSubmitOptions & {
  target: string
  scope?: string
  placeholder?: string
  onSubmitted?: (mark: AgentMark, result: AgentMarkSubmitResult) => void
}

export type IntentField =
  | { name: string; label?: string; type?: "text" | "textarea"; placeholder?: string; required?: boolean; defaultValue?: string }
  | { name: string; label?: string; type: "select"; options: Array<{ label: string; value: string }>; required?: boolean; defaultValue?: string }

export type IntentFormProps = IntentSubmitOptions & {
  scope?: string
  component?: string
  intent?: string
  fields?: IntentField[]
  submitLabel?: string
  clearOnSubmit?: boolean
  anchor?: ShowAnchor
  onSubmitted?: (payload: HumanIntentPayload, result: unknown) => void
}

export type ChoiceGroupOption = {
  label: string
  value: string
  description?: string
}

export type ChoiceGroupProps = IntentSubmitOptions & {
  scope?: string
  component?: string
  intent?: string
  name?: string
  options: ChoiceGroupOption[]
  anchor?: ShowAnchor
  onSubmitted?: (payload: HumanIntentPayload, result: unknown) => void
}

export type DecisionRequestProps = ChoiceGroupProps & {
  question?: string
}

export type ApprovalRequestProps = Omit<ChoiceGroupProps, "options"> & {
  approveLabel?: string
  rejectLabel?: string
}

export type ActionButtonProps = IntentSubmitOptions & {
  scope?: string
  component?: string
  intent?: string
  value?: unknown
  anchor?: ShowAnchor
  children: React.ReactNode
  onSubmitted?: (payload: HumanIntentPayload, result: unknown) => void
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value" | "onSubmit">

export type AnnotationOverlayMode = "idle" | "smart" | "screenshot"

export type AnnotationOverlayProps = {
  enabled?: boolean
  defaultEnabled?: boolean
  scope?: string
  intent?: string
  severity?: string
  submitLabel?: string
  placeholder?: string
  showToolbar?: boolean
  defaultMode?: Exclude<AnnotationOverlayMode, "idle">
  onSubmitted?: (annotation: ShowAnnotation, result: unknown) => void
}

export type AgentMarkLayerProps = {
  events?: ShowEvent[]
  scope?: string
  className?: string
  renderMark?: (event: ShowEvent, rect: MarkAnchorRect) => React.ReactNode
}

type AssistantMarkLayerEvent = Extract<ShowEvent, { type: "assistant.mark.created" | "assistant.mark.updated" | "assistant.mark.resolved" }>

export type AnnotationMarkerProps = {
  rect: MarkAnchorRect
  tone?: "human" | "assistant"
  label?: string
  children?: React.ReactNode
}

type AnnotationDraft = {
  kind: "smart"
  anchor: ShowAnchor
  rect: MarkAnchorRect
  label?: string
  selection?: AreaSelectionResult
  commentPoint?: { x: number; y: number }
}

type ScreenshotCommentDraft = ScreenshotAnnotationItem & {
  viewportPoint?: { x: number; y: number }
  viewportRect?: MarkAnchorRect
}

type ScreenshotDraft = {
  region: MarkAnchorRect
  capture?: Awaited<ReturnType<typeof captureScreenshotRegion>>
  items: ScreenshotCommentDraft[]
  pendingPoint?: { x: number; y: number }
  pendingRect?: MarkAnchorRect
}

const ShowSessionContext = React.createContext<ShowSessionContextValue | null>(null)

export function ShowSessionProvider({
  sessionId,
  children,
  initialEvents = [],
  autoConnect = true,
  onEvent,
  onError,
  ...clientOptions
}: ShowSessionProviderProps) {
  const [events, setEvents] = React.useState<ShowEvent[]>(initialEvents)
  const [connected, setConnected] = React.useState(false)
  const [error, setError] = React.useState<Error | null>(null)
  const lastEventId = events.at(-1)?.id
  const lastEventIdRef = React.useRef<string | undefined>(lastEventId)
  const eventIdsRef = React.useRef(new Set(initialEvents.map((event) => event.id)))
  const options = React.useMemo(
    () => ({ ...clientOptions, sessionId }),
    [clientOptions.basePath, clientOptions.eventsPath, clientOptions.fetch, clientOptions.streamPath, clientOptions.writeToken, sessionId]
  )

  React.useEffect(() => {
    lastEventIdRef.current = lastEventId
  }, [lastEventId])

  const appendEvent = React.useCallback(
    (event: ShowEvent) => {
      if (eventIdsRef.current.has(event.id)) return
      eventIdsRef.current.add(event.id)
      lastEventIdRef.current = event.id
      setEvents((current) => {
        return [...current, event]
      })
      onEvent?.(event)
    },
    [onEvent]
  )

  const refresh = React.useCallback(async () => {
    const { showEventsUrl } = await import("./index.js")
    const fetchImpl = options.fetch ?? fetch
    const response = await fetchImpl(showEventsUrl(options))
    if (!response.ok) {
      throw new Error(`Show events refresh failed: ${response.status} ${response.statusText}`)
    }
    const body = (await response.json()) as { events?: ShowEvent[] }
    const nextEvents = Array.isArray(body.events) ? body.events : []
    eventIdsRef.current = new Set(nextEvents.map((event) => event.id))
    setEvents(nextEvents)
  }, [options])

  React.useEffect(() => {
    if (!autoConnect || typeof EventSource === "undefined") return
    let closed = false
    let source: EventSource | undefined
    async function connect() {
      const { showEventsStreamUrl } = await import("./index.js")
      if (closed) return
      const url = new URL(showEventsStreamUrl(options), window.location.href)
      if (lastEventIdRef.current) url.searchParams.set("after_id", lastEventIdRef.current)
      const nextSource = new EventSource(url.toString())
      if (closed) {
        nextSource.close()
        return
      }
      source = nextSource
      nextSource.onopen = () => {
        if (!closed) setConnected(true)
      }
      nextSource.onerror = () => {
        if (!closed) setConnected(false)
      }
      nextSource.addEventListener("show.event", (message) => {
        try {
          appendEvent(JSON.parse((message as MessageEvent).data) as ShowEvent)
        } catch (parseError) {
          const nextError = parseError instanceof Error ? parseError : new Error("Failed to parse Show event")
          setError(nextError)
          onError?.(nextError)
        }
      })
    }
    void connect()
    return () => {
      closed = true
      source?.close()
      setConnected(false)
    }
  }, [appendEvent, autoConnect, onError, options])

  const submitEvent = React.useCallback(
    async (event: ShowEventInput | ShowEvent, submitOptions: SubmitShowEventOptions = {}) => {
      const mergedOptions = { ...options, ...submitOptions }
      const normalized = normalizeShowEvent(event, mergedOptions.sessionId ?? sessionId)
      const result = await submitShowEvent(normalized, mergedOptions)
      const responseEvent = responseEventFromResult(result)
      appendEvent(responseEvent ?? normalized)
      return result
    },
    [appendEvent, options, sessionId]
  )

  const value = React.useMemo<ShowSessionContextValue>(
    () => ({
      config: { ...clientOptions, sessionId },
      events,
      connected,
      error,
      lastEventId,
      submitEvent,
      submitIntent: (payload, intentOptions = {}) => submitEvent({ type: "human.intent.submitted", payload, anchor: intentOptions.anchor }, intentOptions),
      submitAnnotation: (annotation, annotationOptions = {}) =>
        submitEvent(
          {
            type: "human.annotation.created",
            annotation: {
              ...annotation,
              anchor: annotationOptions.anchor ?? annotation.anchor
            },
            anchor: annotationOptions.anchor ?? annotation.anchor
          },
          annotationOptions
        ),
      refresh
    }),
    [clientOptions.basePath, clientOptions.eventsPath, clientOptions.fetch, clientOptions.streamPath, clientOptions.writeToken, connected, error, events, lastEventId, refresh, sessionId, submitEvent]
  )

  return <ShowSessionContext.Provider value={value}>{children}</ShowSessionContext.Provider>
}

export function useShowSession() {
  const value = React.useContext(ShowSessionContext)
  if (!value) {
    throw new Error("useShowSession must be used within ShowSessionProvider")
  }
  return value
}

export function useShowEvents() {
  return useShowSession().events
}

export function useSubmitIntent() {
  return useShowSession().submitIntent
}

export function useAnchors(scope?: string) {
  const registry = useMarkRegistry(scope)
  return React.useMemo(() => {
    return Array.from(registry.values())
  }, [registry])
}

export function useMarkRegistry(scope?: string) {
  const [version, setVersion] = React.useState(0)
  React.useEffect(() => {
    if (typeof document === "undefined") return
    const observer = new MutationObserver(() => setVersion((value) => value + 1))
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: scope ? [markAttributeName(scope)] : undefined })
    setVersion((value) => value + 1)
    return () => observer.disconnect()
  }, [scope])
  return React.useMemo(() => {
    void version
    const anchors = new Map<string, ShowAnchor>()
    if (typeof document === "undefined") return anchors
    const elements = scope
      ? Array.from(document.querySelectorAll(markAttributeSelector(scope)))
      : Array.from(document.querySelectorAll("*")).filter((element) =>
          Array.from(element.attributes).some((attr) => attr.name.startsWith("mark-"))
        )
    for (const element of elements) {
      const anchor = collectElementContext(element, { scope })
      if (anchor.mark) anchors.set(scope ? anchor.mark : `${anchor.scope ?? "default"}:${anchor.mark}`, anchor)
    }
    return anchors
  }, [scope, version])
}

export function ShowAgentMark({ id, scope, children }: ShowAgentMarkProps) {
  const attrs = markAttributes(id, scope)
  if (React.isValidElement(children) && typeof children.type === "string") {
    return React.cloneElement(children, attrs)
  }
  return (
    <span {...attrs} style={{ display: "contents" }}>
      {children}
    </span>
  )
}

export function AgentMarkForm({ target, scope, placeholder = "Write a mark...", onSubmitted, ...options }: AgentMarkFormProps) {
  const context = React.useContext(ShowSessionContext)
  const [body, setBody] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextMark = { target, scope, body }
    setSubmitting(true)
    setError(null)
    try {
      const response = context
        ? await context.submitEvent({ type: "assistant.mark.created", mark: nextMark, anchor: options.anchor }, options)
        : await submitAgentMark(nextMark, options)
      setBody("")
      onSubmitted?.(nextMark, response)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to submit mark")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form data-show-form="agent-mark" onSubmit={onSubmit} style={formStyle}>
      <textarea value={body} placeholder={placeholder} onChange={(event) => setBody(event.target.value)} style={textareaStyle} />
      <button type="submit" disabled={submitting || !body.trim()} style={buttonStyle}>
        {submitting ? "Sending..." : "Send"}
      </button>
      {error ? <p role="alert" style={errorStyle}>{error}</p> : null}
    </form>
  )
}

export function IntentForm({ scope, component = "form", intent = "submit", fields, submitLabel = "Send", clearOnSubmit = true, anchor, onSubmitted, ...options }: IntentFormProps) {
  const context = React.useContext(ShowSessionContext)
  const [values, setValues] = React.useState<Record<string, string>>(() => initialFieldValues(fields))
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const formFields = fields?.length ? fields : [{ name: "comment", type: "textarea" as const, placeholder: "Write a response..." }]

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const payload: HumanIntentPayload = {
      id: undefined,
      scope,
      component,
      intent,
      values,
      value: values.value ?? values.choice,
      text: values.text,
      comment: values.comment,
      dispatch: true
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = context ? await context.submitIntent(payload, { ...options, anchor }) : await submitIntent(payload, { ...options, anchor })
      if (clearOnSubmit) setValues(initialFieldValues(fields))
      onSubmitted?.(payload, result)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to submit")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form data-show-form="intent" onSubmit={onSubmit} style={formStyle}>
      {formFields.map((field) => (
        <label key={field.name} style={labelStyle}>
          {field.label ? <span>{field.label}</span> : null}
          {field.type === "select" ? (
            <select
              name={field.name}
              required={field.required}
              value={values[field.name] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
              style={inputStyle}
            >
              <option value="" />
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : field.type === "text" ? (
            <input
              name={field.name}
              required={field.required}
              placeholder={field.placeholder}
              value={values[field.name] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
              style={inputStyle}
            />
          ) : (
            <textarea
              name={field.name}
              required={field.required}
              placeholder={field.placeholder}
              value={values[field.name] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
              style={textareaStyle}
            />
          )}
        </label>
      ))}
      <button type="submit" disabled={submitting} style={buttonStyle}>{submitting ? "Sending..." : submitLabel}</button>
      {error ? <p role="alert" style={errorStyle}>{error}</p> : null}
    </form>
  )
}

export function ChoiceGroup({ scope, component = "choice-group", intent = "choose", name = "choice", options, anchor, onSubmitted, ...clientOptions }: ChoiceGroupProps) {
  const context = React.useContext(ShowSessionContext)
  const [submitting, setSubmitting] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function choose(option: ChoiceGroupOption) {
    const payload: HumanIntentPayload = {
      scope,
      component,
      intent,
      value: option.value,
      values: { [name]: option.value },
      text: option.label,
      dispatch: true
    }
    setSubmitting(option.value)
    setError(null)
    try {
      const result = context ? await context.submitIntent(payload, { ...clientOptions, anchor }) : await submitIntent(payload, { ...clientOptions, anchor })
      onSubmitted?.(payload, result)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to submit")
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <div data-show-form="choice-group" style={choiceGroupStyle}>
      {options.map((option) => (
        <button key={option.value} type="button" disabled={submitting !== null} onClick={() => void choose(option)} style={choiceButtonStyle}>
          <strong>{option.label}</strong>
          {option.description ? <span>{option.description}</span> : null}
        </button>
      ))}
      {error ? <p role="alert" style={errorStyle}>{error}</p> : null}
    </div>
  )
}

export function DecisionRequest({ question, ...props }: DecisionRequestProps) {
  return (
    <section data-show-form="decision" style={formStyle}>
      {question ? <p style={{ margin: 0, fontWeight: 600 }}>{question}</p> : null}
      <ChoiceGroup {...props} component={props.component ?? "decision"} intent={props.intent ?? "answer"} />
    </section>
  )
}

export function ApprovalRequest({ approveLabel = "Approve", rejectLabel = "Reject", ...props }: ApprovalRequestProps) {
  return (
    <ChoiceGroup
      {...props}
      component={props.component ?? "approval"}
      intent={props.intent ?? "approve"}
      options={[
        { label: approveLabel, value: "approved" },
        { label: rejectLabel, value: "rejected" }
      ]}
    />
  )
}

export function ActionButton({
  scope,
  component = "button",
  intent = "action",
  value,
  anchor,
  children,
  onSubmitted,
  sessionId,
  basePath,
  eventsPath,
  streamPath,
  writeToken,
  fetch: fetchImpl,
  ...buttonProps
}: ActionButtonProps) {
  const context = React.useContext(ShowSessionContext)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const submitOptions: IntentSubmitOptions = {
    ...(sessionId ? { sessionId } : {}),
    ...(basePath ? { basePath } : {}),
    ...(eventsPath ? { eventsPath } : {}),
    ...(streamPath ? { streamPath } : {}),
    ...(writeToken ? { writeToken } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {})
  }
  async function click(event: React.MouseEvent<HTMLButtonElement>) {
    buttonProps.onClick?.(event)
    if (event.defaultPrevented) return
    const payload: HumanIntentPayload = {
      scope,
      component,
      intent,
      value,
      text: typeof children === "string" ? children : undefined,
      dispatch: true
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = context ? await context.submitIntent(payload, { ...submitOptions, anchor }) : await submitIntent(payload, { ...submitOptions, anchor })
      onSubmitted?.(payload, result)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to submit")
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <>
      <button {...buttonProps} type={buttonProps.type ?? "button"} disabled={buttonProps.disabled || submitting} onClick={(event) => void click(event)}>
        {children}
      </button>
      {error ? <span role="alert" style={errorStyle}>{error}</span> : null}
    </>
  )
}

export function AnnotationOverlay({
  enabled,
  defaultEnabled = false,
  scope,
  intent = "comment",
  severity = "suggestion",
  submitLabel = "Annotate",
  placeholder = "Write a comment...",
  showToolbar = true,
  defaultMode = "smart",
  onSubmitted
}: AnnotationOverlayProps) {
  const context = React.useContext(ShowSessionContext)
  const [internalEnabled, setInternalEnabled] = React.useState(defaultEnabled)
  const active = enabled ?? internalEnabled
  const [mode, setMode] = React.useState<AnnotationOverlayMode>(defaultEnabled ? defaultMode : "idle")
  const [hover, setHover] = React.useState<{ rect: MarkAnchorRect; label?: string } | null>(null)
  const [draft, setDraft] = React.useState<AnnotationDraft | null>(null)
  const [screenshotDraft, setScreenshotDraft] = React.useState<ScreenshotDraft | null>(null)
  const [comment, setComment] = React.useState("")
  const [screenshotComment, setScreenshotComment] = React.useState("")
  const [drag, setDrag] = React.useState<{ purpose: "smart-area" | "screenshot-region" | "screenshot-item"; startX: number; startY: number; rect: MarkAnchorRect } | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const dragRef = React.useRef(drag)
  const smartDragStartRef = React.useRef<{ x: number; y: number; allowArea: boolean } | null>(null)
  const suppressNextClickRef = React.useRef(false)

  React.useEffect(() => {
    dragRef.current = drag
  }, [drag])

  React.useEffect(() => {
    if (!active || mode !== "smart" || draft) {
      setHover(null)
      return
    }
    function hoverElement(event: MouseEvent) {
      if (isOverlayTarget(event.target)) return
      const selection = globalThis.getSelection?.()
      if (selection && !selection.isCollapsed) return
      const element = deepElementFromPoint(event.clientX, event.clientY)
      if (!element) {
        setHover(null)
        return
      }
      const anchor = collectElementContext(element, { scope, includeNearby: true })
      setHover(anchor.rect ? { rect: anchor.rect, label: anchor.label } : null)
    }
    function captureElement(event: MouseEvent) {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (isOverlayTarget(event.target)) return
      const selection = globalThis.getSelection?.()
      if (selection && !selection.isCollapsed) return
      const element = deepElementFromPoint(event.clientX, event.clientY)
      if (!element) return
      event.preventDefault()
      event.stopPropagation()
      const anchor = collectElementContext(element, { scope, includeNearby: true })
      if (anchor.rect) {
        setDraft({ kind: "smart", anchor, rect: anchor.rect, label: anchor.label, commentPoint: { x: event.clientX, y: event.clientY } })
      }
    }
    document.addEventListener("mousemove", hoverElement, true)
    document.addEventListener("click", captureElement, true)
    return () => {
      document.removeEventListener("mousemove", hoverElement, true)
      document.removeEventListener("click", captureElement, true)
    }
  }, [active, draft, mode, scope])

  React.useEffect(() => {
    if (!active || mode !== "smart" || draft) return
    function pointerDown(event: PointerEvent) {
      if (isOverlayTarget(event.target)) return
      smartDragStartRef.current = { x: event.clientX, y: event.clientY, allowArea: !isLikelyTextSelectionTarget(event.target) }
    }
    function pointerMove(event: PointerEvent) {
      const start = smartDragStartRef.current
      if (!start) return
      if (!start.allowArea) return
      const selection = globalThis.getSelection?.()
      if (selection && !selection.isCollapsed) return
      const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y)
      if (distance < 8) return
      const nextDrag = {
        purpose: "smart-area" as const,
        startX: start.x,
        startY: start.y,
        rect: {
          x: start.x,
          y: start.y,
          width: event.clientX - start.x,
          height: event.clientY - start.y
        }
      }
      setDrag(nextDrag)
      event.preventDefault()
      event.stopPropagation()
    }
    function pointerUp(event: PointerEvent) {
      smartDragStartRef.current = null
      const currentDrag = dragRef.current
      if (currentDrag?.purpose !== "smart-area") return
      const rect = normalizeVisualRect(currentDrag.rect)
      flushSync(() => setDrag(null))
      if (rect.width > 4 && rect.height > 4) {
        const selection = collectAreaSelection(rect, { scope, includeNearby: true })
        setDraft({
          kind: "smart",
          anchor: selection.anchor,
          rect: selection.userRegion,
          label: selection.primaryAnchor === "element-group" ? `${selection.matchedElements.length} elements` : "Selected area",
          selection
        })
        suppressNextClickRef.current = true
        event.preventDefault()
        event.stopPropagation()
      }
    }
    document.addEventListener("pointerdown", pointerDown, true)
    document.addEventListener("pointermove", pointerMove, true)
    document.addEventListener("pointerup", pointerUp, true)
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true)
      document.removeEventListener("pointermove", pointerMove, true)
      document.removeEventListener("pointerup", pointerUp, true)
    }
  }, [active, draft, mode, scope])

  React.useEffect(() => {
    if (!active || mode !== "smart" || draft) return
    function capture() {
      const anchor = collectTextSelectionAnchor(globalThis.getSelection?.() ?? null, { scope, includeNearby: true })
      if (anchor?.rect) {
        setDraft({ kind: "smart", anchor, rect: anchor.rect, label: anchor.textQuote || anchor.label })
        setHover(null)
      }
    }
    document.addEventListener("mouseup", capture, true)
    document.addEventListener("keyup", capture, true)
    return () => {
      document.removeEventListener("mouseup", capture, true)
      document.removeEventListener("keyup", capture, true)
    }
  }, [active, draft, mode, scope])

  React.useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMode("idle")
        setDraft(null)
        setScreenshotDraft(null)
        setDrag(null)
        setHover(null)
      }
    }
    document.addEventListener("keydown", escape)
    return () => document.removeEventListener("keydown", escape)
  }, [])

  async function submit() {
    if (!draft || !comment.trim()) return
    const baseAnnotation: ShowAnnotation = {
      scope,
      intent,
      severity,
      status: "pending",
      comment: comment.trim(),
      dispatch: true,
      anchor: draft.anchor
    }
    const annotation = draft.selection ? annotationFromAreaSelection({
      ...baseAnnotation,
      primaryAnchor: draft.selection.primaryAnchor
    }, draft.selection) : baseAnnotation
    setSubmitting(true)
    setError(null)
    try {
      const result = context ? await context.submitAnnotation(annotation, { anchor: draft.anchor }) : await submitAnnotation(annotation, { anchor: draft.anchor })
      setComment("")
      setDraft(null)
      onSubmitted?.(annotation, result)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to submit annotation")
    } finally {
      setSubmitting(false)
    }
  }

  async function submitScreenshotDraft() {
    if (!screenshotDraft?.capture || screenshotDraft.items.length === 0) return
    const annotation = screenshotAnnotationFromDraft({
      scope,
      intent,
      severity,
      status: "pending",
      comment: screenshotDraft.items.map((item) => `${item.label}. ${item.comment}`).join("\n"),
      dispatch: true,
      screenshot: {
        ...screenshotDraft.capture,
        items: screenshotDraft.items.map(({ viewportPoint, viewportRect, ...item }) => item)
      }
    })
    setSubmitting(true)
    setError(null)
    try {
      const result = context ? await context.submitAnnotation(annotation) : await submitAnnotation(annotation)
      setScreenshotDraft(null)
      setScreenshotComment("")
      onSubmitted?.(annotation, result)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to submit screenshot annotation")
    } finally {
      setSubmitting(false)
    }
  }

  function setSmartMode(nextMode: Exclude<AnnotationOverlayMode, "idle">) {
    setMode(nextMode)
    setDraft(null)
    setScreenshotDraft(null)
    setDrag(null)
    setHover(null)
    setError(null)
  }

  function onCapturePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (isOverlayTarget(event.target)) return
    if (screenshotDraft?.capture && !pointInsideRect({ x: event.clientX, y: event.clientY }, screenshotDraft.capture.capturedRegion)) {
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const purpose = screenshotDraft?.capture ? "screenshot-item" : "screenshot-region"
    setDrag({ purpose, startX: event.clientX, startY: event.clientY, rect: { x: event.clientX, y: event.clientY, width: 0, height: 0 } })
  }

  function onCapturePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return
    setDrag({
      ...drag,
      rect: {
        x: drag.startX,
        y: drag.startY,
        width: event.clientX - drag.startX,
        height: event.clientY - drag.startY
      }
    })
  }

  function onCapturePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return
    const rect = normalizeVisualRect(drag.rect)
    if (drag.purpose === "smart-area") {
      if (rect.width > 4 && rect.height > 4) {
        const selection = collectAreaSelection(rect, { scope, includeNearby: true })
        setDraft({
          kind: "smart",
          anchor: selection.anchor,
          rect: selection.userRegion,
          label: selection.primaryAnchor === "element-group" ? `${selection.matchedElements.length} elements` : "Selected area",
          selection
        })
      }
      setDrag(null)
      return
    }
    if (drag.purpose === "screenshot-region") {
      if (rect.width > 8 && rect.height > 8) {
        void captureScreenshotRegion(rect)
          .then((capture) => setScreenshotDraft({ region: rect, capture, items: [] }))
          .catch((captureError) => setError(captureError instanceof Error ? captureError.message : "Failed to capture screenshot region"))
      }
      setDrag(null)
      return
    }
    if (drag.purpose === "screenshot-item" && screenshotDraft?.capture) {
      const capturedRegion = screenshotDraft.capture.capturedRegion
      const constrainedRect = constrainRectToRegion(rect, capturedRegion)
      const point = clampPointToRect({ x: event.clientX, y: event.clientY }, capturedRegion)
      if (rect.width > 8 && rect.height > 8) {
        if (!constrainedRect || constrainedRect.width <= 0 || constrainedRect.height <= 0) {
          setDrag(null)
          return
        }
        setScreenshotDraft({
          ...screenshotDraft,
          pendingRect: constrainedRect,
          pendingPoint: undefined
        })
      } else {
        setScreenshotDraft({
          ...screenshotDraft,
          pendingPoint: point,
          pendingRect: undefined
        })
      }
      setDrag(null)
    }
  }

  function addScreenshotComment() {
    if (!screenshotDraft?.capture || !screenshotComment.trim()) return
    const label = screenshotDraft.items.length + 1
    const capturedRegion = screenshotDraft.capture.capturedRegion
    const item: ScreenshotCommentDraft = screenshotDraft.pendingRect
      ? {
          id: `shot_item_${label}`,
          label,
          comment: screenshotComment.trim(),
          rect: screenshotRectFromViewport(screenshotDraft.pendingRect, capturedRegion),
          viewportRect: screenshotDraft.pendingRect
        }
      : {
          id: `shot_item_${label}`,
          label,
          comment: screenshotComment.trim(),
          point: screenshotPointFromViewport(screenshotDraft.pendingPoint ?? centerPoint(screenshotDraft.region), capturedRegion),
          viewportPoint: screenshotDraft.pendingPoint ?? centerPoint(screenshotDraft.region)
        }
    setScreenshotDraft({
      ...screenshotDraft,
      items: [...screenshotDraft.items, item],
      pendingPoint: undefined,
      pendingRect: undefined
    })
    setScreenshotComment("")
  }

  if (typeof document === "undefined") return null

  return createPortal(
    <>
      {showToolbar ? (
        <div data-show-annotation-ui="" style={toolbarStyle} onClick={(event) => event.stopPropagation()}>
          <button type="button" aria-pressed={active} onClick={() => {
            const next = !active
            setInternalEnabled(next)
            setMode(next ? defaultMode : "idle")
            if (!next) {
              setDraft(null)
              setScreenshotDraft(null)
              setDrag(null)
              setHover(null)
            }
          }} style={toolbarButtonStyle}>{active ? "On" : "Off"}</button>
          <button type="button" disabled={!active} aria-pressed={mode === "smart"} onClick={() => setSmartMode("smart")} style={toolbarButtonStyle}>Smart</button>
          <button type="button" disabled={!active} aria-pressed={mode === "screenshot"} onClick={() => setSmartMode("screenshot")} style={toolbarButtonStyle}>Screenshot</button>
        </div>
      ) : null}
      {hover && active && mode === "smart" && !draft ? <AnnotationMarker rect={hover.rect} tone="human" label={hover.label} /> : null}
      {drag ? <AnnotationMarker rect={normalizeVisualRect(drag.rect)} tone="human" /> : null}
      {active && mode === "screenshot" ? (
        <div
          data-show-annotation-capture=""
          style={areaCaptureStyle}
          onPointerDown={onCapturePointerDown}
          onPointerMove={onCapturePointerMove}
          onPointerUp={onCapturePointerUp}
        />
      ) : null}
      {draft ? (
        <>
          <AnnotationMarker rect={draft.rect} tone="human" label={draft.label} />
          <CommentPopover rect={draft.rect} onClose={() => setDraft(null)}>
            {draft.selection?.classification.ambiguous ? (
              <div style={toggleRowStyle}>
                <button type="button" style={draft.selection.primaryAnchor === "element-group" ? toggleActiveStyle : toggleButtonStyle} onClick={() => {
                  const nextSelection = {
                    ...draft.selection!,
                    primaryAnchor: "element-group" as const,
                    anchor: { ...draft.selection!.anchor, kind: "element-group" as const }
                  }
                  setDraft({ ...draft, selection: nextSelection, anchor: nextSelection.anchor, label: `${nextSelection.matchedElements.length} elements` })
                }}>By elements</button>
                <button type="button" style={draft.selection.primaryAnchor === "area" ? toggleActiveStyle : toggleButtonStyle} onClick={() => {
                  const nextSelection = {
                    ...draft.selection!,
                    primaryAnchor: "area" as const,
                    anchor: { ...draft.selection!.anchor, kind: "area" as const }
                  }
                  setDraft({ ...draft, selection: nextSelection, anchor: nextSelection.anchor, label: "Selected area" })
                }}>By area</button>
              </div>
            ) : null}
            <textarea
              autoFocus
              placeholder={placeholder}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              style={textareaStyle}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setDraft(null)} style={secondaryButtonStyle}>Cancel</button>
              <button type="button" disabled={submitting || !comment.trim()} onClick={() => void submit()} style={buttonStyle}>
                {submitting ? "Sending..." : submitLabel}
              </button>
            </div>
            {error ? <p role="alert" style={errorStyle}>{error}</p> : null}
          </CommentPopover>
        </>
      ) : null}
      {screenshotDraft ? (
        <>
          <AnnotationMarker rect={screenshotDraft.region} tone="assistant" label="Screenshot 1" />
          {screenshotDraft.items.map((item) =>
            item.viewportRect ? (
              <AnnotationMarker key={item.id} rect={item.viewportRect} tone="assistant" label={String(item.label)} />
            ) : item.viewportPoint ? (
              <AnnotationMarker key={item.id} rect={{ x: item.viewportPoint.x - 6, y: item.viewportPoint.y - 6, width: 12, height: 12 }} tone="assistant" label={String(item.label)} />
            ) : null
          )}
          {screenshotDraft.pendingRect ? <AnnotationMarker rect={screenshotDraft.pendingRect} tone="human" label={String(screenshotDraft.items.length + 1)} /> : null}
          {screenshotDraft.pendingPoint ? <AnnotationMarker rect={{ x: screenshotDraft.pendingPoint.x - 6, y: screenshotDraft.pendingPoint.y - 6, width: 12, height: 12 }} tone="human" label={String(screenshotDraft.items.length + 1)} /> : null}
          <CommentPopover rect={screenshotDraft.pendingRect ?? pointRect(screenshotDraft.pendingPoint) ?? screenshotDraft.region} onClose={() => setScreenshotDraft(null)}>
            <div style={{ fontWeight: 600 }}>Screenshot 1</div>
            {screenshotDraft.capture?.dataUrl ? <img src={screenshotDraft.capture.dataUrl} alt="" style={screenshotPreviewStyle} /> : null}
            <textarea
              placeholder="Comment on this screenshot..."
              value={screenshotComment}
              onChange={(event) => setScreenshotComment(event.target.value)}
              style={textareaStyle}
            />
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <button type="button" onClick={() => setScreenshotDraft(null)} style={secondaryButtonStyle}>Retake</button>
              <button type="button" disabled={!screenshotComment.trim()} onClick={addScreenshotComment} style={secondaryButtonStyle}>Add comment</button>
              <button type="button" disabled={submitting || screenshotDraft.items.length === 0} onClick={() => void submitScreenshotDraft()} style={buttonStyle}>
                {submitting ? "Sending..." : "Send batch"}
              </button>
            </div>
            {screenshotDraft.items.length ? (
              <ol style={screenshotListStyle}>
                {screenshotDraft.items.map((item) => (
                  <li key={item.id}>
                    <span>{item.comment}</span>
                    <button type="button" style={inlineDeleteStyle} onClick={() => setScreenshotDraft({ ...screenshotDraft, items: screenshotDraft.items.filter((current) => current.id !== item.id) })}>Remove</button>
                  </li>
                ))}
              </ol>
            ) : null}
            {error ? <p role="alert" style={errorStyle}>{error}</p> : null}
          </CommentPopover>
        </>
      ) : null}
      <AgentMarkLayer scope={scope} />
    </>,
    document.body
  )
}

export function AgentMarkLayer({ events, scope, className, renderMark }: AgentMarkLayerProps) {
  const context = React.useContext(ShowSessionContext)
  const sourceEvents = events ?? context?.events ?? []
  const tick = useViewportTick()
  const marks = React.useMemo(() => {
    void tick
    if (typeof document === "undefined") return []
    const latestByMark = new Map<string, AssistantMarkLayerEvent>()
    for (const event of sourceEvents) {
      if (!event.type.startsWith("assistant.mark.")) continue
      const markEvent = event as AssistantMarkLayerEvent
      if (scope && markAttributeName(markEvent.mark.scope) !== markAttributeName(scope)) continue
      latestByMark.set(`${markEvent.mark.scope}:${markEvent.mark.id}`, markEvent)
    }
    return Array.from(latestByMark.values())
      .map((event) => {
        const resolved = resolveAnchor(event.anchor ?? { kind: "element", selector: event.mark.target, scope: event.mark.scope }, document)
        if (!resolved.rect) return undefined
        return { event, rect: resolved.rect, hidden: event.type === "assistant.mark.resolved" || event.mark.status === "resolved" }
      })
      .filter((item): item is { event: AssistantMarkLayerEvent; rect: MarkAnchorRect; hidden: boolean } => item !== undefined && !item.hidden)
  }, [scope, sourceEvents, tick])

  if (typeof document === "undefined" || marks.length === 0) return null
  return createPortal(
    <div className={className} data-show-agent-mark-layer="" style={layerStyle}>
      {marks.map(({ event, rect }) =>
        renderMark ? (
          <React.Fragment key={event.id}>{renderMark(event, rect)}</React.Fragment>
        ) : (
          <AnnotationMarker key={event.id} rect={rect} tone="assistant" label={agentMarkLabel(event)} />
        )
      )}
    </div>,
    document.body
  )
}

export function AnnotationMarker({ rect, tone = "human", label, children }: AnnotationMarkerProps) {
  const color = tone === "assistant" ? "#2563eb" : "#f59e0b"
  return (
    <div
      data-show-annotation-ui=""
      style={{
        position: "fixed",
        left: rect.x,
        top: rect.y,
        width: Math.max(rect.width, 12),
        height: Math.max(rect.height, 12),
        border: `2px solid ${color}`,
        background: tone === "assistant" ? "rgba(37, 99, 235, 0.08)" : "rgba(245, 158, 11, 0.10)",
        borderRadius: 6,
        pointerEvents: "none",
        zIndex: 2147483000,
        boxSizing: "border-box"
      }}
    >
      {label ? (
        <div
          style={{
            position: "absolute",
            left: -2,
            top: -28,
            maxWidth: 260,
            padding: "3px 7px",
            borderRadius: 999,
            color: "#fff",
            background: color,
            fontSize: 12,
            lineHeight: "18px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis"
          }}
        >
          {label}
        </div>
      ) : null}
      {children}
    </div>
  )
}

function CommentPopover({ rect, children, onClose }: { rect: MarkAnchorRect; children: React.ReactNode; onClose: () => void }) {
  const top = Math.min(window.innerHeight - 220, Math.max(12, rect.y + rect.height + 8))
  const left = Math.min(window.innerWidth - 330, Math.max(12, rect.x))
  return (
    <div data-show-annotation-ui="" role="dialog" style={{ ...popoverStyle, top, left }} onClick={(event) => event.stopPropagation()}>
      <button type="button" aria-label="Close" onClick={onClose} style={closeButtonStyle}>×</button>
      {children}
    </div>
  )
}

function useViewportTick() {
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    const update = () => setTick((value) => value + 1)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [])
  return tick
}

function responseEventFromResult(result: unknown) {
  if (result && typeof result === "object" && "event" in result) {
    return (result as { event?: ShowEvent }).event
  }
  return undefined
}

function initialFieldValues(fields?: IntentField[]) {
  const values: Record<string, string> = {}
  for (const field of fields ?? []) {
    values[field.name] = field.defaultValue ?? ""
  }
  return values
}

function isOverlayTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("[data-show-annotation-ui]"))
}

function isLikelyTextSelectionTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  const tagName = target.tagName.toLowerCase()
  if (["input", "textarea"].includes(tagName) || target.getAttribute("contenteditable") === "true") return true
  const text = target.textContent?.trim()
  if (!text || text.length < 8) return false
  const childElementCount = target.children.length
  return childElementCount <= 2
}

function normalizeVisualRect(rect: MarkAnchorRect): MarkAnchorRect {
  const x = Math.min(rect.x, rect.x + rect.width)
  const y = Math.min(rect.y, rect.y + rect.height)
  return { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) }
}

function centerPoint(rect: MarkAnchorRect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function pointRect(point?: { x: number; y: number }): MarkAnchorRect | undefined {
  if (!point) return undefined
  return { x: point.x - 6, y: point.y - 6, width: 12, height: 12 }
}

function pointInsideRect(point: { x: number; y: number }, rect: MarkAnchorRect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

function clampPointToRect(point: { x: number; y: number }, rect: MarkAnchorRect) {
  return {
    x: Math.min(rect.x + rect.width, Math.max(rect.x, point.x)),
    y: Math.min(rect.y + rect.height, Math.max(rect.y, point.y))
  }
}

function constrainRectToRegion(rect: MarkAnchorRect, region: MarkAnchorRect): MarkAnchorRect | null {
  const x = Math.max(rect.x, region.x)
  const y = Math.max(rect.y, region.y)
  const right = Math.min(rect.x + rect.width, region.x + region.width)
  const bottom = Math.min(rect.y + rect.height, region.y + region.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

function markAttributeSelector(scope: string) {
  return `[${cssEscape(markAttributeName(scope))}]`
}

function cssEscape(value: string) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
}

function agentMarkLabel(event: ShowEvent) {
  if (!event.type.startsWith("assistant.mark.")) return "Agent"
  const mark = (event as Extract<ShowEvent, { type: "assistant.mark.created" | "assistant.mark.updated" | "assistant.mark.resolved" }>).mark
  return mark.body || mark.target || "Agent"
}

const formStyle: React.CSSProperties = {
  display: "grid",
  gap: 10
}

const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: 4,
  fontSize: 13
}

const inputStyle: React.CSSProperties = {
  minHeight: 36,
  border: "1px solid rgba(148, 163, 184, 0.7)",
  borderRadius: 8,
  padding: "8px 10px",
  font: "inherit"
}

const textareaStyle: React.CSSProperties = {
  minHeight: 88,
  resize: "vertical",
  border: "1px solid rgba(148, 163, 184, 0.7)",
  borderRadius: 8,
  padding: 10,
  font: "inherit"
}

const buttonStyle: React.CSSProperties = {
  minHeight: 34,
  border: 0,
  borderRadius: 8,
  padding: "7px 12px",
  color: "#fff",
  background: "#111827",
  font: "inherit",
  cursor: "pointer"
}

const secondaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  color: "#111827",
  background: "#f3f4f6"
}

const errorStyle: React.CSSProperties = {
  margin: 0,
  color: "#b91c1c",
  fontSize: 12
}

const choiceGroupStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8
}

const choiceButtonStyle: React.CSSProperties = {
  display: "grid",
  gap: 3,
  border: "1px solid rgba(148, 163, 184, 0.7)",
  borderRadius: 8,
  background: "#fff",
  padding: "8px 10px",
  textAlign: "left",
  font: "inherit",
  cursor: "pointer"
}

const toolbarStyle: React.CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 16,
  zIndex: 2147483200,
  display: "flex",
  gap: 6,
  padding: 6,
  border: "1px solid rgba(15, 23, 42, 0.15)",
  borderRadius: 999,
  background: "rgba(255, 255, 255, 0.94)",
  boxShadow: "0 12px 40px rgba(15, 23, 42, 0.18)",
  backdropFilter: "blur(10px)"
}

const toolbarButtonStyle: React.CSSProperties = {
  border: 0,
  borderRadius: 999,
  padding: "6px 10px",
  font: "12px/18px system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  background: "#111827",
  color: "#fff",
  cursor: "pointer"
}

const areaCaptureStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 2147482500,
  cursor: "crosshair",
  background: "transparent"
}

const layerStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  pointerEvents: "none",
  zIndex: 2147482900
}

const popoverStyle: React.CSSProperties = {
  position: "fixed",
  width: 320,
  display: "grid",
  gap: 10,
  padding: 12,
  border: "1px solid rgba(15, 23, 42, 0.15)",
  borderRadius: 10,
  background: "#fff",
  boxShadow: "0 18px 50px rgba(15, 23, 42, 0.22)",
  zIndex: 2147483300
}

const closeButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: 6,
  right: 6,
  width: 22,
  height: 22,
  border: 0,
  borderRadius: 999,
  background: "#f3f4f6",
  cursor: "pointer"
}

const toggleRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 6
}

const toggleButtonStyle: React.CSSProperties = {
  border: "1px solid rgba(148, 163, 184, 0.7)",
  borderRadius: 8,
  padding: "6px 8px",
  background: "#fff",
  color: "#111827",
  font: "12px/18px system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  cursor: "pointer"
}

const toggleActiveStyle: React.CSSProperties = {
  ...toggleButtonStyle,
  borderColor: "#111827",
  background: "#111827",
  color: "#fff"
}

const screenshotPreviewStyle: React.CSSProperties = {
  width: "100%",
  maxHeight: 140,
  objectFit: "cover",
  border: "1px solid rgba(148, 163, 184, 0.7)",
  borderRadius: 8
}

const screenshotListStyle: React.CSSProperties = {
  margin: 0,
  paddingInlineStart: 22,
  display: "grid",
  gap: 6,
  fontSize: 12
}

const inlineDeleteStyle: React.CSSProperties = {
  marginInlineStart: 8,
  border: 0,
  background: "transparent",
  color: "#b91c1c",
  cursor: "pointer",
  font: "inherit"
}
