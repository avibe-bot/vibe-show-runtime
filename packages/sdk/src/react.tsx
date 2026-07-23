import * as React from "react"
import { createPortal } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { flushSync } from "react-dom"
import {
  annotationFromAreaSelection,
  captureScreenshotRegion,
  collectAreaSelection,
  collectElementContext,
  collectTextSelectionAnchor,
  deepElementFromPoint,
  reduceAgentMarkEvents,
  partitionAgentMarks,
  attributeNoteReadToken,
  reconcileReadReceipt,
  agentMarkReadStorageKey,
  agentMarkOf,
  normalizeAgentMarkEvent,
  AGENT_NOTE_ATTRIBUTE,
  isMarkAnchored,
  resolveAgentMarkAnchor,
  markAttributes,
  markAttributeName,
  normalizeShowEvent,
  readRuntimeConfig,
  screenshotAnnotationFromDraft,
  screenshotCaptureScale,
  screenshotPointFromViewport,
  screenshotRectFromViewport,
  resolveAnchor,
  showEventsUrl,
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
  type AnnotationControlState,
  type AnnotationMode,
  type MarkAnchorRect,
  type RuntimeConfig,
  type ShowAnchor,
  type ShowAnnotationIntent,
  type SubmitShowEventOptions,
  type ShowAnnotation,
  type ScreenshotAnnotationItem,
  type ShowClientOptions,
  type ShowEvent,
  type ShowEventInput,
  type ReducedAgentMark
} from "./index.js"
import {
  APPROVE_INTENT,
  attachAnnotationWindowApi,
  canSubmitAnnotation,
  connectAnnotationHostBridge,
  createAnnotationController,
  fetchAnnotationAccess,
  isBatchControlNewer,
  isLiveControlEvent,
  resolveWriteToken,
  safeLocalStorage,
  resolveFabVisibility,
  readStoredFabVisible,
  writeStoredFabVisible,
  ANNOTATION_FAB_PARAM_SHOW,
  ANNOTATION_FAB_PARAM_HIDE,
  readStoredFloatPlacement,
  writeStoredFloatPlacement,
  snapToNearestEdge,
  exceedsDragThreshold,
  type FloatPosition,
  type FloatPlacement,
  type AnnotationController,
  type AnnotationHost,
  type AnnotationModeStorage
} from "./annotation-control.js"

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

/** One selectable comment intent chip. `label` is host-localizable (contract: zh defaults). */
export type AnnotationIntentOption = {
  intent: ShowAnnotationIntent | string
  label: string
}

/** Default intent chips: 评论/修改/疑问/批准 → comment/change/question/approve. */
export const DEFAULT_ANNOTATION_INTENTS: AnnotationIntentOption[] = [
  { intent: "comment", label: "评论" },
  { intent: "change", label: "修改" },
  { intent: "question", label: "疑问" },
  { intent: "approve", label: "批准" }
]

/** All overlay copy, exposed so a host can fully localize the chrome (zh defaults below). */
export type AnnotationOverlayLabels = {
  smart: string
  screenshot: string
  exit: string
  /** Tappable exit label used on touch devices (no hardware Esc). */
  exitShort: string
  annotating: string
  smartHint: string
  screenshotHint: string
  send: string
  cancel: string
  retake: string
  addComment: string
  sendBatch: (count: number) => string
  screenshotTitle: (count: number) => string
  commentPlaceholder: string
  screenshotCommentPlaceholder: string
  loginRequired: string
  selectedArea: string
  elementCount: (count: number) => string
  byElements: string
  byArea: string
  enterToSend: string
  // Optional so adding them is not a breaking change to the exported label type — hosts with a full
  // localization object keep compiling; the runtime always fills them from the (complete) defaults.
  /** Send-button label on the approve intent's one-tap fast path. */
  approve?: string
  /** Affordance to reveal the optional note field on the approve fast path. */
  addNote?: string
  /** One-line tip shown by the toolbar '?' affordance. */
  fabTip?: string
  /** Toast shown after the '✕' affordance hides the FAB. */
  fabHiddenToast?: string
}

// Required<> so the built-in defaults must stay complete (every field, incl. the optional ones)
// even though the public/override type marks the newest fields optional.
export const DEFAULT_ANNOTATION_LABELS: Required<AnnotationOverlayLabels> = {
  smart: "Smart",
  screenshot: "截图",
  exit: "Esc 退出",
  exitShort: "退出",
  annotating: "标注模式",
  smartHint: "点选元素 · 选文字 · 框选区域",
  screenshotHint: "拖拽框选截图区域",
  send: "发送",
  cancel: "取消",
  retake: "重新截图",
  addComment: "添加评论",
  sendBatch: (count) => (count > 0 ? `发送 ${count} 条评论` : "发送评论"),
  screenshotTitle: (count) => (count ? `截图 1 · ${count} 条评论` : "截图 1"),
  commentPlaceholder: "写下你的反馈…",
  screenshotCommentPlaceholder: "点击截图内任意位置，添加下一条编号评论…",
  loginRequired: "登录后可标注",
  selectedArea: "选中区域",
  elementCount: (count) => `${count} 个元素`,
  byElements: "按元素",
  byArea: "按区域",
  enterToSend: "Enter 发送 · Esc 取消",
  approve: "批准",
  addNote: "添加备注",
  fabTip: "点选元素或截图,把意见直接发给 Agent;链接加 ?unmark 可隐藏本按钮",
  fabHiddenToast: "已隐藏,链接加 ?mark 可恢复"
}

export type AnnotationOverlayProps = {
  /** Controlled on/off (from the control plane). Omit for uncontrolled use (internal FAB toggle). */
  enabled?: boolean
  /** Uncontrolled initial on/off when `enabled` is omitted. */
  defaultEnabled?: boolean
  /** Controlled capture mode. Omit for uncontrolled use. */
  mode?: AnnotationMode
  /** Uncontrolled initial mode when `mode` is omitted. */
  defaultMode?: AnnotationMode
  /** Whether writes are possible for the current viewer; false hides compose affordances. */
  available?: boolean
  /** Host layout: standalone shows FAB⇄toolbar; embedded shows the mode pill only. */
  host?: AnnotationHost
  scope?: string
  intents?: AnnotationIntentOption[]
  defaultIntent?: ShowAnnotationIntent | string
  severity?: string
  labels?: Partial<AnnotationOverlayLabels>
  onEnable?: (mode?: AnnotationMode) => void
  onDisable?: () => void
  onSetMode?: (mode: AnnotationMode) => void
  onSubmitted?: (annotation: ShowAnnotation, result: unknown) => void
}

export type AgentMarkLayerProps = {
  events?: ShowEvent[]
  scope?: string
  className?: string
  /** Escape hatch: a custom renderer keeps the pre-lifecycle simple layer (no bubbles/badge). */
  renderMark?: (event: ShowEvent, rect: MarkAnchorRect) => React.ReactNode
  /** Whether the viewer can post read receipts (canAnnotate). Default: inferred from a write token.
   *  Anonymous viewers (false) keep read state in localStorage only, never POST. */
  canAnnotate?: boolean
  /** Host mode — drives badge placement (clear the FAB in standalone; bottom-right free in embedded). */
  host?: AnnotationHost
}

type AssistantMarkLayerEvent = Extract<ShowEvent, { type: "assistant.mark.created" | "assistant.mark.updated" | "assistant.mark.resolved" }>

export type AnnotationMarkerTone = "human" | "assistant" | "resolved"
export type AnnotationMarkerVariant = "hover" | "selected" | "region"

