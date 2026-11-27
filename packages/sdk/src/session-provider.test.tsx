// @vitest-environment happy-dom
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ShowSessionProvider, useShowSession, type ShowSessionContextValue, type ShowSessionProviderProps } from "./react.js"
import { TestEventSource, TestWebSocket, showFrame } from "../test/event-stream-fixture.js"
import { SHOW_EVENT_WRITE_TOKEN_HEADER, type ShowEvent } from "./index.js"

let root: Root
let container: HTMLDivElement
let latest: ShowSessionContextValue
let setDraft: React.Dispatch<React.SetStateAction<string>>
let mounts: number
let unmounts: number
let observed: Array<{ config: ShowSessionContextValue["config"]; ids: string[]; cursor?: string; connected: boolean; error: Error | null }>

function Consumer() {
  latest = useShowSession()
  const [draft, updateDraft] = React.useState("")
  setDraft = updateDraft
  React.useEffect(() => {
    mounts += 1
    return () => { unmounts += 1 }
  }, [])
  observed.push({ config: latest.config, ids: latest.events.map((event) => event.id), cursor: latest.lastEventId, connected: latest.connected, error: latest.error })
  return <><input value={draft} onChange={(event) => updateDraft(event.target.value)} /><output>{latest.events.map((event) => event.id).join(",")}</output></>
}

function render(props: Omit<ShowSessionProviderProps, "children"> = {}) {
  act(() => root.render(<ShowSessionProvider {...props}><Consumer /></ShowSessionProvider>))
}

