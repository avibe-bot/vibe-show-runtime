const CSRF_COOKIE_NAME = "vibe_csrf_token"
const CSRF_HEADER_NAME = "X-Vibe-CSRF-Token"

export const ANNOTATION_VOICE_STATUS_PATH = "/api/asr/status"
export const ANNOTATION_VOICE_TRANSCRIPTION_PATH = "/api/asr/transcribe"
export const ANNOTATION_VOICE_CONTEXT_BEFORE_CHARS = 500
export const ANNOTATION_VOICE_CONTEXT_AFTER_CHARS = 200
export const ANNOTATION_VOICE_MAX_DURATION_MS = 60_000
export const ANNOTATION_VOICE_MAX_BYTES = 16 * 1024 * 1024

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
  readonly status?: number

  constructor(code: AnnotationVoiceErrorCode, options: { cause?: unknown; status?: number } = {}) {
    super(code, { cause: options.cause })
    this.name = "AnnotationVoiceError"
    this.code = code
    this.status = options.status
  }
}

export type AnnotationVoiceSnapshot = {
  text: string
  start: number
  end: number
  before: string
  after: string
}

export type AnnotationVoiceTranscriptionInput = {
  blob: Blob
  before: string
  after: string
  signal?: AbortSignal
}

export type AnnotationVoiceAdapter = {
  isAvailable(): Promise<boolean>
  transcribe(input: AnnotationVoiceTranscriptionInput): Promise<string>
}

type VoiceFetch = typeof fetch

const positiveIntegerLimit = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback

export type AnnotationVoiceRequestDependencies = {
  fetch?: VoiceFetch
  encodeBlob?: (blob: Blob) => Promise<string>
  readCsrfCookie?: () => string | null
  maxBytes?: number
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

const edgeCharacter = (text: string, side: "start" | "end"): string => {
  const characters = Array.from(text.trim())
  return side === "start" ? (characters[0] ?? "") : (characters.at(-1) ?? "")
}

const needsBoundarySpace = (left: string, right: string): boolean => {
  if (/\s$/u.test(left) || /^\s/u.test(right)) return false
  const leftCharacter = edgeCharacter(left, "end")
  const rightCharacter = edgeCharacter(right, "start")
  return (
    WORD_CHARACTER.test(leftCharacter)
    && WORD_CHARACTER.test(rightCharacter)
    && !NO_SPACE_SCRIPT.test(leftCharacter)
    && !NO_SPACE_SCRIPT.test(rightCharacter)
  )
}

/** Insert a finalized transcript at the selection captured before the mic button took focus. */
export function insertAnnotationVoiceTranscript(
  currentText: string,
  snapshot: AnnotationVoiceSnapshot,
  transcript: string
): { text: string; start: number; end: number } | null {
  if (currentText !== snapshot.text) return null
  const normalized = transcript.trim()
  if (!normalized) return null

  const left = currentText.slice(0, snapshot.start)
  const right = currentText.slice(snapshot.end)
  const selected = currentText.slice(snapshot.start, snapshot.end)
  const leadingWhitespace = selected.match(/^\s+/u)?.[0] ?? ""
  const trailingWhitespace = selected.match(/\s+$/u)?.[0] ?? ""
  const insertion = snapshot.start === snapshot.end
    ? `${needsBoundarySpace(left, normalized) ? " " : ""}${normalized}${needsBoundarySpace(normalized, right) ? " " : ""}`
    : `${leadingWhitespace}${normalized}${trailingWhitespace}`
  const text = `${left}${insertion}${right}`
  const start = snapshot.start
  return { text, start, end: start + insertion.length }
}

function readDocumentCsrfCookie(): string | null {
  if (typeof document === "undefined") return null
  const prefix = `${CSRF_COOKIE_NAME}=`
  for (const part of document.cookie.split(";")) {
    const value = part.trim()
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length))
  }
  return null
}

async function fetchCsrfToken(fetcher: VoiceFetch, signal?: AbortSignal): Promise<string> {
  const response = await fetcher("/api/csrf-token", {
    credentials: "same-origin",
    signal
  })
  const payload = await response.json().catch(() => null) as { csrf_token?: unknown } | null
  if (!response.ok || typeof payload?.csrf_token !== "string" || !payload.csrf_token) {
    throw new AnnotationVoiceError("unavailable", { status: response.status })
  }
  return payload.csrf_token
}

async function blobAsBase64(blob: Blob): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error)
      reader.onload = () => {
        const value = String(reader.result ?? "")
        const comma = value.indexOf(",")
        resolve(comma === -1 ? value : value.slice(comma + 1))
      }
      reader.readAsDataURL(blob)
    })
  }

  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  const blockSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize))
  }
  return globalThis.btoa(binary)
}

const normalizedMimeType = (blob: Blob): string =>
  blob.type.split(";", 1)[0]?.trim().toLowerCase() || "audio/webm"

const VOICE_EXTENSION_BY_MIME: Record<string, string> = {
  "audio/aac": "aac",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-m4a": "m4a"
}

