import { describe, expect, it, vi } from "vitest"

import {
  AnnotationVoiceError,
  ANNOTATION_VOICE_STATUS_PATH,
  ANNOTATION_VOICE_TRANSCRIPTION_PATH,
  annotationVoiceSnapshot,
  insertAnnotationVoiceTranscript,
  preferredAnnotationVoiceMimeType,
  probeAnnotationVoice,
  startAnnotationVoiceRecording,
  transcribeAnnotationVoice
} from "./annotation-voice.js"

describe("annotation voice text insertion", () => {
  it("inserts at the captured caret with language-aware boundaries", () => {
    const english = annotationVoiceSnapshot("Please review", 6, 6)
    expect(insertAnnotationVoiceTranscript("Please review", english, "carefully")).toEqual({
      text: "Please carefully review",
      start: 6,
      end: 16
    })

    const chinese = annotationVoiceSnapshot("这里需要调整", 2, 2)
    expect(insertAnnotationVoiceTranscript("这里需要调整", chinese, "还")).toEqual({
      text: "这里还需要调整",
      start: 2,
      end: 3
    })
  })

  it("replaces only the captured selection and refuses a changed draft", () => {
    const snapshot = annotationVoiceSnapshot("Keep  old  text", 5, 10)
    expect(insertAnnotationVoiceTranscript(snapshot.text, snapshot, "new")).toEqual({
      text: "Keep  new  text",
      start: 5,
      end: 10
    })
    expect(insertAnnotationVoiceTranscript("Draft changed", snapshot, "new")).toBeNull()
  })
})

describe("annotation voice API adapter", () => {
  it("probes the existing Avibe voice status endpoint", async () => {
    const availableFetch = vi.fn(async () => new Response(JSON.stringify({ available: true }), { status: 200 }))
    await expect(probeAnnotationVoice({ fetch: availableFetch as typeof fetch })).resolves.toBe(true)
    expect(availableFetch).toHaveBeenCalledWith(
      ANNOTATION_VOICE_STATUS_PATH,
      { credentials: "same-origin" }
    )

    const unavailableFetch = vi.fn(async () => new Response(JSON.stringify({ available: false }), { status: 200 }))
    await expect(probeAnnotationVoice({ fetch: unavailableFetch as typeof fetch })).resolves.toBe(false)
  })

  it("sends one final dictation with cleanup context through the shared endpoint", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init })
      if (String(input) === "/api/csrf-token") {
        return new Response(JSON.stringify({ csrf_token: "csrf-1" }), { status: 200 })
      }
      return new Response(JSON.stringify({ text: "整理后的反馈", cleanup: "success" }), { status: 200 })
    })

    await expect(transcribeAnnotationVoice(
      {
        blob: new Blob(["audio"], { type: "audio/webm;codecs=opus" }),
        before: "前文",
        after: "后文"
      },
      {
        fetch: fetcher as typeof fetch,
        encodeBlob: async () => "encoded-audio",
        readCsrfCookie: () => null
      }
    )).resolves.toBe("整理后的反馈")

    expect(requests.map(({ input }) => String(input))).toEqual([
      "/api/csrf-token",
      ANNOTATION_VOICE_TRANSCRIPTION_PATH
    ])
    const request = requests[1]!.init!
    expect(new Headers(request.headers).get("X-Vibe-CSRF-Token")).toBe("csrf-1")
    expect(JSON.parse(String(request.body))).toMatchObject({
      name: "voice.webm",
      mime: "audio/webm",
      data: "encoded-audio",
      sequence: 0,
      final: true,
      finalize_only: false,
      receipts: [],
      before: "前文",
      after: "后文"
    })
  })

  it("replays only the rejected CSRF request with the browser's current cookie", async () => {
    const tokens: string[] = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get("X-Vibe-CSRF-Token") ?? "")
      if (tokens.length === 1) {
        return new Response(JSON.stringify({ message: "Forbidden: invalid csrf token" }), { status: 403 })
      }
      return new Response(JSON.stringify({ text: "ok", cleanup: "success" }), { status: 200 })
    })
    const cookies = ["stale", "current"]

    await expect(transcribeAnnotationVoice(
      { blob: new Blob(["audio"], { type: "audio/webm" }), before: "", after: "" },
      {
        fetch: fetcher as typeof fetch,
        encodeBlob: async () => "encoded",
        readCsrfCookie: () => cookies.shift() ?? null
      }
    )).resolves.toBe("ok")
    expect(tokens).toEqual(["stale", "current"])
  })

  it("does not replay an unrelated forbidden response", async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ error: "forbidden" }),
      { status: 403 }
    ))

    const failure = transcribeAnnotationVoice(
      { blob: new Blob(["audio"], { type: "audio/webm" }), before: "", after: "" },
      {
        fetch: fetcher as typeof fetch,
        encodeBlob: async () => "encoded",
        readCsrfCookie: () => "csrf"
      }
    )
    await expect(failure).rejects.toMatchObject<Partial<AnnotationVoiceError>>({
      code: "failed",
      status: 403
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("preserves the server's retry-relevant failure class", async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ error: "transcription_timeout" }),
      { status: 504 }
    ))
    const failure = transcribeAnnotationVoice(
      { blob: new Blob(["audio"], { type: "audio/webm" }), before: "", after: "" },
      {
        fetch: fetcher as typeof fetch,
        encodeBlob: async () => "encoded",
        readCsrfCookie: () => "csrf"
      }
    )
    await expect(failure).rejects.toMatchObject<Partial<AnnotationVoiceError>>({
      code: "timeout",
      status: 504
    })
  })
})