export type AnnotationMarkerProps = {
  rect: MarkAnchorRect
  tone?: AnnotationMarkerTone
  variant?: AnnotationMarkerVariant
  /** Anchor chip text rendered above the box (e.g. the element label). */
  label?: string
  /** Corner badge content (a number or an icon); omit for a plain highlight box. */
  badge?: React.ReactNode
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
  enabled: enabledProp,
  defaultEnabled = false,
  mode: modeProp,
  defaultMode = "smart",
  available = true,
  host = "standalone",
  scope,
  intents,
  defaultIntent,
  severity = "suggestion",
  labels,
  onEnable,
  onDisable,
  onSetMode,
  onSubmitted
}: AnnotationOverlayProps) {
  const context = React.useContext(ShowSessionContext)
  const copy = React.useMemo(() => {
    const merged = { ...DEFAULT_ANNOTATION_LABELS, ...labels }
    // If a host localized `exit` but not `exitShort`, use their `exit` on touch too (avoid mixed
    // languages after upgrade); fall back to the built-in short label only when neither is provided.
    merged.exitShort = labels?.exitShort ?? labels?.exit ?? DEFAULT_ANNOTATION_LABELS.exitShort
    // The optional approve-path labels always resolve to a string (a host may omit them, or pass
    // undefined in a Partial), so the buttons never render blank.
    merged.approve = labels?.approve ?? DEFAULT_ANNOTATION_LABELS.approve
    merged.addNote = labels?.addNote ?? DEFAULT_ANNOTATION_LABELS.addNote
    merged.fabTip = labels?.fabTip ?? DEFAULT_ANNOTATION_LABELS.fabTip
    merged.fabHiddenToast = labels?.fabHiddenToast ?? DEFAULT_ANNOTATION_LABELS.fabHiddenToast
    return merged
  }, [labels])
  const intentOptions = intents ?? DEFAULT_ANNOTATION_INTENTS
  // Controlled when `enabled`/`mode` are supplied (the control-plane wrapper); otherwise uncontrolled
  // with internal state so a direct `<AnnotationOverlay />` consumer can still toggle via the FAB.
  const [internalEnabled, setInternalEnabled] = React.useState(defaultEnabled)
  const [internalMode, setInternalMode] = React.useState<AnnotationMode>(defaultMode)
  const isEnabledControlled = enabledProp !== undefined
  const isModeControlled = modeProp !== undefined
  const enabled = isEnabledControlled ? enabledProp : internalEnabled
  const mode = isModeControlled ? modeProp : internalMode
  const enable = React.useCallback((next?: AnnotationMode) => {
    if (!isEnabledControlled) setInternalEnabled(true)
    if (next && !isModeControlled) setInternalMode(next)
    onEnable?.(next)
  }, [isEnabledControlled, isModeControlled, onEnable])
  const disable = React.useCallback(() => {
    if (!isEnabledControlled) setInternalEnabled(false)
    onDisable?.()
  }, [isEnabledControlled, onDisable])
  const changeMode = React.useCallback((next: AnnotationMode) => {
    if (!isModeControlled) setInternalMode(next)
    onSetMode?.(next)
  }, [isModeControlled, onSetMode])
  // "Active" == the overlay can capture: enabled AND the viewer may write. Anonymous public
  // visitors (available === false) see markers only, never a capture surface.
  const active = enabled && available
  const cramped = useCrampedLayout()
  const touchInput = useTouchInput()
  const [selectedIntent, setSelectedIntent] = React.useState<ShowAnnotationIntent | string>(
    defaultIntent ?? intentOptions[0]?.intent ?? "comment"
  )
  // On the approve fast path the comment box is hidden by default (one-tap approve); this reveals the
  // optional note field. Reset only when the intent actually CHANGES — re-clicking the already-active
  // chip must not collapse an open note (which would then be submitted as empty text, #725).
  const [noteExpanded, setNoteExpanded] = React.useState(false)
  const selectIntent = React.useCallback((intent: string) => {
    if (intent === selectedIntent) return
    setSelectedIntent(intent)
    setNoteExpanded(false)
  }, [selectedIntent])
  // Focus target for the collapsed approve card (no textarea to autofocus) — keeps focus in the overlay.
  const approveSendRef = React.useRef<HTMLButtonElement | null>(null)
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
  const screenshotItemSequenceRef = React.useRef(0)
  const screenshotCaptureTokenRef = React.useRef(0)
  const activeRef = React.useRef(active)
  const modeRef = React.useRef(mode)
  activeRef.current = active
  modeRef.current = mode

  React.useEffect(() => {
    dragRef.current = drag
  }, [drag])

  // Clear all transient annotation state whenever the overlay turns off (or loses write access) or
  // the capture mode switches, so the page returns to exactly its pre-annotation state (§6).
  React.useEffect(() => {
    setDraft(null)
    resetScreenshotState()
    setComment("")
    setDrag(null)
    setHover(null)
    smartDragStartRef.current = null
    suppressNextClickRef.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetScreenshotState is a stable local
  }, [enabled, mode, available])

  // Page-scroll locks (see usePageScrollLock), each released automatically when its condition clears.
  //  • Screenshot framing — TOUCH-ONLY: a mouse drag never scrolls the page, and locking body/html
  //    overflow on a classic-scrollbar desktop would reflow the page before the user frames, so the
  //    capture would differ from what they saw (#408). The scoped touchmove guard cancels touch scroll
  //    starting inside the capture surface so a region drag draws instead of scrolling (§7, #242).
  usePageScrollLock(active && mode === "screenshot" && touchInput, "[data-show-annotation-capture]")
  //  • Smart comment card open — ALL input types: the selection box uses viewport coords, so page
  //    scroll under an open card drifts the highlight off the element. Released on card
  //    close/submit/cancel/Esc/退出 (each clears `draft`). Submitted annotations leave no persistent
  //    marker, so draft-time locking fully covers it — no follow-the-element tracking needed.
  usePageScrollLock(active && Boolean(draft))

  // Collapsed approve card has no textarea to autofocus; focus the primary (批准) button so keyboard
  // stays inside the overlay — CommentSurface only guards keys that originate inside the card (#732).
  React.useEffect(() => {
    if (Boolean(draft) && selectedIntent === APPROVE_INTENT && !noteExpanded) {
      approveSendRef.current?.focus()
    }
  }, [draft, selectedIntent, noteExpanded])

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
      if (event.key !== "Escape" || !active) return
      // Esc cancels an open draft first; a second Esc (nothing open) exits annotation mode (§6).
      if (draft || screenshotDraft) {
        setDraft(null)
        resetScreenshotState()
        setDrag(null)
        setHover(null)
        return
      }
      disable()
    }
    document.addEventListener("keydown", escape)
    return () => document.removeEventListener("keydown", escape)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetScreenshotState is a stable local
  }, [active, draft, screenshotDraft, disable])

  async function submit() {
    // Effective note text: empty when the comment box is hidden (approve fast path, no note expanded),
    // so switching to approve after typing under another intent never submits stale, hidden text.
    const text = selectedIntent === APPROVE_INTENT && !noteExpanded ? "" : comment
    if (!draft || !canSubmitAnnotation(selectedIntent, text)) return
    const baseAnnotation: ShowAnnotation = {
      scope,
      intent: selectedIntent,
      severity,
      status: "pending",
      comment: text.trim(),
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
    if (!active || !screenshotDraft?.capture || screenshotDraft.items.length === 0) return
    const annotation = screenshotAnnotationFromDraft({
      scope,
      intent: selectedIntent,
      severity,
      status: "pending",
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
      resetScreenshotState()
      onSubmitted?.(annotation, result)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to submit screenshot annotation")
    } finally {
      setSubmitting(false)
    }
  }

  function resetScreenshotState() {
    screenshotCaptureTokenRef.current += 1
    setScreenshotDraft(null)
    screenshotItemSequenceRef.current = 0
    setScreenshotComment("")
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
        const captureToken = ++screenshotCaptureTokenRef.current
        void captureScreenshotRegion(rect)
          .then((capture) => {
            if (screenshotCaptureTokenRef.current !== captureToken || !activeRef.current || modeRef.current !== "screenshot") {
              return
            }
            if (!capture.captured) {
              setError(capture.captureError || "Screenshot capture failed")
              return
            }
            screenshotItemSequenceRef.current = 0
            setScreenshotComment("")
            setError(null)
            if (activeRef.current) {
              setScreenshotDraft({ region: rect, capture, items: [] })
            }
          })
          .catch((captureError) => {
            if (screenshotCaptureTokenRef.current === captureToken && activeRef.current && modeRef.current === "screenshot") {
              setError(captureError instanceof Error ? captureError.message : "Failed to capture screenshot region")
            }
          })
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
    if (!active || !screenshotDraft?.capture || !screenshotComment.trim()) return
    const label = ++screenshotItemSequenceRef.current
    const id = `shot_item_${label}`
    const capturedRegion = screenshotDraft.capture.capturedRegion
    // Item coordinates are stored in screenshot-image space, so they still land on the PNG when the
    // capture was downsampled past the size cap (scale < 1); scale is 1 for the common case.
    const scale = screenshotCaptureScale(screenshotDraft.capture)
    const item: ScreenshotCommentDraft = screenshotDraft.pendingRect
      ? {
          id,
          label,
          comment: screenshotComment.trim(),
          rect: screenshotRectFromViewport(screenshotDraft.pendingRect, capturedRegion, scale),
          viewportRect: screenshotDraft.pendingRect
        }
      : {
          id,
          label,
          comment: screenshotComment.trim(),
          point: screenshotPointFromViewport(screenshotDraft.pendingPoint ?? centerPoint(screenshotDraft.region), capturedRegion, scale),
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

  const ambiguous = draft?.selection?.classification.ambiguous
  const nextItemLabel = screenshotItemSequenceRef.current + 1
  // Approve is a one-tap fast path: the comment box is hidden (submit allowed with empty text) unless
  // the user opts into an optional note. Every other intent shows the box and requires non-empty text.
  const isApprove = selectedIntent === APPROVE_INTENT
  const commentVisible = !isApprove || noteExpanded

  return createPortal(
    <>
      <AnnotationChrome
        host={host}
        enabled={enabled}
        available={available}
        mode={mode}
        touchInput={touchInput}
        labels={copy}
        sessionId={context?.config.sessionId}
        onEnable={enable}
        onDisable={disable}
        onSetMode={changeMode}
      />

      {active && mode === "smart" && hover && !draft ? (
        <AnnotationMarker rect={hover.rect} tone="human" variant="hover" label={hover.label} />
      ) : null}
      {active && mode === "smart" && drag ? (
        <AnnotationMarker rect={normalizeVisualRect(drag.rect)} tone="human" variant="region" />
      ) : null}

      {active && mode === "screenshot" ? (
        <div
          data-show-annotation-capture=""
          style={screenshotDraft ? screenshotItemSurfaceStyle : screenshotCaptureStyle}
          onPointerDown={onCapturePointerDown}
          onPointerMove={onCapturePointerMove}
          onPointerUp={onCapturePointerUp}
        />
      ) : null}
      {active && mode === "screenshot" && !screenshotDraft && drag?.purpose === "screenshot-region" ? (
        <ScreenshotRegionFrame rect={normalizeVisualRect(drag.rect)} label={copy.screenshotTitle(0)} />
      ) : null}

      {active && draft ? (
        <>
          <AnnotationMarker rect={draft.rect} tone="human" variant="selected" label={draft.label} />
          <CommentSurface
            anchorRect={draft.rect}
            cramped={cramped}
            onClose={() => setDraft(null)}
            footer={
              <div style={cardFooterStyle}>
                {/* Hint only when the comment box is shown and Enter-to-send applies (hardware keyboard). */}
                <span style={footerHintStyle}>{commentVisible && !touchInput ? copy.enterToSend : ""}</span>
                <button ref={approveSendRef} type="button" disabled={submitting || !canSubmitAnnotation(selectedIntent, comment)} onClick={() => void submit()} style={disabledButtonStyle(primaryButtonStyle, submitting || !canSubmitAnnotation(selectedIntent, comment))}>
                  {isApprove ? <IntentIcon intent={APPROVE_INTENT} /> : <SendIcon />}
                  {submitting ? "…" : isApprove ? copy.approve : copy.send}
                </button>
              </div>
            }
          >
            {draft.label ? <AnchorChip label={draft.label} /> : null}
            {ambiguous ? (
              <div style={toggleRowStyle}>
                <button type="button" style={draft.selection!.primaryAnchor === "element-group" ? toggleActiveStyle : toggleButtonStyle} onClick={() => {
                  const nextSelection = { ...draft.selection!, primaryAnchor: "element-group" as const, anchor: { ...draft.selection!.anchor, kind: "element-group" as const } }
                  setDraft({ ...draft, selection: nextSelection, anchor: nextSelection.anchor, label: copy.elementCount(nextSelection.matchedElements.length) })
                }}>{copy.byElements}</button>
                <button type="button" style={draft.selection!.primaryAnchor === "area" ? toggleActiveStyle : toggleButtonStyle} onClick={() => {
                  const nextSelection = { ...draft.selection!, primaryAnchor: "area" as const, anchor: { ...draft.selection!.anchor, kind: "area" as const } }
                  setDraft({ ...draft, selection: nextSelection, anchor: nextSelection.anchor, label: copy.selectedArea })
                }}>{copy.byArea}</button>
              </div>
            ) : null}
            <IntentChips options={intentOptions} value={selectedIntent} onChange={selectIntent} />
            {commentVisible ? (
              <textarea
                autoFocus
                placeholder={copy.commentPlaceholder}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends when a hardware keyboard is present (Shift+Enter for a newline); a
                  // touch device keeps Enter as a newline. Keyed on input capability, not layout, so a
                  // narrow desktop window in the sheet layout still submits on Enter.
                  if (event.key === "Enter" && !event.shiftKey && !touchInput) {
                    event.preventDefault()
                    void submit()
                  }
                }}
                style={overlayTextareaStyle}
              />
            ) : (
              // Approve fast path: box hidden by default; offer a minimal opt-in to add a note.
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setNoteExpanded(true)} style={addNoteButtonStyle}>
                + {copy.addNote}
              </button>
            )}
            {error ? <p role="alert" style={overlayErrorStyle}>{error}</p> : null}
          </CommentSurface>
        </>
      ) : null}

      {active && screenshotDraft ? (
        <>
          <ScreenshotRegionFrame rect={screenshotDraft.region} label={copy.screenshotTitle(0)} showHandles />
          {screenshotDraft.items.map((item) =>
            item.viewportRect ? (
              <AnnotationMarker key={item.id} rect={item.viewportRect} tone="human" variant="region" badge={item.label} />
            ) : item.viewportPoint ? (
              <NumberPin key={item.id} point={item.viewportPoint} tone="human" label={item.label} />
            ) : null
          )}
          {screenshotDraft.pendingRect ? <AnnotationMarker rect={screenshotDraft.pendingRect} tone="human" variant="selected" badge={nextItemLabel} /> : null}
          {screenshotDraft.pendingPoint ? <NumberPin point={screenshotDraft.pendingPoint} tone="human" label={nextItemLabel} pending /> : null}
          <CommentSurface
            anchorRect={screenshotDraft.region}
            cramped={cramped}
            width={SCREENSHOT_CARD_WIDTH}
            onClose={() => resetScreenshotState()}
            footer={
              <ScreenshotBatchFooter
                draft={screenshotDraft}
                comment={screenshotComment}
                submitting={submitting}
                labels={copy}
                onAddComment={addScreenshotComment}
                onRetake={resetScreenshotState}
                onSend={() => void submitScreenshotDraft()}
              />
            }
          >
            <ScreenshotBatchBody
              draft={screenshotDraft}
              comment={screenshotComment}
              labels={copy}
              onCommentChange={setScreenshotComment}
              onRemoveItem={(id) => setScreenshotDraft({ ...screenshotDraft, items: screenshotDraft.items.filter((current) => current.id !== id) })}
            />
            {error ? <p role="alert" style={overlayErrorStyle}>{error}</p> : null}
          </CommentSurface>
        </>
      ) : null}

      {error && active && !draft && !screenshotDraft ? (
        <div data-show-annotation-ui="" role="alert" style={floatingErrorStyle}>{error}</div>
      ) : null}
      <AgentMarkLayer scope={scope} host={host} canAnnotate={available} />
    </>,
    document.body
  )
}

// ── Chrome: standalone FAB ⇄ pill toolbar, embedded mode pill, login hint ────────────────

type AnnotationChromeProps = {
  host: AnnotationHost
  enabled: boolean
  available: boolean
  mode: AnnotationMode
  touchInput: boolean
  labels: AnnotationOverlayLabels
  sessionId?: string
  onEnable?: (mode?: AnnotationMode) => void
  onDisable?: () => void
  onSetMode?: (mode: AnnotationMode) => void
}

/**
 * The embedded mode pill's label. On coarse-pointer (touch) viewports the '标注模式 · ' prefix and the
 * long screenshot hint are dropped to just the mode name (`Smart` / `截图`) so the pill stays on ONE line
 * even at 320px; desktop keeps the full copy. Pure so the mobile-vs-desktop choice is unit-testable.
 */