function event(id: string): ShowEvent {
  return JSON.parse(showFrame(id).split("data: ")[1]) as ShowEvent
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("WebSocket", TestWebSocket)
  vi.stubGlobal("EventSource", TestEventSource)
  vi.stubGlobal("location", new URL("https://runtime.test/show/s/index.html"))
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")))
  vi.stubGlobal("__AVIBE_SHOW__", { basePath: "https://runtime.test/show/s/", eventStreamTransport: "websocket-sse-v1" })
  TestWebSocket.instances = []
  TestEventSource.instances = []
  mounts = 0
  unmounts = 0
  observed = []
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

  it("receives actual parsed frames and resumes through its single WS reconnect owner", async () => {
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
    await act(async () => socket.disconnect())
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

  it("disconnects after an authoritative denial without creating a replacement stream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })))
    render()
    const socket = TestWebSocket.instances[0]
    act(() => socket.open())
    expect(latest.connected).toBe(true)
    await act(async () => socket.fail())
    expect(latest.connected).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(120_000))
    expect(TestWebSocket.instances).toHaveLength(1)
    expect(TestEventSource.instances).toHaveLength(0)
  })

  it("leaves an old Runtime disconnected when the host has no EventSource API", () => {
    vi.stubGlobal("EventSource", undefined)
    vi.stubGlobal("__AVIBE_SHOW__", { basePath: "https://old-runtime.test/show/s/" })
    const onError = vi.fn()
    render({ onError })
    expect(latest.connected).toBe(false)
    expect(latest.error).toBeNull()
    expect(TestWebSocket.instances).toHaveLength(0)
    expect(onError).not.toHaveBeenCalled()
  })

  it("keeps the missing-SSE-API no-op scoped to the selected foreign origin", () => {
    vi.stubGlobal("EventSource", undefined)
    render({ streamPath: "https://old-runtime.test/p/share/__show/events?stream=1" })
    expect(latest.connected).toBe(false)
    expect(latest.error).toBeNull()
    expect(TestWebSocket.instances).toHaveLength(0)
    // The explicit capability describes that target and can still select WS.
    render({
      streamPath: "https://new-runtime.test/p/share/__show/events?stream=1",
      eventStreamTransport: "websocket-sse-v1"
    })
    act(() => TestWebSocket.instances[0].receive(showFrame("foreign-ws")))
    expect(container.textContent).toBe("foreign-ws")
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

describe("ShowSessionProvider source lifetime preserves the application", () => {
  const changes: Array<[string, Omit<ShowSessionProviderProps, "children">]> = [
    ["sessionId", { sessionId: "replacement" }],
    ["basePath", { basePath: "https://replacement.test/show/next/" }],
    ["streamPath", { streamPath: "/show/next/__show/events?stream=1" }],
    ["eventsPath", { eventsPath: "/show/next/__show/events" }]
  ]

  it.each(changes)("preserves consumer draft and mount identity across %s source changes", (_name, replacement) => {
    render()
    act(() => {
      setDraft("unsent draft")
      TestWebSocket.instances[0].open()
      TestWebSocket.instances[0].receive(showFrame("old"))
    })
    render(replacement)
    expect(container.querySelector("input")?.value).toBe("unsent draft")
    expect(mounts).toBe(1)
    expect(unmounts).toBe(0)
    expect(latest.events).toEqual([])
    expect(latest.lastEventId).toBeUndefined()
    expect(latest.connected).toBe(false)
    expect(latest.error).toBeNull()
  })

  it.each(changes)("never exposes prior source state on the first %s switched render, including queued updates", (_name, replacement) => {
    // Use SSE so queued handlers can be driven directly after disposal too.
    vi.stubGlobal("__AVIBE_SHOW__", { basePath: "https://runtime.test/show/s/" })
    render()
    const source = TestEventSource.instances[0]
    act(() => {
      source.onopen?.(new Event("open"))
      source.receive("{malformed")
      source.receive(JSON.stringify(event("old")))
    })
    expect(latest.connected).toBe(true)
    expect(latest.error).toBeInstanceOf(Error)
    observed = []
    act(() => {
      source.receive(JSON.stringify(event("queued-old")))
      root.render(<ShowSessionProvider {...replacement}><Consumer /></ShowSessionProvider>)
    })
    expect(observed.length).toBeGreaterThan(0)
    for (const frame of observed) {
      expect(frame.ids).toEqual([])
      expect(frame.cursor).toBeUndefined()
      expect(frame.connected).toBe(false)
      expect(frame.error).toBeNull()
    }
  })

  it("switches effective transport while retaining consumer identity", () => {
    render()
    act(() => { setDraft("keep"); TestWebSocket.instances[0].receive(showFrame("old")) })
    vi.stubGlobal("__AVIBE_SHOW__", { basePath: "https://runtime.test/show/s/" })
    render()
    expect(TestWebSocket.instances[0].closeCount).toBe(1)
    expect(TestEventSource.instances).toHaveLength(1)
    expect(latest.events).toEqual([])
    expect(container.querySelector("input")?.value).toBe("keep")
    render({ eventStreamTransport: "websocket-sse-v1" })
    expect(TestEventSource.instances[0].closeCount).toBe(1)
    expect(TestWebSocket.instances).toHaveLength(2)
    expect(mounts).toBe(1)
    expect(unmounts).toBe(0)
  })

  it("seeds each source once without reseeding same-source renders", () => {
    render({ initialEvents: [event("seed-a")] })
    expect(new URL(TestWebSocket.instances[0].url).searchParams.get("after_id")).toBe("seed-a")
    render({ initialEvents: [event("ignored-new-seed")] })
    expect(container.textContent).toBe("seed-a")
    expect(TestWebSocket.instances).toHaveLength(1)
    const onEvent = vi.fn()
    render({ sessionId: "next", initialEvents: [event("seed-b")], onEvent })
    expect(container.textContent).toBe("seed-b")
    expect(new URL(TestWebSocket.instances[1].url).searchParams.get("after_id")).toBe("seed-b")
    act(() => TestWebSocket.instances[1].receive(showFrame("seed-b")))
    expect(container.textContent).toBe("seed-b")
    expect(onEvent).not.toHaveBeenCalled()
    act(() => TestWebSocket.instances[1].receive(showFrame("seed-a")))
    expect(container.textContent).toBe("seed-b,seed-a")
  })

  it.each(["source switch", "autoConnect", "options"])("ignores every queued callback from a disposed subscription after %s", (reason) => {
    vi.stubGlobal("__AVIBE_SHOW__", { basePath: "https://runtime.test/show/s/" })
    const onEvent = vi.fn()
    const onError = vi.fn()
    render({ onEvent, onError })
    const old = TestEventSource.instances[0]
    const open = old.onopen
    const error = old.onerror
    if (reason === "source switch") render({ sessionId: "next", onEvent, onError })
    if (reason === "autoConnect") render({ autoConnect: false, onEvent, onError })
    if (reason === "options") render({ writeToken: "replacement", onEvent, onError })
    expect(old.closeCount).toBe(1)
    act(() => {
      open?.(new Event("open"))
      error?.(new Event("error"))
      old.receive(JSON.stringify(event("stale")))
      old.receive("{invalid stale")
    })
    expect(latest.connected).toBe(false)
    expect(latest.error).toBeNull()
    expect(latest.events).toEqual([])
    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    if (reason === "autoConnect") {
      render({ onEvent, onError })
      expect(TestEventSource.instances).toHaveLength(2)
    }
  })

  it.each(["HTTP", "JSON"])("ignores refresh completions from a previous source at the %s await", async (boundary) => {
    const http = deferred<Response>()
    const body = deferred<{ events: ShowEvent[] }>()
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(http.promise)
    render({ fetch: fetchImpl })
    const operation = latest.refresh()
    expect(fetchImpl).toHaveBeenCalledOnce()
    if (boundary === "JSON") {
      await act(async () => http.resolve({ ok: true, json: () => body.promise } as Response))
    }
    render({ sessionId: "next", initialEvents: [event("next-seed")] })
    if (boundary === "HTTP") http.resolve({ ok: true, json: () => body.promise } as Response)
    body.resolve({ events: [event("old-refresh")] })
    await act(async () => operation)
    expect(container.textContent).toBe("next-seed")
    expect(latest.lastEventId).toBe("next-seed")
    act(() => TestWebSocket.instances[1].receive(showFrame("old-refresh")))
    expect(container.textContent).toBe("next-seed,old-refresh")
  })

  it("keeps refresh rejection semantics after a source switch", async () => {
    const http = deferred<Response>()
    render({ fetch: vi.fn<typeof fetch>().mockReturnValue(http.promise) })
    const operation = latest.refresh()
    const failure = expect(operation).rejects.toThrow("Show events refresh failed: 403")
    render({ sessionId: "next" })
    http.resolve(new Response("denied", { status: 403 }))
    await act(async () => failure)
    expect(latest.events).toEqual([])
    expect(latest.error).toBeNull()
  })

  it("does not revive an earlier source lifetime when its URL is selected again", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true, event: event("obsolete") }))
    render({ sessionId: "original", fetch: fetchImpl })
    const oldSubmit = latest.submitEvent
    render({ sessionId: "other", fetch: fetchImpl })
    render({ sessionId: "original", fetch: fetchImpl })
    await act(async () => { await oldSubmit(event("retained")) })
    expect(latest.events).toEqual([])
    act(() => TestWebSocket.instances[2].receive(showFrame("obsolete")))
    expect(latest.events.map((value) => value.id)).toEqual(["obsolete"])
  })

  it.each(["submitEvent", "submitIntent", "submitAnnotation"] as const)("ignores previous-source %s results while preserving caller results", async (method) => {
    const http = deferred<Response>()
    const body = deferred<unknown>()
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(http.promise)
    const onEvent = vi.fn()
    render({ fetch: fetchImpl, onEvent, sessionId: "original" })
    const operation = method === "submitEvent" ? latest.submitEvent(event("submitted"))
      : method === "submitIntent" ? latest.submitIntent({ text: "intent" })
        : latest.submitAnnotation({ id: "annotation", intent: "comment", text: "comment" })
    await act(async () => http.resolve({ ok: true, json: () => body.promise } as Response))
    const replacementCallback = vi.fn()
    render({ sessionId: "next", onEvent: replacementCallback })
    const result = { ok: true, event: event("server-result") }
    body.resolve(result)
    let received: unknown
    await act(async () => { received = await operation })
    expect(received).toBe(result)
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).sessionId).toBe("original")
    expect(latest.events).toEqual([])
    expect(latest.lastEventId).toBeUndefined()
    expect(onEvent).not.toHaveBeenCalled()
    expect(replacementCallback).not.toHaveBeenCalled()
  })

  it("retained old operations cannot affect or retarget a replacement source", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) =>
      jsonResponse(init?.method === "POST" ? { ok: true, event: event("old-submit") } : { events: [event("old-refresh")] }))
    vi.stubGlobal("__AVIBE_SHOW__", { basePath: "https://runtime.test/show/old/", sessionId: "old", writeToken: "old-token", eventStreamTransport: "websocket-sse-v1" })
    render({ fetch: fetchImpl })
    const old = latest
    vi.stubGlobal("__AVIBE_SHOW__", { basePath: "https://runtime.test/show/new/", sessionId: "new", writeToken: "new-token", eventStreamTransport: "websocket-sse-v1" })
    const onEvent = vi.fn()
    render({ onEvent })
    await act(async () => {
      await old.refresh()
      expect(await old.submitEvent(event("retained"))).toMatchObject({ ok: true })
    })
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://runtime.test/show/old/__show/events", "https://runtime.test/show/old/__show/events"
    ])
    expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({ [SHOW_EVENT_WRITE_TOKEN_HEADER]: "old-token" })
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)).sessionId).toBe("old")
    expect(latest.events).toEqual([])
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("updates same-source client options without resetting consumer state", async () => {
    const fetchA = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true, event: event("a") }))
    const fetchB = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ ok: true, event: event("b") }))
    render({ fetch: fetchA, writeToken: "token-a" })
    act(() => { setDraft("keep"); TestWebSocket.instances[0].receive(showFrame("live")) })
    render({ fetch: fetchB, writeToken: "token-b" })
    expect(TestWebSocket.instances[0].closeCount).toBe(1)
    expect(new URL(TestWebSocket.instances[1].url).searchParams.get("after_id")).toBe("live")
    expect(container.textContent).toBe("live")
    expect(container.querySelector("input")?.value).toBe("keep")
    await act(async () => { await latest.submitEvent(event("request")) })
    expect(fetchA).not.toHaveBeenCalled()
    expect(fetchB.mock.calls[0][1]?.headers).toMatchObject({ [SHOW_EVENT_WRITE_TOKEN_HEADER]: "token-b" })
    expect(container.textContent).toBe("live,b")
    expect(mounts).toBe(1)
    expect(unmounts).toBe(0)
  })

  it("retains per-submit target and token overrides", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }))
    render({ basePath: "https://original.test/show/source/", fetch: fetchImpl, writeToken: "original" })
    await act(async () => { await latest.submitEvent(event("override"), { basePath: "https://override.test/show/other/", writeToken: "override", sessionId: "other" }) })
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://override.test/show/other/__show/events")
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ [SHOW_EVENT_WRITE_TOKEN_HEADER]: "override" })
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).sessionId).toBe("other")
  })

  it("updates error callbacks without replacing the subscription", () => {
    const original = vi.fn()
    const replacement = vi.fn()
    render({ onError: original })
    render({ onError: replacement })
    act(() => TestWebSocket.instances[0].receive("event: show.event\ndata: {invalid\n\n"))
    expect(original).not.toHaveBeenCalled()
    expect(replacement).toHaveBeenCalledOnce()
    expect(TestWebSocket.instances).toHaveLength(1)
  })

  it.each(["refresh", "submit"])("unmount isolates a pending %s completion and preserves its caller contract", async (operation) => {
    const http = deferred<Response>()
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(http.promise)
    const onEvent = vi.fn()
    const onError = vi.fn()
    render({ fetch: fetchImpl, onEvent, onError })
    const pending = operation === "refresh" ? latest.refresh() : latest.submitEvent(event("submitted"))
    act(() => root.unmount())
    const result = operation === "refresh" ? { events: [event("late")] } : { ok: true, event: event("late") }
    http.resolve(jsonResponse(result))
    await act(async () => { expect(await pending).toEqual(operation === "refresh" ? undefined : result) })
    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("refresh replaces cursor and dedup before the next same-source subscription", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ events: [event("refreshed")] }))
    render({ fetch: fetchImpl, initialEvents: [event("old")] })
    await act(async () => latest.refresh())
    render({ fetch: fetchImpl, autoConnect: false })
    render({ fetch: fetchImpl })
    expect(new URL(TestWebSocket.instances[1].url).searchParams.get("after_id")).toBe("refreshed")
    act(() => TestWebSocket.instances[1].receive(showFrame("old")))
    expect(container.textContent).toBe("refreshed,old")
  })

  it("keeps one live subscription under StrictMode", () => {
    const onEvent = vi.fn()
    act(() => root.render(<React.StrictMode><ShowSessionProvider onEvent={onEvent}><Consumer /></ShowSessionProvider></React.StrictMode>))
    act(() => setDraft("strict draft"))
    expect(TestWebSocket.instances.filter((socket) => socket.closeCount === 0)).toHaveLength(1)
    const live = TestWebSocket.instances.at(-1)!
    act(() => {
      for (const socket of TestWebSocket.instances) socket.receive(showFrame("event"))
      live.receive(showFrame("event"))
    })
    expect(onEvent).toHaveBeenCalledOnce()
    expect(container.textContent).toBe("event")
    const before = { mounts, unmounts }
    act(() => root.render(<React.StrictMode><ShowSessionProvider sessionId="next" onEvent={onEvent}><Consumer /></ShowSessionProvider></React.StrictMode>))
    expect({ mounts, unmounts }).toEqual(before)
    expect(container.querySelector("input")?.value).toBe("strict draft")
    expect(latest.events).toEqual([])
    expect(TestWebSocket.instances.filter((socket) => socket.closeCount === 0)).toHaveLength(1)
  })
})

