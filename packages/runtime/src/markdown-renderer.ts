import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { lstat, readdir, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { chromium } from "playwright-core"
import TurndownService from "turndown"
import { gfm } from "turndown-plugin-gfm"

export const DEFAULT_MARKDOWN_RENDER_TIMEOUT_MS = 30_000
export const DEFAULT_MARKDOWN_CACHE_TTL_MS = 30_000
export const DEFAULT_MARKDOWN_CACHE_ENTRIES_PER_SESSION = 64
export const DEFAULT_MARKDOWN_CACHE_ENTRIES_GLOBAL = 256
export const DEFAULT_MARKDOWN_MAX_BYTES = 512 * 1024
export const DEFAULT_BROWSER_IDLE_MS = 60_000
export const DEFAULT_BROWSER_PROVISION_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MARKDOWN_CACHE_MAINTENANCE_INTERVAL_MS = 5_000
const DEFAULT_RENDER_QUIET_PERIOD_MS = 150
const SYSTEM_BROWSER_CHANNELS = ["chrome", "msedge"] as const
const MANAGED_BROWSER_TARGET = "managed" as const
const WORKSPACE_FINGERPRINT_EXCLUDED_ENTRIES = new Set(["node_modules", ".git", "dist", "build"])
const PLAYWRIGHT_CLI_PATH = join(
  dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")),
  "cli.js"
)

export type ShowRenderContext = "private" | "shared"
export type MarkdownRenderErrorCode =
  | "invalid_target"
  | "session_unknown"
  | "renderer_unavailable"
  | "render_timeout"
  | "render_failed"
  | "output_too_large"

export class MarkdownRenderError extends Error {
  constructor(
    readonly code: MarkdownRenderErrorCode,
    readonly status: number,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "MarkdownRenderError"
  }
}

export type MarkdownRenderRequest = {
  sessionId: string
  context: ShowRenderContext
  basePath: string
  target: string
  internalBasePath: string
  renderUrl: string
  workspace: string
  prepare: () => Promise<void>
}

export type MarkdownRenderResult = {
  markdown: string
  cache: "hit" | "miss"
}

export type MarkdownNavigationResponse = {
  ok(): boolean
  status(): number
}

export type MarkdownNetworkRequest = {
  method(): string
  resourceType(): string
  url(): string
}

type MarkdownNetworkEvent = "request" | "requestfinished" | "requestfailed"

export type MarkdownPage = {
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number }
  ): Promise<MarkdownNavigationResponse | null>
  on(event: MarkdownNetworkEvent, listener: (request: MarkdownNetworkRequest) => void): void
  off(event: MarkdownNetworkEvent, listener: (request: MarkdownNetworkRequest) => void): void
  evaluate<Result>(pageFunction: () => Result | Promise<Result>): Promise<Result>
  evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result>
}

export type MarkdownBrowserContext = {
  newPage(): Promise<MarkdownPage>
  close(): Promise<void>
}

export type MarkdownBrowser = {
  isConnected(): boolean
  newContext(): Promise<MarkdownBrowserContext>
  close(): Promise<void>
  on(event: "disconnected", listener: () => void): void
}

export type SystemBrowserChannel = typeof SYSTEM_BROWSER_CHANNELS[number]
export type BrowserTarget = SystemBrowserChannel | typeof MANAGED_BROWSER_TARGET
export type BrowserLauncher = (
  target: BrowserTarget,
  timeoutMs: number
) => Promise<MarkdownBrowser>

export type BrowserProvisionResult = {
  ok: boolean
  missingLinuxDependencies?: boolean
  error?: unknown
}

export type BrowserProvisioner = (timeoutMs: number) => Promise<BrowserProvisionResult>

export type MarkdownRendererOptions = {
  timeoutMs?: number
  cacheTtlMs?: number
  cacheEntriesPerSession?: number
  cacheEntriesGlobal?: number
  cacheMaintenanceIntervalMs?: number
  maxOutputBytes?: number
  browserIdleMs?: number
  quietPeriodMs?: number
  browserDiscoveryDisabled?: boolean
  browserProvisioningDisabled?: boolean
  browserProvisionTimeoutMs?: number
  launchBrowser?: BrowserLauncher
  provisionBrowser?: BrowserProvisioner
  now?: () => number
}

