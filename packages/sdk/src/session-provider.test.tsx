// @vitest-environment happy-dom
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ShowSessionProvider, useShowSession, type ShowSessionContextValue, type ShowSessionProviderProps } from "./react.js"
import { TestEventSource, TestWebSocket, showFrame } from "../test/event-stream-fixture.js"

let root: Root
let container: HTMLDivElement
let latest: ShowSessionContextValue

function Consumer() {
  latest = useShowSession()
  return <output>{latest.events.map((event) => event.id).join(",")}</output>
}

function render(props: Omit<ShowSessionProviderProps, "children"> = {}) {
  act(() => root.render(<ShowSessionProvider {...props}><Consumer /></ShowSessionProvider>))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("WebSocket", TestWebSocket)
  vi.stubGlobal("EventSource", TestEventSource)
  vi.stubGlobal("__AVIBE_SHOW__", { basePath: "https://runtime.test/show/s/", eventStreamTransport: "websocket-sse-v1" })
  TestWebSocket.instances = []
  TestEventSource.instances = []
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("ShowSessionProvider consumes the shared subscription transport", () => {
  it("honors the injected capability with older explicit same-origin stream options", () => {
    render({ basePath: "https://runtime.test/show/s/", streamPath: "__show/events?stream=1" })
    expect(TestWebSocket.instances).toHaveLength(1)
    expect(TestWebSocket.instances[0].url).toBe("wss://runtime.test/show/s/__show/events?stream=1")
    expect(TestEventSource.instances).toHaveLength(0)
    act(() => TestWebSocket.instances[0].receive(showFrame("injected-capability")))
    expect(container.textContent).toBe("injected-capability")
  })

  it("receives actual parsed frames and resumes through its single WS reconnect owner", () => {
    const onEvent = vi.fn()
    const seed = JSON.parse(showFrame("seed").split("data: ")[1]) // includes only trailing whitespace
    render({ initialEvents: [seed], onEvent })
    const socket = TestWebSocket.instances[0]
    expect(new URL(socket.url).searchParams.get("after_id")).toBe("seed")
    act(() => {
      socket.open()
      socket.receive(showFrame("event_1", "中文"))
      socket.receive(showFrame("event_1", "duplicate"))
    })
    expect(latest.connected).toBe(true)
    expect(container.textContent).toBe("seed,event_1")
    expect(onEvent).toHaveBeenCalledOnce()
    act(() => socket.disconnect())
    expect(latest.connected).toBe(false)
    act(() => vi.advanceTimersByTime(500))
    expect(TestWebSocket.instances).toHaveLength(2)
    expect(new URL(TestWebSocket.instances[1].url).searchParams.get("after_id")).toBe("event_1")
    act(() => {
      TestWebSocket.instances[1].open()
      TestWebSocket.instances[1].receive(showFrame("event_2"))
    })
    expect(container.textContent).toBe("seed,event_1,event_2")
    expect(TestEventSource.instances).toHaveLength(0)
  })

  it("switches origins without sharing capability, cursor, deduplication or late deliveries", () => {
    const onEvent = vi.fn()
    const onError = vi.fn()
    render({ onEvent, onError })
    const socket = TestWebSocket.instances[0]
    const late = socket.onmessage
    act(() => socket.receive(showFrame("same-id", "original")))
    render({ basePath: "https://old-runtime.test/p/share/", onEvent, onError })
    expect(socket.closeCount).toBe(1)
    expect(container.textContent).toBe("")
    expect(latest.lastEventId).toBeUndefined()
    const sse = TestEventSource.instances[0]
    expect(new URL(sse.url).searchParams.has("after_id")).toBe(false)
    act(() => {
      late?.(new MessageEvent("message", { data: showFrame("stale") }))
      sse.receive(JSON.stringify({ id: "same-id", type: "system.runtime.status", payload: { text: "new source" } }))
    })
    expect(container.textContent).toBe("same-id")
    expect(latest.events[0]).toMatchObject({ payload: { text: "new source" } })
    expect(onEvent).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
    // Even a manually queued EventSource callback is ignored once its owner closes.
    render({ basePath: "https://new-runtime.test/show/s2/", eventStreamTransport: "websocket-sse-v1" })
    expect(sse.closeCount).toBe(1)
    act(() => sse.receive("{invalid stale data"))
    expect(container.textContent).toBe("")
    expect(onError).not.toHaveBeenCalled()
    expect(new URL(TestWebSocket.instances[1].url).searchParams.has("after_id")).toBe(false)
  })

  it("updates callbacks without replacing the subscription", () => {
    const original = vi.fn()
    const replacement = vi.fn()
    render({ onEvent: original })
    render({ onEvent: replacement })
    expect(TestWebSocket.instances).toHaveLength(1)
    act(() => TestWebSocket.instances[0].receive(showFrame("live")))
    expect(original).not.toHaveBeenCalled()
    expect(replacement).toHaveBeenCalledOnce()
  })

  it("keeps WS failures as failures and cancels retries when autoConnect is disabled", () => {
    render()
    act(() => TestWebSocket.instances[0].fail())
    expect(latest.connected).toBe(false)
    expect(TestEventSource.instances).toHaveLength(0)
    render({ autoConnect: false })
    act(() => vi.advanceTimersByTime(120_000))
    expect(TestWebSocket.instances).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("unmount cancels a pending reconnect and prevents queued messages reaching callbacks", () => {
    const onEvent = vi.fn()
    render({ onEvent })
    const socket = TestWebSocket.instances[0]
    const late = socket.onmessage
    act(() => socket.fail())
    act(() => root.unmount())
    late?.(new MessageEvent("message", { data: showFrame("after-unmount") }))
    vi.advanceTimersByTime(120_000)
    expect(onEvent).not.toHaveBeenCalled()
    expect(socket.closeCount).toBe(1)
    expect(TestWebSocket.instances).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not require the EventSource API when WS was advertised", () => {
    vi.stubGlobal("EventSource", undefined)
    render()
    act(() => TestWebSocket.instances[0].receive(showFrame("ws-only")))
    expect(container.textContent).toBe("ws-only")
  })

  it("preserves old Runtime SSE and reports malformed live payloads through onError", () => {
    vi.stubGlobal("__AVIBE_SHOW__", { basePath: "https://old-runtime.test/show/s/" })
    const onError = vi.fn()
    render({ onError })
    const sse = TestEventSource.instances[0]
    act(() => sse.receive("{invalid"))
    expect(latest.error).toBeInstanceOf(Error)
    expect(onError).toHaveBeenCalledOnce()
    act(() => sse.receive(JSON.stringify({ id: "sse-event", type: "system.runtime.status" })))
    expect(container.textContent).toBe("sse-event")
    expect(TestWebSocket.instances).toHaveLength(0)
  })
})