export function modePillLabel(
  mode: AnnotationMode,
  touchInput: boolean,
  labels: Pick<Required<AnnotationOverlayLabels>, "annotating" | "smart" | "screenshot" | "screenshotHint">
): string {
  if (mode === "screenshot") return touchInput ? labels.screenshot : labels.screenshotHint
  return touchInput ? labels.smart : `${labels.annotating} · ${labels.smart}`
}

/** Standalone-only FAB visibility from the frozen ?mark / ?unmark query param: an explicit param flips it
 *  AND persists the choice, then is stripped from the URL at boot (one-time switch); a param-free load
 *  honors the stored choice. Query param, not the hash, so it never collides with the Show Page hash
 *  router. Embedded host is always visible. `hide()` is the ✕ button (≡ ?unmark, persisted). */
function useFabVisibility(host: AnnotationHost, sessionId: string | undefined) {
  const storage = React.useMemo(() => safeLocalStorage(), [])
  const [visible, setVisible] = React.useState<boolean>(() => {
    if (host !== "standalone" || typeof window === "undefined") return true
    return resolveFabVisibility(window.location.search, readStoredFabVisible(sessionId, storage)).visible
  })
  // Read the ?mark / ?unmark switch ONCE at boot: apply it, persist the choice, then STRIP the param via
  // replaceState so the URL returns clean — keeping any other query params AND the hash route (#/…) intact,
  // since the Show Page hash router owns the hash. It's a one-time switch, so there is no ongoing listener.
  React.useEffect(() => {
    if (host !== "standalone" || typeof window === "undefined") return
    const resolved = resolveFabVisibility(window.location.search, readStoredFabVisible(sessionId, storage))
    if (resolved.persist !== null) writeStoredFabVisible(sessionId, resolved.persist, storage)
    setVisible(resolved.visible)
    try {
      const url = new URL(window.location.href)
      if (url.searchParams.has(ANNOTATION_FAB_PARAM_SHOW) || url.searchParams.has(ANNOTATION_FAB_PARAM_HIDE)) {
        url.searchParams.delete(ANNOTATION_FAB_PARAM_SHOW)
        url.searchParams.delete(ANNOTATION_FAB_PARAM_HIDE)
        const query = url.searchParams.toString()
        window.history.replaceState(null, "", `${url.pathname}${query ? `?${query}` : ""}${url.hash}`)
      }
    } catch {
      /* best-effort — a blocked replaceState / URL parse must not break visibility */
    }
  }, [host, sessionId, storage])
  const hide = React.useCallback(() => {
    // ✕ affordance: persist hidden + hide. The URL is already param-clean (stripped at boot), so there is
    // nothing to neutralize — the stored preference wins on the next param-free load.
    writeStoredFabVisible(sessionId, false, storage)
    setVisible(false)
  }, [sessionId, storage])
  return { visible, hide }
}

// A touch above the old 20px: a down-biased drop shadow needs clearance from the viewport bottom or its
// lower half is clipped (owner mobile report). This inset is the floating-chrome margin AND the drag
// bottom bound, so the shadow renders fully at the resting position and at any snapped position.
const FLOAT_INSET = 26

type DraggableResult = {
  style: React.CSSProperties
  dragging: boolean
  pointerHandlers: Pick<React.DOMAttributes<HTMLElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">
  /** Call at the start of onClick: returns true (and consumes) when the gesture was a drag, not a click. */
  consumeDragClick: () => boolean
}

/**
 * Unified pointer drag (mouse + touch) with a 6px click-vs-drag threshold. While dragging the element
 * follows the pointer; on release it SNAPS to the nearest vertical edge and the position persists per
 * element+session. A restored/again-resized position is re-snapped to the current viewport so it can
 * never end up off-screen. `touch-action:none` keeps a touch-drag from scrolling the page.
 */
function useDraggable(element: "fab" | "badge", sessionId: string | undefined, restingHeight: number): DraggableResult {
  const storage = React.useMemo(() => safeLocalStorage(), [])
  // Persist the snapped EDGE + vertical offset, NOT an absolute left — so a right placement survives a
  // viewport resize / a mobile→desktop reload, and a wider element (the toolbar) reuses it width-independently.
  const [placement, setPlacement] = React.useState<FloatPlacement | null>(() => readStoredFloatPlacement(element, sessionId, storage) ?? null)
  const [dragPos, setDragPos] = React.useState<FloatPosition | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const gesture = React.useRef<{ startX: number; startY: number; originLeft: number; originTop: number; moved: boolean } | null>(null)
  const draggedRef = React.useRef(false)
  // The element's actual height (FAB 52 / badge 48, refined from the measured rect once dragged) — used to
  // clamp the bottom clearance on resize so a down-anchored element never re-clips its shadow (#3637621027).
  const heightRef = React.useRef(restingHeight)

  // Reload the placement when the element/session changes — the useState initializer runs only on the
  // first mount, so a SPA that swaps `sessionId` on a reused provider would otherwise keep the prior
  // session's placement and write it into the new session's key, defeating per-session storage (#3637761504).
  React.useEffect(() => {
    setPlacement(readStoredFloatPlacement(element, sessionId, storage) ?? null)
  }, [element, sessionId, storage])

  // On resize keep the element on-screen by clamping only the vertical offset; the edge is preserved.
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const clampTop = () => setPlacement((prev) => (prev ? { edge: prev.edge, top: Math.min(Math.max(FLOAT_INSET, prev.top), Math.max(FLOAT_INSET, window.innerHeight - FLOAT_INSET - heightRef.current)) } : prev))
    clampTop()
    window.addEventListener("resize", clampTop)
    return () => window.removeEventListener("resize", clampTop)
  }, [])

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return // primary mouse button / any touch-pen
    // Reset the drag flag at the START of every gesture. A touch drag usually fires NO click on release,
    // so clearing on `consumeDragClick` alone would leave the flag set and suppress the next real tap.
    draggedRef.current = false
    const rect = event.currentTarget.getBoundingClientRect()
    heightRef.current = rect.height
    gesture.current = { startX: event.clientX, startY: event.clientY, originLeft: rect.left, originTop: rect.top, moved: false }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* capture is best-effort */ }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g) return
    const dx = event.clientX - g.startX
    const dy = event.clientY - g.startY
    if (!g.moved && !exceedsDragThreshold(dx, dy)) return
    g.moved = true
    if (!dragging) setDragging(true)
    setDragPos({ left: g.originLeft + dx, top: g.originTop + dy })
    event.preventDefault()
  }
  const finish = (event: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current
    gesture.current = null
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* best-effort */ }
    if (g?.moved) {
      draggedRef.current = true
      // Measure the ACTUAL element size at release (the badge width varies with the count) so the
      // right-edge snap lands flush rather than at a nominal offset.
      const rect = event.currentTarget.getBoundingClientRect()
      const snapped = snapToNearestEdge(
        { left: g.originLeft + (event.clientX - g.startX), top: g.originTop + (event.clientY - g.startY) },
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
        FLOAT_INSET,
        { bottom: window.innerHeight - FLOAT_INSET }
      )
      const next: FloatPlacement = { edge: snapped.edge, top: snapped.top }
      setPlacement(next)
      writeStoredFloatPlacement(element, sessionId, next, storage)
    }
    setDragPos(null)
    setDragging(false)
  }
  const consumeDragClick = () => {
    if (draggedRef.current) {
      draggedRef.current = false
      return true
    }
    return false
  }
  // While dragging: follow the pointer (absolute). At rest: EDGE-anchored (inset from the chosen side)
  // so the FAB and the wider expanded toolbar share the placement without either overflowing off-screen.
  const style: React.CSSProperties = dragPos
    ? { left: dragPos.left, top: dragPos.top, right: "auto", bottom: "auto", touchAction: "none" }
    : placement
      ? { top: placement.top, bottom: "auto", touchAction: "none", ...(placement.edge === "left" ? { left: FLOAT_INSET, right: "auto" } : { right: FLOAT_INSET, left: "auto" }) }
      : { touchAction: "none" }
  return { style, dragging, pointerHandlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish }, consumeDragClick }
}

function AnnotationChrome({ host, enabled, available, mode, touchInput, labels, sessionId, onEnable, onDisable, onSetMode }: AnnotationChromeProps) {
  // No "Esc" wording on touch devices (no hardware Esc); the exit affordance is always tappable. Keyed
  // on input capability, not layout, so a narrow desktop window still shows the clickable "Esc" label.
  const exitLabel = touchInput ? labels.exitShort : labels.exit
  // Hooks must be unconditional (called before the host/availability early returns below).
  const fabVisibility = useFabVisibility(host, sessionId)
  const fabDrag = useDraggable("fab", sessionId, 52) // FAB is 52px tall
  const [toast, setToast] = React.useState<string | null>(null)
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])
  const flashToast = React.useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3200)
  }, [])
  // ✕ affordance: hide the FAB (≡ #unmark, persisted) and confirm with a brief toast so the user knows
  // how to bring it back. Also disables an active session so nothing is left capturing.
  const hideFab = React.useCallback(() => {
    onDisable?.()
    fabVisibility.hide()
    if (labels.fabHiddenToast) flashToast(labels.fabHiddenToast)
  }, [onDisable, fabVisibility, flashToast, labels.fabHiddenToast])
  // If the hash flips to #unmark (or the ✕ fires) WHILE a session is active, the hide switch must also
  // stop capture — not just hide the collapsed FAB — so the documented switch works mid-session (#3637478399).
  React.useEffect(() => {
    if (host === "standalone" && !fabVisibility.visible && enabled) onDisable?.()
  }, [host, fabVisibility.visible, enabled, onDisable])

  if (host === "embedded") {
    // Embedded in the chat iframe: the chat header owns enable/disable; the overlay only shows a
    // status pill so the user knows annotation is live and how to exit (contract §2, design kn94D).
    if (!enabled || !available) return null
    return (
      <div data-show-annotation-ui="" style={modePillStyle} onClick={(event) => event.stopPropagation()}>
        <span style={{ ...modePillDotStyle, background: COLORS.human }} />
        <span style={modePillLabelStyle}>
          {modePillLabel(mode, touchInput, labels as Required<AnnotationOverlayLabels>)}
        </span>
        <button type="button" style={modePillExitStyle} onClick={() => onDisable?.()}>{exitLabel}</button>
      </div>
    )
  }

  // The hash / ✕ hide switch gates ALL standalone chrome — the collapsed FAB, the expanded toolbar, AND
  // the anonymous login hint below — so #unmark hides everything, not just the FAB (#3637621031 /
  // #3637478399); the disable effect above stops capture too. The toast still renders so the ✕
  // confirmation shows even after the chrome is hidden.
  if (!fabVisibility.visible) {
    return toast ? <div data-show-annotation-ui="" role="status" style={toastStyle}>{toast}</div> : null
  }

  // Standalone tab: anonymous public visitors can't write — hide the FAB, show a quiet login hint.
  if (!available) {
    return (
      <div data-show-annotation-ui="" style={loginHintStyle}>
        <LockIcon />
        {labels.loginRequired}
      </div>
    )
  }

  // Standalone chrome (visible + available). The collapsed FAB is the draggable form; enabling expands
  // the toolbar, which reuses the FAB's edge placement.
  let content: React.ReactNode = null
  if (!enabled) {
    content = (
      <button
        type="button"
        data-show-annotation-ui=""
        aria-label={labels.annotating}
        style={{ ...fabStyle, ...fabDrag.style }}
        {...fabDrag.pointerHandlers}
        onClick={() => {
          if (fabDrag.consumeDragClick()) return // a drag, not a click — don't open
          onEnable?.()
        }}
      >
        <AnnotateIcon />
      </button>
    )
  } else {
    content = (
      // Reuse the FAB's edge placement so the toolbar stays where the user moved it (#3637478393); clamp
      // its width and use icon-only mode tabs on touch so every control stays on-screen at ~320px (#3637478390).
      <div data-show-annotation-ui="" style={{ ...toolbarStyle, ...fabDrag.style, maxWidth: "calc(100vw - 52px)" }} onClick={(event) => event.stopPropagation()}>
        <button type="button" aria-label={exitLabel} style={toolbarIndicatorStyle} onClick={() => onDisable?.()}>
          <AnnotateIcon />
        </button>
        <ModeTab active={mode === "smart"} onClick={() => onSetMode?.("smart")} icon={<SparkleIcon />} label={labels.smart} compact={touchInput} />
        <ModeTab active={mode === "screenshot"} onClick={() => onSetMode?.("screenshot")} icon={<CameraIcon />} label={labels.screenshot} compact={touchInput} />
        <button type="button" style={toolbarExitStyle} onClick={() => onDisable?.()}>{exitLabel}</button>
        {/* Trailing subtle affordances: '?' one-line tip, '✕' hide (≡ #unmark). */}
        <ToolbarHelp tip={labels.fabTip ?? ""} touchInput={touchInput} />
        <button type="button" aria-label={labels.fabHiddenToast ?? "hide"} style={toolbarGlyphButtonStyle} onClick={hideFab}>✕</button>
      </div>
    )
  }

  return (
    <>
      {content}
      {toast ? <div data-show-annotation-ui="" role="status" style={toastStyle}>{toast}</div> : null}
    </>
  )
}

