import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { subscribeShowEvents } from "./index.js"
import { TestEventSource, TestWebSocket, showFrame } from "../test/event-stream-fixture.js"

beforeEach(() => {
  vi.useFakeTimers()
  TestWebSocket.instances = []
  TestEventSource.instances = []
  vi.stubGlobal("WebSocket", TestWebSocket)
  vi.stubGlobal("EventSource", TestEventSource)
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

  it("supports open/error/message properties, readyState, removable listeners and once listeners", () => {
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
    expect(failed).toHaveBeenCalledOnce()
    expect(source.readyState).toBe(source.CONNECTING)
    source.close()
    expect(source.readyState).toBe(source.CLOSED)
  })

  it("does not dispatch incomplete frames or comment heartbeats", () => {
    const source = subscribeShowEvents(websocketOptions)
    const received = vi.fn()
    source.addEventListener("show.event", received)
    source.onmessage = received
    const socket = TestWebSocket.instances[0]
    socket.receive(": keepalive\n\nid: cursor-only\n\nevent: show.event\ndata: partial")
    expect(received).not.toHaveBeenCalled()
    socket.disconnect()
    vi.advanceTimersByTime(500)
    expect(new URL(TestWebSocket.instances[1].url).searchParams.get("after_id")).toBe("cursor-only")
    TestWebSocket.instances[1].receive("data: fresh\n\n")
    expect(received).toHaveBeenCalledOnce()
    expect(received.mock.calls[0][0].data).toBe("fresh")
    source.close()
  })
})

describe("WebSocket reconnect lifecycle", () => {
  it("uses only WS through failures, with bounded exponential backoff and cursor replay", () => {
    const source = subscribeShowEvents({ ...websocketOptions, afterId: "seed" })
    const delays = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]
    for (const delay of delays) {
      const socket = TestWebSocket.instances.at(-1)!
      const count = TestWebSocket.instances.length
      const lateClose = socket.onclose
      socket.fail()
      lateClose?.(new Event("close"))
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
    vi.advanceTimersByTime(500)
    expect(new URL(TestWebSocket.instances.at(-1)!.url).searchParams.get("after_id")).toBe("最新")
    expect(TestEventSource.instances).toHaveLength(0)
    source.close()
  })

  it("honors empty ID reset and drops obsolete socket deliveries", () => {
    const source = subscribeShowEvents({ ...websocketOptions, afterId: "seed" })
    const received = vi.fn()
    source.addEventListener("show.event", received)
    const old = TestWebSocket.instances[0]
    const late = old.onmessage
    old.receive("id:\n\n")
    old.disconnect()
    late?.(new MessageEvent("message", { data: showFrame("stale") }))
    vi.advanceTimersByTime(500)
    expect(new URL(TestWebSocket.instances[1].url).searchParams.has("after_id")).toBe(false)
    expect(received).not.toHaveBeenCalled()
    source.close()
  })

  it.each(["connecting", "open", "retry"] as const)("close cancels a source while %s", (state) => {
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
    vi.advanceTimersByTime(120_000)
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
    await vi.runAllTicks()
    expect(failed).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(500)
    await vi.runAllTicks()
    expect(construct).toHaveBeenCalledTimes(2)
    expect(TestEventSource.instances).toHaveLength(0)
    source.close()
    vi.advanceTimersByTime(120_000)
    expect(construct).toHaveBeenCalledTimes(2)
  })
})