export type MarkdownRenderer = {
  render(request: MarkdownRenderRequest): Promise<MarkdownRenderResult>
  invalidateSession(sessionId: string): Promise<void>
  close(): Promise<void>
}

type CacheEntry = {
  sessionId: string
  markdown: string
  fingerprint: string
  createdAt: number
}

type CleanedDocument = {
  html: string
  mountEmpty: boolean
}

export function createMarkdownRenderer(options: MarkdownRendererOptions = {}): MarkdownRenderer {
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? envInteger("VIBE_SHOW_RENDER_TIMEOUT_MS"),
    DEFAULT_MARKDOWN_RENDER_TIMEOUT_MS
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
  const browserIdleMs = nonNegativeInteger(
    options.browserIdleMs ?? envInteger("VIBE_SHOW_RENDER_BROWSER_IDLE_MS"),
    DEFAULT_BROWSER_IDLE_MS
  )
  const quietPeriodMs = nonNegativeInteger(options.quietPeriodMs, DEFAULT_RENDER_QUIET_PERIOD_MS)
  const browserProvisionTimeoutMs = positiveInteger(
    options.browserProvisionTimeoutMs,
    positiveInteger(
      envInteger("AVIBE_SHOW_RENDER_PROVISION_TIMEOUT_MS"),
      DEFAULT_BROWSER_PROVISION_TIMEOUT_MS
    )
  )
  const now = options.now ?? Date.now
  const browserPool = new BrowserPool({
    idleMs: browserIdleMs,
    discoveryDisabled: options.browserDiscoveryDisabled ?? envFlag("VIBE_SHOW_RENDER_DISABLE_BROWSER_DISCOVERY"),
    provisioningDisabled: options.browserProvisioningDisabled ?? envFlag("AVIBE_SHOW_RENDER_NO_PROVISION"),
    provisionTimeoutMs: browserProvisionTimeoutMs,
    launchBrowser: options.launchBrowser ?? launchBrowserTarget,
    provisionBrowser: options.provisionBrowser ?? provisionManagedBrowser
  })
  const mutex = new AsyncMutex()
  const cache = new MarkdownRenderCache({
    ttlMs: cacheTtlMs,
    entriesPerSession: cacheEntriesPerSession,
    entriesGlobal: cacheEntriesGlobal,
    now
  })
  const cacheMaintenanceTimer = cacheTtlMs > 0
    ? setInterval(() => cache.deleteExpired(), cacheMaintenanceIntervalMs)
    : undefined
  cacheMaintenanceTimer?.unref?.()
  let closed = false

  return {
    async render(request) {
      if (closed) {
        throw renderFailed("The Markdown renderer is closed.")
      }
      const deadline = new RenderDeadline(timeoutMs)

      try {
        const cacheKey = renderCacheKey(request)
        const initialFingerprint = await deadline.wait(fingerprintOrRenderFailed(request.workspace))
        const initialHit = cache.get(cacheKey, initialFingerprint)
        if (initialHit) {
          return { markdown: initialHit.markdown, cache: "hit" }
        }

        const waitStart = Date.now()
        return await mutex.runExclusive(async () => {
          deadline.extendBy(Date.now() - waitStart)
          const lockedFingerprint = await deadline.wait(fingerprintOrRenderFailed(request.workspace))
          const lockedHit = cache.get(cacheKey, lockedFingerprint)
          if (lockedHit) {
            return { markdown: lockedHit.markdown, cache: "hit" }
          }

          await deadline.wait(request.prepare())
          const renderFingerprint = await deadline.wait(fingerprintOrRenderFailed(request.workspace))
          const preparedHit = cache.get(cacheKey, renderFingerprint)
          if (preparedHit) {
            return { markdown: preparedHit.markdown, cache: "hit" }
          }

          const markdown = await renderPageToMarkdown({
            request,
            browserPool,
            deadline,
            timeoutMs,
            quietPeriodMs,
            maxOutputBytes
          })

          // A file changed while the browser was rendering. Serve this request, but do
          // not make the possibly transitional result a cache hit for the new state.
          const completedFingerprint = await deadline.wait(fingerprintOrRenderFailed(request.workspace))
          if (completedFingerprint === renderFingerprint) {
            cache.set(cacheKey, {
              sessionId: request.sessionId,
              markdown,
              fingerprint: renderFingerprint
            })
          } else {
            cache.delete(cacheKey)
          }
          return { markdown, cache: "miss" }
        })
      } catch (error) {
        throw normalizeRenderError(error, timeoutMs, deadline)
      }
    },
    async invalidateSession(sessionId) {
      if (closed) return
      await mutex.runExclusive(async () => {
        cache.invalidateSession(sessionId)
      })
    },
    async close() {
      closed = true
      if (cacheMaintenanceTimer) clearInterval(cacheMaintenanceTimer)
      cache.clear()
      await mutex.runExclusive(() => browserPool.close())
    }
  }
}

