export const ANNOTATION_VOICE_CONTEXT_BEFORE_CHARS = 500
export const ANNOTATION_VOICE_CONTEXT_AFTER_CHARS = 200
export const ANNOTATION_VOICE_REQUEST_MESSAGE = "avibe:annotation:voice:request"
export const ANNOTATION_VOICE_EVENT_MESSAGE = "avibe:annotation:voice:event"

export type AnnotationVoiceErrorCode =
  | "cancelled"
  | "draft_changed"
  | "empty"
  | "failed"
  | "permission"
  | "start_failed"
  | "timeout"
  | "too_large"
  | "unavailable"

export class AnnotationVoiceError extends Error {
  readonly code: AnnotationVoiceErrorCode
  readonly retryable: boolean

  constructor(code: AnnotationVoiceErrorCode, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(code, { cause: options.cause })
    this.name = "AnnotationVoiceError"
    this.code = code
    this.retryable = options.retryable === true
  }
}

export type AnnotationVoiceSnapshot = {
  text: string
  start: number
  end: number
  before: string
  after: string
}

export type AnnotationVoiceSession = {
  readonly done: Promise<string>
  stop(): void
  retry(input: AnnotationVoiceRetryInput): Promise<string>
  abort(): void
}

export type AnnotationVoiceRetryInput = {
  before: string
  after: string
}

export type AnnotationVoiceStartInput = {
  before: string
  after: string
  signal?: AbortSignal
  onPreview?: (text: string) => void
}

export type AnnotationVoiceAdapter = {
  isAvailable(): Promise<boolean>
  start(input: AnnotationVoiceStartInput): Promise<AnnotationVoiceSession>
}

export type AnnotationVoiceRequest =
  | { type: typeof ANNOTATION_VOICE_REQUEST_MESSAGE; action: "query"; requestId: string }
  | {
      type: typeof ANNOTATION_VOICE_REQUEST_MESSAGE
      action: "start"
      requestId: string
      before: string
      after: string
    }
  | { type: typeof ANNOTATION_VOICE_REQUEST_MESSAGE; action: "stop" | "abort"; requestId: string }
  | {
      type: typeof ANNOTATION_VOICE_REQUEST_MESSAGE
      action: "retry"
      requestId: string
      before: string
      after: string
    }

export type AnnotationVoiceEvent =
  | {
      type: typeof ANNOTATION_VOICE_EVENT_MESSAGE
      kind: "availability"
      requestId: string
      available: boolean
    }
  | {
      type: typeof ANNOTATION_VOICE_EVENT_MESSAGE
      kind: "started" | "preview" | "result"
      requestId: string
      text?: string
    }
  | {
      type: typeof ANNOTATION_VOICE_EVENT_MESSAGE
      kind: "error"
      requestId: string
      code: AnnotationVoiceErrorCode
      retryable: boolean
    }

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

const boundedSelection = (text: string, start: number, end: number): [number, number] => {
  const safeStart = Math.max(0, Math.min(text.length, Math.floor(start)))
  const safeEnd = Math.max(safeStart, Math.min(text.length, Math.floor(end)))
  return [safeStart, safeEnd]
}