/** Subtle '?' affordance on the toolbar: hover (mouse) or tap (touch) reveals a one-line tip. */
function ToolbarHelp({ tip, touchInput }: { tip: string; touchInput: boolean }) {
  const [open, setOpen] = React.useState(false)
  if (!tip) return null
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        aria-label={tip}
        style={toolbarGlyphButtonStyle}
        onPointerEnter={() => { if (!touchInput) setOpen(true) }}
        onPointerLeave={() => { if (!touchInput) setOpen(false) }}
        onClick={() => { if (touchInput) setOpen((value) => !value) }}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      {open ? <span role="tooltip" style={toolbarHelpTipStyle}>{tip}</span> : null}
    </span>
  )
}

function ModeTab({ active, onClick, icon, label, compact }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; compact?: boolean }) {
  // Compact (touch / narrow): icon-only with the label as the accessible name, so the toolbar's controls
  // fit within a ~320px viewport (#3637478390).
  return (
    <button type="button" aria-pressed={active} aria-label={compact ? label : undefined} onClick={onClick} style={active ? modeTabActiveStyle : modeTabStyle}>
      {icon}
      {compact ? null : label}
    </button>
  )
}

// ── Intent chips, anchor chip, comment surface (popover / mobile bottom-sheet) ──────────

function IntentChips({ options, value, onChange }: { options: AnnotationIntentOption[]; value: string; onChange: (intent: string) => void }) {
  return (
    <div style={intentChipsStyle}>
      {options.map((option) => {
        const selected = option.intent === value
        return (
          // onMouseDown preventDefault: don't take focus on a mouse press, so a clicked-then-unselected
          // chip shows no lingering focus ring (renders identical to its siblings). Keyboard Tab focus
          // is unaffected, so the ring still shows for keyboard users.
          <button key={option.intent} type="button" aria-pressed={selected} onMouseDown={(event) => event.preventDefault()} onClick={() => onChange(option.intent)} style={selected ? intentChipActiveStyle : intentChipStyle}>
            <IntentIcon intent={option.intent} />
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function AnchorChip({ label }: { label: string }) {
  return (
    <span style={anchorChipStyle}>
      <AnchorIcon />
      <span style={anchorChipTextStyle}>{label}</span>
    </span>
  )
}

/**
 * The comment container: a positioned popover on desktop, a bottom sheet on mobile (design urZTa).
 * Capped height with a scrollable body and a PINNED footer, so a long anchor label / comment list
 * can never push the send row off-screen (mobile overflow fix, §4).
 */
function CommentSurface({ anchorRect, cramped, onClose, footer, children, width = COMMENT_CARD_WIDTH }: { anchorRect: MarkAnchorRect; cramped: boolean; onClose: () => void; footer?: React.ReactNode; children: React.ReactNode; width?: number }) {
  // Keyboard isolation: keep keys typed in the card from reaching host-page shortcuts (`/`, arrows,
  // Cmd/Ctrl+K, …). Escape stays overlay-owned → cancel the card. Enter-to-send is handled on the
  // smart textarea before this bubble-phase guard stops propagation.
  const keyGuard = {
    onKeyDown: (event: React.KeyboardEvent) => {
      event.stopPropagation()
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
      }
    },
    onKeyUp: (event: React.KeyboardEvent) => event.stopPropagation()
  }
  const inner = (
    <>
      <button type="button" aria-label="Close" onClick={onClose} style={closeButtonStyle}>×</button>
      <div style={commentBodyStyle}>{children}</div>
      {footer ? <div style={commentFooterStyle}>{footer}</div> : null}
    </>
  )
  if (cramped) {
    return (
      <div data-show-annotation-ui="" role="dialog" style={sheetStyle} onClick={(event) => event.stopPropagation()} {...keyGuard}>
        <div style={sheetHandleStyle} />
        {inner}
      </div>
    )
  }
  const top = Math.min(window.innerHeight - 260, Math.max(12, anchorRect.y + anchorRect.height + 10))
  const left = Math.min(window.innerWidth - width - 12, Math.max(12, anchorRect.x))
  return (
    <div data-show-annotation-ui="" role="dialog" style={{ ...popoverStyle, top, left, width }} onClick={(event) => event.stopPropagation()} {...keyGuard}>
      {inner}
    </div>
  )
}

// ── Screenshot chrome: spotlit region frame + numbered pins + batch card ────────────────

function ScreenshotRegionFrame({ rect, label, showHandles }: { rect: MarkAnchorRect; label: string; showHandles?: boolean }) {
  return (
    <div data-show-annotation-ui="" style={{ ...regionFrameStyle, left: rect.x, top: rect.y, width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) }}>
      <span style={regionLabelStyle}>
        <CameraIcon />
        {label}
      </span>
      {showHandles ? REGION_HANDLES.map((corner) => <span key={corner} style={{ ...regionHandleStyle, ...regionHandlePosition(corner) }} />) : null}
    </div>
  )
}

function NumberPin({ point, tone, label, pending }: { point: { x: number; y: number }; tone: AnnotationMarkerTone; label: number | string; pending?: boolean }) {
  const accent = tone === "assistant" ? COLORS.agent : COLORS.human
  return (
    <div
      data-show-annotation-ui=""
      style={{
        position: "fixed",
        left: point.x - 13,
        top: point.y - 13,
        width: 26,
        height: 26,
        borderRadius: 999,
        display: "grid",
        placeItems: "center",
        font: `600 12px/1 ${FONT_STACK}`,
        color: COLORS.onAccent,
        background: accent,
        border: `2px solid ${COLORS.surface}`,
        boxShadow: `0 4px 14px ${accent}55`,
        opacity: pending ? 0.7 : 1,
        pointerEvents: "none",
        zIndex: MARKER_Z
      }}
    >
      {label}
    </div>
  )
}

type ScreenshotBatchCardProps = {
  draft: ScreenshotDraft
  comment: string
  submitting: boolean
  labels: AnnotationOverlayLabels
  onCommentChange: (value: string) => void
  onAddComment: () => void
  onRemoveItem: (id: string) => void
  onRetake: () => void
  onSend: () => void
}

/** Scrollable body of the screenshot batch card (header, preview, numbered comment list, input). */
function ScreenshotBatchBody({ draft, comment, labels, onCommentChange, onRemoveItem }: Pick<ScreenshotBatchCardProps, "draft" | "comment" | "labels" | "onCommentChange" | "onRemoveItem">) {
  return (
    <>
      <div style={batchHeaderStyle}>
        <CameraIcon />
        <span style={{ fontWeight: 600 }}>{labels.screenshotTitle(draft.items.length)}</span>
      </div>
      {draft.capture?.dataUrl ? <img src={draft.capture.dataUrl} alt="" style={screenshotPreviewStyle} /> : null}
      {draft.items.length ? (
        <ol style={screenshotListStyle}>
          {draft.items.map((item) => (
            <li key={item.id} style={screenshotListItemStyle}>
              <span style={listNumberStyle}>{item.label}</span>
              <span style={listCommentStyle}>{item.comment}</span>
              <button type="button" aria-label="Remove" style={inlineDeleteStyle} onClick={() => onRemoveItem(item.id!)}><TrashIcon /></button>
            </li>
          ))}
        </ol>
      ) : null}
      <textarea
        placeholder={labels.screenshotCommentPlaceholder}
        value={comment}
        onChange={(event) => onCommentChange(event.target.value)}
        style={overlayTextareaStyle}
      />
    </>
  )
}

/** Pinned footer of the screenshot batch card (retake / add comment / send batch). */
function ScreenshotBatchFooter({ draft, comment, submitting, labels, onAddComment, onRetake, onSend }: Pick<ScreenshotBatchCardProps, "draft" | "comment" | "submitting" | "labels" | "onAddComment" | "onRetake" | "onSend">) {
  return (
    <div style={cardFooterStyle}>
      <button type="button" onClick={onRetake} style={secondaryButtonStyle}>
        <RetakeIcon />
        {labels.retake}
      </button>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={!comment.trim()} onClick={onAddComment} style={disabledButtonStyle(ghostButtonStyle, !comment.trim())}>{labels.addComment}</button>
        <button type="button" disabled={submitting || draft.items.length === 0} onClick={onSend} style={disabledButtonStyle(primaryButtonStyle, submitting || draft.items.length === 0)}>
          <SendIcon />
          {submitting ? "…" : labels.sendBatch(draft.items.length)}
        </button>
      </div>
    </div>
  )
}

// Two ORTHOGONAL concerns, deliberately NOT one flag (they diverge on a narrow desktop window):
//  • TOUCH INPUT — the primary pointer is coarse with no hover, so there's no hardware keyboard/Esc
//    to rely on. Drives Enter-to-send suppression, the Esc-vs-tap exit label, and touch-scroll locks.
//    Never width-based: a narrow desktop window still has a keyboard.
//  • CRAMPED LAYOUT — the comment card should use the bottom sheet instead of the fixed-width popover:
//    a touch device OR a viewport too narrow (≤640px) for the 340px popover (which would clip
//    off-screen). Layout-only — it must NOT gate keyboard affordances.
const TOUCH_INPUT_QUERY = "(hover: none) and (pointer: coarse)"
const CRAMPED_LAYOUT_QUERY = `${TOUCH_INPUT_QUERY}, (max-width: 640px)`

/** Touch-primary input (coarse pointer, no hover); incl. iPad+keyboard, without UA sniffing. */
function useTouchInput() {
  return useMediaQuery(TOUCH_INPUT_QUERY)
}

/** Use the bottom-sheet layout: touch device OR a viewport too narrow for the popover (#534). */
function useCrampedLayout() {
  return useMediaQuery(CRAMPED_LAYOUT_QUERY)
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = React.useState(() => matchMediaQuery(query))
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [query])
  return matches
}

function matchMediaQuery(query: string) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia(query).matches
}

/**
 * Lock page scrolling (body/html `overflow: hidden` + `overscroll-behavior: contain`) while `active`,
 * restoring the prior inline values on release. When `touchGuardSelector` is given, also cancel touch
 * scrolling that originates inside a matching element (the screenshot drag surface) so a drag draws
 * instead of scrolling — scoped, so a portaled card elsewhere stays scrollable (#242). Never sets
 * `touch-action` on <body> for the same reason. Used for both the screenshot-framing lock (touch-only)
 * and the smart comment-card lock (all input types); the gating lives at each call site.
 */
function usePageScrollLock(active: boolean, touchGuardSelector?: string) {
  React.useEffect(() => {
    if (!active || typeof document === "undefined") return
    const body = document.body
    const html = document.documentElement
    const previous = {
      bodyOverflow: body.style.overflow,
      bodyOverscroll: body.style.overscrollBehavior,
      bodyPaddingRight: body.style.paddingRight,
      htmlOverflow: html.style.overflow
    }
    // Compensate the vertical scrollbar width with body padding BEFORE hiding overflow: removing a
    // classic (non-overlay) scrollbar would otherwise shrink the content box and reflow the page,
    // drifting the viewport-anchored marker/card off the just-selected element (#720). Overlay
    // scrollbars report 0 width → no padding added (no-op, e.g. the touch screenshot path).
    const scrollbarWidth = window.innerWidth - html.clientWidth
    if (scrollbarWidth > 0) {
      const currentPaddingRight = parseFloat(window.getComputedStyle(body).paddingRight) || 0
      body.style.paddingRight = `${currentPaddingRight + scrollbarWidth}px`
    }
    body.style.overflow = "hidden"
    body.style.overscrollBehavior = "contain"
    html.style.overflow = "hidden"
    let blockTouchScroll: ((event: TouchEvent) => void) | undefined
    if (touchGuardSelector) {
      blockTouchScroll = (event: TouchEvent) => {
        if (event.target instanceof Element && event.target.closest(touchGuardSelector)) {
          event.preventDefault()
        }
      }
      document.addEventListener("touchmove", blockTouchScroll, { passive: false })
    }
    return () => {
      body.style.overflow = previous.bodyOverflow
      body.style.overscrollBehavior = previous.bodyOverscroll
      body.style.paddingRight = previous.bodyPaddingRight
      html.style.overflow = previous.htmlOverflow
      if (blockTouchScroll) document.removeEventListener("touchmove", blockTouchScroll)
    }
  }, [active, touchGuardSelector])
}

export function AgentMarkLayer(props: AgentMarkLayerProps) {
  // A custom `renderMark` keeps the original simple layer (backward compatible). The default path is
  // the Phase 2 conversation lifecycle: unread violet dot → answer bubble → read-retire + aggregate badge.
  if (props.renderMark) return <LegacyAgentMarkLayer {...props} renderMark={props.renderMark} />
  return (
    <AgentMarkConversation
      events={props.events}
      scope={props.scope}
      className={props.className}
      canAnnotate={props.canAnnotate}
      host={props.host ?? "standalone"}
    />
  )
}

function LegacyAgentMarkLayer({ events, scope, className, renderMark }: AgentMarkLayerProps & { renderMark: NonNullable<AgentMarkLayerProps["renderMark"]> }) {
  const context = React.useContext(ShowSessionContext)
  const sourceEvents = events ?? context?.events ?? []
  const tick = useViewportTick()
  const marks = React.useMemo(() => {
    void tick
    if (typeof document === "undefined") return []
    // Shape-tolerant + null-safe like the default path: read the mark via agentMarkOf (event.mark OR
    // the on-wire payload) and resolve anchors through resolveAgentMarkAnchor (R5).
    const latestByMark = new Map<string, { event: AssistantMarkLayerEvent; mark: AgentMark }>()
    for (const event of sourceEvents) {
      if (!event.type.startsWith("assistant.mark.")) continue
      const mark = agentMarkOf(event)
      if (!mark) continue
      if (scope && markAttributeName(mark.scope) !== markAttributeName(scope)) continue
      latestByMark.set(`${mark.scope}:${mark.id}`, { event: event as AssistantMarkLayerEvent, mark })
    }
    return Array.from(latestByMark.values())
      .map(({ event, mark }) => {
        const anchor = resolveAgentMarkAnchor(event, sourceEvents)
        const resolved = anchor ? resolveAnchor(anchor, document) : undefined
        if (!resolved?.rect) return undefined
        return { event, rect: resolved.rect, hidden: event.type === "assistant.mark.resolved" || mark.status === "resolved" }
      })
      .filter((item): item is { event: AssistantMarkLayerEvent; rect: MarkAnchorRect; hidden: boolean } => item !== undefined && !item.hidden)
  }, [scope, sourceEvents, tick])

  if (typeof document === "undefined" || marks.length === 0) return null
  return createPortal(
    <div className={className} data-show-agent-mark-layer="" style={layerStyle}>
      {marks.map(({ event, rect }) => (
        // Hand the custom renderer a canonical mark-shaped event so renderers reading event.mark don't
        // throw on a payload-shaped live event (#282).
        <React.Fragment key={event.id}>{renderMark(normalizeAgentMarkEvent(event), rect)}</React.Fragment>
      ))}
    </div>,
    document.body
  )
}

// ── Phase 2 agent reverse-mark conversation lifecycle ───────────────────────────────────

type MarkCandidate = {
  readKey: string
  kind: "reply" | "note" | "attribute-note"
  body: string
  targetLabel: string
  createdAt: string
  anchor: ShowAnchor | undefined
  /** Read on a prior load (event-backed resolve, or a persisted read token) ⇒ not rendered unless re-read this view. */
  retiredAtLoad: boolean
  event?: ReducedAgentMark["event"]
  /** Normalized mark (shape-agnostic: event.mark ?? on-wire payload) for the read-receipt POST. */
  mark?: ReducedAgentMark["mark"]
}
type ResolvedMarkCandidate = MarkCandidate & { rect?: MarkAnchorRect; element?: Element; anchored: boolean; read: boolean }
type AttributeNoteMark = { anchor: ShowAnchor; text: string }

/** Scan the page for declarative `agent-note="<text>"` elements, re-scanning on DOM mutation (mirrors
 *  useMarkRegistry). One descriptor per element: its anchor + the note text. */
function useAttributeNoteMarks(scope?: string): AttributeNoteMark[] {
  const [version, setVersion] = React.useState(0)
  React.useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return
    const observer = new MutationObserver(() => setVersion((value) => value + 1))
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: [AGENT_NOTE_ATTRIBUTE] })
    return () => observer.disconnect()
  }, [])
  return React.useMemo(() => {
    void version
    if (typeof document === "undefined") return []
    const notes: AttributeNoteMark[] = []
    for (const element of Array.from(document.querySelectorAll(`[${AGENT_NOTE_ATTRIBUTE}]`))) {
      const text = (element.getAttribute(AGENT_NOTE_ATTRIBUTE) ?? "").trim()
      if (!text) continue
      notes.push({ anchor: collectElementContext(element, { scope }), text })
    }
    return notes
  }, [scope, version])
}

