import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import {
  defaultTreeAdapter,
  html as htmlNames,
  parseFragment,
  serialize,
  type DefaultTreeAdapterTypes
} from "parse5"
import {
  convertRenderedHtmlToMarkdown,
  MarkdownRenderError
} from "./markdown-core.js"

export type SsrMarkdownConversionOptions = {
  documentUrl: string
  basePath: string
  internalBasePath: string
  workspace?: string
  maxOutputBytes: number
}

export type SsrMarkdownConversionResult = {
  markdown: string
  html: string
}

export function convertSsrRenderedHtmlToMarkdown(
  source: string,
  options: SsrMarkdownConversionOptions
): SsrMarkdownConversionResult {
  let html: string
  try {
    html = cleanupSsrRenderedHtml(source, options)
  } catch (error) {
    throw postRenderPhaseError("cleanup", error)
  }

  try {
    const markdown = convertRenderedHtmlToMarkdown(html)
    if (!markdown.trim()) throw new Error("The rendered page has no Markdown content")
    if (utf8ByteLength(markdown) > options.maxOutputBytes) {
      throw outputTooLarge(options.maxOutputBytes)
    }
    return { markdown, html }
  } catch (error) {
    throw postRenderPhaseError("conversion", error)
  }
}

function postRenderPhaseError(phase: "cleanup" | "conversion", cause: unknown): Error {
  const source = cause && typeof cause === "object"
    ? cause as Record<string, unknown>
    : { message: String(cause) }
  const error = new Error(
    typeof source.message === "string" ? source.message : "SSR Markdown processing failed",
    { cause }
  ) as Error & { code?: string; status?: number; phase: "cleanup" | "conversion" }
  if (typeof source.name === "string") error.name = source.name
  if (typeof source.code === "string") error.code = source.code
  if (typeof source.status === "number" && Number.isFinite(source.status)) {
    error.status = source.status
  }
  error.phase = phase
  return error
}

export function cleanupSsrRenderedHtml(
  source: string,
  options: SsrMarkdownConversionOptions
): string {
  if (utf8ByteLength(source) > options.maxOutputBytes) {
    throw outputTooLarge(options.maxOutputBytes)
  }

  const fragment = parseFragment(source)
  cleanChildren(fragment, options)
  const cleaned = serialize(fragment).trim()
  if (utf8ByteLength(cleaned) > options.maxOutputBytes) {
    throw outputTooLarge(options.maxOutputBytes)
  }
  return cleaned
}

function cleanChildren(
  parent: DefaultTreeAdapterTypes.ParentNode,
  options: SsrMarkdownConversionOptions
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
  options: SsrMarkdownConversionOptions
): void {
  const attribute = element.attrs.find(({ name }) => name === attributeName)
  if (!attribute || /^(?:data|javascript|mailto|tel):/i.test(attribute.value.trim())) return

  const currentDocument = new URL(options.documentUrl)
  const callerBase = new URL(options.basePath, currentDocument.origin)
  const documentBase = new URL(currentDocument.href)
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

function withTrailingSlash(pathname: string): string {
  return pathname.endsWith("/") ? pathname : `${pathname}/`
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
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
