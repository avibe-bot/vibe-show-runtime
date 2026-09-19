import { describe, expect, it, vi } from "vitest"

import {
  AnnotationVoiceError,
  ANNOTATION_VOICE_EVENT_MESSAGE,
  ANNOTATION_VOICE_REQUEST_MESSAGE,
  annotationVoiceEventFromPayload,
  annotationVoiceSnapshot,
  createAnnotationVoiceBridgeAdapter,
  createAnnotationVoiceStandaloneAdapter,
  insertAnnotationVoiceTranscript,
  type AnnotationVoiceEvent,
  type AnnotationVoiceRequest
} from "./annotation-voice.js"

describe("annotation voice text insertion", () => {
  it("inserts at the captured caret with language-aware boundaries", () => {
    const english = annotationVoiceSnapshot("Please review", 6, 6)
    expect(insertAnnotationVoiceTranscript("Please review", english, "carefully")).toEqual({
      ok: true,
      text: "Please carefully review",
      start: 6,
      end: 16
    })

    const chinese = annotationVoiceSnapshot("这里需要调整", 2, 2)
    expect(insertAnnotationVoiceTranscript("这里需要调整", chinese, "还")).toEqual({
      ok: true,
      text: "这里还需要调整",
      start: 2,
      end: 3
    })
  })

  it("replaces only the captured selection and refuses a changed draft", () => {
    const snapshot = annotationVoiceSnapshot("Keep  old  text", 5, 10)
    expect(insertAnnotationVoiceTranscript(snapshot.text, snapshot, "new")).toEqual({
      ok: true,
      text: "Keep  new  text",
      start: 5,
      end: 10
    })
    expect(insertAnnotationVoiceTranscript("Draft changed", snapshot, "new")).toEqual({
      ok: false,
      code: "draft_changed"
    })
    expect(insertAnnotationVoiceTranscript("Draft changed", snapshot, "  ")).toEqual({
      ok: false,
      code: "empty"
    })
  })

  it("separates dictated sentences from adjacent punctuation and words", () => {
    const afterSentence = annotationVoiceSnapshot("Please fix.", 11, 11)
    expect(insertAnnotationVoiceTranscript(afterSentence.text, afterSentence, "Also update tests")).toEqual({
      ok: true,
      text: "Please fix. Also update tests",
      start: 11,
      end: 29
    })

    const beforeWord = annotationVoiceSnapshot("today", 0, 0)
    expect(insertAnnotationVoiceTranscript(beforeWord.text, beforeWord, "Ready.")).toEqual({
      ok: true,
      text: "Ready. today",
      start: 0,
      end: 7
    })
  })
})

class FakeBridgeWindow {
  listener: ((event: MessageEvent) => void) | null = null

  addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
    this.listener = listener
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent) => void) {
    if (this.listener === listener) this.listener = null
  }

  dispatch(data: AnnotationVoiceEvent, source: unknown, origin = "https://show.test") {
    this.listener?.({ data, source, origin } as MessageEvent)
  }
}

const bridge = (dependencies: Parameters<typeof createAnnotationVoiceBridgeAdapter>[0] = {}) => {
  const targetWindow = new FakeBridgeWindow()
  const requests: AnnotationVoiceRequest[] = []
  const parent = {
    postMessage: (message: unknown) => requests.push(message as AnnotationVoiceRequest)
  }
  const adapter = createAnnotationVoiceBridgeAdapter({
    ...dependencies,
    window: targetWindow,
    parent,
    origin: "https://show.test"
  })
  const reply = (message: Omit<AnnotationVoiceEvent, "type">) => {
    targetWindow.dispatch({ type: ANNOTATION_VOICE_EVENT_MESSAGE, ...message } as AnnotationVoiceEvent, parent)
  }
  return { adapter, parent, reply, requests, targetWindow }
}