class FakeMediaRecorder extends EventTarget {
  mimeType = "audio/webm;codecs=opus"
  state: RecordingState = "inactive"
  startTimeslice: number | undefined

  start(timeslice?: number) {
    this.startTimeslice = timeslice
    this.state = "recording"
  }

  stop() {
    const data = new Event("dataavailable")
    Object.defineProperty(data, "data", {
      value: new Blob(["captured"], { type: this.mimeType })
    })
    this.dispatchEvent(data)
    this.state = "inactive"
    this.dispatchEvent(new Event("stop"))
  }
}

describe("annotation browser recording", () => {
  it("chooses a supported recording type and releases the microphone after stop", async () => {
    expect(preferredAnnotationVoiceMimeType((mime) => mime === "audio/webm")).toBe("audio/webm")
    const stopTrack = vi.fn()
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream
    const recorder = new FakeMediaRecorder()
    const recording = await startAnnotationVoiceRecording({
      getUserMedia: async () => stream,
      createRecorder: () => recorder as unknown as MediaRecorder,
      isTypeSupported: (mime) => mime === "audio/webm;codecs=opus"
    })

    expect(recorder.startTimeslice).toBe(1000)
    await expect(recording.stop()).resolves.toMatchObject({
      size: 8,
      type: "audio/webm;codecs=opus"
    })
    expect(stopTrack).toHaveBeenCalledOnce()
  })

  it("releases the microphone and drops buffered audio when cancelled", async () => {
    const stopTrack = vi.fn()
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream
    const recorder = new FakeMediaRecorder()
    const recording = await startAnnotationVoiceRecording({
      getUserMedia: async () => stream,
      createRecorder: () => recorder as unknown as MediaRecorder
    })

    recording.abort()
    await expect(recording.done).resolves.toMatchObject({ size: 0 })
    expect(stopTrack).toHaveBeenCalledOnce()
  })

  it("classifies a denied microphone grant before creating a recorder", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" })
    const createRecorder = vi.fn()
    const recording = startAnnotationVoiceRecording({
      getUserMedia: async () => { throw denied },
      createRecorder
    })
    await expect(recording).rejects.toMatchObject<Partial<AnnotationVoiceError>>({ code: "permission" })
    expect(createRecorder).not.toHaveBeenCalled()
  })

  it("releases the microphone when recorder construction fails", async () => {
    const stopTrack = vi.fn()
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream
    const failure = startAnnotationVoiceRecording({
      getUserMedia: async () => stream,
      createRecorder: () => { throw new DOMException("unsupported", "NotSupportedError") }
    })

    await expect(failure).rejects.toMatchObject<Partial<AnnotationVoiceError>>({ code: "start_failed" })
    expect(stopTrack).toHaveBeenCalledOnce()
  })
})
