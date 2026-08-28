type CapturedError = { name: string; code: number }

function captureError(operation: () => unknown): CapturedError {
  try {
    operation()
    return { name: "none", code: 0 }
  } catch (error) {
    const candidate = error as { name?: unknown; code?: unknown }
    return {
      name: String(candidate.name ?? "Error"),
      code: typeof candidate.code === "number" ? candidate.code : 0
    }
  }
}

function encodeInto(value: string, size: number) {
  const destination = new Uint8Array(size)
  return {
    result: new TextEncoder().encodeInto(value, destination),
    bytes: [...destination]
  }
}

const decoder = new TextDecoder()
const streamingDecoder = new TextDecoder()
const streamingText = streamingDecoder.decode(new Uint8Array([0xe2, 0x82]), { stream: true }) +
  streamingDecoder.decode(new Uint8Array([0xac]))
const params = new URLSearchParams([["duplicate", "first"], ["duplicate", "second"]])
params.append("space", "a b")
params.delete("duplicate", "first")
const url = new URL("../report?period=Q3#summary", "https://example.test/teams/acme/")
url.searchParams.append("space", "a b")
const abortError = new DOMException("stopped", "AbortError")
const firstNow = performance.now()
const secondNow = performance.now()
const scheduled: string[] = []
const cancelled = setTimeout(() => scheduled.push("cancelled"), 0)
clearTimeout(cancelled)
const cancelledInterval = setInterval(() => scheduled.push("interval"), 0)
clearInterval(cancelledInterval)
queueMicrotask(() => scheduled.push("microtask"))
const channel = new MessageChannel()
channel.port1.onmessage = () => scheduled.push("message")
channel.port2.postMessage("ready")
await new Promise<void>((resolve) => {
  setTimeout(() => {
    scheduled.push("timeout")
    resolve()
  }, 0)
})
channel.port1.close()
channel.port2.close()

const report = {
  textEncoder: {
    encoded: [...new TextEncoder().encode("A\u00e9\ud83d\ude00\ud800")],
    shortMultibyte: encodeInto("\u00e9", 1),
    mixedBoundary: encodeInto("A\u00e9", 2),
    astralBoundary: encodeInto("\ud83d\ude00", 3),
    replacementBoundary: encodeInto("\ud800", 3)
  },
  textDecoder: {
    bom: decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])),
    ignoreBom: new TextDecoder("utf-8", { ignoreBOM: true })
      .decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])),
    utf16: new TextDecoder("utf-16le").decode(new Uint8Array([0x41, 0x00])),
    streaming: streamingText,
    fatalError: captureError(() => {
      new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff]))
    }),
    properties: {
      encoding: new TextDecoder("UTF8", { fatal: true, ignoreBOM: true }).encoding,
      fatal: new TextDecoder("UTF8", { fatal: true }).fatal,
      ignoreBOM: new TextDecoder("UTF8", { ignoreBOM: true }).ignoreBOM
    }
  },
  base64: {
    decoded: atob(" YQ== "),
    encoded: btoa("\u00e9"),
    atobError: captureError(() => atob("!!!!")),
    btoaError: captureError(() => btoa("\u2713"))
  },
  url: {
    href: url.href,
    invalidError: captureError(() => new URL("relative-only")),
    params: params.toString(),
    duplicates: params.getAll("duplicate"),
    size: params.size
  },
  domException: {
    name: abortError.name,
    message: abortError.message,
    code: abortError.code,
    text: abortError.toString(),
    tag: Object.prototype.toString.call(abortError),
    staticAbortCode: DOMException.ABORT_ERR,
    instanceAbortCode: abortError.ABORT_ERR
  },
  performance: {
    finite: Number.isFinite(firstNow) && Number.isFinite(performance.timeOrigin),
    monotonic: secondNow >= firstNow,
    relativeClock: firstNow < 1_000_000_000_000,
    epochOrigin: performance.timeOrigin > 1_000_000_000_000,
    tag: Object.prototype.toString.call(performance)
  },
  scheduling: scheduled,
  policy: {
    nodeEnvironment: Reflect.get(
      Reflect.get(
        Reflect.get(globalThis, ["pro", "cess"].join("")) as object,
        "env"
      ) as object,
      ["NODE", "ENV"].join("_")
    ),
    delayedIntrinsicsUnavailable: [
      globalThis.FinalizationRegistry,
      globalThis.SharedArrayBuffer,
      globalThis.Atomics,
      globalThis.WebAssembly
    ].every((value) => value === undefined)
  }
}

export default function IntrinsicConformanceFixture() {
  return (
    <main>
      <h1>SSR intrinsic conformance</h1>
      <p>IntrinsicReportBegin<code>{JSON.stringify(report)}</code>IntrinsicReportEnd</p>
    </main>
  )
}