export const annotationVoiceFileName = (blob: Blob): string =>
  `voice.${VOICE_EXTENSION_BY_MIME[normalizedMimeType(blob)] ?? "webm"}`

const newDictationId = (): string =>
  globalThis.crypto?.randomUUID?.()
  ?? `annotation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`

const voiceResponseError = (response: Response, payload: unknown): AnnotationVoiceError => {
  const upstream = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { error?: unknown }).error
    : undefined
  if (response.status === 413 || upstream === "file_too_large") {
    return new AnnotationVoiceError("too_large", { status: response.status })
  }
  if (response.status === 504 || upstream === "transcription_timeout") {
    return new AnnotationVoiceError("timeout", { status: response.status })
  }
  if (upstream === "transcription_empty") {
    return new AnnotationVoiceError("empty", { status: response.status })
  }
  if (
    response.status === 503
    || upstream === "asr_not_configured"
    || upstream === "asr_unavailable"
  ) {
    return new AnnotationVoiceError("unavailable", { status: response.status })
  }
  return new AnnotationVoiceError("failed", { status: response.status })
}

const invalidCsrfResponse = (response: Response, payload: unknown): boolean =>
  response.status === 403
  && Boolean(payload && typeof payload === "object" && (payload as { message?: unknown }).message === "Forbidden: invalid csrf token")

export async function probeAnnotationVoice(
  dependencies: Pick<AnnotationVoiceRequestDependencies, "fetch"> = {}
): Promise<boolean> {
  const fetcher = dependencies.fetch ?? globalThis.fetch
  if (!fetcher) return false
  try {
    const response = await fetcher(ANNOTATION_VOICE_STATUS_PATH, { credentials: "same-origin" })
    const payload = await response.json().catch(() => null) as { available?: unknown } | null
    return response.ok && payload?.available === true
  } catch {
    return false
  }
}

export async function transcribeAnnotationVoice(
  input: AnnotationVoiceTranscriptionInput,
  dependencies: AnnotationVoiceRequestDependencies = {}
): Promise<string> {
  const fetcher = dependencies.fetch ?? globalThis.fetch
  if (!fetcher) throw new AnnotationVoiceError("unavailable")
  const readCsrfCookie = dependencies.readCsrfCookie ?? readDocumentCsrfCookie
  const encodeBlob = dependencies.encodeBlob ?? blobAsBase64
  const maxBytes = positiveIntegerLimit(dependencies.maxBytes, ANNOTATION_VOICE_MAX_BYTES)
  if (input.blob.size > maxBytes) throw new AnnotationVoiceError("too_large")
  const data = await encodeBlob(input.blob)
  const body = JSON.stringify({
    name: annotationVoiceFileName(input.blob),
    mime: normalizedMimeType(input.blob),
    data,
    dictation_id: newDictationId(),
    sequence: 0,
    overlap_ms: 0,
    final: true,
    finalize_only: false,
    receipts: [],
    before: input.before,
    after: input.after
  })

  let csrfToken = readCsrfCookie() ?? await fetchCsrfToken(fetcher, input.signal)
  const send = (token: string) => fetcher(ANNOTATION_VOICE_TRANSCRIPTION_PATH, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      [CSRF_HEADER_NAME]: token
    },
    body,
    signal: input.signal
  })

  try {
    let response = await send(csrfToken)
    let payload = await response.json().catch(() => null) as unknown
    if (invalidCsrfResponse(response, payload)) {
      csrfToken = readCsrfCookie() ?? await fetchCsrfToken(fetcher, input.signal)
      response = await send(csrfToken)
      payload = await response.json().catch(() => null)
    }
    if (!response.ok) throw voiceResponseError(response, payload)
    const text = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { text?: unknown }).text
      : undefined
    if (typeof text !== "string" || !text.trim()) throw new AnnotationVoiceError("empty", { status: response.status })
    return text
  } catch (error) {
    if (error instanceof AnnotationVoiceError) throw error
    if (input.signal?.aborted) throw new AnnotationVoiceError("cancelled", { cause: error })
    throw new AnnotationVoiceError("unavailable", { cause: error })
  }
}

export const defaultAnnotationVoiceAdapter: AnnotationVoiceAdapter = {
  isAvailable: () => probeAnnotationVoice(),
  transcribe: (input) => transcribeAnnotationVoice(input)
}

export type AnnotationVoiceRecording = {
  readonly done: Promise<Blob>
  stop(): Promise<Blob>
  abort(): void
}

type AnnotationMediaRecorder = Pick<
  MediaRecorder,
  "addEventListener" | "mimeType" | "removeEventListener" | "start" | "state" | "stop"
>

export type AnnotationVoiceRecordingDependencies = {
  getUserMedia?: () => Promise<MediaStream>
  createRecorder?: (stream: MediaStream, options?: MediaRecorderOptions) => AnnotationMediaRecorder
  isTypeSupported?: (mimeType: string) => boolean
  maxDurationMs?: number
  maxBytes?: number
}

const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus"
] as const