function AgentMarkConversation({ events, scope, className, canAnnotate, host }: {
  events?: ShowEvent[]
  scope?: string
  className?: string
  canAnnotate?: boolean
  host: AnnotationHost
}) {
  const context = React.useContext(ShowSessionContext)
  const sourceEvents = events ?? context?.events ?? []
  const sessionId = context?.config.sessionId
  // Gate the read-receipt POST on an ACTUAL write token, resolved the SAME way submitShowEvent does —
  // the provider token OR the injected `__AVIBE_SHOW__.writeToken` runtime fallback (#276) — not the
  // `available`/authenticated hint (true before the /__show/me probe populates a token, #572). No
  // token ⇒ localStorage path (durable on this device); when a token exists, reads POST cross-device.
  // `canAnnotate === false` is an explicit anonymous opt-out.
  const writeToken = context?.config.writeToken ?? readRuntimeConfig().writeToken
  const canPost = canAnnotate !== false && Boolean(writeToken)
  const tick = useViewportTick()
  const attributeNotes = useAttributeNoteMarks(scope)
  const storage = React.useMemo(() => safeLocalStorage(), [])
  const readTokensAtLoad = React.useMemo(() => loadReadTokens(sessionId, storage), [sessionId, storage])
  const [readInView, setReadInView] = React.useState<ReadonlySet<string>>(() => new Set())
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null)
  const [listOpen, setListOpen] = React.useState(false)
  const [flashKey, setFlashKey] = React.useState<string | null>(null)
  const flashTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

  const candidates = React.useMemo<MarkCandidate[]>(() => {
    const list: MarkCandidate[] = []
    for (const reduced of reduceAgentMarkEvents(sourceEvents, scope)) {
      // VERSIONED read key (identity + a TRUE version: the winning mark id, else its createdAt): the
      // anonymous-viewer localStorage read path must hide only the exact version read, so an agent
      // re-mark (new mark id, even same body) shows again as unread rather than inheriting the prior
      // read token (#67/#288). The logged-in path is event-backed via resolvedByEvent (newest-wins).
      // Read mark fields from the shape-agnostic reduced.mark (event.mark OR the on-wire payload) — never
      // reduced.event.mark, which is undefined for the live backend's payload-shaped events (R5).
      const readKey = `${reduced.identity}#${reduced.mark.id || reduced.createdAt}`
      list.push({
        readKey,
        kind: reduced.kind,
        body: reduced.mark.body,
        targetLabel: reduced.mark.target || (reduced.kind === "reply" ? "回应" : "标注"),
        createdAt: reduced.createdAt,
        // Canonical anchor resolution (event anchor → reply's referenced annotation anchor → target via
        // targetToAnchor, which handles the SDK mark-id form and selectors) — no hand-rolled selector (#257/#283).
        anchor: resolveAgentMarkAnchor(reduced.event, sourceEvents),
        // event-backed read (cross-device) OR an anonymous viewer's persisted (versioned) localStorage read.
        retiredAtLoad: reduced.resolvedByEvent || readTokensAtLoad.has(readKey),
        event: reduced.event,
        mark: reduced.mark
      })
    }
    for (const note of attributeNotes) {
      const anchorId = note.anchor.mark ?? note.anchor.selector ?? note.anchor.textQuote ?? note.text
      const token = attributeNoteReadToken(scope ?? note.anchor.scope, anchorId, note.text)
      list.push({
        readKey: token,
        kind: "attribute-note",
        body: note.text,
        targetLabel: note.anchor.label ?? anchorId,
        createdAt: "",
        anchor: note.anchor,
        retiredAtLoad: readTokensAtLoad.has(token)
      })
    }
    // Newest event marks first; attribute notes (no timestamp) sort last, keeping DOM order.
    return list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
  }, [sourceEvents, scope, attributeNotes, readTokensAtLoad])

  const resolved = React.useMemo<ResolvedMarkCandidate[]>(() => {
    void tick
    if (typeof document === "undefined") return []
    return candidates
      .map((candidate) => {
        const anchorResult = candidate.anchor ? resolveAnchor(candidate.anchor, document) : undefined
        // Trust any resolution except `missing` — incl. area/screenshot region rects with no element
        // (a reply to a human area selection, #72). Only `missing` (stale fallback rect) is routed to
        // the badge list, and its stale rect is dropped so the bubble never opens at a guessed position
        // (#69). Never guess-pin (spec rule 4 / D6).
        const anchored = anchorResult ? isMarkAnchored(anchorResult.confidence, Boolean(anchorResult.rect)) : false
        return { ...candidate, rect: anchored ? anchorResult?.rect : undefined, element: anchorResult?.element, anchored, read: readInView.has(candidate.readKey) }
      })
      // Retired on a fresh load and not re-read this view ⇒ gone (created − resolved on replay).
      .filter((candidate) => !candidate.retiredAtLoad || candidate.read)
  }, [candidates, readInView, tick])

  const partition = React.useMemo(() => partitionAgentMarks(resolved, 5), [resolved])
  const rendered = React.useMemo(
    () => [...partition.inlineUnread, ...partition.inlineRead, ...partition.overflow, ...partition.failed],
    [partition]
  )

  const markRead = React.useCallback((candidate: ResolvedMarkCandidate) => {
    if (readInView.has(candidate.readKey)) return
    setReadInView((prev) => reconcileReadReceipt(prev, candidate.readKey, "read"))
    if (candidate.kind === "attribute-note" || !canPost) {
      // Declarative note (no event identity) or anonymous viewer (cannot POST) ⇒ localStorage only.
      writeReadToken(sessionId, storage, candidate.readKey)
    } else if (candidate.mark) {
      // Read receipt: event-backed, cross-device. Author is stamped server-side (the reading user).
      // Empty message content ⇒ metadata-only: the runtime's recordShowEvent skips empty content, so
      // opening a bubble never re-appends the answer to chat history (#61). The bubble reads the mark
      // body directly, so the answer is still shown. Uses the normalized mark (shape-agnostic, R5).
      const submit = context?.submitEvent({
        type: "assistant.mark.resolved",
        mark: candidate.mark,
        anchor: candidate.event?.anchor,
        message: { role: "assistant", content: "" }
      })
      // Optimistic read-state is only durable once the backend ACCEPTS the receipt. If the POST fails
      // (non-2xx — e.g. `mark_version_conflict`), ROLL BACK to unread so the badge is honest and the user
      // can retry; never persist a read-state the backend rejected (cross-device divergence otherwise).
      void submit?.catch(() => setReadInView((prev) => reconcileReadReceipt(prev, candidate.readKey, "rollback")))
    }
  }, [readInView, canPost, sessionId, storage, context])

  const openMark = React.useCallback((candidate: ResolvedMarkCandidate) => {
    setExpandedKey(candidate.readKey)
    markRead(candidate)
  }, [markRead])

  const openFromList = React.useCallback((candidate: ResolvedMarkCandidate) => {
    if (candidate.element && typeof candidate.element.scrollIntoView === "function") {
      try { candidate.element.scrollIntoView({ behavior: "smooth", block: "center" }) } catch { /* older browsers */ }
      setFlashKey(candidate.readKey)
      if (flashTimer.current) clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setFlashKey(null), 1200)
    }
    openMark(candidate)
  }, [openMark])

  if (typeof document === "undefined" || rendered.length === 0) return null
  const expanded = rendered.find((candidate) => candidate.readKey === expandedKey) ?? null
  const flashed = flashKey ? rendered.find((candidate) => candidate.readKey === flashKey && candidate.rect) : undefined
  return createPortal(
    <div className={className} data-show-agent-mark-layer="" style={layerStyle}>
      {partition.inlineUnread.map((candidate) =>
        candidate.rect ? <MarkDot key={candidate.readKey} rect={candidate.rect} read={false} onClick={() => openMark(candidate)} /> : null
      )}
      {partition.inlineRead.map((candidate) =>
        candidate.rect ? <MarkDot key={candidate.readKey} rect={candidate.rect} read onClick={() => openMark(candidate)} /> : null
      )}
      {flashed?.rect ? <AnnotationMarker rect={flashed.rect} tone="assistant" variant="selected" /> : null}
      {partition.showBadge ? <MarkBadge count={partition.unreadCount} host={host} sessionId={sessionId} onClick={() => setListOpen((value) => !value)} /> : null}
      {listOpen ? <MarkList marks={rendered} host={host} onOpen={openFromList} onClose={() => setListOpen(false)} /> : null}
      {expanded ? <MarkBubble mark={expanded} onClose={() => setExpandedKey(null)} /> : null}
    </div>,
    document.body
  )
}

