/** The server advertises this capability; a failed handshake never discovers it. */
export type ShowEventStreamTransport = "websocket-sse-v1"

const MIN_RECONNECT_MS = 500
const MAX_RECONNECT_MS = 30_000
const ADMISSION_PROBE_TIMEOUT_MS = 3_000

/**
 * EventSource's receive-only interface over the exact SSE endpoint via WS.
 * This source alone owns reconnection; consumers only listen and close.
 */
export class WebSocketEventSource extends EventTarget implements EventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSED = 2
  readonly withCredentials = false
  readonly url: string
  readyState: number = this.CONNECTING
  onopen: EventSource["onopen"] = null
  onerror: EventSource["onerror"] = null
  onmessage: EventSource["onmessage"] = null

  private socket?: WebSocket
  private timer?: ReturnType<typeof setTimeout>
  private lastEventId: string
  private reconnectMs = MIN_RECONNECT_MS
  private probe?: AbortController
  private readonly fetchImpl?: typeof fetch

  constructor(url: URL, fetchImpl?: typeof fetch) {
    super()
    const socketUrl = new URL(url)
    if (socketUrl.protocol === "http:") socketUrl.protocol = "ws:"
    if (socketUrl.protocol === "https:") socketUrl.protocol = "wss:"
    this.url = socketUrl.toString()
    this.lastEventId = socketUrl.searchParams.get("after_id") ?? ""
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    this.connect()
  }

  addEventListener<K extends keyof EventSourceEventMap>(
    type: K,
    listener: (this: EventSource, event: EventSourceEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void
  addEventListener(type: string, listener: (this: EventSource, event: MessageEvent) => unknown, options?: boolean | AddEventListenerOptions): void
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | ((this: EventSource, event: MessageEvent) => unknown) | null, options?: boolean | AddEventListenerOptions) {
    super.addEventListener(type, listener as EventListenerOrEventListenerObject | null, options)
  }

  removeEventListener<K extends keyof EventSourceEventMap>(
    type: K,
    listener: (this: EventSource, event: EventSourceEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions
  ): void
  removeEventListener(type: string, listener: (this: EventSource, event: MessageEvent) => unknown, options?: boolean | EventListenerOptions): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | ((this: EventSource, event: MessageEvent) => unknown) | null, options?: boolean | EventListenerOptions) {
    super.removeEventListener(type, listener as EventListenerOrEventListenerObject | null, options)
  }

  close() {
    this.readyState = this.CLOSED
    clearTimeout(this.timer)
    this.timer = undefined
    this.probe?.abort()
    this.probe = undefined
    this.releaseSocket()
  }

  private releaseSocket() {
    const socket = this.socket
    this.socket = undefined
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    socket.close()
  }

  private emit(event: Event, terminal = false) {
    this.dispatchEvent(event)
    if (!terminal && this.readyState === this.CLOSED) return
    if (event.type === "open") this.onopen?.call(this, event)
    if (event.type === "error") this.onerror?.call(this, event)
    if (event.type === "message") this.onmessage?.call(this, event as MessageEvent)
  }

  private connect() {
    if (this.readyState === this.CLOSED) return
    const url = new URL(this.url)
    // An empty SSE id resets the cursor, including a caller-supplied initial cursor.
    url.searchParams.delete("after_id")
    if (this.lastEventId) url.searchParams.set("after_id", this.lastEventId)
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      // Allow callers to attach error listeners before reporting construction failure.
      queueMicrotask(() => { void this.reconnect(url) })
      return
    }
    this.socket = socket
    const active = () => this.socket === socket && this.readyState !== this.CLOSED
    const parser = new SseParser(this.lastEventId, (type, data, id) => {
      if (!active()) return
      this.lastEventId = id
      if (data === undefined) return
      const event = new MessageEvent(type, { data, lastEventId: id, origin: url.origin })
      this.emit(event)
    })
    socket.onopen = () => {
      if (!active()) return
      this.readyState = this.OPEN
      this.reconnectMs = MIN_RECONNECT_MS
      this.emit(new Event("open"))
    }
    socket.onmessage = (event) => {
      if (active() && typeof event.data === "string") parser.push(event.data)
    }
    socket.onerror = () => {
      if (active()) void this.reconnect(url)
    }
    socket.onclose = (event) => {
      if (active()) void this.reconnect(url, event.code === 1008)
    }
  }

  private async reconnect(url: URL, policyDenied = false) {
    if (this.readyState === this.CLOSED) return
    this.readyState = this.CONNECTING
    this.releaseSocket()
    const denied = policyDenied || await this.admissionDenied(url)
    if (this.readyState === this.CLOSED) return
    if (denied) {
      this.close()
      this.emit(new Event("error"), true)
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.connect()
    }, this.reconnectMs)
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS)
    this.emit(new Event("error"))
  }

  private async admissionDenied(socketUrl: URL): Promise<boolean> {
    const fetchImpl = this.fetchImpl
    const url = new URL(socketUrl)
    url.protocol = url.protocol === "wss:" ? "https:" : "http:"
    // Only these server-owned Show routes guarantee a non-streaming JSON GET
    // when `stream` is absent. Never guess that policy for /api/events or a
    // custom endpoint. A foreign origin's CORS/credential policy is not ours.
    if (!fetchImpl || url.origin !== globalThis.location?.origin ||
      !/^\/(?:show|p)\/[^/]+\/__show\/events$/.test(url.pathname)) return false
    url.searchParams.delete("stream")
    url.searchParams.delete("after_id")
    if (this.lastEventId) url.searchParams.set("after_id", this.lastEventId)
    const controller = new AbortController()
    this.probe = controller
    const timeout = setTimeout(() => controller.abort(), ADMISSION_PROBE_TIMEOUT_MS)
    let onAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      const request = fetchImpl(url, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "manual",
        headers: { Accept: "application/json" },
        signal: controller.signal
      }).then((response) => {
        // Read only admission status, never consume/replay probe events. Also
        // dispose late responses if a caller's fetch ignores cancellation.
        void response.body?.cancel().catch(() => {})
        return response.status >= 400 && response.status < 500 &&
          ![408, 425, 429].includes(response.status)
      })
      return await Promise.race([request, aborted])
    } catch {
      // Network/CORS/deadline failures give no authoritative denial status.
      return false
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener("abort", onAbort)
      if (this.probe === controller) this.probe = undefined
    }
  }
}

/** Incremental SSE line/frame decoding, including CRLF split across WS messages. */
class SseParser {
  private line = ""
  private skipLf = false
  private firstCharacter = true
  private type = ""
  private data: string[] = []

  constructor(
    private id: string,
    private readonly receive: (type: string, data: string | undefined, id: string) => void
  ) {}

  push(chunk: string) {
    for (const character of chunk) {
      if (this.firstCharacter) {
        this.firstCharacter = false
        if (character === "\uFEFF") continue
      }
      if (this.skipLf) {
        this.skipLf = false
        if (character === "\n") continue
      }
      if (character === "\r" || character === "\n") {
        this.consumeLine()
        this.skipLf = character === "\r"
      } else {
        this.line += character
      }
    }
  }

  private consumeLine() {
    const line = this.line
    this.line = ""
    if (!line) {
      this.receive(this.type || "message", this.data.length ? this.data.join("\n") : undefined, this.id)
      this.type = ""
      this.data = []
      return
    }
    const separator = line.indexOf(":")
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? "" : line.slice(separator + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") this.type = value
    if (field === "data") this.data.push(value)
    if (field === "id" && !value.includes("\0")) this.id = value
  }
}