describe("ShowSessionProvider commit and operation boundaries", () => {
  it("preserves caller rejection from pending and retained submissions", async () => {
    const http = deferred<Response>()
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(http.promise)
    render({ fetch: fetchImpl })
    const old = latest
    const pending = old.submitEvent(event("pending"))
    const pendingFailure = expect(pending).rejects.toThrow("Show event submit failed: 403")
    render({ sessionId: "replacement" })
    const retained = old.submitIntent({ text: "retained" })
    const retainedFailure = expect(retained).rejects.toThrow("Show event submit failed: 403")
    http.resolve(new Response("denied", { status: 403 }))
    await act(async () => { await Promise.all([pendingFailure, retainedFailure]) })
    expect(latest.events).toEqual([])
    expect(latest.error).toBeNull()
  })

  it("ignores a submit response delayed before its HTTP resolution", async () => {
    const http = deferred<Response>()
    const onEvent = vi.fn()
    render({ fetch: vi.fn<typeof fetch>().mockReturnValue(http.promise), onEvent })
    const pending = latest.submitEvent(event("pending"))
    render({ sessionId: "replacement", onEvent })
    const result = { ok: true, event: event("late") }
    http.resolve(jsonResponse(result))
    await act(async () => { expect(await pending).toEqual(result) })
    expect(latest.events).toEqual([])
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("preserves per-event session identity ahead of injected submission defaults", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ ok: true }))
    vi.stubGlobal("__AVIBE_SHOW__", { basePath: "https://runtime.test/show/s/", sessionId: "injected", eventStreamTransport: "websocket-sse-v1" })
    render({ fetch: fetchImpl })
    await act(async () => {
      await latest.submitEvent({ ...event("explicit"), sessionId: "event-session" })
      await latest.submitEvent(event("fallback"))
    })
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).sessionId)).toEqual(["event-session", "injected"])
  })

  it("captures the legacy document session fallback for a retained operation", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ ok: true }))
    render({ fetch: fetchImpl })
    const oldSubmit = latest.submitEvent
    vi.stubGlobal("__AVIBE_SHOW__", { basePath: "https://runtime.test/show/new/", sessionId: "new", eventStreamTransport: "websocket-sse-v1" })
    render()
    await act(async () => { await oldSubmit(event("retained")) })
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).sessionId).toBe("s")
    expect(latest.events).toEqual([])
  })

  it("allows an operation started by a child layout effect to update its committed source", async () => {
    const http = deferred<Response>()
    let pending!: Promise<void>
    function LayoutConsumer() {
      const context = useShowSession()
      React.useLayoutEffect(() => { pending = context.refresh() }, [context.refresh])
      return <Consumer />
    }
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(http.promise)
    act(() => root.render(<ShowSessionProvider fetch={fetchImpl}><LayoutConsumer /></ShowSessionProvider>))
    http.resolve(jsonResponse({ events: [event("layout-refresh")] }))
    await act(async () => pending)
    expect(latest.events.map((value) => value.id)).toEqual(["layout-refresh"])
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("keeps the committed source live when a concurrent replacement render is abandoned", async () => {
    const never = new Promise<void>(() => {})
    function SuspendReplacement() {
      if (useShowSession().config.sessionId === "suspended") throw never
      return null
    }
    function application(sessionId: string) {
      return <React.Suspense fallback={<span>pending</span>}><ShowSessionProvider sessionId={sessionId}><Consumer /><SuspendReplacement /></ShowSessionProvider></React.Suspense>
    }
    await act(async () => root.render(application("original")))
    act(() => setDraft("committed draft"))
    const socket = TestWebSocket.instances[0]
    await act(async () => React.startTransition(() => root.render(application("suspended"))))
    expect(socket.closeCount).toBe(0)
    act(() => socket.receive(showFrame("still-current")))
    await act(async () => root.render(application("original")))
    expect(latest.events.map((value) => value.id)).toEqual(["still-current"])
    expect(container.querySelector("input")?.value).toBe("committed draft")
    expect(TestWebSocket.instances).toHaveLength(1)
    expect(mounts).toBe(1)
  })
})