function MarkDot({ rect, read, onClick }: { rect: MarkAnchorRect; read: boolean; onClick: () => void }) {
  const size = read ? 12 : 16
  return (
    <button
      type="button"
      data-show-annotation-ui=""
      aria-label="Agent 标注"
      onClick={onClick}
      style={{
        position: "fixed",
        left: rect.x + rect.width - size / 2,
        top: rect.y - size / 2,
        width: size,
        height: size,
        padding: 0,
        borderRadius: 999,
        cursor: "pointer",
        boxSizing: "border-box",
        border: `2px solid ${COLORS.surface}`,
        background: read ? COLORS.resolved : COLORS.agent,
        boxShadow: read ? "none" : `0 0 0 4px ${COLORS.agent}33, 0 4px 14px ${COLORS.agent}55`,
        pointerEvents: "auto",
        zIndex: MARKER_Z,
        transition: "background 160ms ease, box-shadow 160ms ease, width 160ms ease, height 160ms ease"
      }}
    />
  )
}

function MarkBubble({ mark, onClose }: { mark: ResolvedMarkCandidate; onClose: () => void }) {
  const width = 300
  const rect = mark.rect
  const left = rect ? Math.min(window.innerWidth - width - 12, Math.max(12, rect.x)) : Math.max(12, (window.innerWidth - width) / 2)
  const top = rect ? Math.min(window.innerHeight - 180, Math.max(12, rect.y + rect.height + 12)) : Math.max(12, window.innerHeight / 2 - 90)
  // Cap the fixed bubble to the space below its top edge and scroll the body, so a long agent answer
  // is never cut off past the viewport (the bubble is position:fixed, so page scroll can't reach it) (#576).
  const maxHeight = Math.max(140, window.innerHeight - top - 16)
  return (
    <div data-show-annotation-ui="" role="dialog" onClick={(event) => event.stopPropagation()} style={{ ...markBubbleShellStyle, left, top, width, maxHeight, display: "flex", flexDirection: "column" }}>
      <div style={{ ...markBubbleHeaderStyle, flex: "0 0 auto" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={markBubbleAuthorDotStyle} />
          <strong style={{ color: COLORS.textPrimary, font: `600 13px/1 ${FONT_STACK}` }}>Agent</strong>
          {mark.createdAt ? <span style={{ color: COLORS.textMuted, font: `400 12px/1 ${FONT_STACK}` }}>{formatRelativeTime(mark.createdAt)}</span> : null}
        </span>
        <button type="button" aria-label="Close" onClick={onClose} style={markBubbleCloseStyle}>×</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", color: COLORS.textPrimary, font: `400 13px/1.5 ${FONT_STACK}`, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {mark.body}
        {!mark.anchored ? <div style={{ marginTop: 8, color: COLORS.textMuted, font: `400 12px/1.4 ${FONT_STACK}` }}>原位置已更新</div> : null}
      </div>
    </div>
  )
}

function MarkBadge({ count, host, sessionId, onClick }: { count: number; host: AnnotationHost; sessionId?: string; onClick: () => void }) {
  const drag = useDraggable("badge", sessionId, 48) // badge is 48px tall
  return (
    <button
      type="button"
      data-show-annotation-ui=""
      aria-label={`${count} 条 Agent 标注待读`}
      {...drag.pointerHandlers}
      onClick={() => {
        if (drag.consumeDragClick()) return // a drag, not a tap — don't open the list
        onClick()
      }}
      // Default bottom-right (clear of the bottom-center pill); a saved/dragged position overrides it.
      style={{ ...markBadgeBaseStyle, bottom: host === "embedded" ? 26 : 92, ...drag.style }}
    >
      <BotIcon />
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{count}</span>
    </button>
  )
}

function MarkList({ marks, host, onOpen, onClose }: { marks: ResolvedMarkCandidate[]; host: AnnotationHost; onOpen: (mark: ResolvedMarkCandidate) => void; onClose: () => void }) {
  return (
    <div
      data-show-annotation-ui=""
      role="dialog"
      onClick={(event) => event.stopPropagation()}
      style={{ ...markBubbleShellStyle, right: 20, bottom: host === "embedded" ? 72 : 140, width: 320, maxHeight: "60vh", overflowY: "auto" }}
    >
      <div style={markBubbleHeaderStyle}>
        <strong style={{ color: COLORS.textPrimary, font: `600 13px/1 ${FONT_STACK}` }}>Agent 标注</strong>
        <button type="button" aria-label="Close" onClick={onClose} style={markBubbleCloseStyle}>×</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {marks.map((mark) => (
          <button key={mark.readKey} type="button" onClick={() => onOpen(mark)} style={markListRowStyle}>
            <span style={{ ...markListKindDotStyle, background: mark.read ? COLORS.resolved : COLORS.agent }} />
            <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
              <span style={markListTargetStyle}>{mark.anchored ? mark.targetLabel : "原位置已更新"}</span>
              <span style={markListBodyStyle}>{mark.body}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const minutes = Math.floor((Date.now() - then) / 60000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function loadReadTokens(sessionId: string | undefined, storage: AnnotationModeStorage | undefined): Set<string> {
  if (!storage) return new Set()
  try {
    const raw = storage.getItem(agentMarkReadStorageKey(sessionId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((token): token is string => typeof token === "string")) : new Set()
  } catch {
    return new Set()
  }
}

function writeReadToken(sessionId: string | undefined, storage: AnnotationModeStorage | undefined, token: string): void {
  if (!storage) return
  try {
    const tokens = loadReadTokens(sessionId, storage)
    if (tokens.has(token)) return
    tokens.add(token)
    storage.setItem(agentMarkReadStorageKey(sessionId), JSON.stringify(Array.from(tokens)))
  } catch {
    // Best-effort: storage may be unavailable or full. Losing read state must never break rendering.
  }
}

export function AnnotationMarker({ rect, tone = "human", variant = "selected", label, badge, children }: AnnotationMarkerProps) {
  const accent = tone === "assistant" ? COLORS.agent : tone === "resolved" ? COLORS.resolved : COLORS.human
  const hover = variant === "hover"
  return (
    <div
      data-show-annotation-ui=""
      style={{
        position: "fixed",
        left: rect.x,
        top: rect.y,
        width: Math.max(rect.width, 12),
        height: Math.max(rect.height, 12),
        border: `${hover ? 1.5 : 2}px ${hover ? "dashed" : "solid"} ${accent}`,
        background: `${accent}14`,
        borderRadius: 10,
        pointerEvents: "none",
        zIndex: MARKER_Z,
        boxSizing: "border-box",
        boxShadow: variant === "selected" ? `0 0 0 4px ${accent}22, 0 8px 28px ${accent}33` : "none"
      }}
    >
      {label ? (
        <span style={{ ...anchorChipStyle, ...markerChipStyle, borderColor: accent, color: accent }}>
          <AnchorIcon />
          <span style={anchorChipTextStyle}>{label}</span>
        </span>
      ) : null}
      {badge !== undefined && badge !== null ? (
        <span
          style={{
            position: "absolute",
            top: -12,
            right: -12,
            minWidth: 24,
            height: 24,
            padding: "0 6px",
            borderRadius: 999,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 3,
            font: `600 12px/1 ${FONT_STACK}`,
            color: COLORS.onAccent,
            background: accent,
            border: `2px solid ${COLORS.surface}`,
            boxShadow: `0 4px 14px ${accent}55`
          }}
        >
          {badge}
        </span>
      ) : null}
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

// ── Light styles for the agent-authored page components (IntentForm/ChoiceGroup/AgentMarkForm).
//    These render inside the page and must NOT adopt the overlay's fixed-dark chrome. ──────────

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

// ── Overlay design system (self-contained; fixed dark, mint/violet accents; no @avibe/show-ui). ──

/** Overlay palette (design refs): dark chrome, mint human accent, violet agent accent. */
const COLORS = {
  surface: "#11111C",
  surfacePopover: "rgba(17, 17, 28, 0.95)",
  surfaceRaised: "rgba(255, 255, 255, 0.05)",
  human: "#5BFFA0",
  agent: "#7C5BFF",
  resolved: "rgba(245, 246, 250, 0.35)",
  danger: "#FF6B6B",
  warn: "#FFC857",
  onAccent: "#080812",
  textPrimary: "#F5F6FA",
  textMuted: "rgba(245, 246, 250, 0.58)",
  border: "rgba(245, 246, 250, 0.12)",
  borderStrong: "rgba(245, 246, 250, 0.2)"
} as const

const FONT_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const COMMENT_CARD_WIDTH = 340
// The screenshot batch card carries a THREE-button footer (retake / add / send) + a numbered comment
// list, so its desktop popover is wider than the single-action smart card (design frames ≥ 420px). On
// narrow/touch viewports both fall back to the same full-width bottom sheet (CommentSurface `cramped`).
const SCREENSHOT_CARD_WIDTH = 440

// z-index bands, all near the top of the 32-bit range so the overlay sits above host page chrome.
const CAPTURE_Z = 2147482500
const AGENT_LAYER_Z = 2147482900
const MARKER_Z = 2147483000
const CHROME_Z = 2147483200
const CARD_Z = 2147483300
const TOAST_Z = 2147483400

const cardBaseStyle: React.CSSProperties = {
  // Flex column so the body scrolls and the footer (send row) stays pinned within the capped height.
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 14,
  color: COLORS.textPrimary,
  background: COLORS.surfacePopover,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 16,
  boxShadow: "0 24px 70px rgba(4, 4, 10, 0.55)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  font: `13px/1.5 ${FONT_STACK}`
}

const popoverStyle: React.CSSProperties = {
  ...cardBaseStyle,
  position: "fixed",
  width: COMMENT_CARD_WIDTH,
  maxWidth: "calc(100vw - 24px)",
  maxHeight: "70vh",
  overflow: "hidden",
  zIndex: CARD_Z
}

const sheetStyle: React.CSSProperties = {
  ...cardBaseStyle,
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  width: "100%",
  maxHeight: "85vh",
  overflow: "hidden",
  paddingTop: 20,
  paddingBottom: "max(20px, env(safe-area-inset-bottom))",
  borderRadius: "20px 20px 0 0",
  zIndex: CARD_Z
}

// Scrollable middle of the comment card; the pinned footer sits below it.
const commentBodyStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  flex: "1 1 auto",
  minHeight: 0,
  overflowY: "auto",
  overflowX: "hidden"
}

const commentFooterStyle: React.CSSProperties = {
  flex: "0 0 auto"
}

const sheetHandleStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: "50%",
  transform: "translateX(-50%)",
  width: 40,
  height: 4,
  borderRadius: 999,
  background: COLORS.borderStrong
}

const closeButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: 10,
  right: 10,
  width: 26,
  height: 26,
  border: 0,
  borderRadius: 999,
  color: COLORS.textMuted,
  background: COLORS.surfaceRaised,
  cursor: "pointer",
  font: `16px/1 ${FONT_STACK}`
}

const overlayTextareaStyle: React.CSSProperties = {
  minHeight: 84,
  resize: "vertical",
  color: COLORS.textPrimary,
  background: "rgba(0, 0, 0, 0.25)",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 12,
  padding: "10px 12px",
  font: `13px/1.5 ${FONT_STACK}`,
  outline: "none",
  boxSizing: "border-box",
  width: "100%"
}

const cardFooterStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8
}

const footerHintStyle: React.CSSProperties = {
  color: COLORS.textMuted,
  fontSize: 12
}

const overlayErrorStyle: React.CSSProperties = {
  margin: 0,
  color: COLORS.danger,
  fontSize: 12
}

const overlayButtonBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  minHeight: 40,
  padding: "0 16px",
  border: `1px solid transparent`,
  borderRadius: 12,
  font: `600 13px/1 ${FONT_STACK}`,
  cursor: "pointer",
  // Footer labels ("重新截图" / "添加评论" / "发送 N 条评论") must stay on ONE line — wrapping them was the
  // owner-reported symptom on the narrow screenshot card. Widening the card gives them room to sit inline.
  whiteSpace: "nowrap"
}

/**
 * Overlay buttons use inline styles (no stylesheet for `:disabled`), so the DISABLED look must be applied
 * explicitly. A disabled action reads as clearly dimmed/gray — never the bright mint of an enabled send
 * (owner feedback: "发送 0 条评论" looked enabled). Returns the base unchanged when enabled (same ref).
 */
export function disabledButtonStyle(base: React.CSSProperties, disabled: boolean): React.CSSProperties {
  if (!disabled) return base
  return {
    ...base,
    color: COLORS.textMuted,
    background: COLORS.surfaceRaised,
    borderColor: COLORS.border,
    boxShadow: "none",
    cursor: "not-allowed"
  }
}

const primaryButtonStyle: React.CSSProperties = {
  ...overlayButtonBase,
  color: COLORS.onAccent,
  background: COLORS.human,
  boxShadow: `0 8px 24px ${COLORS.human}44`
}

const secondaryButtonStyle: React.CSSProperties = {
  ...overlayButtonBase,
  color: COLORS.textPrimary,
  background: COLORS.surfaceRaised,
  borderColor: COLORS.border
}

const ghostButtonStyle: React.CSSProperties = {
  ...overlayButtonBase,
  color: COLORS.textPrimary,
  background: "transparent",
  borderColor: COLORS.border
}

// Minimal opt-in to add a note on the approve fast path — a quiet text affordance, not a full control.
const addNoteButtonStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  padding: "2px 0",
  border: "none",
  background: "transparent",
  color: COLORS.textMuted,
  font: `500 12px/1 ${FONT_STACK}`,
  cursor: "pointer"
}

// Intent chips (评论/修改/疑问/批准).
const intentChipsStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6
}

const intentChipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  minHeight: 30,
  padding: "0 10px",
  borderRadius: 999,
  color: COLORS.textMuted,
  background: "transparent",
  border: `1px solid ${COLORS.border}`,
  font: `500 12px/1 ${FONT_STACK}`,
  cursor: "pointer"
}

const intentChipActiveStyle: React.CSSProperties = {
  ...intentChipStyle,
  color: COLORS.human,
  background: `${COLORS.human}1f`,
  borderColor: `${COLORS.human}66`
}

// Ambiguity toggle (by elements / by area).
const toggleRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 6
}

const toggleButtonStyle: React.CSSProperties = {
  minHeight: 32,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 10,
  background: "transparent",
  color: COLORS.textMuted,
  font: `500 12px/1 ${FONT_STACK}`,
  cursor: "pointer"
}

const toggleActiveStyle: React.CSSProperties = {
  ...toggleButtonStyle,
  color: COLORS.human,
  background: `${COLORS.human}1f`,
  borderColor: `${COLORS.human}66`
}

// Anchor chip ("⧉ Card · Open blockers").
const anchorChipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  maxWidth: "100%",
  padding: "4px 9px",
  borderRadius: 8,
  color: COLORS.human,
  background: `${COLORS.human}1a`,
  border: `1px solid ${COLORS.human}55`,
  font: `600 12px/1.2 ${FONT_STACK}`,
  boxSizing: "border-box",
  // Clip the label so a long anchor never widens the card (§4).
  overflow: "hidden"
}

const anchorChipTextStyle: React.CSSProperties = {
  // `minWidth: 0` lets this flex child shrink so the ellipsis actually engages inside the chip.
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
}

// Anchor chip variant floating above a marker box.
const markerChipStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: -30,
  maxWidth: 260,
  background: COLORS.surface,
  pointerEvents: "none"
}

