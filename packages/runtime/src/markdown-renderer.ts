import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { Worker } from "node:worker_threads"
import type { FSWatcher, ViteDevServer } from "vite"
import type { FetchFunctionOptions } from "vite/module-runner"
import {
  convertRenderedHtmlToMarkdown,
  MarkdownRenderError,
  type MarkdownRenderErrorCode
} from "./markdown-core.js"
import type {
  SsrMarkdownConversionOptions,
  SsrMarkdownConversionResult
} from "./ssr-markdown-conversion.js"
import {
  createSsrMarkdownCacheKey,
  type SsrRouteLocation
} from "./ssr-markdown.js"
import { SSR_MARKDOWN_ENTRY_ID } from "./ssr-markdown-entry-plugin.js"
import {
  createWorkspaceFingerprinter,
  type WorkspaceFingerprinter
} from "./workspace-fingerprint.js"

export { workspaceFingerprint } from "./workspace-fingerprint.js"
export {
  convertRenderedHtmlToMarkdown,
  MarkdownRenderError,
  type MarkdownRenderErrorCode
} from "./markdown-core.js"

export const DEFAULT_MARKDOWN_LOAD_TIMEOUT_MS = 10_000
export const DEFAULT_MARKDOWN_REACT_TIMEOUT_MS = 5_000
export const DEFAULT_MARKDOWN_CONVERSION_TIMEOUT_MS = 5_000
export const DEFAULT_MARKDOWN_CACHE_TTL_MS = 30_000
export const DEFAULT_MARKDOWN_CACHE_ENTRIES_PER_SESSION = 64
export const DEFAULT_MARKDOWN_CACHE_ENTRIES_GLOBAL = 256
export const DEFAULT_MARKDOWN_MAX_BYTES = 512 * 1024
const DEFAULT_MARKDOWN_CACHE_MAINTENANCE_INTERVAL_MS = 5_000
const SLOW_TIMING_MS = Number(process.env.VIBE_SHOW_RUNTIME_SLOW_TIMING_MS ?? "1000")
const WATCHER_EVENTS = ["add", "change", "unlink", "addDir", "unlinkDir"] as const

export type ShowRenderContext = "private" | "shared"
export type SsrMarkdownPreparedSession = {
  vite: ViteDevServer
  internalBasePath: string
  origin: string
}

export type MarkdownRenderRequest = {
  sessionId: string
  context: ShowRenderContext
  basePath: string
  target: string
  workspace: string
  signal?: AbortSignal
  prepare(signal: AbortSignal): Promise<SsrMarkdownPreparedSession>
}

export type MarkdownRenderPhase = "load" | "render" | "conversion"
export type MarkdownRenderPhaseTiming = {
  sessionId: string
  phase: MarkdownRenderPhase
  durationMs: number
  outcome: "ok" | "error" | "timeout" | "cancelled"
}

export type MarkdownRenderResult = {
  markdown: string
  cache: "hit" | "miss"
  timings: Partial<Record<MarkdownRenderPhase, number>>
}

export type SsrMarkdownWorker = {
  load(sessionId: string, vite: ViteDevServer): Promise<void>
  render(sessionId: string, location: SsrRouteLocation): Promise<string>
  convert(
    sessionId: string,
    html: string,
    options: SsrMarkdownConversionOptions
  ): Promise<SsrMarkdownConversionResult>
  invalidateSession(sessionId: string): Promise<void>
  terminate(): Promise<void>
  close(): Promise<void>
}

type WorkerFactory = (url: URL) => Worker

export type MarkdownRendererOptions = {
  loadTimeoutMs?: number
  reactTimeoutMs?: number
  conversionTimeoutMs?: number
  cacheTtlMs?: number
  cacheEntriesPerSession?: number
  cacheEntriesGlobal?: number
  cacheMaintenanceIntervalMs?: number
  maxOutputBytes?: number
  workspaceFingerprinter?: WorkspaceFingerprinter
  worker?: SsrMarkdownWorker
  workerFactory?: WorkerFactory
  now?: () => number
  onPhaseTiming?: (timing: MarkdownRenderPhaseTiming) => void
}