export function preferredAnnotationVoiceMimeType(
  isTypeSupported: ((mimeType: string) => boolean) | undefined
): string | undefined {
  return isTypeSupported ? RECORDING_MIME_TYPES.find((mimeType) => isTypeSupported(mimeType)) : undefined
}

const stopMediaStream = (stream: MediaStream): void => {
  for (const track of stream.getTracks()) track.stop()
}

const recordingStartError = (error: unknown): AnnotationVoiceError => {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined
  return new AnnotationVoiceError(
    name === "NotAllowedError" || name === "SecurityError" ? "permission" : "start_failed",
    { cause: error }
  )
}

/** Start a bounded browser-owned recording and release every media track on all terminal paths. */
export async function startAnnotationVoiceRecording(
  dependencies: AnnotationVoiceRecordingDependencies = {}
): Promise<AnnotationVoiceRecording> {
  const getUserMedia = dependencies.getUserMedia
    ?? (globalThis.navigator?.mediaDevices?.getUserMedia
      ? () => globalThis.navigator.mediaDevices.getUserMedia({ audio: true })
      : undefined)
  const MediaRecorderConstructor = globalThis.MediaRecorder
  const createRecorder = dependencies.createRecorder
    ?? (MediaRecorderConstructor
      ? (stream: MediaStream, options?: MediaRecorderOptions) => new MediaRecorderConstructor(stream, options)
      : undefined)
  if (!getUserMedia || !createRecorder) throw new AnnotationVoiceError("start_failed")

  let stream: MediaStream
  try {
    stream = await getUserMedia()
  } catch (error) {
    throw recordingStartError(error)
  }

  const isTypeSupported = dependencies.isTypeSupported
    ?? MediaRecorderConstructor?.isTypeSupported?.bind(MediaRecorderConstructor)
  const mimeType = preferredAnnotationVoiceMimeType(isTypeSupported)
  let recorder: AnnotationMediaRecorder
  try {
    recorder = createRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch (error) {
    stopMediaStream(stream)
    throw recordingStartError(error)
  }

  const chunks: Blob[] = []
  const maxDurationMs = positiveIntegerLimit(
    dependencies.maxDurationMs,
    ANNOTATION_VOICE_MAX_DURATION_MS
  )
  const maxBytes = positiveIntegerLimit(dependencies.maxBytes, ANNOTATION_VOICE_MAX_BYTES)
  let bufferedBytes = 0
  let limitError: AnnotationVoiceError | null = null
  let aborted = false
  let settled = false
  let durationTimer: ReturnType<typeof setTimeout> | null = null
  let resolveDone: (blob: Blob) => void
  let rejectDone: (error: unknown) => void
  const done = new Promise<Blob>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  // A recorder can fail before its owner asks to stop. Keep that rejection
  // observed while still returning the original promise to callers.
  void done.catch(() => undefined)

  const cleanup = () => {
    if (durationTimer !== null) clearTimeout(durationTimer)
    durationTimer = null
    recorder.removeEventListener("dataavailable", onData as EventListener)
    recorder.removeEventListener("error", onError)
    recorder.removeEventListener("stop", onStop)
    stopMediaStream(stream)
  }
  const settle = (result: Blob | AnnotationVoiceError) => {
    if (settled) return
    settled = true
    cleanup()
    if (result instanceof AnnotationVoiceError) rejectDone(result)
    else resolveDone(result)
  }
  const onData = (event: Event) => {
    const data = (event as BlobEvent).data
    if (aborted || limitError || !data?.size) return
    if (bufferedBytes + data.size > maxBytes) {
      limitError = new AnnotationVoiceError("too_large")
      chunks.length = 0
      bufferedBytes = 0
      if (recorder.state !== "inactive") recorder.stop()
      else settle(limitError)
      return
    }
    chunks.push(data)
    bufferedBytes += data.size
  }
  const onError = (event: Event) => {
    const error = (event as Event & { error?: unknown }).error
    settle(new AnnotationVoiceError("start_failed", { cause: error }))
  }
  const onStop = () => {
    if (limitError) {
      settle(limitError)
      return
    }
    const type = recorder.mimeType || mimeType || chunks[0]?.type || "audio/webm"
    settle(new Blob(aborted ? [] : chunks, { type }))
  }

  recorder.addEventListener("dataavailable", onData as EventListener)
  recorder.addEventListener("error", onError)
  recorder.addEventListener("stop", onStop)
  try {
    recorder.start(1000)
  } catch (error) {
    const normalized = recordingStartError(error)
    settle(normalized)
    throw normalized
  }
  if (!settled) {
    durationTimer = setTimeout(() => {
      if (!settled && recorder.state !== "inactive") recorder.stop()
    }, maxDurationMs)
  }

  return {
    done,
    stop: () => {
      if (!settled && recorder.state !== "inactive") recorder.stop()
      return done
    },
    abort: () => {
      if (settled) return
      aborted = true
      if (recorder.state !== "inactive") recorder.stop()
      else settle(new Blob([], { type: recorder.mimeType || mimeType || "audio/webm" }))
    }
  }
}