// Standalone FAB (collapsed).
const fabStyle: React.CSSProperties = {
  position: "fixed",
  right: 26,
  bottom: 26,
  zIndex: CHROME_Z,
  width: 52,
  height: 52,
  display: "grid",
  placeItems: "center",
  borderRadius: 16,
  color: COLORS.human,
  background: COLORS.surfacePopover,
  border: `1px solid ${COLORS.border}`,
  // Softer, less down-biased than the card shadow so it renders fully near the viewport bottom edge
  // rather than being clipped in half (owner mobile report).
  boxShadow: "0 8px 28px rgba(4, 4, 10, 0.5)",
  cursor: "pointer",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)"
}

// Standalone pill toolbar (expanded).
const toolbarStyle: React.CSSProperties = {
  position: "fixed",
  right: 26,
  bottom: 26,
  zIndex: CHROME_Z,
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: 5,
  borderRadius: 999,
  color: COLORS.textPrimary,
  background: COLORS.surfacePopover,
  border: `1px solid ${COLORS.border}`,
  boxShadow: "0 8px 28px rgba(4, 4, 10, 0.5)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)"
}

const toolbarIndicatorStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  display: "grid",
  placeItems: "center",
  borderRadius: 999,
  border: 0,
  color: COLORS.onAccent,
  background: COLORS.human,
  cursor: "pointer"
}

const modeTabStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  minHeight: 32,
  padding: "0 12px",
  borderRadius: 999,
  border: 0,
  color: COLORS.textMuted,
  background: "transparent",
  font: `600 13px/1 ${FONT_STACK}`,
  cursor: "pointer"
}

const modeTabActiveStyle: React.CSSProperties = {
  ...modeTabStyle,
  color: COLORS.human,
  background: `${COLORS.human}1f`
}

const toolbarExitStyle: React.CSSProperties = {
  minHeight: 32,
  padding: "0 10px",
  borderRadius: 999,
  border: 0,
  color: COLORS.textMuted,
  background: "transparent",
  font: `500 12px/1 ${FONT_STACK}`,
  cursor: "pointer"
}

// Subtle trailing '?' / '✕' glyph buttons on the expanded toolbar (muted, consistent with the chrome).
const toolbarGlyphButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  display: "grid",
  placeItems: "center",
  borderRadius: 999,
  border: 0,
  color: COLORS.textMuted,
  background: "transparent",
  font: `600 13px/1 ${FONT_STACK}`,
  cursor: "pointer"
}

const toolbarHelpTipStyle: React.CSSProperties = {
  position: "absolute",
  bottom: "calc(100% + 10px)",
  right: 0,
  maxWidth: 240,
  padding: "8px 10px",
  borderRadius: 10,
  background: COLORS.surfacePopover,
  border: `1px solid ${COLORS.border}`,
  color: COLORS.textPrimary,
  font: `500 12px/1.4 ${FONT_STACK}`,
  boxShadow: "0 12px 32px rgba(4, 4, 10, 0.5)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  zIndex: CARD_Z,
  pointerEvents: "none"
}

const toastStyle: React.CSSProperties = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 88,
  margin: "0 auto",
  width: "fit-content",
  maxWidth: "calc(100vw - 24px)",
  padding: "10px 16px",
  borderRadius: 999,
  background: COLORS.surfacePopover,
  border: `1px solid ${COLORS.border}`,
  color: COLORS.textPrimary,
  font: `500 13px/1.4 ${FONT_STACK}`,
  boxShadow: "0 16px 44px rgba(4, 4, 10, 0.55)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  zIndex: CARD_Z,
  textAlign: "center"
}

// Violet agent-mark badge — soft violet glow, tabular count, sized/weighted to match the FAB family.
const markBadgeBaseStyle: React.CSSProperties = {
  position: "fixed",
  right: 20,
  minWidth: 48,
  height: 48,
  padding: "0 14px",
  borderRadius: 999,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  cursor: "pointer",
  border: "1px solid rgba(124, 91, 255, 0.5)",
  background: COLORS.agent,
  color: COLORS.onAccent,
  font: `700 15px/1 ${FONT_STACK}`,
  // Soft violet glow: a low-offset drop + a faint ring, so it reads as a glow and isn't clipped at the
  // viewport bottom edge (matches the FAB shadow treatment).
  boxShadow: "0 6px 24px rgba(124, 91, 255, 0.42), 0 0 0 3px rgba(124, 91, 255, 0.14)",
  pointerEvents: "auto",
  zIndex: CHROME_Z
}

// Embedded mode pill (bottom-center status indicator).
const modePillStyle: React.CSSProperties = {
  position: "fixed",
  // Center via full-viewport containing block + auto margins, NOT `left:50%`: a fixed element at
  // left:50% with no width caps its shrink-to-fit available width at ~50vw, which forced the pill to
  // wrap to two lines on phones. left:0/right:0 + margin auto + fit-content lets it size to its content
  // (capped by maxWidth) and stay centered. `nowrap` keeps it on ONE line always (owner iPhone report).
  left: 0,
  right: 0,
  bottom: 20,
  margin: "0 auto",
  width: "fit-content",
  maxWidth: "calc(100vw - 24px)",
  zIndex: CHROME_Z,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 14px",
  borderRadius: 999,
  color: COLORS.textPrimary,
  background: COLORS.surfacePopover,
  border: `1px solid ${COLORS.border}`,
  boxShadow: "0 16px 44px rgba(4, 4, 10, 0.55)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  font: `600 13px/1 ${FONT_STACK}`,
  whiteSpace: "nowrap"
}

const modePillDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  flexShrink: 0
}

const modePillLabelStyle: React.CSSProperties = {
  color: COLORS.textPrimary,
  whiteSpace: "nowrap"
}

const modePillExitStyle: React.CSSProperties = {
  border: 0,
  borderRadius: 999,
  padding: "6px 12px",
  minHeight: 32,
  color: COLORS.textMuted,
  background: COLORS.surfaceRaised,
  fontWeight: 500,
  fontSize: 12,
  cursor: "pointer",
  fontFamily: FONT_STACK,
  // Never let the exit label break vertically (退/出 stacked) when space is tight.
  whiteSpace: "nowrap",
  flexShrink: 0
}

// Standalone login hint (anonymous public visitor; FAB hidden).
const loginHintStyle: React.CSSProperties = {
  position: "fixed",
  right: 20,
  bottom: 20,
  zIndex: CHROME_Z,
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  padding: "8px 12px",
  borderRadius: 999,
  color: COLORS.textMuted,
  background: COLORS.surfacePopover,
  border: `1px solid ${COLORS.border}`,
  boxShadow: "0 12px 34px rgba(4, 4, 10, 0.5)",
  font: `500 12px/1 ${FONT_STACK}`,
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)"
}

// Screenshot capture surfaces + region frame.
const screenshotCaptureStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: CAPTURE_Z,
  cursor: "crosshair",
  background: "rgba(8, 8, 18, 0.28)",
  // Touch drag draws the region instead of scrolling the page (mobile screenshot fix).
  touchAction: "none"
}

const screenshotItemSurfaceStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: CAPTURE_Z,
  cursor: "crosshair",
  background: "transparent",
  touchAction: "none"
}

const regionFrameStyle: React.CSSProperties = {
  position: "fixed",
  border: `2px solid ${COLORS.human}`,
  borderRadius: 8,
  // Spotlight: a huge outset shadow dims everything outside the region (design annot-screenshot).
  boxShadow: `0 0 0 100000px rgba(8, 8, 18, 0.6)`,
  pointerEvents: "none",
  zIndex: MARKER_Z,
  boxSizing: "border-box"
}

const regionLabelStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: -30,
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "4px 9px",
  borderRadius: 8,
  color: COLORS.onAccent,
  background: COLORS.human,
  font: `600 12px/1 ${FONT_STACK}`
}

const regionHandleStyle: React.CSSProperties = {
  position: "absolute",
  width: 10,
  height: 10,
  borderRadius: 3,
  background: COLORS.human,
  border: `2px solid ${COLORS.surface}`
}

// Batch card list.
const batchHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: COLORS.textPrimary
}