async function renderPageToMarkdown(options: {
  request: MarkdownRenderRequest
  browserPool: BrowserPool
  deadline: RenderDeadline
  timeoutMs: number
  quietPeriodMs: number
  maxOutputBytes: number
}): Promise<string> {
  const { request, browserPool, deadline, timeoutMs, quietPeriodMs, maxOutputBytes } = options
  let browser: MarkdownBrowser | undefined
  let context: MarkdownBrowserContext | undefined
  let network: RenderNetworkTracker | undefined
  let timedOut = false

  try {
    browser = await browserPool.acquire(deadline)
    // A fresh context has no cookies, storage, credentials, or caller headers.
    context = await deadline.wait(browser.newContext())
    const page = await deadline.wait(context.newPage())
    network = trackRenderNetwork(page, quietPeriodMs)
    const navigation = await deadline.wait(page.goto(request.renderUrl, {
      waitUntil: "domcontentloaded",
      timeout: deadline.remaining()
    }))
    if (!navigation?.ok()) {
      throw new Error(`Navigation returned HTTP ${navigation?.status() ?? "unknown"}`)
    }
    await deadline.wait(network.waitForIdle())
    await deadline.wait(page.evaluate(settleRenderedPage, quietPeriodMs))
    // A mount effect can start data loading after the first idle window. Observe
    // one more idle edge before extraction, then let the page flush its result.
    await deadline.wait(network.waitForIdle())
    await deadline.wait(page.evaluate(settleRenderedPage, 0))
    const cleaned = await deadline.wait(page.evaluate(cleanupRenderedDocument, {
      basePath: request.basePath,
      internalBasePath: request.internalBasePath
    }))
    if (cleaned.mountEmpty) {
      throw new Error("The Show Page mount is empty")
    }

    const markdown = convertRenderedHtmlToMarkdown(cleaned.html)
    if (!markdown.trim()) {
      throw new Error("The rendered page has no Markdown content")
    }
    if (Buffer.byteLength(markdown, "utf8") > maxOutputBytes) {
      throw new MarkdownRenderError(
        "output_too_large",
        502,
        `Rendered Markdown exceeds the ${formatByteLimit(maxOutputBytes)} output limit.`
      )
    }
    return markdown
  } catch (error) {
    if (error instanceof MarkdownRenderError) {
      timedOut = error.code === "render_timeout"
      throw error
    }
    if (isTimeoutError(error) || deadline.expired()) {
      timedOut = true
      throw new MarkdownRenderError(
        "render_timeout",
        504,
        `Show Page rendering exceeded the ${formatTimeout(timeoutMs)} timeout.`,
        { cause: error }
      )
    }
    throw renderFailed("Show Page rendering failed.", error)
  } finally {
    network?.dispose()
    try {
      if (context) {
        const closing = context.close().catch(() => undefined)
        if (!timedOut) {
          await deadline.wait(closing)
        }
      }
    } finally {
      if (browser && !browser.isConnected()) {
        browserPool.discard(browser)
      }
      if (timedOut && browser) {
        // Never hand a browser with a timed-out context to the next serialized
        // render. Closing is best-effort because the response deadline elapsed.
        browserPool.discard(browser)
        void browser.close().catch(() => undefined)
      }
      browserPool.release()
    }
  }
}

type RenderNetworkTracker = {
  waitForIdle(): Promise<void>
  dispose(): void
}