describe("annotation voice host bridge", () => {
  it("accepts only complete host event payloads", () => {
    expect(annotationVoiceEventFromPayload({
      type: ANNOTATION_VOICE_EVENT_MESSAGE,
      kind: "availability",
      requestId: "probe-1",
      available: true
    })).toMatchObject({ kind: "availability", available: true })
    expect(annotationVoiceEventFromPayload({
      type: ANNOTATION_VOICE_EVENT_MESSAGE,
      kind: "error",
      requestId: "voice-1",
      code: "timeout",
      retryable: true
    })).toMatchObject({ kind: "error", code: "timeout" })
    expect(annotationVoiceEventFromPayload({
      type: ANNOTATION_VOICE_EVENT_MESSAGE,
      kind: "error",
      requestId: "voice-1",
      code: "invented",
      retryable: false
    })).toBeUndefined()
  })

  it("queries availability from the owning client", async () => {
    const { adapter, reply, requests } = bridge()
    const available = adapter.isAvailable()
    expect(requests[0]).toMatchObject({
      type: ANNOTATION_VOICE_REQUEST_MESSAGE,
      action: "query"
    })
    reply({
      kind: "availability",
      requestId: requests[0]!.requestId,
      available: true
    })
    await expect(available).resolves.toBe(true)
  })

  it("ignores foreign availability replies and fails the probe closed", async () => {
    vi.useFakeTimers()
    try {
      const { adapter, parent, requests, targetWindow } = bridge()
      const available = adapter.isAvailable()
      const requestId = requests[0]!.requestId
      targetWindow.dispatch({
        type: ANNOTATION_VOICE_EVENT_MESSAGE,
        kind: "availability",
        requestId,
        available: true
      }, parent, "https://evil.test")
      await vi.advanceTimersByTimeAsync(1_500)
      await expect(available).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("starts, previews, stops, and returns the existing client's transcript", async () => {
    const { adapter, reply, requests } = bridge()
    const onPreview = vi.fn()
    const starting = adapter.start({ before: "before", after: "after", onPreview })
    const start = requests[0]!
    expect(start).toMatchObject({
      type: ANNOTATION_VOICE_REQUEST_MESSAGE,
      action: "start",
      before: "before",
      after: "after"
    })
    reply({ kind: "started", requestId: start.requestId })
    const session = await starting

    reply({ kind: "preview", requestId: start.requestId, text: "实时文字" })
    expect(onPreview).toHaveBeenCalledWith("实时文字")
    session.stop()
    expect(requests.at(-1)).toEqual({
      type: ANNOTATION_VOICE_REQUEST_MESSAGE,
      action: "stop",
      requestId: start.requestId
    })
    reply({ kind: "result", requestId: start.requestId, text: "整理后的文字" })
    await expect(session.done).resolves.toBe("整理后的文字")
  })

  it("times out a dropped start handshake and aborts the host request", async () => {
    vi.useFakeTimers()
    try {
      const { adapter, requests } = bridge({ startTimeoutMs: 2_000 })
      const starting = adapter.start({ before: "", after: "" })
      const rejection = expect(starting).rejects.toMatchObject<Partial<AnnotationVoiceError>>({ code: "timeout" })
      const requestId = requests[0]!.requestId

      await vi.advanceTimersByTimeAsync(2_000)

      await rejection
      expect(requests.at(-1)).toEqual({
        type: ANNOTATION_VOICE_REQUEST_MESSAGE,
        action: "abort",
        requestId
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("preserves a failed client session for retry and supports explicit discard", async () => {
    const { adapter, reply, requests } = bridge()
    const starting = adapter.start({ before: "", after: "" })
    const requestId = requests[0]!.requestId
    reply({ kind: "started", requestId })
    const session = await starting

    reply({ kind: "error", requestId, code: "timeout", retryable: true })
    await expect(session.done).rejects.toMatchObject<Partial<AnnotationVoiceError>>({
      code: "timeout",
      retryable: true
    })

    const retried = session.retry({ before: "latest before", after: "latest after" })
    expect(requests.at(-1)).toEqual({
      type: ANNOTATION_VOICE_REQUEST_MESSAGE,
      action: "retry",
      requestId,
      before: "latest before",
      after: "latest after"
    })
    reply({ kind: "result", requestId, text: "retry worked" })
    await expect(retried).resolves.toBe("retry worked")

    session.abort()
    expect(requests.at(-1)).toEqual({
      type: ANNOTATION_VOICE_REQUEST_MESSAGE,
      action: "abort",
      requestId
    })
  })
})

class FakeStandaloneRecorder {
  state = "inactive"
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  addEventListener(type: "dataavailable" | "error" | "stop", listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: "dataavailable" | "error" | "stop", listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  start() {
    this.state = "recording"
  }

  stop() {
    if (this.state === "inactive") return
    this.state = "inactive"
    this.emit("dataavailable", new Blob(["spoken"], { type: "audio/webm" }))
    this.emit("stop")
  }

  endUnexpectedly() {
    if (this.state === "inactive") return
    this.state = "inactive"
    this.emit("dataavailable", new Blob(["spoken"], { type: "audio/webm" }))
    this.emit("stop")
  }

  fail() {
    this.state = "inactive"
    this.emit("error")
  }

  private emit(type: "dataavailable" | "error" | "stop", data?: Blob) {
    const event = data
      ? ({ type, data } as unknown as Event)
      : ({ type } as Event)
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const fakeStream = () => {
  const stop = vi.fn()
  return {
    stream: { getTracks: () => [{ stop }] } as unknown as MediaStream,
    stop
  }
}

describe("standalone annotation voice adapter", () => {
  it("uses same-origin status, CSRF, and transcription endpoints", async () => {
    const recorder = new FakeStandaloneRecorder()
    const stream = fakeStream()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/asr/status") {
        return new Response(JSON.stringify({ available: true }), { status: 200 })
      }
      if (input === "/api/csrf-token") {
        return new Response(JSON.stringify({ csrf_token: "csrf-1" }), { status: 200 })
      }
      expect(input).toBe("/api/asr/transcribe")
      expect(init?.credentials).toBe("same-origin")
      expect(new Headers(init?.headers).get("X-Vibe-CSRF-Token")).toBe("csrf-1")
      const body = JSON.parse(String(init?.body)) as { data?: unknown; before?: string; after?: string }
      expect(body.data).toEqual(expect.any(String))
      expect(body.before).toBe("前")
      expect(body.after).toBe("后")
      return new Response(JSON.stringify({ text: "语音结果" }), { status: 200 })
    })
    const adapter = createAnnotationVoiceStandaloneAdapter({
      fetch: fetchMock,
      getUserMedia: async () => stream.stream,
      createRecorder: () => recorder,
      isTypeSupported: (mimeType) => mimeType === "audio/webm"
    })

    await expect(adapter.isAvailable()).resolves.toBe(true)
    const session = await adapter.start({ before: "前", after: "后" })
    session.stop()

    await expect(session.done).resolves.toBe("语音结果")
    expect(stream.stop).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith("/api/asr/status", expect.objectContaining({
      credentials: "same-origin"
    }))
  })

  it("retains the recording for a retryable transcription failure", async () => {
    const recorder = new FakeStandaloneRecorder()
    const stream = fakeStream()
    let transcriptionAttempts = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/asr/status") {
        return new Response(JSON.stringify({ available: true }), { status: 200 })
      }
      if (input === "/api/csrf-token") {
        return new Response(JSON.stringify({ csrf_token: "csrf-2" }), { status: 200 })
      }
      transcriptionAttempts += 1
      return transcriptionAttempts === 1
        ? new Response(JSON.stringify({ error: "transcription_timeout" }), { status: 504 })
        : new Response(JSON.stringify({ text: "重试结果" }), { status: 200 })
    })
    const adapter = createAnnotationVoiceStandaloneAdapter({
      fetch: fetchMock,
      getUserMedia: async () => stream.stream,
      createRecorder: () => recorder,
      isTypeSupported: () => false
    })

    const session = await adapter.start({ before: "", after: "" })
    session.stop()
    await expect(session.done).rejects.toMatchObject<Partial<AnnotationVoiceError>>({
      code: "timeout",
      retryable: true
    })

    await expect(session.retry({ before: "最新", after: "" })).resolves.toBe("重试结果")
    expect(transcriptionAttempts).toBe(2)
  })

  it("applies the transcription timeout while acquiring a CSRF token", async () => {
    vi.useFakeTimers()
    try {
      const recorder = new FakeStandaloneRecorder()
      const stream = fakeStream()
      let csrfSignal: AbortSignal | undefined
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input !== "/api/csrf-token") {
          throw new Error(`Unexpected request: ${String(input)}`)
        }
        csrfSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"))
          }, { once: true })
        })
      })
      const adapter = createAnnotationVoiceStandaloneAdapter({
        fetch: fetchMock,
        getUserMedia: async () => stream.stream,
        createRecorder: () => recorder,
        isTypeSupported: () => false
      })

      const session = await adapter.start({ before: "", after: "" })
      session.stop()
      const completed = expect(session.done).rejects.toMatchObject<Partial<AnnotationVoiceError>>({
        code: "timeout",
        retryable: true
      })

      await vi.advanceTimersByTimeAsync(180_000)
      await completed
      expect(csrfSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps caller cancellation wired through a pending transcription response", async () => {
    const recorder = new FakeStandaloneRecorder()
    const stream = fakeStream()
    const controller = new AbortController()
    let responseSignal: AbortSignal | undefined
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/csrf-token") {
        return new Response(JSON.stringify({ csrf_token: "csrf-4" }), { status: 200 })
      }
      responseSignal = init?.signal ?? undefined
      return {
        ok: true,
        json: () => new Promise<unknown>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"))
          }, { once: true })
        })
      } as Response
    })
    const adapter = createAnnotationVoiceStandaloneAdapter({
      fetch: fetchMock,
      getUserMedia: async () => stream.stream,
      createRecorder: () => recorder,
      isTypeSupported: () => false
    })

    const session = await adapter.start({ before: "", after: "", signal: controller.signal })
    session.stop()
    await vi.waitFor(() => expect(responseSignal).toBeDefined())

    const outcome = Promise.race([
      session.done.then(() => "resolved", (error) => error),
      new Promise<"hung">((resolve) => globalThis.setTimeout(() => resolve("hung"), 100))
    ])
    controller.abort()

    await expect(outcome).resolves.toMatchObject({ code: "cancelled" })
    expect(responseSignal?.aborted).toBe(true)
  })

  it("bounds a stalled availability probe", async () => {
    vi.useFakeTimers()
    try {
      const recorder = new FakeStandaloneRecorder()
      const stream = fakeStream()
      let statusSignal: AbortSignal | undefined
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe("/api/asr/status")
        statusSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"))
          }, { once: true })
        })
      })
      const adapter = createAnnotationVoiceStandaloneAdapter({
        fetch: fetchMock,
        getUserMedia: async () => stream.stream,
        createRecorder: () => recorder,
        isTypeSupported: () => false
      })

      const available = adapter.isAvailable()
      await vi.advanceTimersByTimeAsync(1_500)

      await expect(available).resolves.toBe(false)
      expect(statusSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not advertise voice without browser microphone capture support", async () => {
    vi.stubGlobal("navigator", { mediaDevices: {} })
    try {
      const fetchMock = vi.fn()
      const adapter = createAnnotationVoiceStandaloneAdapter({
        fetch: fetchMock,
        createRecorder: () => new FakeStandaloneRecorder(),
        isTypeSupported: () => false
      })

      await expect(adapter.isAvailable()).resolves.toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("classifies recorder start failures as start failures", async () => {
    const recorder = new FakeStandaloneRecorder()
    vi.spyOn(recorder, "start").mockImplementation(() => {
      throw new DOMException("unsupported", "NotSupportedError")
    })
    const stream = fakeStream()
    const adapter = createAnnotationVoiceStandaloneAdapter({
      fetch: vi.fn(),
      getUserMedia: async () => stream.stream,
      createRecorder: () => recorder,
      isTypeSupported: () => false
    })

    await expect(adapter.start({ before: "", after: "" })).rejects.toMatchObject({
      code: "start_failed",
      retryable: false
    })
    expect(stream.stop).toHaveBeenCalledOnce()
  })

  it("settles cancellation if the signal changes during microphone acquisition", async () => {
    const recorder = new FakeStandaloneRecorder()
    const stream = fakeStream()
    const controller = new AbortController()
    const getUserMedia = vi.fn(async () => {
      controller.abort()
      return stream.stream
    })
    const adapter = createAnnotationVoiceStandaloneAdapter({
      fetch: vi.fn(),
      getUserMedia,
      createRecorder: () => recorder,
      isTypeSupported: () => false
    })

    await expect(adapter.start({ before: "", after: "", signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled"
    })
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(stream.stop).toHaveBeenCalledOnce()
  })

  it("settles cancellation when an active recording is aborted", async () => {
    const recorder = new FakeStandaloneRecorder()
    const stream = fakeStream()
    const adapter = createAnnotationVoiceStandaloneAdapter({
      fetch: vi.fn(),
      getUserMedia: async () => stream.stream,
      createRecorder: () => recorder,
      isTypeSupported: () => false
    })

    const session = await adapter.start({ before: "", after: "" })
    session.abort()

    await expect(session.done).rejects.toMatchObject({ code: "cancelled" })
    expect(stream.stop).toHaveBeenCalledOnce()
  })

  it("transcribes an unexpected recorder stop and does not offer a retry after recorder failure", async () => {
    const stream = fakeStream()
    let transcriptionCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/csrf-token") {
        return new Response(JSON.stringify({ csrf_token: "csrf-3" }), { status: 200 })
      }
      transcriptionCalls += 1
      return new Response(JSON.stringify({ text: "设备停止后的结果" }), { status: 200 })
    })
    const unexpectedRecorder = new FakeStandaloneRecorder()
    const adapter = createAnnotationVoiceStandaloneAdapter({
      fetch: fetchMock,
      getUserMedia: async () => stream.stream,
      createRecorder: () => unexpectedRecorder,
      isTypeSupported: () => false
    })

    const session = await adapter.start({ before: "", after: "" })
    unexpectedRecorder.endUnexpectedly()
    await expect(session.done).resolves.toBe("设备停止后的结果")
    expect(transcriptionCalls).toBe(1)

    const failedRecorder = new FakeStandaloneRecorder()
    const failedAdapter = createAnnotationVoiceStandaloneAdapter({
      fetch: fetchMock,
      getUserMedia: async () => stream.stream,
      createRecorder: () => failedRecorder,
      isTypeSupported: () => false
    })
    const failedSession = await failedAdapter.start({ before: "", after: "" })
    failedRecorder.fail()
    await expect(failedSession.done).rejects.toMatchObject<Partial<AnnotationVoiceError>>({
      code: "failed",
      retryable: false
    })
    await expect(failedSession.retry({ before: "", after: "" })).rejects.toMatchObject({
      code: "failed"
    })
  })
})