export function annotationVoiceSnapshot(
  text: string,
  start: number,
  end: number
): AnnotationVoiceSnapshot {
  const [safeStart, safeEnd] = boundedSelection(text, start, end)
  return {
    text,
    start: safeStart,
    end: safeEnd,
    before: text.slice(Math.max(0, safeStart - ANNOTATION_VOICE_CONTEXT_BEFORE_CHARS), safeStart),
    after: text.slice(safeEnd, safeEnd + ANNOTATION_VOICE_CONTEXT_AFTER_CHARS)
  }
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u
const LEADING_SENTENCE_PUNCTUATION = /^[.,!?:;…，。！？：；、](?:\s|$)/u
const LEADING_OUTER_BOUNDARY = /^[\p{P}\p{S}]+/u
const TRAILING_OUTER_BOUNDARY = /[\p{P}\p{S}]+$/u
const LEADING_WORD_GRAPHEME = /^[\p{L}\p{N}_]\p{M}*/u
const TRAILING_WORD_GRAPHEME = /[\p{L}\p{N}_]\p{M}*$/u
const OPENING_DELIMITER = /^[\p{Ps}\p{Pi}]$/u
const SYMMETRIC_DELIMITER = /^["'`]$/u
const TRAILING_TOKEN_JOINER = /(?:[/\\]|::|->|\?\.)$/u
const LEADING_CALL_DELIMITER = /^[([{]/u

const edgeCharacter = (text: string, side: "start" | "end"): string => {
  const wordGrapheme = side === "start"
    ? text.match(LEADING_WORD_GRAPHEME)
    : text.match(TRAILING_WORD_GRAPHEME)
  if (wordGrapheme) return wordGrapheme[0]
  const characters = Array.from(text)
  return side === "start" ? (characters[0] ?? "") : (characters.at(-1) ?? "")
}

const endsWithOpeningDelimiter = (text: string): boolean => {
  const characters = Array.from(text)
  const delimiter = characters.at(-1) ?? ""
  if (OPENING_DELIMITER.test(delimiter)) return true
  if (!SYMMETRIC_DELIMITER.test(delimiter)) return false
  return !TRAILING_WORD_GRAPHEME.test(characters.slice(0, -1).join(""))
}

const joiningBoundaryCharacter = (text: string, followingText: string): string | undefined => {
  if (TRAILING_TOKEN_JOINER.test(text)) return edgeCharacter(text, "end")
  if (text.endsWith(".") && LEADING_CALL_DELIMITER.test(followingText)) return "."
  return undefined
}

const boundaryCharacter = (text: string, side: "start" | "end"): string => {
  if (side === "end" && endsWithOpeningDelimiter(text)) return edgeCharacter(text, side)
  const boundaryText = side === "start"
    ? (LEADING_SENTENCE_PUNCTUATION.test(text) ? text : text.replace(LEADING_OUTER_BOUNDARY, ""))
    : text.replace(TRAILING_OUTER_BOUNDARY, "")
  return edgeCharacter(boundaryText, side)
}

const needsBoundarySpace = (
  left: string,
  right: string,
  leftBoundary?: string,
  rightBoundary?: string
): boolean => {
  const leftCharacter = leftBoundary ?? boundaryCharacter(left, "end")
  const rightCharacter = rightBoundary ?? boundaryCharacter(right, "start")
  return (
    WORD_CHARACTER.test(leftCharacter)
    && WORD_CHARACTER.test(rightCharacter)
    && !NO_SPACE_SCRIPT.test(leftCharacter)
    && !NO_SPACE_SCRIPT.test(rightCharacter)
  )
}

/** Insert a finalized transcript at the selection captured before the mic button took focus. */
export type AnnotationVoiceInsertionResult =
  | { ok: true; text: string; start: number; end: number }
  | { ok: false; code: "draft_changed" | "empty" }

export function insertAnnotationVoiceTranscript(
  currentText: string,
  snapshot: AnnotationVoiceSnapshot,
  transcript: string
): AnnotationVoiceInsertionResult {
  const normalized = transcript.trim()
  if (!normalized) return { ok: false, code: "empty" }
  if (currentText !== snapshot.text) return { ok: false, code: "draft_changed" }

  const left = currentText.slice(0, snapshot.start)
  const right = currentText.slice(snapshot.end)
  const selected = currentText.slice(snapshot.start, snapshot.end)
  const leadingWhitespace = selected.match(/^\s+/u)?.[0] ?? ""
  const trailingWhitespace = selected.match(/\s+$/u)?.[0] ?? ""
  const leftBoundary = joiningBoundaryCharacter(left, right)
  const transcriptBoundary = joiningBoundaryCharacter(normalized, right)
  const insertion = snapshot.start === snapshot.end
    ? `${needsBoundarySpace(left, normalized, leftBoundary) ? " " : ""}${normalized}${needsBoundarySpace(normalized, right, transcriptBoundary) ? " " : ""}`
    : `${leadingWhitespace}${normalized}${trailingWhitespace}`
  const text = `${left}${insertion}${right}`
  return { ok: true, text, start: snapshot.start, end: snapshot.start + insertion.length }
}

const newRequestId = (): string =>
  globalThis.crypto?.randomUUID?.()
  ?? `annotation-voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`

const isVoiceErrorCode = (value: unknown): value is AnnotationVoiceErrorCode =>
  value === "cancelled"
  || value === "draft_changed"
  || value === "empty"
  || value === "failed"
  || value === "permission"
  || value === "start_failed"
  || value === "timeout"
  || value === "too_large"
  || value === "unavailable"

export function annotationVoiceEventFromPayload(value: unknown): AnnotationVoiceEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const payload = value as Record<string, unknown>
  if (
    payload.type !== ANNOTATION_VOICE_EVENT_MESSAGE
    || typeof payload.requestId !== "string"
    || !payload.requestId
  ) {
    return undefined
  }
  if (payload.kind === "availability" && typeof payload.available === "boolean") {
    return {
      type: ANNOTATION_VOICE_EVENT_MESSAGE,
      kind: "availability",
      requestId: payload.requestId,
      available: payload.available
    }
  }
  if (payload.kind === "started") {
    return { type: ANNOTATION_VOICE_EVENT_MESSAGE, kind: "started", requestId: payload.requestId }
  }
  if ((payload.kind === "preview" || payload.kind === "result") && typeof payload.text === "string") {
    return {
      type: ANNOTATION_VOICE_EVENT_MESSAGE,
      kind: payload.kind,
      requestId: payload.requestId,
      text: payload.text
    }
  }
  if (
    payload.kind === "error"
    && isVoiceErrorCode(payload.code)
    && typeof payload.retryable === "boolean"
  ) {
    return {
      type: ANNOTATION_VOICE_EVENT_MESSAGE,
      kind: "error",
      requestId: payload.requestId,
      code: payload.code,
      retryable: payload.retryable
    }
  }
  return undefined
}

type AnnotationVoiceBridgeWindow = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void
}

type AnnotationVoiceBridgeTarget = {
  postMessage(message: unknown, targetOrigin: string): void
}

export type AnnotationVoiceBridgeDependencies = {
  window?: AnnotationVoiceBridgeWindow
  parent?: AnnotationVoiceBridgeTarget
  origin?: string
  availabilityTimeoutMs?: number
  startTimeoutMs?: number
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

type BridgeSessionState = {
  started: Deferred<void>
  result: Deferred<string>
  onPreview?: (text: string) => void
  signal?: AbortSignal
  abortFromSignal?: () => void
  startTimer?: ReturnType<typeof globalThis.setTimeout>
}

/** Use the owning Avibe client as the one voice implementation for an embedded Show Page. */
export function createAnnotationVoiceBridgeAdapter(
  dependencies: AnnotationVoiceBridgeDependencies = {}
): AnnotationVoiceAdapter {
  const targetWindow: AnnotationVoiceBridgeWindow | undefined = dependencies.window
    ?? (typeof window !== "undefined" ? window : undefined)
  const parent: AnnotationVoiceBridgeTarget | undefined = dependencies.parent
    ?? (typeof window !== "undefined" ? window.parent : undefined)
  const origin = dependencies.origin
    ?? (typeof location !== "undefined" ? location.origin : "*")
  const schedule = dependencies.setTimeout ?? globalThis.setTimeout
  const cancelTimer = dependencies.clearTimeout ?? globalThis.clearTimeout
  const availabilityTimeoutMs = dependencies.availabilityTimeoutMs ?? 1_500
  const startTimeoutMs = dependencies.startTimeoutMs ?? 30_000
  const availability = new Map<string, Deferred<boolean>>()
  const sessions = new Map<string, BridgeSessionState>()

  const post = (request: AnnotationVoiceRequest): void => {
    parent?.postMessage(request, origin)
  }
  const releaseSession = (requestId: string, state: BridgeSessionState): void => {
    if (sessions.get(requestId) !== state) return
    sessions.delete(requestId)
    if (state.startTimer !== undefined) {
      cancelTimer(state.startTimer)
      state.startTimer = undefined
    }
    if (state.abortFromSignal) state.signal?.removeEventListener("abort", state.abortFromSignal)
  }
  const listener = (event: MessageEvent) => {
    if (origin !== "*" && event.origin !== origin) return
    if (parent && event.source !== parent) return
    const message = annotationVoiceEventFromPayload(event.data)
    if (!message) return
    if (message.kind === "availability") {
      availability.get(message.requestId)?.resolve(message.available)
      availability.delete(message.requestId)
      return
    }
    const state = sessions.get(message.requestId)
    if (!state) return
    if (message.kind === "started") {
      if (state.startTimer !== undefined) {
        cancelTimer(state.startTimer)
        state.startTimer = undefined
      }
      state.started.resolve()
    } else if (message.kind === "preview") {
      state.onPreview?.(message.text ?? "")
    } else if (message.kind === "result") {
      state.result.resolve(message.text ?? "")
      releaseSession(message.requestId, state)
    } else if (message.kind === "error") {
      if (state.startTimer !== undefined) {
        cancelTimer(state.startTimer)
        state.startTimer = undefined
      }
      const error = new AnnotationVoiceError(message.code, { retryable: message.retryable })
      state.started.reject(error)
      state.result.reject(error)
      if (!message.retryable) releaseSession(message.requestId, state)
    }
  }
  targetWindow?.addEventListener("message", listener)

  return {
    async isAvailable() {
      if (!targetWindow || !parent || Object.is(parent, targetWindow)) return false
      const requestId = newRequestId()
      const response = deferred<boolean>()
      availability.set(requestId, response)
      const timer = schedule(() => {
        if (availability.delete(requestId)) response.resolve(false)
      }, availabilityTimeoutMs)
      post({ type: ANNOTATION_VOICE_REQUEST_MESSAGE, action: "query", requestId })
      try {
        return await response.promise
      } finally {
        cancelTimer(timer)
        availability.delete(requestId)
      }
    },

    async start(input) {
      if (!targetWindow || !parent || Object.is(parent, targetWindow)) {
        throw new AnnotationVoiceError("unavailable")
      }
      const requestId = newRequestId()
      const state: BridgeSessionState = {
        started: deferred<void>(),
        result: deferred<string>(),
        onPreview: input.onPreview,
        signal: input.signal
      }
      void state.result.promise.catch(() => undefined)
      sessions.set(requestId, state)
      const abort = () => {
        post({ type: ANNOTATION_VOICE_REQUEST_MESSAGE, action: "abort", requestId })
        const error = new AnnotationVoiceError("cancelled")
        state.started.reject(error)
        state.result.reject(error)
        releaseSession(requestId, state)
      }
      state.abortFromSignal = abort
      if (input.signal?.aborted) {
        abort()
        throw new AnnotationVoiceError("cancelled")
      }
      input.signal?.addEventListener("abort", abort, { once: true })
      state.startTimer = schedule(() => {
        if (sessions.get(requestId) !== state) return
        post({ type: ANNOTATION_VOICE_REQUEST_MESSAGE, action: "abort", requestId })
        const error = new AnnotationVoiceError("timeout")
        state.started.reject(error)
        state.result.reject(error)
        releaseSession(requestId, state)
      }, startTimeoutMs)
      post({
        type: ANNOTATION_VOICE_REQUEST_MESSAGE,
        action: "start",
        requestId,
        before: input.before,
        after: input.after
      })
      try {
        await state.started.promise
      } catch (error) {
        releaseSession(requestId, state)
        throw error
      }

      const session: AnnotationVoiceSession = {
        done: state.result.promise,
        stop: () => post({ type: ANNOTATION_VOICE_REQUEST_MESSAGE, action: "stop", requestId }),
        retry: (retryInput) => {
          const nextResult = deferred<string>()
          void nextResult.promise.catch(() => undefined)
          state.result = nextResult
          sessions.set(requestId, state)
          post({
            type: ANNOTATION_VOICE_REQUEST_MESSAGE,
            action: "retry",
            requestId,
            before: retryInput.before,
            after: retryInput.after
          })
          return nextResult.promise
        },
        abort
      }
      return session
    }
  }
}

export const defaultAnnotationVoiceAdapter = createAnnotationVoiceBridgeAdapter()