describe("ShowSessionProvider hidden but mounted lifetimes", () => {
  it("retains events, submit results and connection errors while Suspense hides the Provider", async () => {
    const submission = deferred<Response>()
    const suspended = deferred<void>()
    let hidden = false
    const onEvent = vi.fn()
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) =>
      init?.method === "POST" ? submission.promise : jsonResponse({ events: [] }))
    function PendingChild() {
      if (hidden) throw suspended.promise
      return null
    }
    function application() {
      return <React.Suspense fallback={<span data-fallback="true">pending</span>}><ShowSessionProvider fetch={fetchImpl} onEvent={onEvent}><Consumer /><PendingChild /></ShowSessionProvider></React.Suspense>
    }
    act(() => root.render(application()))
    const socket = TestWebSocket.instances[0]
    act(() => {
      socket.open()
      setDraft("hidden draft")
    })
    const operation = latest.submitEvent(event("pending-submit"))
    hidden = true
    // Intentionally NOT a transition: React hides the displayed subtree and
    // disconnects layout effects, while leaving its passive subscription live.
    act(() => root.render(application()))
    expect(container.querySelector("[data-fallback]")).not.toBeNull()
    expect(socket.closeCount).toBe(0)
    expect(unmounts).toBe(0)
    const result = { ok: true, event: event("hidden-submit") }
    act(() => socket.receive(showFrame("hidden-stream", "隐藏期间")))
    submission.resolve(jsonResponse(result))
    await act(async () => { expect(await operation).toEqual(result) })
    expect(onEvent.mock.calls.map(([value]) => value.id)).toEqual(["hidden-stream", "hidden-submit"])
    await act(async () => socket.fail())
    hidden = false
    suspended.resolve()
    await act(async () => root.render(application()))
    expect(container.querySelector("[data-fallback]")).toBeNull()
    expect(latest.events.map((value) => value.id)).toEqual(["hidden-stream", "hidden-submit"])
    expect(latest.lastEventId).toBe("hidden-submit")
    expect(latest.connected).toBe(false)
    expect(container.querySelector("input")?.value).toBe("hidden draft")
    expect(mounts).toBe(1)
    expect(unmounts).toBe(0)
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(TestWebSocket.instances).toHaveLength(2)
    // The transport resumes its last received SSE ID; locally appended submit
    // results do not rewrite an already-owned transport cursor.
    expect(new URL(TestWebSocket.instances[1].url).searchParams.get("after_id")).toBe("hidden-stream")
    act(() => TestWebSocket.instances[1].open())
    expect(latest.connected).toBe(true)
  })

  it("resets connection state before reopening an Activity-hidden Provider", () => {
    function application(mode: "visible" | "hidden") {
      return <React.Activity mode={mode}><ShowSessionProvider><Consumer /></ShowSessionProvider></React.Activity>
    }
    act(() => root.render(application("visible")))
    const first = TestWebSocket.instances[0]
    act(() => {
      setDraft("activity draft")
      first.open()
      first.receive(showFrame("before-hidden"))
    })
    expect(latest.connected).toBe(true)
    act(() => root.render(application("hidden")))
    expect(first.closeCount).toBe(1)
    act(() => root.render(application("visible")))
    const replacement = TestWebSocket.instances[1]
    expect(replacement.closeCount).toBe(0)
    expect(latest.connected).toBe(false)
    expect(latest.events.map((value) => value.id)).toEqual(["before-hidden"])
    expect(new URL(replacement.url).searchParams.get("after_id")).toBe("before-hidden")
    expect(container.querySelector("input")?.value).toBe("activity draft")
    act(() => replacement.open())
    expect(latest.connected).toBe(true)
    expect(TestWebSocket.instances.filter((socket) => socket.closeCount === 0)).toHaveLength(1)
  })

  it("rejects old stream errors between replacement layout commit and passive disposal", () => {
    vi.stubGlobal("__AVIBE_SHOW__", { basePath: "https://runtime.test/show/s/" })
    let original!: TestEventSource
    let closedDuringLayout: number | undefined
    const onError = vi.fn()
    function AfterProvider({ replaced }: { replaced: boolean }) {
      React.useLayoutEffect(() => {
        if (!replaced) return
        // The Provider's layout commit ran; old passive cleanup has not yet run.
        closedDuringLayout = original.closeCount
        original.onopen?.(new Event("open"))
        original.receive("{malformed old stream")
      }, [replaced])
      return null
    }
    function application(replaced: boolean) {
      return <><ShowSessionProvider sessionId={replaced ? "next" : "original"} onError={onError}><Consumer /></ShowSessionProvider><AfterProvider replaced={replaced} /></>
    }
    act(() => root.render(application(false)))
    original = TestEventSource.instances[0]
    act(() => root.render(application(true)))
    expect(closedDuringLayout).toBe(0)
    expect(original.closeCount).toBe(1)
    expect(onError).not.toHaveBeenCalled()
    expect(latest.error).toBeNull()
    expect(latest.connected).toBe(false)
    expect(latest.events).toEqual([])
  })

  it.each([undefined, "explicit-token"])("uses a runtime token supplied after the last Provider render (explicit=%s)", async (writeToken) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }))
    render({ fetch: fetchImpl, writeToken })
    const renderCount = observed.length
    vi.stubGlobal("__AVIBE_SHOW__", {
      basePath: "https://runtime.test/show/s/", eventStreamTransport: "websocket-sse-v1", writeToken: "late-token"
    })
    expect(observed).toHaveLength(renderCount)
    await act(async () => { await latest.submitEvent(event("late-token-submit")) })
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ [SHOW_EVENT_WRITE_TOKEN_HEADER]: writeToken ?? "late-token" })
  })
})
