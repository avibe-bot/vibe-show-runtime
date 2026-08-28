import { realpath } from "node:fs/promises"
import type { ViteDevServer } from "vite"
import {
  convertRenderedHtmlToMarkdown,
  MarkdownRenderError
} from "./markdown-core.js"
import { cleanupSsrRenderedHtml } from "./ssr-markdown-conversion.js"
import { SSR_MARKDOWN_ENTRY_ID } from "./ssr-markdown-entry-plugin.js"

export {
  cleanupSsrRenderedHtml,
  convertSsrRenderedHtmlToMarkdown,
  type SsrMarkdownConversionOptions,
  type SsrMarkdownConversionResult
} from "./ssr-markdown-conversion.js"

const DEFAULT_SSR_MARKDOWN_MAX_BYTES = 512 * 1024
const SSR_ORIGIN = "http://show-runtime.local"

export const SSR_MARKDOWN_REPRESENTATION_VERSION = "ssr-initial-tree-v1"

export type SsrRouteLocation = {
  pathname: string
  search: string
  origin: string
  basePath: string
}

export type SsrMarkdownRequest = {
  vite: ViteDevServer
  target: string
  basePath: string
  internalBasePath?: string
  origin?: string
  maxOutputBytes?: number
  signal?: AbortSignal
}

export type SsrMarkdownTimings = {
  loadMs: number
  renderMs: number
  cleanupMs: number
  convertMs: number
}

export type SsrMarkdownResult = {
  markdown: string
  html: string
  timings: SsrMarkdownTimings
}

export type SsrMarkdownCacheIdentity = {
  sessionId: string
  workspaceVersion: string
  context: "private" | "shared"
  target: string
  basePath: string
}

type LoadedSsrEntry = {
  render(location: SsrRouteLocation): string
}

export type SsrMarkdownPipeline<Loaded> = {
  load(): Promise<Loaded>
  render(loaded: Loaded): string
  cleanup(html: string): string
  convert(html: string): string
}

export function createSsrMarkdownCacheKey(identity: SsrMarkdownCacheIdentity): string {
  return JSON.stringify([
    SSR_MARKDOWN_REPRESENTATION_VERSION,
    identity.sessionId,
    identity.workspaceVersion,
    identity.context,
    normalizeSsrTarget(identity.target),
    normalizeBasePath(identity.basePath)
  ])
}

export async function renderSsrMarkdown(request: SsrMarkdownRequest): Promise<SsrMarkdownResult> {
  try {
    throwIfAborted(request.signal)
    const workspace = await waitForAbort(realpath(request.vite.config.root), request.signal)
    const location = routeLocation(request)
    const maxOutputBytes = positiveInteger(request.maxOutputBytes, DEFAULT_SSR_MARKDOWN_MAX_BYTES)
    return await runSsrMarkdownPipeline({
      async load() {
        const entryModule = await request.vite.ssrLoadModule(SSR_MARKDOWN_ENTRY_ID) as Record<string, unknown>
        if (typeof entryModule.render !== "function") {
          throw new Error("The Show Page SSR entry has no render function")
        }
        return entryModule as LoadedSsrEntry
      },
      render(entry) {
        return entry.render(location)
      },
      cleanup(html) {
        return cleanupSsrRenderedHtml(html, {
          documentUrl: documentUrl(location, request.target),
          basePath: location.basePath,
          internalBasePath: request.internalBasePath ?? location.basePath,
          workspace,
          maxOutputBytes
        })
      },
      convert(html) {
        const markdown = convertRenderedHtmlToMarkdown(html)
        if (!markdown.trim()) throw new Error("The rendered page has no Markdown content")
        if (Buffer.byteLength(markdown, "utf8") > maxOutputBytes) {
          throw outputTooLarge(maxOutputBytes)
        }
        return markdown
      }
    }, request.signal)
  } catch (error) {
    if (isAbortError(error, request.signal) || error instanceof MarkdownRenderError) throw error
    throw new MarkdownRenderError(
      "render_failed",
      502,
      "Show Page rendering failed.",
      { cause: error }
    )
  }
}

export async function runSsrMarkdownPipeline<Loaded>(
  pipeline: SsrMarkdownPipeline<Loaded>,
  signal?: AbortSignal
): Promise<SsrMarkdownResult> {
  const timings: SsrMarkdownTimings = {
    loadMs: 0,
    renderMs: 0,
    cleanupMs: 0,
    convertMs: 0
  }

  throwIfAborted(signal)
  const loadStarted = performance.now()
  const loaded = await waitForAbort(pipeline.load(), signal)
  timings.loadMs = performance.now() - loadStarted

  throwIfAborted(signal)
  const renderStarted = performance.now()
  const rawHtml = pipeline.render(loaded)
  timings.renderMs = performance.now() - renderStarted

  throwIfAborted(signal)
  const cleanupStarted = performance.now()
  const html = pipeline.cleanup(rawHtml)
  timings.cleanupMs = performance.now() - cleanupStarted

  throwIfAborted(signal)
  const convertStarted = performance.now()
  const markdown = pipeline.convert(html)
  timings.convertMs = performance.now() - convertStarted
  throwIfAborted(signal)

  return { markdown, html, timings }
}

function routeLocation(request: SsrMarkdownRequest): SsrRouteLocation {
  const target = new URL(normalizeSsrTarget(request.target), SSR_ORIGIN)
  const origin = new URL(request.origin ?? SSR_ORIGIN).origin
  return {
    pathname: target.pathname,
    search: target.search,
    origin,
    basePath: normalizeBasePath(request.basePath)
  }
}

function documentUrl(location: SsrRouteLocation, target: string): string {
  const route = new URL(normalizeSsrTarget(target), SSR_ORIGIN)
  const url = new URL(location.basePath, location.origin)
  url.pathname = `${withTrailingSlash(url.pathname)}${route.pathname.replace(/^\/+/, "")}`
  url.search = route.search
  return url.href
}

function normalizeSsrTarget(target: string): string {
  const queryIndex = target.indexOf("?")
  const pathname = queryIndex === -1 ? target : target.slice(0, queryIndex)
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    pathnameHasParentSegment(pathname)
  ) {
    throw new MarkdownRenderError(
      "invalid_target",
      400,
      "The SSR target must resolve to a path within the Show Page."
    )
  }
  const parsed = new URL(target, SSR_ORIGIN)
  return `${parsed.pathname}${parsed.search}`
}

function pathnameHasParentSegment(pathname: string): boolean {
  let decoded = pathname
  while (true) {
    if (decoded.split(/[\\/]/).includes("..")) return true
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return false
      decoded = next
    } catch {
      return true
    }
  }
}

function normalizeBasePath(basePath: string): string {
  const pathname = new URL(basePath, SSR_ORIGIN).pathname
  return withTrailingSlash(pathname.startsWith("/") ? pathname : `/${pathname}`)
}

function withTrailingSlash(pathname: string): string {
  return pathname.endsWith("/") ? pathname : `${pathname}/`
}

function outputTooLarge(maxOutputBytes: number): MarkdownRenderError {
  return new MarkdownRenderError(
    "output_too_large",
    502,
    `Rendered Markdown exceeds the ${maxOutputBytes} byte output limit.`
  )
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException("SSR Markdown rendering was aborted.", "AbortError")
}

async function waitForAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await operation
  throwIfAborted(signal)
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      try {
        throwIfAborted(signal)
      } catch (error) {
        reject(error)
      }
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort, { once: true })
    operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
  })
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false
  return error === signal.reason || error instanceof Error && error.name === "AbortError"
}