function trackRenderNetwork(
  page: MarkdownPage,
  quietPeriodMs: number
): RenderNetworkTracker {
  const pending = new Map<MarkdownNetworkRequest, string>()
  const completedPolls = new Set<string>()
  let activityVersion = 0
  let disposed = false

  const requestKey = (request: MarkdownNetworkRequest) =>
    `${request.method()}\0${request.resourceType()}\0${request.url()}`

  const requestStarted = (request: MarkdownNetworkRequest) => {
    const resourceType = request.resourceType().toLowerCase()
    if (resourceType === "eventsource" || resourceType === "websocket") return
    const key = requestKey(request)
    // The first XHR/fetch populates the page; identical later requests are a
    // polling loop and must not make a snapshot impossible.
    if ((resourceType === "fetch" || resourceType === "xhr") && completedPolls.has(key)) return
    pending.set(request, key)
    activityVersion += 1
  }
  const requestSettled = (request: MarkdownNetworkRequest) => {
    const key = pending.get(request)
    if (key === undefined) return
    pending.delete(request)
    const resourceType = request.resourceType().toLowerCase()
    if (resourceType === "fetch" || resourceType === "xhr") completedPolls.add(key)
    activityVersion += 1
  }

  page.on("request", requestStarted)
  page.on("requestfinished", requestSettled)
  page.on("requestfailed", requestSettled)

  return {
    async waitForIdle() {
      let idleSince: number | undefined
      let idleVersion = -1
      while (!disposed) {
        const now = Date.now()
        if (pending.size === 0) {
          if (idleSince === undefined || idleVersion !== activityVersion) {
            idleSince = now
            idleVersion = activityVersion
          }
          if (now - idleSince >= quietPeriodMs) return
        } else {
          idleSince = undefined
          idleVersion = activityVersion
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      pending.clear()
      page.off("request", requestStarted)
      page.off("requestfinished", requestSettled)
      page.off("requestfailed", requestSettled)
    }
  }
}

/**
 * Runs inside the browser page. Keep this function self-contained: Playwright
 * serializes its body and does not carry module-scope bindings with it.
 */
export function settleRenderedPage(quietPeriodMs: number): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(resolve, quietPeriodMs)
      })
    })
  })
}

/**
 * Runs inside the rendered page before any HTML crosses back into Node. The
 * annotation selectors mirror the runtime SDK's overlay chrome attributes.
 */
export function cleanupRenderedDocument(options: {
  basePath: string
  internalBasePath: string
}): CleanedDocument {
  const cleanupSelector = [
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    '[aria-hidden="true"]',
    "[hidden]",
    "[data-agent-hidden]",
    "[data-show-annotation-ui]",
    "[data-show-annotation-capture]",
    "[data-show-agent-mark-layer]",
    "[data-show-annotation-root]",
    ".avs-fallback-shell"
  ].join(",")

  for (const element of document.querySelectorAll(cleanupSelector)) {
    element.remove()
  }

  for (const element of document.querySelectorAll<HTMLElement>("[agent-note]")) {
    const text = element.getAttribute("agent-note")?.trim()
    element.removeAttribute("agent-note")
    if (!text) continue
    const note = document.createElement("blockquote")
    note.setAttribute("data-avibe-agent-note", "")
    note.textContent = `agent-note: ${text}`
    if (!element.insertAdjacentElement("afterend", note)) {
      element.append(note)
    }
  }

  const documentUrl = new URL(document.URL)
  const documentBase = new URL(document.baseURI)
  const callerBase = new URL(options.basePath, documentUrl.origin)
  const internalBase = new URL(options.internalBasePath, documentUrl.origin)
  const internalRoot = internalBase.pathname.endsWith("/")
    ? internalBase.pathname
    : `${internalBase.pathname}/`
  const callerRoot = callerBase.pathname.endsWith("/")
    ? callerBase.pathname
    : `${callerBase.pathname}/`
  const callerDocumentBase = new URL(documentBase.href)
  if (callerDocumentBase.origin === documentUrl.origin) {
    const suffix = internalPathSuffix(callerDocumentBase.pathname)
    if (suffix !== undefined) callerDocumentBase.pathname = `${callerRoot}${suffix}`
  }

  function internalPathSuffix(pathname: string): string | undefined {
    if (pathname === internalRoot.slice(0, -1)) return ""
    if (!pathname.startsWith(internalRoot)) return undefined
    return pathname.slice(internalRoot.length).replace(/^\/+/, "")
  }

  function rewriteAttribute(element: Element, attribute: "href" | "src") {
    const raw = element.getAttribute(attribute)
    if (raw === null || /^(?:data|javascript|mailto|tel):/i.test(raw.trim())) return

    const isCallerRelative = raw === "" || raw.startsWith("#") || raw.startsWith("?") ||
      (!raw.startsWith("/") && !/^[a-z][a-z\d+.-]*:/i.test(raw))
    let resolved: URL
    try {
      resolved = new URL(raw, isCallerRelative ? callerDocumentBase : documentBase)
    } catch {
      return
    }

    if (resolved.origin !== documentUrl.origin) {
      element.setAttribute(attribute, resolved.href)
      return
    }

    const suffix = internalPathSuffix(resolved.pathname)
    if (suffix !== undefined) resolved.pathname = `${callerRoot}${suffix}`
    element.setAttribute(attribute, `${resolved.pathname}${resolved.search}${resolved.hash}`)
  }

  for (const anchor of document.querySelectorAll("a[href]")) {
    rewriteAttribute(anchor, "href")
  }
  for (const image of document.querySelectorAll("img[src]")) {
    rewriteAttribute(image, "src")
  }

  const mount = document.querySelector("#root, #app, [data-show-root]")
  const mountEmpty = Boolean(
    mount &&
    !mount.textContent?.trim() &&
    !mount.querySelector("img, picture, video, audio, input, button, table, ul, ol, dl")
  )
  return {
    html: document.body?.innerHTML.trim() ?? "",
    mountEmpty
  }
}