export type MarkdownRenderer = {
  render(request: MarkdownRenderRequest): Promise<MarkdownRenderResult>
  invalidateSession(sessionId: string, releaseResources?: () => Promise<void>): Promise<void>
  close(): Promise<void>
}

type CacheEntry = {
  sessionId: string
  markdown: string
  createdAt: number
}

type WatcherBinding = {
  vite: ViteDevServer
  workspace: string
  watcher: FSWatcher
  listener: (path: string) => void
}

export function createMarkdownRenderer(options: MarkdownRendererOptions = {}): MarkdownRenderer {
  const loadTimeoutMs = positiveInteger(
    options.loadTimeoutMs ?? envInteger("VIBE_SHOW_RENDER_LOAD_TIMEOUT_MS"),
    DEFAULT_MARKDOWN_LOAD_TIMEOUT_MS
  )
  const reactTimeoutMs = positiveInteger(
    options.reactTimeoutMs ?? envInteger("VIBE_SHOW_RENDER_REACT_TIMEOUT_MS"),
    DEFAULT_MARKDOWN_REACT_TIMEOUT_MS
  )
  const conversionTimeoutMs = positiveInteger(
    options.conversionTimeoutMs ?? envInteger("VIBE_SHOW_RENDER_CONVERSION_TIMEOUT_MS"),
    DEFAULT_MARKDOWN_CONVERSION_TIMEOUT_MS
  )
  const cacheTtlMs = nonNegativeInteger(
    options.cacheTtlMs ?? envInteger("VIBE_SHOW_RENDER_CACHE_TTL_MS"),
    DEFAULT_MARKDOWN_CACHE_TTL_MS
  )
  const cacheEntriesPerSession = positiveInteger(
    options.cacheEntriesPerSession,
    DEFAULT_MARKDOWN_CACHE_ENTRIES_PER_SESSION
  )
  const cacheEntriesGlobal = positiveInteger(
    options.cacheEntriesGlobal,
    DEFAULT_MARKDOWN_CACHE_ENTRIES_GLOBAL
  )
  const cacheMaintenanceIntervalMs = positiveInteger(
    options.cacheMaintenanceIntervalMs,
    DEFAULT_MARKDOWN_CACHE_MAINTENANCE_INTERVAL_MS
  )
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? envInteger("VIBE_SHOW_RENDER_MAX_BYTES"),
    DEFAULT_MARKDOWN_MAX_BYTES
  )
  const now = options.now ?? Date.now
  const workspaceFingerprinter = options.workspaceFingerprinter ?? createWorkspaceFingerprinter()
  const worker = options.worker ?? createModuleGraphSsrWorker(options.workerFactory)
  const mutex = new AsyncMutex()
  const cache = new MarkdownRenderCache({
    ttlMs: cacheTtlMs,
    entriesPerSession: cacheEntriesPerSession,
    entriesGlobal: cacheEntriesGlobal,
    now
  })
  const loadedFingerprints = new Map<string, string>()
  const watcherBindings = new Map<string, WatcherBinding>()
  const scheduledInvalidations = new Set<string>()
  const closeController = new AbortController()
  const cacheMaintenanceTimer = cacheTtlMs > 0
    ? setInterval(() => cache.deleteExpired(), cacheMaintenanceIntervalMs)
    : undefined
  cacheMaintenanceTimer?.unref?.()
  let closed = false

  const renderer: MarkdownRenderer = {
    async render(request) {
      if (closed) throw rendererUnavailable("The SSR Markdown renderer is closed.")
      const combined = combineAbortSignals(request.signal, closeController.signal)
      const timings: Partial<Record<MarkdownRenderPhase, number>> = {}

      try {
        throwIfAborted(combined.signal)
        const initialBudget = new PhaseBudget("load", loadTimeoutMs)
        const initialFingerprint = await initialBudget.wait(
          fingerprintOrRenderFailed(workspaceFingerprinter, request.sessionId, request.workspace),
          combined.signal
        )
        const initialKey = renderCacheKey(request, initialFingerprint)
        const initialHit = cache.get(initialKey)
        if (initialHit) {
          return { markdown: initialHit.markdown, cache: "hit", timings }
        }

        return await mutex.runExclusive(async () => {
          throwIfAborted(combined.signal)
          const loadStarted = performance.now()
          const loadBudget = new PhaseBudget("load", loadTimeoutMs)
          let loadOutcome: MarkdownRenderPhaseTiming["outcome"] = "ok"
          let prepared!: SsrMarkdownPreparedSession
          let fingerprint!: string
          let cacheKey!: string
          try {
            const lockedFingerprint = await loadBudget.wait(
              fingerprintOrRenderFailed(workspaceFingerprinter, request.sessionId, request.workspace),
              combined.signal
            )
            const lockedKey = renderCacheKey(request, lockedFingerprint)
            const lockedHit = cache.get(lockedKey)
            if (lockedHit) {
              return { markdown: lockedHit.markdown, cache: "hit", timings }
            }

            prepared = await loadBudget.wait(request.prepare(combined.signal), combined.signal)
            const watcherChanged = await loadBudget.wait(
              bindSessionWatcher(request.sessionId, request.workspace, prepared.vite),
              combined.signal
            )
            if (watcherChanged) {
              loadedFingerprints.delete(request.sessionId)
              await runWorkerOperation(
                loadBudget,
                combined.signal,
                worker,
                () => worker.invalidateSession(request.sessionId)
              )
            }

            fingerprint = await loadBudget.wait(
              fingerprintOrRenderFailed(workspaceFingerprinter, request.sessionId, request.workspace),
              combined.signal
            )
            cacheKey = renderCacheKey(request, fingerprint)
            const preparedHit = cache.get(cacheKey)
            if (preparedHit) {
              return { markdown: preparedHit.markdown, cache: "hit", timings }
            }

            const loadedFingerprint = loadedFingerprints.get(request.sessionId)
            if (loadedFingerprint !== undefined && loadedFingerprint !== fingerprint) {
              invalidateViteSsrGraph(prepared.vite)
              await runWorkerOperation(
                loadBudget,
                combined.signal,
                worker,
                () => worker.invalidateSession(request.sessionId)
              )
            }
            await runWorkerOperation(
              loadBudget,
              combined.signal,
              worker,
              () => worker.load(request.sessionId, prepared.vite)
            )
            loadedFingerprints.set(request.sessionId, fingerprint)
          } catch (error) {
            loadOutcome = phaseOutcome(error, combined.signal)
            throw error
          } finally {
            timings.load = performance.now() - loadStarted
            emitPhaseTiming(request.sessionId, "load", timings.load, loadOutcome)
          }

          const location = ssrRouteLocation(request, prepared)
          const renderStarted = performance.now()
          const renderBudget = new PhaseBudget("render", reactTimeoutMs)
          let renderOutcome: MarkdownRenderPhaseTiming["outcome"] = "ok"
          let html: string
          try {
            html = await runWorkerOperation(
              renderBudget,
              combined.signal,
              worker,
              () => worker.render(request.sessionId, location)
            )
            if (typeof html !== "string") throw new Error("The SSR worker returned invalid HTML")
          } catch (error) {
            renderOutcome = phaseOutcome(error, combined.signal)
            throw error
          } finally {
            timings.render = performance.now() - renderStarted
            emitPhaseTiming(request.sessionId, "render", timings.render, renderOutcome)
          }

          const conversionStarted = performance.now()
          const conversionBudget = new PhaseBudget("conversion", conversionTimeoutMs)
          let conversionOutcome: MarkdownRenderPhaseTiming["outcome"] = "ok"
          let converted: SsrMarkdownConversionResult
          try {
            const canonicalWorkspace = await conversionBudget.wait(
              realpath(request.workspace),
              combined.signal
            )
            converted = await runWorkerOperation(
              conversionBudget,
              combined.signal,
              worker,
              () => worker.convert(request.sessionId, html, {
                documentUrl: ssrDocumentUrl(request, prepared),
                basePath: request.basePath,
                internalBasePath: prepared.internalBasePath,
                workspace: canonicalWorkspace,
                maxOutputBytes
              })
            )
            if (
              !converted ||
              typeof converted.markdown !== "string" ||
              typeof converted.html !== "string"
            ) {
              throw new Error("The SSR worker returned an invalid conversion result")
            }
            if (!converted.markdown.trim()) throw new Error("The rendered page has no Markdown content")
            if (Buffer.byteLength(converted.markdown, "utf8") > maxOutputBytes) {
              throw outputTooLarge(maxOutputBytes)
            }
          } catch (error) {
            conversionOutcome = phaseOutcome(error, combined.signal)
            throw error
          } finally {
            timings.conversion = performance.now() - conversionStarted
            emitPhaseTiming(request.sessionId, "conversion", timings.conversion, conversionOutcome)
          }

          cache.set(cacheKey, {
            sessionId: request.sessionId,
            markdown: converted.markdown
          })
          return { markdown: converted.markdown, cache: "miss", timings }
        }, combined.signal)
      } catch (error) {
        throw normalizeRenderError(error, combined.signal, {
          load: loadTimeoutMs,
          render: reactTimeoutMs,
          conversion: conversionTimeoutMs
        }, maxOutputBytes)
      } finally {
        combined.dispose()
      }
    },

    async invalidateSession(sessionId, releaseResources) {
      if (closed) return
      cache.invalidateSession(sessionId)
      workspaceFingerprinter.invalidateSession(sessionId)
      unbindSessionWatcher(sessionId)
      await mutex.runExclusive(async () => {
        cache.invalidateSession(sessionId)
        workspaceFingerprinter.invalidateSession(sessionId)
        loadedFingerprints.delete(sessionId)
        const budget = new PhaseBudget("load", loadTimeoutMs)
        try {
          await runWorkerOperation(
            budget,
            closeController.signal,
            worker,
            () => worker.invalidateSession(sessionId)
          )
        } catch {
          await worker.terminate()
        }
        await releaseResources?.()
      }, closeController.signal)
    },

    async close() {
      if (closed) return
      closed = true
      closeController.abort(new DOMException("The SSR Markdown renderer is closing.", "AbortError"))
      if (cacheMaintenanceTimer) clearInterval(cacheMaintenanceTimer)
      cache.clear()
      workspaceFingerprinter.clear()
      loadedFingerprints.clear()
      for (const sessionId of [...watcherBindings.keys()]) unbindSessionWatcher(sessionId)
      await worker.terminate()
      await mutex.runExclusive(() => worker.close())
    }
  }

  function emitPhaseTiming(
    sessionId: string,
    phase: MarkdownRenderPhase,
    durationMs: number,
    outcome: MarkdownRenderPhaseTiming["outcome"]
  ): void {
    options.onPhaseTiming?.({ sessionId, phase, durationMs, outcome })
    if (durationMs < SLOW_TIMING_MS) return
    console.error(JSON.stringify({
      level: "warn",
      source: "show-runtime",
      event: "ssr-markdown-slow-phase",
      sessionId,
      phase,
      outcome,
      durationMs: Number(durationMs.toFixed(1))
    }))
  }

  async function bindSessionWatcher(
    sessionId: string,
    workspace: string,
    vite: ViteDevServer
  ): Promise<boolean> {
    const logicalWorkspace = resolve(workspace)
    const canonicalWorkspace = await realpath(workspace)
    const existing = watcherBindings.get(sessionId)
    if (existing?.vite === vite && existing.workspace === canonicalWorkspace) return false
    const changed = existing !== undefined
    unbindSessionWatcher(sessionId)

    const listener = (path: string) => {
      if (
        (!pathWithinWorkspace(path, logicalWorkspace) && !pathWithinWorkspace(path, canonicalWorkspace)) ||
        scheduledInvalidations.has(sessionId)
      ) return
      invalidateViteSsrGraph(vite)
      scheduledInvalidations.add(sessionId)
      cache.invalidateSession(sessionId)
      workspaceFingerprinter.invalidateSession(sessionId)
      void renderer.invalidateSession(sessionId).catch(() => undefined).finally(() => {
        scheduledInvalidations.delete(sessionId)
      })
    }
    for (const event of WATCHER_EVENTS) vite.watcher.on(event, listener)
    watcherBindings.set(sessionId, {
      vite,
      workspace: canonicalWorkspace,
      watcher: vite.watcher,
      listener
    })
    return changed
  }

  function unbindSessionWatcher(sessionId: string): void {
    const binding = watcherBindings.get(sessionId)
    if (!binding) return
    watcherBindings.delete(sessionId)
    for (const event of WATCHER_EVENTS) binding.watcher.off(event, binding.listener)
  }

  return renderer
}

