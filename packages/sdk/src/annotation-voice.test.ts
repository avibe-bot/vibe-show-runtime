import { describe, expect, it, vi } from "vitest"

import {
  AnnotationVoiceError,
  ANNOTATION_VOICE_EVENT_MESSAGE,
  ANNOTATION_VOICE_REQUEST_MESSAGE,
  annotationVoiceEventFromPayload,
  annotationVoiceSnapshot,
  createAnnotationVoiceBridgeAdapter,
  insertAnnotationVoiceTranscript,
  type AnnotationVoiceEvent,
  type AnnotationVoiceRequest
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

  it("separates dictated sentences from adjacent punctuation and words", () => {
    const afterSentence = annotationVoiceSnapshot("Please fix.", 11, 11)
    expect(insertAnnotationVoiceTranscript(afterSentence.text, afterSentence, "Also update tests")).toEqual({
      text: "Please fix. Also update tests",
      start: 11,
      end: 29
    })

    const beforeWord = annotationVoiceSnapshot("today", 0, 0)
    expect(insertAnnotationVoiceTranscript(beforeWord.text, beforeWord, "Ready.")).toEqual({
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

const bridge = () => {
  const targetWindow = new FakeBridgeWindow()
  const requests: AnnotationVoiceRequest[] = []
  const parent = {
    postMessage: (message: unknown) => requests.push(message as AnnotationVoiceRequest)
  }
  const adapter = createAnnotationVoiceBridgeAdapter({
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

    const retried = session.retry()
    expect(requests.at(-1)).toEqual({
      type: ANNOTATION_VOICE_REQUEST_MESSAGE,
      action: "retry",
      requestId
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