export function convertRenderedHtmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    headingStyle: "atx",
    strongDelimiter: "**"
  })
  turndown.use(gfm)
  const markdown = turndown.turndown(html).trim()
  return markdown ? `${markdown}\n` : ""
}

export async function workspaceFingerprint(workspace: string): Promise<string> {
  const hash = createHash("sha256")
  await fingerprintDirectory(workspace, "", hash)
  return hash.digest("hex")
}

async function fingerprintDirectory(
  workspace: string,
  relativeDirectory: string,
  hash: ReturnType<typeof createHash>
): Promise<void> {
  const directory = relativeDirectory ? join(workspace, relativeDirectory) : workspace
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    if (!relativeDirectory && WORKSPACE_FINGERPRINT_EXCLUDED_ENTRIES.has(entry.name)) continue
    const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name
    const path = join(workspace, relativePath)
    const info = await lstat(path, { bigint: true })
    hash.update(relativePath.replaceAll("\\", "/"))
    hash.update("\0")
    hash.update(entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file")
    hash.update("\0")
    hash.update(info.size.toString())
    hash.update("\0")
    hash.update(info.mtimeNs.toString())
    hash.update("\0")
    if (entry.isSymbolicLink()) {
      const target = await stat(path, { bigint: true }).catch(() => undefined)
      if (target) {
        hash.update(target.size.toString())
        hash.update("\0")
        hash.update(target.mtimeNs.toString())
        hash.update("\0")
      }
    }
    if (entry.isDirectory()) {
      await fingerprintDirectory(workspace, relativePath, hash)
    }
  }
}

async function fingerprintOrRenderFailed(workspace: string): Promise<string> {
  try {
    return await workspaceFingerprint(workspace)
  } catch (error) {
    throw renderFailed("Show Page workspace could not be read.", error)
  }
}

function renderCacheKey(request: MarkdownRenderRequest): string {
  return JSON.stringify([request.sessionId, request.target, request.basePath])
}

class MarkdownRenderCache {
  private readonly entries = new Map<string, CacheEntry>()

  constructor(private readonly options: {
    ttlMs: number
    entriesPerSession: number
    entriesGlobal: number
    now: () => number
  }) {}

