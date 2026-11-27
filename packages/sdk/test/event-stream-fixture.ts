/** Receive-only browser socket double; tests drive the actual SDK and Provider. */
export class TestWebSocket {
  static instances: TestWebSocket[] = []
  readonly url: string
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  closeCount = 0

  constructor(url: string | URL) {
    this.url = String(url)
    TestWebSocket.instances.push(this)
  }

  open() { this.onopen?.(new Event("open")) }
  receive(data: string) { this.onmessage?.(new MessageEvent("message", { data })) }
  fail() { this.onerror?.(new Event("error")) }
  disconnect() { this.onclose?.(new Event("close")) }
  close() { this.closeCount += 1 }
}

export class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = []
  readonly url: string
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closeCount = 0

  constructor(url: string) {
    super()
    this.url = url
    TestEventSource.instances.push(this)
  }

  close() { this.closeCount += 1 }
  receive(data: string) { this.dispatchEvent(new MessageEvent("show.event", { data })) }
}

export function showFrame(id: string, text = id) {
  return `event: show.event\nid: ${id}\ndata: ${JSON.stringify({
    id, type: "system.runtime.status", createdAt: "2026-11-27T00:00:00Z", payload: { text }
  })}\n\n`
}
