import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { subscribeShowEvents } from "./index.js"
import { TestEventSource, TestWebSocket, showFrame } from "../test/event-stream-fixture.js"

beforeEach(() => {
  vi.useFakeTimers()
  TestWebSocket.instances = []
  TestEventSource.instances = []
  vi.stubGlobal("WebSocket", TestWebSocket)
  vi.stubGlobal("EventSource", TestEventSource)
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")))
  vi.stubGlobal("location", new URL("https://runtime.test/show/session/index.html"))
  vi.stubGlobal("__AVIBE_SHOW__", { basePath: "/show/session/" })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const websocketOptions = { eventStreamTransport: "websocket-sse-v1" } as const

describe("Show event transport capability boundary", () => {
  it("preserves native SSE for a new SDK and an old Runtime", () => {
    const source = subscribeShowEvents({ afterId: "old cursor" })
    expect(source).toBeInstanceOf(TestEventSource)
    expect(source.url).toBe("https://runtime.test/show/session/__show/events?stream=1&after_id=old+cursor")
    expect(TestWebSocket.instances).toHaveLength(0)
    source.close()
  })

  it.each([
    ["http://runtime.test/show/session/__show/events?stream=1&extra=a", "ws:"],
    ["https://runtime.test/p/share/__show/events?stream=1&extra=a", "wss:"],
    ["ws://runtime.test/show/session/__show/events?stream=1&extra=a", "ws:"],
    ["wss://runtime.test/p/share/__show/events?stream=1&extra=a", "wss:"]
  ])("changes only the scheme and cursor of %s", (streamPath, protocol) => {
    const source = subscribeShowEvents({ ...websocketOptions, streamPath, afterId: "事件 1" })
    const expected = new URL(streamPath)
    expected.protocol = protocol
    expected.searchParams.set("after_id", "事件 1")
    expect(TestWebSocket.instances[0].url).toBe(expected.toString())
    expect(TestEventSource.instances).toHaveLength(0)
    source.close()
  })

  it("inherits an injected capability only within the injected stream origin", () => {
    vi.stubGlobal("__AVIBE_SHOW__", {
      basePath: "https://injected.test/show/s/",
      streamPath: "__show/events?stream=1",
      eventStreamTransport: "websocket-sse-v1"
    })
    const inherited = subscribeShowEvents({ streamPath: "custom?stream=1" })
    const foreign = subscribeShowEvents({ basePath: "https://old-runtime.test/p/share/" })
    const foreignStream = subscribeShowEvents({ streamPath: "https://old-runtime.test/p/other/__show/events?stream=1" })
    const explicitForeign = subscribeShowEvents({
      ...websocketOptions, streamPath: "https://new-runtime.test/p/share/__show/events?stream=1"
    })
    expect(inherited.url).toBe("wss://injected.test/show/s/custom?stream=1")
    expect(foreign).toBeInstanceOf(TestEventSource)
    expect(foreignStream).toBeInstanceOf(TestEventSource)
    expect(foreign.url).toBe("https://old-runtime.test/p/share/__show/events?stream=1")
    expect(explicitForeign.url).toBe("wss://new-runtime.test/p/share/__show/events?stream=1")
    for (const source of [inherited, foreign, foreignStream, explicitForeign]) source.close()
  })
})

describe("WebSocket SSE decoding and EventSource interface", () => {
  it("delivers fragmented and batched frames with unchanged names, Unicode payloads and IDs", () => {
    const source = subscribeShowEvents(websocketOptions)
    const events: MessageEvent[] = []
    source.addEventListener("show.event", (event) => events.push(event as MessageEvent))
    const socket = TestWebSocket.instances[0]
    const text = "\uFEFF: heartbeat\r\n\r\nevent: show.event\r\nid: 事件_1\r\ndata: {\"text\":\r\ndata: \"你好 🐈\"}\r\n\r\n"
    for (const character of text) socket.receive(character)
    socket.receive(`${showFrame("event_2")}event: show.event\nid: ignored\0id\ndata: final\n\n`)
    expect(events.map((event) => [event.type, event.data, event.lastEventId])).toEqual([
      ["show.event", "{\"text\":\n\"你好 🐈\"}", "事件_1"],
      ["show.event", JSON.stringify({ id: "event_2", type: "system.runtime.status", createdAt: "2026-11-27T00:00:00Z", payload: { text: "event_2" } }), "event_2"],
      ["show.event", "final", "event_2"]
    ])
    expect(events[0].origin).toBe("wss://runtime.test")
    source.close()
  })

  it("supports open/error/message properties, readyState, removable listeners and once listeners", async () => {
    const source = subscribeShowEvents(websocketOptions)
    expect(source.readyState).toBe(source.CONNECTING)
    const opened = vi.fn()
    const failed = vi.fn()
    const message = vi.fn()
    const once = vi.fn()
    const removed = vi.fn()
    source.onopen = opened
    source.onerror = failed
    source.onmessage = message
    source.addEventListener("message", once, { once: true })
    source.addEventListener("message", removed)
    source.removeEventListener("message", removed)
    const socket = TestWebSocket.instances[0]
    socket.open()
    expect(source.readyState).toBe(source.OPEN)
    socket.receive("data: first\n\ndata: second\n\n")
    expect(opened).toHaveBeenCalledOnce()
    expect(message).toHaveBeenCalledTimes(2)
    expect(once).toHaveBeenCalledOnce()
    expect(removed).not.toHaveBeenCalled()
    socket.fail()
    await vi.advanceTimersByTimeAsync(0)
    expect(failed).toHaveBeenCalledOnce()
    expect(source.readyState).toBe(source.CONNECTING)
    source.close()
    expect(source.readyState).toBe(source.CLOSED)
  })

  it("does not dispatch incomplete frames or comment heartbeats", async () => {
    const source = subscribeShowEvents(websocketOptions)
    const received = vi.fn()
    source.addEventListener("show.event", received)
    source.onmessage = received
    const socket = TestWebSocket.instances[0]
    socket.receive(": keepalive\n\nid: cursor-only\n\nevent: show.event\ndata: partial")
    expect(received).not.toHaveBeenCalled()
    socket.disconnect()
    await vi.advanceTimersByTimeAsync(0)
    vi.advanceTimersByTime(500)
    expect(new URL(TestWebSocket.instances[1].url).searchParams.get("after_id")).toBe("cursor-only")
    TestWebSocket.instances[1].receive("data: fresh\n\n")
    expect(received).toHaveBeenCalledOnce()
    expect(received.mock.calls[0][0].data).toBe("fresh")
    source.close()
  })
})

describe("WebSocket reconnect lifecycle", () => {
  it.each(["quiet", "heartbeats"])("resets outage backoff on open even with %s traffic", async (traffic) => {
    const source = subscribeShowEvents(websocketOptions)
    for (const delay of [500, 1000, 2000, 4000, 8000, 16000]) {
      TestWebSocket.instances.at(-1)!.fail()
      await vi.advanceTimersByTimeAsync(delay)
    }
    const recovered = TestWebSocket.instances.at(-1)!
    const count = TestWebSocket.instances.length
    recovered.open()
    if (traffic === "heartbeats") recovered.receive(": idle\n\n")
    recovered.disconnect()
    await vi.advanceTimersByTimeAsync(499)
    expect(TestWebSocket.instances).toHaveLength(count)
    await vi.advanceTimersByTimeAsync(1)
    expect(TestWebSocket.instances).toHaveLength(count + 1)
    source.close()
  })

  it("uses only WS through failures, with bounded exponential backoff and cursor replay", async () => {
    const source = subscribeShowEvents({ ...websocketOptions, afterId: "seed" })
    const delays = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]
    for (const delay of delays) {
      const socket = TestWebSocket.instances.at(-1)!
      const count = TestWebSocket.instances.length
      const lateClose = socket.onclose
      socket.fail()
      lateClose?.(new Event("close"))
      await vi.advanceTimersByTimeAsync(0)
      vi.advanceTimersByTime(delay - 1)
      expect(TestWebSocket.instances).toHaveLength(count)
      vi.advanceTimersByTime(1)
      expect(TestWebSocket.instances).toHaveLength(count + 1)
      expect(new URL(TestWebSocket.instances.at(-1)!.url).searchParams.get("after_id")).toBe("seed")
    }
    const recovered = TestWebSocket.instances.at(-1)!
    recovered.open()
    recovered.receive(showFrame("最新"))
    recovered.disconnect()
    await vi.advanceTimersByTimeAsync(0)
    vi.advanceTimersByTime(500)
    expect(new URL(TestWebSocket.instances.at(-1)!.url).searchParams.get("after_id")).toBe("最新")
    expect(TestEventSource.instances).toHaveLength(0)
    source.close()
  })

  it("honors empty ID reset and drops obsolete socket deliveries", async () => {
    const source = subscribeShowEvents({ ...websocketOptions, afterId: "seed" })
    const received = vi.fn()
    source.addEventListener("show.event", received)
    const old = TestWebSocket.instances[0]
    const late = old.onmessage
    old.receive("id:\n\n")
    old.disconnect()
    late?.(new MessageEvent("message", { data: showFrame("stale") }))
    await vi.advanceTimersByTimeAsync(500)
    expect(new URL(TestWebSocket.instances[1].url).searchParams.has("after_id")).toBe(false)
    expect(received).not.toHaveBeenCalled()
    source.close()
  })

  it.each(["connecting", "open", "retry"] as const)("close cancels a source while %s", async (state) => {
    const source = subscribeShowEvents(websocketOptions)
    const socket = TestWebSocket.instances[0]
    const lateMessage = socket.onmessage
    const lateOpen = socket.onopen
    const received = vi.fn()
    source.addEventListener("show.event", received)
    source.onopen = received
    if (state === "open") socket.open()
    received.mockClear()
    if (state === "retry") socket.fail()
    source.close()
    source.close()
    lateOpen?.(new Event("open"))
    lateMessage?.(new MessageEvent("message", { data: showFrame("stale") }))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(received).not.toHaveBeenCalled()
    expect(socket.closeCount).toBe(1)
    expect(TestWebSocket.instances).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reports constructor failures asynchronously, retries WS and never downgrades", async () => {
    const construct = vi.fn(function () { throw new Error("unavailable") })
    vi.stubGlobal("WebSocket", construct)
    const source = subscribeShowEvents(websocketOptions)
    const failed = vi.fn()
    source.onerror = failed
    await vi.advanceTimersByTimeAsync(0)
    expect(failed).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(500)
    expect(construct).toHaveBeenCalledTimes(2)
    expect(TestEventSource.instances).toHaveLength(0)
    source.close()
    vi.advanceTimersByTime(120_000)
    expect(construct).toHaveBeenCalledTimes(2)
  })
})

describe("Show WS admission failure classification", () => {
  it("calls the browser fetch without binding the EventSource as its receiver", async () => {
    const fetchImpl = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError("Illegal invocation")
      return Promise.resolve(new Response("denied", { status: 403 }))
    })
    vi.stubGlobal("fetch", fetchImpl)
    const source = subscribeShowEvents(websocketOptions)
    TestWebSocket.instances[0].fail()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl.mock.contexts).toEqual([undefined])
    expect(source.readyState).toBe(source.CLOSED)
    source.close()
  })

  it.each([400, 401, 403, 404, 405, 410])("closes on an authoritative %s without retry or SSE downgrade", async (status) => {
    const bodyCancelled = vi.fn(async () => {})
    const fetchImpl = vi.fn(async () => ({ status, body: { cancel: bodyCancelled } }) as unknown as Response)
    const source = subscribeShowEvents({ ...websocketOptions, afterId: "seed", fetch: fetchImpl })
    const errorStates: number[] = []
    source.onerror = () => errorStates.push(source.readyState)
    TestWebSocket.instances[0].receive(showFrame("最新"))
    TestWebSocket.instances[0].fail()
    await vi.advanceTimersByTimeAsync(0)
    expect(source.readyState).toBe(source.CLOSED)
    expect(errorStates).toEqual([source.CLOSED])
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe("https://runtime.test/show/session/__show/events?after_id=%E6%9C%80%E6%96%B0")
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", redirect: "manual", cache: "no-store" })
    expect(bodyCancelled).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(TestWebSocket.instances).toHaveLength(1)
    expect(TestEventSource.instances).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([200, 408, 425, 429, 500, 503])("keeps %s retryable without consuming its body as events", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not an event stream", { status })))
    const source = subscribeShowEvents(websocketOptions)
    const event = vi.fn()
    source.onmessage = event
    TestWebSocket.instances[0].fail()
    await vi.advanceTimersByTimeAsync(500)
    expect(source.readyState).toBe(source.CONNECTING)
    expect(TestWebSocket.instances).toHaveLength(2)
    expect(TestEventSource.instances).toHaveLength(0)
    expect(event).not.toHaveBeenCalled()
    source.close()
  })

  it("retries a network failure and preserves the public share path and cursor", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network unavailable"))
    const source = subscribeShowEvents({
      ...websocketOptions, fetch: fetchImpl, streamPath: "/p/share/__show/events?stream=1&extra=value", afterId: "cursor"
    })
    TestWebSocket.instances[0].fail()
    await vi.advanceTimersByTimeAsync(500)
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://runtime.test/p/share/__show/events?extra=value&after_id=cursor")
    expect(TestWebSocket.instances).toHaveLength(2)
    expect(new URL(TestWebSocket.instances[1].url).searchParams.get("after_id")).toBe("cursor")
    source.close()
  })

  it.each([true, false])("bounds a stalled probe without terminal denial (fetch honors signal=%s)", async (honorsSignal) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) =>
      new Promise((_resolve, reject) => {
        if (honorsSignal) init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    )
    const source = subscribeShowEvents({ ...websocketOptions, fetch: fetchImpl })
    TestWebSocket.instances[0].fail()
    await vi.advanceTimersByTimeAsync(3_499)
    expect(TestWebSocket.instances).toHaveLength(1)
    expect(source.readyState).toBe(source.CONNECTING)
    await vi.advanceTimersByTimeAsync(1)
    expect(TestWebSocket.instances).toHaveLength(2)
    source.close()
  })

  it("close aborts the probe and ignores a late denial from the disposed source", async () => {
    let resolve!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      signal = init?.signal
      return new Promise((done) => { resolve = done })
    })
    const source = subscribeShowEvents({ ...websocketOptions, fetch: fetchImpl })
    const error = vi.fn()
    source.onerror = error
    TestWebSocket.instances[0].fail()
    expect(signal?.aborted).toBe(false)
    source.close()
    expect(signal?.aborted).toBe(true)
    resolve(new Response("denied", { status: 403 }))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(error).not.toHaveBeenCalled()
    expect(TestWebSocket.instances).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    "/api/events",
    "/custom/events?stream=1",
    "https://foreign.test/p/share/__show/events?stream=1"
  ])("does not guess non-streaming or credential policy for %s", async (streamPath) => {
    const source = subscribeShowEvents({ ...websocketOptions, streamPath })
    TestWebSocket.instances[0].fail()
    await vi.advanceTimersByTimeAsync(500)
    expect(fetch).not.toHaveBeenCalled()
    expect(TestWebSocket.instances).toHaveLength(2)
    source.close()
  })

  it("treats a received WS policy-violation close as authoritative without HTTP", async () => {
    const source = subscribeShowEvents({ ...websocketOptions, streamPath: "/custom/events" })
    TestWebSocket.instances[0].onclose?.(Object.assign(new Event("close"), { code: 1008 }))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(source.readyState).toBe(source.CLOSED)
    expect(TestWebSocket.instances).toHaveLength(1)
    expect(fetch).not.toHaveBeenCalled()
  })
})