  get(key: string, fingerprint: string): CacheEntry | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.fingerprint !== fingerprint || this.isExpired(entry, this.options.now())) {
      this.entries.delete(key)
      return undefined
    }

    // Map insertion order is the global LRU order. A successful serve makes
    // this entry the most recently served without extending its TTL.
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

  delete(key: string): void {
    this.entries.delete(key)
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

class BrowserPool {
  private browser: MarkdownBrowser | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly options: {
    idleMs: number
    discoveryDisabled: boolean
    provisioningDisabled: boolean
    provisionTimeoutMs: number
    launchBrowser: BrowserLauncher
    provisionBrowser: BrowserProvisioner
  }) {}

  private provisionAttempted = false
  private provisionFailure: BrowserProvisionResult | undefined

  async acquire(deadline: RenderDeadline): Promise<MarkdownBrowser> {
    this.clearIdleTimer()
    if (this.disposed) {
      throw renderFailed("The Markdown browser pool is closed.")
    }
    if (this.browser?.isConnected()) {
      return this.browser
    }
    this.browser = undefined
    const launchErrors: unknown[] = []
    if (!this.options.discoveryDisabled) {
      for (const channel of SYSTEM_BROWSER_CHANNELS) {
        const launched = await this.tryLaunch(channel, deadline, launchErrors)
        if (launched) return launched
      }
    }

    // A previously provisioned shell remains usable even when NEW provisioning
    // is disabled. Playwright resolves it from its user-owned browser cache.
    const cachedManaged = await this.tryLaunch(MANAGED_BROWSER_TARGET, deadline, launchErrors)
    if (cachedManaged) return cachedManaged

    if (this.options.provisioningDisabled) {
      throw rendererUnavailable({
        causes: launchErrors,
        provisioningDisabled: true
      })
    }

    if (!this.provisionAttempted) {
      this.provisionAttempted = true
      const provisionStarted = Date.now()
      try {
        this.provisionFailure = await this.options.provisionBrowser(this.options.provisionTimeoutMs)
      } catch (error) {
        this.provisionFailure = {
          ok: false,
          missingLinuxDependencies: missingLinuxDependencies(error),
          error
        }
      } finally {
        // Browser download time is provisioning, not page-render time. Preserve
        // the frozen hard timeout for launch/navigation/settling/extraction.
        deadline.extendBy(Date.now() - provisionStarted)
      }
    }

    if (this.provisionFailure?.ok) {
      const provisioned = await this.tryLaunch(MANAGED_BROWSER_TARGET, deadline, launchErrors)
      if (provisioned) return provisioned
    }
    throw rendererUnavailable({
      causes: [...launchErrors, this.provisionFailure?.error],
      provisioningFailed: true,
      missingLinuxDependencies: this.provisionFailure?.missingLinuxDependencies
    })
  }

  release(): void {
    this.clearIdleTimer()
    const browser = this.browser
    if (!browser) return
    this.idleTimer = setTimeout(() => {
      if (this.browser !== browser) return
      this.browser = undefined
      void browser.close().catch(() => undefined)
    }, this.options.idleMs)
    this.idleTimer.unref?.()
  }

  discard(browser: MarkdownBrowser): void {
    if (this.browser === browser) {
      this.browser = undefined
      this.clearIdleTimer()
    }
  }

  async close(): Promise<void> {
    this.disposed = true
    this.clearIdleTimer()
    const browser = this.browser
    this.browser = undefined
    if (browser) {
      await browser.close().catch(() => undefined)
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  private async tryLaunch(
    target: BrowserTarget,
    deadline: RenderDeadline,
    errors: unknown[]
  ): Promise<MarkdownBrowser | undefined> {
    try {
      const launched = await deadline.wait(
        this.options.launchBrowser(target, deadline.remaining())
      )
      if (!launched.isConnected()) {
        await launched.close().catch(() => undefined)
        throw new Error(`${target} disconnected during launch`)
      }
      launched.on("disconnected", () => {
        if (this.browser === launched) {
          this.browser = undefined
          this.clearIdleTimer()
        }
      })
      this.browser = launched
      return launched
    } catch (error) {
      if (isTimeoutError(error) || deadline.expired()) {
        throw new MarkdownRenderError(
          "render_timeout",
          504,
          "Show Page rendering exceeded the configured timeout.",
          { cause: error }
        )
      }
      errors.push(error)
      return undefined
    }
  }
}

class RenderDeadline {
  private expiresAt: number

  constructor(timeoutMs: number) {
    this.expiresAt = Date.now() + timeoutMs
  }

  remaining(): number {
    const remaining = this.expiresAt - Date.now()
    if (remaining <= 0) {
      throw new RenderDeadlineError()
    }
    return remaining
  }

  expired(): boolean {
    return Date.now() >= this.expiresAt
  }

  extendBy(durationMs: number): void {
    if (Number.isFinite(durationMs) && durationMs > 0) {
      this.expiresAt += durationMs
    }
  }

  async wait<T>(operation: Promise<T>): Promise<T> {
    const remaining = this.remaining()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new RenderDeadlineError()), remaining)
          timer.unref?.()
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

class RenderDeadlineError extends Error {
  constructor() {
    super("Markdown render deadline exceeded")
    this.name = "TimeoutError"
  }
}

class AsyncMutex {
  private tail = Promise.resolve()

  async runExclusive<T>(operation: () => Promise<T>, deadline?: RenderDeadline): Promise<T> {
    const previous = this.tail
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Even a caller that times out while queued remains chained behind the
    // current owner, so abandoning its slot never lets a later render overlap.
    this.tail = previous.then(() => gate)
    try {
      if (deadline) await deadline.wait(previous)
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

async function launchBrowserTarget(
  target: BrowserTarget,
  timeoutMs: number
): Promise<MarkdownBrowser> {
  return await chromium.launch({
    ...(target === MANAGED_BROWSER_TARGET ? {} : { channel: target }),
    headless: true,
    timeout: timeoutMs
  }) as unknown as MarkdownBrowser
}

async function provisionManagedBrowser(timeoutMs: number): Promise<BrowserProvisionResult> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      PLAYWRIGHT_CLI_PATH,
      "install",
      "chromium",
      "--only-shell",
      "--no-progress"
    ], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    })
    let output = ""
    const appendOutput = (chunk: Buffer | string) => {
      if (output.length < 64 * 1024) {
        output += chunk.toString().slice(0, 64 * 1024 - output.length)
      }
    }
    child.stdout?.on("data", appendOutput)
    child.stderr?.on("data", appendOutput)

    let settled = false
    const finish = (result: BrowserProvisionResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({
        ok: false,
        error: new Error("Managed browser provisioning timed out")
      })
    }, timeoutMs)
    child.once("error", (error) => {
      finish({
        ok: false,
        missingLinuxDependencies: missingLinuxDependencies(error),
        error
      })
    })
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish({ ok: true })
        return
      }
      const error = new Error(
        `Managed browser provisioning failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}): ${output}`
      )
      finish({
        ok: false,
        missingLinuxDependencies: missingLinuxDependencies(error),
        error
      })
    })
  })
}