export function createModuleGraphSsrWorker(workerFactory?: WorkerFactory): SsrMarkdownWorker {
  return new ModuleGraphSsrWorker(workerFactory)
}

class ModuleGraphSsrWorker implements SsrMarkdownWorker {
  private readonly workerFactory: WorkerFactory
  private readonly workerUrl = new URL("./ssr-markdown-worker.js", import.meta.url)
  private readonly bindings = new Map<string, { vite: ViteDevServer, generation: number }>()
  private readonly pending = new Map<number, {
    command: WorkerCommandName
    resolve(value: unknown): void
    reject(error: Error): void
  }>()
  private worker: Worker | undefined
  private nextRequestId = 1
  private nextGeneration = 1
  private closed = false

  constructor(workerFactory: WorkerFactory = (url) => new Worker(url, {
    // The SSR runner is self-contained. Inheriting host-only V8 flags such as
    // --expose-gc makes Node reject worker startup with ERR_WORKER_INVALID_EXEC_ARGV.
    execArgv: []
  })) {
    this.workerFactory = workerFactory
  }

  async load(sessionId: string, vite: ViteDevServer): Promise<void> {
    let binding = this.bindings.get(sessionId)
    if (binding?.vite !== vite) {
      await this.invalidateWorkerSession(sessionId)
      binding = { vite, generation: this.nextGeneration++ }
      this.bindings.set(sessionId, binding)
    }
    await this.command("load", {
      sessionId,
      generation: binding.generation,
      entryId: SSR_MARKDOWN_ENTRY_ID
    })
  }