const screenshotPreviewStyle: React.CSSProperties = {
  width: "100%",
  maxHeight: 132,
  objectFit: "cover",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 10
}

const screenshotListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: 6,
  maxHeight: 160,
  overflowY: "auto"
}

const screenshotListItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "6px 8px",
  borderRadius: 10,
  background: COLORS.surfaceRaised
}

const listNumberStyle: React.CSSProperties = {
  flex: "0 0 auto",
  minWidth: 20,
  height: 20,
  display: "grid",
  placeItems: "center",
  borderRadius: 999,
  color: COLORS.onAccent,
  background: COLORS.human,
  font: `600 11px/1 ${FONT_STACK}`
}

const listCommentStyle: React.CSSProperties = {
  flex: 1,
  color: COLORS.textPrimary,
  fontSize: 12,
  lineHeight: 1.45,
  wordBreak: "break-word"
}

const inlineDeleteStyle: React.CSSProperties = {
  flex: "0 0 auto",
  display: "grid",
  placeItems: "center",
  width: 22,
  height: 22,
  border: 0,
  borderRadius: 6,
  background: "transparent",
  color: COLORS.textMuted,
  cursor: "pointer"
}

const floatingErrorStyle: React.CSSProperties = {
  position: "fixed",
  right: 20,
  bottom: 84,
  zIndex: TOAST_Z,
  maxWidth: 320,
  border: `1px solid ${COLORS.danger}55`,
  borderRadius: 12,
  padding: "10px 12px",
  color: COLORS.danger,
  background: COLORS.surfacePopover,
  boxShadow: "0 12px 36px rgba(4, 4, 10, 0.5)",
  font: `12px/1.5 ${FONT_STACK}`,
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)"
}

const layerStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  pointerEvents: "none",
  zIndex: AGENT_LAYER_Z
}

// ── Agent-mark bubble / badge / list chrome (dark floating, matches the overlay) ────────
const markBubbleShellStyle: React.CSSProperties = {
  position: "fixed",
  boxSizing: "border-box",
  padding: 14,
  borderRadius: 14,
  background: COLORS.surfacePopover,
  border: `1px solid ${COLORS.borderStrong}`,
  boxShadow: "0 18px 48px rgba(0, 0, 0, 0.5)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  pointerEvents: "auto",
  zIndex: CARD_Z
}

const markBubbleHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  marginBottom: 8
}

const markBubbleAuthorDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  background: COLORS.agent,
  flex: "0 0 auto"
}

const markBubbleCloseStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: COLORS.textMuted,
  font: `400 18px/1 ${FONT_STACK}`,
  cursor: "pointer",
  padding: 0,
  lineHeight: 1,
  flex: "0 0 auto"
}

const markListRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  width: "100%",
  padding: "8px 6px",
  border: "none",
  borderRadius: 8,
  background: "transparent",
  cursor: "pointer",
  textAlign: "left"
}

const markListKindDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  marginTop: 5,
  borderRadius: 999,
  flex: "0 0 auto"
}

const markListTargetStyle: React.CSSProperties = {
  display: "block",
  color: COLORS.textPrimary,
  font: `500 12px/1.3 ${FONT_STACK}`,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
}

const markListBodyStyle: React.CSSProperties = {
  display: "block",
  color: COLORS.textMuted,
  font: `400 12px/1.3 ${FONT_STACK}`,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
}

const REGION_HANDLES = ["nw", "ne", "sw", "se"] as const

function regionHandlePosition(corner: (typeof REGION_HANDLES)[number]): React.CSSProperties {
  const offset = -6
  return {
    top: corner.startsWith("n") ? offset : undefined,
    bottom: corner.startsWith("s") ? offset : undefined,
    left: corner.endsWith("w") ? offset : undefined,
    right: corner.endsWith("e") ? offset : undefined
  }
}

// ── Inline icons (self-contained; no lucide/icon-font dependency). ──────────────────────

type IconProps = { size?: number }

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false
  }
}

function AnnotateIcon({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      <path d="M12 8v6M9 11h6" />
    </svg>
  )
}

function SparkleIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    </svg>
  )
}

function CameraIcon({ size = 15 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

function SendIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  )
}

function AnchorIcon({ size = 13 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <path d="M14 8h5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-5" />
    </svg>
  )
}

function LockIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

function BotIcon({ size = 13 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V4M9 14h.01M15 14h.01" />
    </svg>
  )
}

function TrashIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
    </svg>
  )
}

function RetakeIcon({ size = 14 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}

function IntentIcon({ intent, size = 13 }: { intent: string; size?: number }) {
  if (intent === "change" || intent === "fix") {
    return (
      <svg {...svgProps(size)}>
        <path d="M14.7 6.3a4 4 0 0 1-5 5L4 17v3h3l5.7-5.7a4 4 0 0 1 5-5l-2.3-2.3z" />
      </svg>
    )
  }
  if (intent === "question") {
    return (
      <svg {...svgProps(size)}>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3M12 17h.01" />
      </svg>
    )
  }
  if (intent === "approve") {
    return (
      <svg {...svgProps(size)}>
        <path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3zM7 11l4-8a2 2 0 0 1 2 2v3h5a2 2 0 0 1 2 2l-1.5 6a2 2 0 0 1-2 1.5H7" />
      </svg>
    )
  }
  return (
    <svg {...svgProps(size)}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  )
}

// ── Overlay bootstrap: mount the control-plane-driven overlay in its own React root. ───────

/** React error boundary so any overlay render failure degrades silently (never breaks the host). */
class AnnotationErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown) {
    console.warn("[avibe-show] annotation overlay error", error)
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

function useAnnotationControllerState(controller: AnnotationController): AnnotationControlState {
  return React.useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
}

export type AnnotationRootProps = {
  controller: AnnotationController
  config?: RuntimeConfig
  /** Run the `__show/me` auth probe (default true); pass false to skip it. */
  probeAuth?: boolean
} & Pick<AnnotationOverlayProps, "scope" | "intents" | "defaultIntent" | "severity" | "labels" | "onSubmitted">

/**
 * Bridges the framework-agnostic controller to the React overlay: subscribes to control state,
 * forwards `system.annotation.control` SSE events into the controller, runs the auth probe, and
 * renders the overlay.
 *
 * Control events are LIVE-ONLY (owner ruling): the page always boots with annotation disabled and
 * only a control event created at/after page load may enable it — a stale command replayed by the
 * SSE stream is ignored via `isLiveControlEvent`.
 */
export function AnnotationRoot({ controller, config = readRuntimeConfig(), probeAuth = true, scope, intents, defaultIntent, severity, labels, onSubmitted }: AnnotationRootProps) {
  const state = useAnnotationControllerState(controller)
  const [initialEvents, setInitialEvents] = React.useState<ShowEvent[] | null>(null)
  // Page-load timestamp: control events older than this are treated as replay and ignored. Set once.
  const pageLoadedAtRef = React.useRef<string>(new Date().toISOString())
  // The resolved write token lives in React state so a probe that fills it (public share) re-renders
  // and the event client's writeToken updates — a custom-config mount can't rely on the global.
  const [writeToken, setWriteToken] = React.useState<string | undefined>(config.writeToken)
  const eventFetchOptions = React.useMemo<ShowClientOptions>(
    () => ({ basePath: config.basePath, eventsPath: config.eventsPath, streamPath: config.streamPath }),
    [config.basePath, config.eventsPath, config.streamPath]
  )

  // Auth probe (contract §5 v2): gate the UI on canAnnotate and resolve the share-scoped write token
  // into state so THIS mount's submits carry it. On a failed/absent probe we can't confirm write
  // access, so gate off unless an injected token / auth hint already proves this mount may write.
  React.useEffect(() => {
    if (!probeAuth) return
    let cancelled = false
    void (async () => {
      const access = await fetchAnnotationAccess({ basePath: config.basePath, mePath: config.annotation?.mePath })
      if (cancelled) return
      if (access) {
        controller.setAvailable(access.canAnnotate)
        setWriteToken(resolveWriteToken(config, access))
      } else if (!config.writeToken && !config.annotation?.authenticated) {
        controller.setAvailable(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [controller, probeAuth, config.basePath, config.writeToken, config.annotation?.mePath, config.annotation?.authenticated])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // Fetch current events to seed marks + set the SSE `after_id`. STALE control events (created
        // before page load) are ignored — control is live-only (owner ruling). But a control created
        // AFTER page load can land in this initial batch (before the SSE opens with `after_id` past
        // it); that one is genuinely live and must be applied here, or advancing `after_id` would drop
        // it entirely. Later live controls arrive via `onEvent`.
        const response = await fetch(showEventsUrl(eventFetchOptions))
        const body = response.ok ? ((await response.json()) as { events?: ShowEvent[] }) : { events: [] }
        const events = Array.isArray(body.events) ? body.events : []
        if (cancelled) return
        const liveControl = events.filter((event) => isLiveControlEvent(event, pageLoadedAtRef.current)).at(-1)
        // Apply this replayed batch control only if it is chronologically NEWER than any intent already
        // applied since load (a window/bridge command, or an earlier live control). Ordering by the
        // control's `createdAt` vs the last command's timestamp — a shared-clock comparison — is what a
        // revision counter could not do: a genuinely-live control authored AFTER a startup command still
        // lands, while a stale batch control a fresher command superseded is skipped. Covers the
        // pre-fetch and in-flight windows alike (#513, #237, #402).
        if (liveControl && isBatchControlNewer(liveControl.createdAt, controller.getLastCommandAt())) {
          controller.applyControlEvent(liveControl)
        }
        setInitialEvents(events)
      } catch {
        if (!cancelled) setInitialEvents([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [eventFetchOptions, controller])

  if (initialEvents === null) return null

  return (
    <ShowSessionProvider
      sessionId={config.sessionId}
      basePath={config.basePath}
      eventsPath={config.eventsPath}
      streamPath={config.streamPath}
      writeToken={writeToken}
      initialEvents={initialEvents}
      onEvent={(event) => {
        // Apply ONLY live control events (created at/after page load); ignore replayed stale ones.
        if (isLiveControlEvent(event, pageLoadedAtRef.current)) controller.applyControlEvent(event)
      }}
    >
      <AnnotationOverlay
        enabled={state.enabled}
        mode={state.mode}
        available={state.available}
        host={controller.host}
        scope={scope}
        intents={intents}
        defaultIntent={defaultIntent}
        severity={severity}
        labels={labels}
        onEnable={(mode) => controller.enable(mode)}
        onDisable={() => controller.disable()}
        onSetMode={(mode) => controller.setMode(mode)}
        onSubmitted={onSubmitted}
      />
    </ShowSessionProvider>
  )
}

export type MountAnnotationOverlayOptions = Pick<AnnotationRootProps, "scope" | "intents" | "defaultIntent" | "severity" | "labels" | "onSubmitted"> & {
  config?: RuntimeConfig
  controller?: AnnotationController
  container?: HTMLElement
  /** Set false to skip the `__show/me` auth probe (default: run it). */
  probeAuth?: boolean
}

/**
 * Mount the annotation overlay in its own React root appended to `document.body` (contract §7).
 * Wires the control plane (window API, embedded postMessage bridge, auth probe) and returns an
 * unmount function. Every failure is contained so the host page is never broken.
 */
export function mountAnnotationOverlay(options: MountAnnotationOverlayOptions = {}): () => void {
  if (typeof document === "undefined") return () => {}
  const config = options.config ?? readRuntimeConfig()
  const controller = options.controller ?? createAnnotationController({ config })
  attachAnnotationWindowApi(controller)
  const disconnectBridge = controller.host === "embedded" ? connectAnnotationHostBridge(controller) : undefined

  const container = options.container ?? document.createElement("div")
  container.setAttribute("data-show-annotation-root", "")
  if (!container.isConnected) {
    document.body.appendChild(container)
  }
  const root: Root = createRoot(container)
  root.render(
    <AnnotationErrorBoundary>
      <AnnotationRoot
        controller={controller}
        config={config}
        probeAuth={options.probeAuth}
        scope={options.scope}
        intents={options.intents}
        defaultIntent={options.defaultIntent}
        severity={options.severity}
        labels={options.labels}
        onSubmitted={options.onSubmitted}
      />
    </AnnotationErrorBoundary>
  )

  return () => {
    disconnectBridge?.()
    root.unmount()
    if (!options.container && container.parentNode) {
      container.parentNode.removeChild(container)
    }
  }
}
