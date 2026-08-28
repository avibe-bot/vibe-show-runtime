export const SSR_MARKDOWN_IPC_CONTROL_MAX_BYTES = 64 * 1024
export const SSR_MARKDOWN_IPC_MODULE_MAX_BYTES = 16 * 1024 * 1024
export const SSR_MARKDOWN_IPC_MODULE_TOTAL_MAX_BYTES = 64 * 1024 * 1024
export const SSR_MARKDOWN_IPC_ERROR_MAX_BYTES = 8 * 1024

const IPC_MAX_DEPTH = 16
const IPC_MAX_ENTRIES = 16_384

export type SsrMarkdownSerializedError = {
  name?: string
  message?: string
  stack?: string
  code?: string
  status?: number
  phase?: "cleanup" | "conversion"
}

export class SsrMarkdownIpcLimitError extends Error {
  readonly code = "ERR_SSR_MARKDOWN_IPC_LIMIT"

  constructor(readonly boundary: string) {
    super(`The SSR Markdown ${boundary} exceeded its IPC limit`)
    this.name = "SsrMarkdownIpcLimitError"
  }
}

export class SsrMarkdownIpcBudget {
  #usedBytes = 0

  constructor(
    readonly maxBytes: number,
    readonly boundary: string,
    readonly messageBoundary = `${boundary} message`
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new SsrMarkdownIpcLimitError(boundary)
    }
  }

  get usedBytes(): number {
    return this.#usedBytes
  }

  add(value: unknown, perMessageMaxBytes: number): number {
    const size = assertSsrMarkdownIpcValue(
      value,
      perMessageMaxBytes,
      this.messageBoundary
    )
    if (this.#usedBytes + size > this.maxBytes) {
      throw new SsrMarkdownIpcLimitError(this.boundary)
    }
    this.#usedBytes += size
    return size
  }
}

export function assertSsrMarkdownIpcValue(
  value: unknown,
  maxBytes: number,
  boundary: string
): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new SsrMarkdownIpcLimitError(boundary)
  }
  let bytes = 0
  let entries = 0
  const ancestors = new Set<object>()

  visit(value, 0)
  return bytes

  function add(amount: number): void {
    bytes += amount
    if (bytes > maxBytes) throw new SsrMarkdownIpcLimitError(boundary)
  }

  function visit(candidate: unknown, depth: number): void {
    entries += 1
    if (entries > IPC_MAX_ENTRIES || depth > IPC_MAX_DEPTH) {
      throw new SsrMarkdownIpcLimitError(boundary)
    }
    if (candidate === null || candidate === undefined) {
      add(4)
      return
    }
    if (typeof candidate === "string") {
      add(Buffer.byteLength(candidate, "utf8") + 4)
      return
    }
    if (typeof candidate === "number" || typeof candidate === "bigint") {
      add(16)
      return
    }
    if (typeof candidate === "boolean") {
      add(4)
      return
    }
    if (typeof candidate !== "object") {
      throw new SsrMarkdownIpcLimitError(boundary)
    }
    if (ArrayBuffer.isView(candidate)) {
      add(candidate.byteLength + 16)
      return
    }
    if (candidate instanceof ArrayBuffer) {
      add(candidate.byteLength + 16)
      return
    }
    if (ancestors.has(candidate)) throw new SsrMarkdownIpcLimitError(boundary)
    ancestors.add(candidate)
    try {
      if (Array.isArray(candidate)) {
        add(8)
        for (const item of candidate) visit(item, depth + 1)
        return
      }
      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new SsrMarkdownIpcLimitError(boundary)
      }
      add(8)
      for (const [key, item] of Object.entries(candidate)) {
        add(Buffer.byteLength(key, "utf8") + 4)
        visit(item, depth + 1)
      }
    } finally {
      ancestors.delete(candidate)
    }
  }
}

export function serializeSsrMarkdownError(value: unknown): SsrMarkdownSerializedError {
  const error = value && typeof value === "object"
    ? value as Record<string, unknown>
    : { name: "Error", message: String(value) }
  const serialized: SsrMarkdownSerializedError = {
    name: boundedText(error.name, 128),
    message: boundedText(error.message, 4 * 1024),
    stack: boundedText(error.stack, 3 * 1024),
    code: boundedText(error.code, 128),
    status: typeof error.status === "number" && Number.isFinite(error.status)
      ? error.status
      : undefined,
    phase: error.phase === "cleanup" || error.phase === "conversion"
      ? error.phase
      : undefined
  }
  assertSsrMarkdownIpcValue(
    serialized,
    SSR_MARKDOWN_IPC_ERROR_MAX_BYTES,
    "serialized error"
  )
  return serialized
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value

  let low = 0
  let high = Math.min(value.length, maxBytes)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle
    else high = middle - 1
  }
  if (
    low > 0 &&
    low < value.length &&
    /[\uD800-\uDBFF]/.test(value[low - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(value[low] ?? "")
  ) {
    low -= 1
  }
  return value.slice(0, low)
}