  async render(sessionId: string, location: SsrRouteLocation): Promise<string> {
    const binding = this.requireBinding(sessionId)
    return await this.command("render", {
      sessionId,
      generation: binding.generation,
      location
    }) as string
  }

  async convert(
    sessionId: string,
    html: string,
    options: SsrMarkdownConversionOptions
  ): Promise<SsrMarkdownConversionResult> {
    const binding = this.requireBinding(sessionId)
    return await this.command("convert", {
      sessionId,
      generation: binding.generation,
      html,
      options
    }) as SsrMarkdownConversionResult
  }

  async invalidateSession(sessionId: string): Promise<void> {
    this.bindings.delete(sessionId)
    await this.invalidateWorkerSession(sessionId)
  }

  async terminate(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    this.worker = undefined
    const error = new WorkerTerminatedError()
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    await worker.terminate().catch(() => undefined)
  }

  async close(): Promise<void> {
    this.closed = true
    this.bindings.clear()
    await this.terminate()
  }

  private async invalidateWorkerSession(sessionId: string): Promise<void> {
    if (!this.worker) return
    try {
      await this.command("invalidate", { sessionId })
    } catch {
      await this.terminate()
    }
  }

  private requireBinding(sessionId: string): { vite: ViteDevServer, generation: number } {
    const binding = this.bindings.get(sessionId)
    if (!binding) throw new Error("The SSR worker session is not loaded")
    return binding
  }

