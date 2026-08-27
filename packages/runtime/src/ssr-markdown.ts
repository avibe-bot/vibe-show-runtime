import { realpathSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import {
  defaultTreeAdapter,
  html as htmlNames,
  parseFragment,
  serialize,
  type DefaultTreeAdapterTypes
} from "parse5"
import type { ViteDevServer } from "vite"
import {
  convertRenderedHtmlToMarkdown,
  MarkdownRenderError
} from "./markdown-core.js"
import { SSR_MARKDOWN_ENTRY_ID } from "./ssr-markdown-entry-plugin.js"

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

export function cleanupSsrRenderedHtml(
  source: string,
  options: {
    documentUrl: string
    basePath: string
    internalBasePath: string
    workspace?: string
    maxOutputBytes: number
  }
): string {
  if (Buffer.byteLength(source, "utf8") > options.maxOutputBytes) {
    throw outputTooLarge(options.maxOutputBytes)
  }

  const fragment = parseFragment(source)
  cleanChildren(fragment, options)
  const cleaned = serialize(fragment).trim()
  if (Buffer.byteLength(cleaned, "utf8") > options.maxOutputBytes) {
    throw outputTooLarge(options.maxOutputBytes)
  }
  return cleaned
}

function cleanChildren(
  parent: DefaultTreeAdapterTypes.ParentNode,
  options: Parameters<typeof cleanupSsrRenderedHtml>[1]
): void {
  for (const node of [...parent.childNodes]) {
    if (node.nodeName === "#comment") {
      defaultTreeAdapter.detachNode(node)
      continue
    }
    if (!("tagName" in node)) continue
    if (shouldRemoveElement(node)) {
      defaultTreeAdapter.detachNode(node)
      continue
    }

    cleanChildren(node, options)
    if (node.tagName === "template" && "content" in node) {
      cleanChildren(node.content, options)
    }
    rewriteUrlAttribute(node, "href", options)
    rewriteUrlAttribute(node, "src", options)
    preserveAgentNote(node)
  }
}

function shouldRemoveElement(element: DefaultTreeAdapterTypes.Element): boolean {
  if (["script", "style", "noscript", "svg", "canvas"].includes(element.tagName)) {
    return true
  }
  if (attributeValue(element, "aria-hidden")?.toLowerCase() === "true") return true
  if (hasAttribute(element, "hidden") || hasAttribute(element, "data-agent-hidden")) return true
  if (
    hasAttribute(element, "data-show-annotation-ui") ||
    hasAttribute(element, "data-show-annotation-capture") ||
    hasAttribute(element, "data-show-agent-mark-layer") ||
    hasAttribute(element, "data-show-annotation-root")
  ) {
    return true
  }
  return (attributeValue(element, "class") ?? "").split(/\s+/).includes("avs-fallback-shell")
}

function preserveAgentNote(element: DefaultTreeAdapterTypes.Element): void {
  const noteText = attributeValue(element, "agent-note")?.trim()
  removeAttribute(element, "agent-note")
  if (!noteText) return

  const note = defaultTreeAdapter.createElement(
    "blockquote",
    htmlNames.NS.HTML,
    [{ name: "data-avibe-agent-note", value: "" }]
  )
  defaultTreeAdapter.insertText(note, `agent-note: ${noteText}`)
  const parent = element.parentNode
  if (!parent) {
    defaultTreeAdapter.appendChild(element, note)
    return
  }
  const index = parent.childNodes.indexOf(element)
  const next = parent.childNodes[index + 1]
  if (next) defaultTreeAdapter.insertBefore(parent, note, next)
  else defaultTreeAdapter.appendChild(parent, note)
}

function rewriteUrlAttribute(
  element: DefaultTreeAdapterTypes.Element,
  attributeName: "href" | "src",
  options: Parameters<typeof cleanupSsrRenderedHtml>[1]
): void {
  const attribute = element.attrs.find(({ name }) => name === attributeName)
  if (!attribute || /^(?:data|javascript|mailto|tel):/i.test(attribute.value.trim())) return

  const currentDocument = new URL(options.documentUrl)
  const callerBase = new URL(options.basePath, currentDocument.origin)
  const documentBase = new URL(callerBase.href)
  const internalBase = new URL(options.internalBasePath, currentDocument.origin)
  const internalRoot = withTrailingSlash(internalBase.pathname)
  const callerRoot = withTrailingSlash(callerBase.pathname)
  const raw = attribute.value
  const callerRelative = raw === "" || raw.startsWith("#") || raw.startsWith("?") ||
    (!raw.startsWith("/") && !/^[a-z][a-z\d+.-]*:/i.test(raw))

  let resolved: URL
  try {
    resolved = new URL(raw, callerRelative ? documentBase : currentDocument)
  } catch {
    return
  }
  if (resolved.origin !== currentDocument.origin) {
    attribute.value = resolved.href
    return
  }

  if (resolved.pathname.includes("/@fs/")) {
    const workspacePath = options.workspace && callerWorkspaceAssetPath(
      resolved.pathname,
      options.workspace,
      callerRoot
    )
    if (!workspacePath) {
      removeAttribute(element, attributeName)
      return
    }
    resolved.pathname = workspacePath
  }

  const suffix = internalPathSuffix(resolved.pathname, internalRoot)
  if (suffix !== undefined) resolved.pathname = `${callerRoot}${suffix}`
  attribute.value = `${resolved.pathname}${resolved.search}${resolved.hash}`
}

function callerWorkspaceAssetPath(
  pathname: string,
  workspace: string,
  callerRoot: string
): string | undefined {
  const marker = "/@fs/"
  const markerIndex = pathname.indexOf(marker)
  if (markerIndex === -1) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname.slice(markerIndex + marker.length))
  } catch {
    return undefined
  }
  const assetPath = /^[a-z]:\//i.test(decoded) ? decoded : `/${decoded}`
  let canonicalAssetPath: string
  try {
    canonicalAssetPath = realpathSync(resolve(assetPath))
  } catch {
    return undefined
  }
  const relativePath = relative(workspace, canonicalAssetPath)
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  ) {
    return undefined
  }
  return `${callerRoot}${relativePath.replaceAll("\\", "/")}`
}

function internalPathSuffix(pathname: string, internalRoot: string): string | undefined {
  if (pathname === internalRoot.slice(0, -1)) return ""
  if (!pathname.startsWith(internalRoot)) return undefined
  return pathname.slice(internalRoot.length).replace(/^\/+/, "")
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

function attributeValue(element: DefaultTreeAdapterTypes.Element, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value
}

function hasAttribute(element: DefaultTreeAdapterTypes.Element, name: string): boolean {
  return element.attrs.some((attribute) => attribute.name === name)
}

function removeAttribute(element: DefaultTreeAdapterTypes.Element, name: string): void {
  const index = element.attrs.findIndex((attribute) => attribute.name === name)
  if (index !== -1) element.attrs.splice(index, 1)
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