function rendererUnavailable(options: {
  causes?: unknown[]
  provisioningDisabled?: boolean
  provisioningFailed?: boolean
  missingLinuxDependencies?: boolean
} = {}): MarkdownRenderError {
  const causes = (options.causes ?? []).filter((cause) => cause !== undefined)
  const missingDependencies = options.missingLinuxDependencies || causes.some(missingLinuxDependencies)
  let message: string
  if (missingDependencies) {
    message = "No usable browser was found because Linux browser libraries are missing. Install Google Chrome or Microsoft Edge, or run `playwright install --with-deps chromium` as root, then retry."
  } else if (options.provisioningDisabled) {
    message = "No usable browser was found. Install Google Chrome or Microsoft Edge, or enable managed Playwright provisioning by unsetting AVIBE_SHOW_RENDER_NO_PROVISION."
  } else if (options.provisioningFailed) {
    message = "No usable browser was found. Install Google Chrome or Microsoft Edge, or restore network access and restart the runtime to retry managed Playwright provisioning."
  } else {
    message = "No usable browser was found. Install Google Chrome or Microsoft Edge, or enable managed Playwright provisioning."
  }
  return new MarkdownRenderError(
    "renderer_unavailable",
    503,
    message,
    { cause: causes.at(-1) }
  )
}

function renderFailed(message: string, cause?: unknown): MarkdownRenderError {
  return new MarkdownRenderError("render_failed", 502, message, { cause })
}

function normalizeRenderError(
  error: unknown,
  timeoutMs: number,
  deadline: RenderDeadline
): MarkdownRenderError {
  if (error instanceof MarkdownRenderError) return error
  if (isTimeoutError(error) || deadline.expired()) {
    return new MarkdownRenderError(
      "render_timeout",
      504,
      `Show Page rendering exceeded the ${formatTimeout(timeoutMs)} timeout.`,
      { cause: error }
    )
  }
  return renderFailed("Show Page rendering failed.", error)
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof RenderDeadlineError || (
    error instanceof Error && error.name === "TimeoutError"
  )
}

function missingLinuxDependencies(error: unknown): boolean {
  if (process.platform !== "linux") return false
  const message = error instanceof Error ? `${error.message}\n${String(error.cause ?? "")}` : String(error ?? "")
  return /missing dependencies|missing libraries|install-deps|install --with-deps|shared libraries|shared object file/i.test(message)
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
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
  if (bytes % 1024 === 0) {
    return `${bytes / 1024} KiB`
  }
  return `${bytes} byte`
}