  private ensureWorker(): Worker {
    if (this.closed) throw new SsrWorkerUnavailableError("The SSR worker is closed")
    if (this.worker) return this.worker
    let worker: Worker
    try {
      worker = this.workerFactory(this.workerUrl)
    } catch (error) {
      throw new SsrWorkerUnavailableError("The SSR worker could not be started", { cause: error })
    }
    this.worker = worker
    worker.on("message", (message: WorkerMessage) => {
      if (message?.type === "command-result") this.handleCommandResult(message)
      else if (message?.type === "vite-rpc") void this.handleViteRpc(worker, message)
    })
    worker.once("error", (error) => this.failWorker(worker, error))
    worker.once("exit", (code) => {
      if (this.worker !== worker) return
      this.failWorker(worker, new Error(`The SSR worker exited with code ${code}`))
    })
    return worker
  }

  private command(name: WorkerCommandName, data: Record<string, unknown>): Promise<unknown> {
    const worker = this.ensureWorker()
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { command: name, resolve, reject })
      try {
        worker.postMessage({ type: "command", requestId, name, ...data })
      } catch (error) {
        this.pending.delete(requestId)
        reject(new SsrWorkerUnavailableError("The SSR worker could not accept work", { cause: error }))
      }
    })
  }

  private handleCommandResult(message: WorkerCommandResult): void {
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.pending.delete(message.requestId)
    if (message.error) {
      pending.reject(new WorkerCommandError(pending.command, message.error))
    } else {
      pending.resolve(message.result)
    }
  }

  private async handleViteRpc(worker: Worker, message: WorkerViteRpc): Promise<void> {
    const binding = this.bindings.get(message.sessionId)
    try {
      if (!binding || binding.generation !== message.generation) {
        throw new Error("The Vite session changed while the SSR worker was loading it")
      }
      const invocation = message.payload.data
      let result: unknown
      if (invocation.name === "fetchModule") {
        const [id, importer, fetchOptions] = invocation.data
        if (typeof id !== "string") throw new Error("The SSR worker sent an invalid module id")
        result = await binding.vite.environments.ssr.fetchModule(
          id,
          typeof importer === "string" ? importer : undefined,
          isRecord(fetchOptions) ? fetchOptions as FetchFunctionOptions : undefined
        )
      } else if (invocation.name === "getBuiltins") {
        result = binding.vite.environments.ssr.config.resolve.builtins.map((builtin) =>
          typeof builtin === "string"
            ? { type: "string", value: builtin }
            : { type: "RegExp", source: builtin.source, flags: builtin.flags }
        )
      } else {
        throw new Error(`Unsupported Vite worker RPC: ${invocation.name}`)
      }
      if (this.worker === worker) {
        worker.postMessage({
          type: "vite-rpc-result",
          rpcId: message.rpcId,
          response: { result }
        })
      }
    } catch (error) {
      if (this.worker === worker) {
        worker.postMessage({
          type: "vite-rpc-result",
          rpcId: message.rpcId,
          response: { error: serializeError(error) }
        })
      }
    }
  }

  private failWorker(worker: Worker, cause: unknown): void {
    if (this.worker !== worker) return
    this.worker = undefined
    const error = new SsrWorkerUnavailableError("The SSR worker stopped unexpectedly", { cause })
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

type WorkerCommandName = "load" | "render" | "convert" | "invalidate"
type SerializedError = {
  name?: string
  message?: string
  stack?: string
  code?: string
  status?: number
}
type WorkerCommandResult = {
  type: "command-result"
  requestId: number
  result?: unknown
  error?: SerializedError
}
type WorkerViteRpc = {
  type: "vite-rpc"
  rpcId: number
  sessionId: string
  generation: number
  payload: {
    type: "custom"
    event: "vite:invoke"
    data: {
      id: string
      name: string
      data: unknown[]
    }
  }
}
type WorkerMessage = WorkerCommandResult | WorkerViteRpc

export class SsrWorkerUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SsrWorkerUnavailableError"
  }
}

class WorkerTerminatedError extends Error {
  constructor() {
    super("The SSR worker was terminated")
    this.name = "WorkerTerminatedError"
  }
}

class WorkerCommandError extends Error {
  readonly code: string | undefined
  readonly status: number | undefined

  constructor(readonly command: WorkerCommandName, details: SerializedError) {
    super(details.message ?? `The SSR worker ${command} command failed`)
    this.name = details.name ?? "WorkerCommandError"
    this.stack = details.stack ?? this.stack
    this.code = details.code
    this.status = details.status
  }
}

class PhaseBudget {
  private readonly expiresAt: number

  constructor(readonly phase: MarkdownRenderPhase, readonly timeoutMs: number) {
    this.expiresAt = Date.now() + timeoutMs
  }

  async wait<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    throwIfAborted(signal)
    const remaining = this.expiresAt - Date.now()
    if (remaining <= 0) throw new RenderPhaseTimeoutError(this.phase)

    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new RenderPhaseTimeoutError(this.phase)), remaining)
          timer.unref?.()
        }),
        new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(abortReason(signal))
          signal.addEventListener("abort", abortListener, { once: true })
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (abortListener) signal.removeEventListener("abort", abortListener)
    }
  }
}

class RenderPhaseTimeoutError extends Error {
  constructor(readonly phase: MarkdownRenderPhase) {
    super(`SSR Markdown ${phase} deadline exceeded`)
    this.name = "TimeoutError"
  }
}

async function runWorkerOperation<T>(
  budget: PhaseBudget,
  signal: AbortSignal,
  worker: SsrMarkdownWorker,
  operation: () => Promise<T>
): Promise<T> {
  throwIfAborted(signal)
  let work: Promise<T>
  try {
    work = operation()
  } catch (error) {
    throw error
  }
  try {
    return await budget.wait(work, signal)
  } catch (error) {
    if (error instanceof RenderPhaseTimeoutError || signal.aborted) {
      await worker.terminate()
    }
    throw error
  }
}

class MarkdownRenderCache {
  private readonly entries = new Map<string, CacheEntry>()

  constructor(private readonly options: {
    ttlMs: number
    entriesPerSession: number
    entriesGlobal: number
    now: () => number
  }) {}

  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.isExpired(entry, this.options.now())) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(key: string, entry: Omit<CacheEntry, "createdAt">): void {
    const createdAt = this.options.now()
    this.deleteExpired(createdAt)
    this.entries.delete(key)
    if (this.options.ttlMs === 0) return
    this.entries.set(key, { ...entry, createdAt })
    this.enforceSessionLimit(entry.sessionId)
    this.enforceGlobalLimit()
  }

  deleteExpired(at = this.options.now()): void {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, at)) this.entries.delete(key)
    }
  }

  invalidateSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.entries.delete(key)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  private isExpired(entry: CacheEntry, at: number): boolean {
    return at - entry.createdAt >= this.options.ttlMs
  }

  private enforceSessionLimit(sessionId: string): void {
    let overflow = 0
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) overflow += 1
    }
    overflow -= this.options.entriesPerSession
    for (const [key, entry] of this.entries) {
      if (overflow <= 0) return
      if (entry.sessionId !== sessionId) continue
      this.entries.delete(key)
      overflow -= 1
    }
  }

  private enforceGlobalLimit(): void {
    while (this.entries.size > this.options.entriesGlobal) {
      const oldest = this.entries.keys().next()
      if (oldest.done) return
      this.entries.delete(oldest.value)
    }
  }
}

class AsyncMutex {
  private tail = Promise.resolve()

  async runExclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tail
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tail = previous.then(() => gate)
    try {
      if (signal) await waitForAbort(previous, signal)
      else await previous
    } catch (error) {
      release()
      throw error
    }
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

async function fingerprintOrRenderFailed(
  fingerprinter: WorkspaceFingerprinter,
  sessionId: string,
  workspace: string
): Promise<string> {
  try {
    return await fingerprinter.fingerprint(sessionId, workspace)
  } catch (error) {
    throw renderFailed("Show Page workspace could not be read.", error)
  }
}

function renderCacheKey(request: MarkdownRenderRequest, fingerprint: string): string {
  return createSsrMarkdownCacheKey({
    sessionId: request.sessionId,
    workspaceVersion: fingerprint,
    context: request.context,
    target: request.target,
    basePath: request.basePath
  })
}

function ssrRouteLocation(
  request: MarkdownRenderRequest,
  prepared: SsrMarkdownPreparedSession
): SsrRouteLocation {
  const target = new URL(request.target, "http://show-runtime.local")
  return {
    pathname: target.pathname,
    search: target.search,
    origin: new URL(prepared.origin).origin,
    basePath: normalizeBasePath(request.basePath)
  }
}

function ssrDocumentUrl(
  request: MarkdownRenderRequest,
  prepared: SsrMarkdownPreparedSession
): string {
  const target = new URL(request.target, "http://show-runtime.local")
  const url = new URL(normalizeBasePath(request.basePath), prepared.origin)
  url.pathname = `${withTrailingSlash(url.pathname)}${target.pathname.replace(/^\/+/, "")}`
  url.search = target.search
  return url.href
}

function normalizeBasePath(basePath: string): string {
  const pathname = new URL(basePath, "http://show-runtime.local").pathname
  return withTrailingSlash(pathname.startsWith("/") ? pathname : `/${pathname}`)
}

function withTrailingSlash(pathname: string): string {
  return pathname.endsWith("/") ? pathname : `${pathname}/`
}

function pathWithinWorkspace(path: string, workspace: string): boolean {
  const candidate = resolve(path)
  const relativePath = relative(workspace, candidate)
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

function invalidateViteSsrGraph(vite: ViteDevServer): void {
  vite.environments?.ssr?.moduleGraph.invalidateAll()
}

function normalizeRenderError(
  error: unknown,
  signal: AbortSignal,
  timeouts: Record<MarkdownRenderPhase, number>,
  maxOutputBytes: number
): MarkdownRenderError {
  if (signal.aborted && (error === signal.reason || isAbortError(error))) throw error
  if (error instanceof MarkdownRenderError) return error
  if (error instanceof RenderPhaseTimeoutError) {
    return new MarkdownRenderError(
      "render_timeout",
      504,
      `Show Page ${phaseLabel(error.phase)} exceeded the ${formatTimeout(timeouts[error.phase])} timeout.`,
      { cause: error }
    )
  }
  if (error instanceof SsrWorkerUnavailableError) {
    return rendererUnavailable("The SSR Markdown worker is unavailable.", error)
  }
  if (
    error instanceof WorkerCommandError &&
    error.command === "convert" &&
    error.code === "output_too_large"
  ) {
    return outputTooLarge(maxOutputBytes)
  }
  return renderFailed("Show Page rendering failed.", error)
}

function phaseOutcome(
  error: unknown,
  signal: AbortSignal
): MarkdownRenderPhaseTiming["outcome"] {
  if (signal.aborted && (error === signal.reason || isAbortError(error))) return "cancelled"
  if (error instanceof RenderPhaseTimeoutError) return "timeout"
  return "error"
}

function phaseLabel(phase: MarkdownRenderPhase): string {
  if (phase === "load") return "module loading"
  if (phase === "render") return "React rendering"
  return "Markdown conversion"
}

function outputTooLarge(maxOutputBytes: number): MarkdownRenderError {
  return new MarkdownRenderError(
    "output_too_large",
    502,
    `Rendered Markdown exceeds the ${formatByteLimit(maxOutputBytes)} output limit.`
  )
}

function rendererUnavailable(message: string, cause?: unknown): MarkdownRenderError {
  return new MarkdownRenderError("renderer_unavailable", 503, message, { cause })
}

function renderFailed(message: string, cause?: unknown): MarkdownRenderError {
  return new MarkdownRenderError("render_failed", 502, message, { cause })
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const listeners: Array<{ signal: AbortSignal, listener: () => void }> = []
  for (const signal of signals) {
    if (!signal) continue
    const listener = () => {
      if (!controller.signal.aborted) controller.abort(abortReason(signal))
    }
    if (signal.aborted) listener()
    else {
      signal.addEventListener("abort", listener, { once: true })
      listeners.push({ signal, listener })
    }
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const item of listeners) item.signal.removeEventListener("abort", item.listener)
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("SSR Markdown rendering was aborted.", "AbortError")
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

async function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  let listener: (() => void) | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        listener = () => reject(abortReason(signal))
        signal.addEventListener("abort", listener, { once: true })
      })
    ])
  } finally {
    if (listener) signal.removeEventListener("abort", listener)
  }
}

function serializeError(value: unknown): SerializedError {
  if (!(value instanceof Error)) return { name: "Error", message: String(value) }
  return {
    name: value.name,
    message: value.message,
    stack: value.stack,
    code: "code" in value && typeof value.code === "string" ? value.code : undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function envInteger(name: string): number | undefined {
  const value = process.env[name]
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback
  return Number.isFinite(selected) && selected > 0 ? Math.floor(selected) : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback
  return Number.isFinite(selected) && selected >= 0 ? Math.floor(selected) : fallback
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs % 1000 === 0) {
    const seconds = timeoutMs / 1000
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`
  }
  return `${timeoutMs} ms`
}

function formatByteLimit(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`
}
