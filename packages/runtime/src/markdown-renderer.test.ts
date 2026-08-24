import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cleanupRenderedDocument,
  convertRenderedHtmlToMarkdown,
  createMarkdownRenderer,
  settleRenderedPage,
  workspaceFingerprint,
  type BrowserTarget,
  type MarkdownBrowser,
  type MarkdownBrowserContext,
  type MarkdownPage,
  type MarkdownRenderRequest
} from "./markdown-renderer.js"
import { startShowRuntimeServer } from "./server.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true
  })))
})

describe("rendered DOM conversion", () => {
  it("removes non-semantic subtrees, annotation chrome, and preserves agent notes", () => {
    const removed = Array.from({ length: 13 }, () => new FakeElement())
    const noted = new FakeElement({ "agent-note": "Prefer the audited total" })
    const relativeLink = new FakeElement({ href: "reports/daily" })
    const currentLink = new FakeElement({ href: "#details" })
    const internalLink = new FakeElement({ href: "/sessions/demo/app/settings" })
    const image = new FakeElement({ src: "images/chart.png" })
    const mount = new FakeElement()
    mount.textContent = "Visible page content"
    const queried: string[] = []
    const fakeDocument = {
      URL: "http://127.0.0.1:4177/sessions/demo/app/overview?view=week",
      baseURI: "http://127.0.0.1:4177/sessions/demo/app/overview?view=week",
      body: { innerHTML: "<main>Visible page content</main>" },
      createElement: () => new FakeElement(),
      querySelector(selector: string) {
        return selector.startsWith("#root") ? mount : null
      },
      querySelectorAll(selector: string) {
        queried.push(selector)
        if (selector === "[agent-note]") return [noted]
        if (selector === "a[href]") return [relativeLink, currentLink, internalLink]
        if (selector === "img[src]") return [image]
        return removed
      }
    }

    const result = withDocument(fakeDocument as unknown as Document, () => cleanupRenderedDocument({
      basePath: "/p/public-share/",
      internalBasePath: "/sessions/demo/app/"
    }))

    expect(removed.every((element) => element.removed)).toBe(true)
    const cleanupQuery = queried[0]
    for (const selector of [
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
      "[data-show-annotation-root]"
    ]) {
      expect(cleanupQuery).toContain(selector)
    }
    expect(noted.getAttribute("agent-note")).toBeNull()
    expect(noted.insertedAfter?.textContent).toBe("agent-note: Prefer the audited total")
    expect(relativeLink.getAttribute("href")).toBe("/p/public-share/reports/daily")
    expect(currentLink.getAttribute("href")).toBe("/p/public-share/overview?view=week#details")
    expect(internalLink.getAttribute("href")).toBe("/p/public-share/settings")
    expect(image.getAttribute("src")).toBe("/p/public-share/images/chart.png")
    expect(result).toEqual({ html: "<main>Visible page content</main>", mountEmpty: false })
  })

  it("converts semantic HTML with the GFM table and strikethrough extensions", () => {
    const markdown = convertRenderedHtmlToMarkdown(`
      <main>
        <h1>Release status</h1>
        <table>
          <thead><tr><th>Lane</th><th>Status</th></tr></thead>
          <tbody><tr><td>A</td><td>Ready</td></tr></tbody>
        </table>
        <p><s>Draft</s> Final</p>
        <blockquote>agent-note: Verify the release asset first</blockquote>
      </main>
    `)

    expect(markdown).toContain("# Release status")
    expect(markdown).toContain("| Lane | Status |")
    expect(markdown).toContain("| A | Ready |")
    expect(markdown).toContain("~Draft~ Final")
    expect(markdown).toContain("> agent-note: Verify the release asset first")
    expect(markdown.endsWith("\n")).toBe(true)
  })
})

describe("workspace render cache", () => {
  it("ignores dotfiles and node_modules but changes for every workspace-owned file change", async () => {
    const workspace = await temporaryDirectory("fingerprint")
    await mkdir(join(workspace, "src"), { recursive: true })
    await mkdir(join(workspace, ".git"), { recursive: true })
    await mkdir(join(workspace, "node_modules", "fixture"), { recursive: true })
    await writeFile(join(workspace, "src", "App.tsx"), "export default 'one'\n")
    await writeFile(join(workspace, ".git", "HEAD"), "private-one\n")
    await writeFile(join(workspace, "node_modules", "fixture", "index.js"), "ignored-one\n")
    const initial = await workspaceFingerprint(workspace)

    await writeFile(join(workspace, ".git", "HEAD"), "private-two-with-a-different-size\n")
    await writeFile(join(workspace, "node_modules", "fixture", "index.js"), "ignored-two-with-a-different-size\n")
    expect(await workspaceFingerprint(workspace)).toBe(initial)

    await writeFile(join(workspace, "src", "App.tsx"), "export default 'two-with-a-different-size'\n")
    expect(await workspaceFingerprint(workspace)).not.toBe(initial)
  })

  it("serializes concurrent misses and lets the second request use the first result", async () => {
    const workspace = await fixtureWorkspace("serialized")
    const browser = new FakeBrowser(() => ({ html: "<h1>Serialized</h1>", mode: "success" }))
    const launches: BrowserTarget[] = []
    const prepare = vi.fn(async () => undefined)
    const renderer = createMarkdownRenderer({
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        launches.push(target)
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 0
    })
    const request = renderRequest(workspace, prepare)

    try {
      const [first, second] = await Promise.all([
        renderer.render(request),
        renderer.render(request)
      ])
      expect([first.cache, second.cache].sort()).toEqual(["hit", "miss"])
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(browser.contextCount).toBe(1)
      expect(launches).toEqual(["chrome"])
    } finally {
      await renderer.close()
    }
  })

  it("keys entries by rendering context and expires dynamic data at the TTL backstop", async () => {
    const workspace = await fixtureWorkspace("cache-context")
    const browser = new FakeBrowser(() => ({ html: "<h1>Context cache</h1>", mode: "success" }))
    let now = 10_000
    const renderer = createMarkdownRenderer({
      cacheTtlMs: 30_000,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      browserProvisioningDisabled: true,
      quietPeriodMs: 0,
      now: () => now
    })
    const shared = renderRequest(workspace)
    const privateRequest = { ...shared, context: "private" as const }
    const nestedRequest = {
      ...shared,
      target: "/dashboard?view=week",
      renderUrl: "http://127.0.0.1:4177/sessions/fixture/app/dashboard?view=week"
    }

    try {
      await expect(renderer.render(shared)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(shared)).resolves.toMatchObject({ cache: "hit" })
      await expect(renderer.render(privateRequest)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(nestedRequest)).resolves.toMatchObject({ cache: "miss" })
      expect(browser.contextCount).toBe(3)

      now += 30_000
      await expect(renderer.render(shared)).resolves.toMatchObject({ cache: "miss" })
      expect(browser.contextCount).toBe(4)
    } finally {
      await renderer.close()
    }
  })
})

describe("browser resolution ladder", () => {
  it("uses Chrome first and never provisions when a system browser is available", async () => {
    const workspace = await fixtureWorkspace("system-browser")
    const browser = new FakeBrowser(() => ({ html: "<h1>System Chrome</h1>", mode: "success" }))
    const targets: BrowserTarget[] = []
    const provision = vi.fn(async () => ({ ok: true }))
    const renderer = createMarkdownRenderer({
      launchBrowser: async (target) => {
        targets.push(target)
        return browser
      },
      provisionBrowser: provision,
      quietPeriodMs: 0
    })

    try {
      await expect(renderer.render(renderRequest(workspace))).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(renderRequest(workspace, undefined, "/p/second-base/"))).resolves.toMatchObject({ cache: "miss" })
      expect(targets).toEqual(["chrome"])
      expect(browser.contextCount).toBe(2)
      expect(provision).not.toHaveBeenCalled()
    } finally {
      await renderer.close()
    }
  })

  it("provisions the managed shell once, then reuses its cached installation after a crash", async () => {
    const workspace = await fixtureWorkspace("managed-browser")
    let installed = false
    const browsers: FakeBrowser[] = []
    const targets: BrowserTarget[] = []
    const provision = vi.fn(async () => {
      installed = true
      return { ok: true }
    })
    const renderer = createMarkdownRenderer({
      launchBrowser: async (target) => {
        targets.push(target)
        if (target !== "managed" || !installed) throw new Error(`${target} unavailable`)
        const browser = new FakeBrowser(() => ({ html: "<h1>Managed shell</h1>", mode: "success" }))
        browsers.push(browser)
        return browser
      },
      provisionBrowser: provision,
      quietPeriodMs: 0
    })

    try {
      await renderer.render(renderRequest(workspace))
      expect(targets).toEqual(["chrome", "msedge", "managed", "managed"])
      expect(provision).toHaveBeenCalledTimes(1)

      browsers[0].disconnect()
      await writeFile(join(workspace, "src", "App.tsx"), "export default 'changed after crash'\n")
      await renderer.render(renderRequest(workspace, undefined, "/p/after-crash/"))
      expect(provision).toHaveBeenCalledTimes(1)
      expect(targets.at(-1)).toBe("managed")
      expect(browsers).toHaveLength(2)
    } finally {
      await renderer.close()
    }
  })

  it("returns deterministic remediation when provisioning is disabled by environment", async () => {
    const workspace = await fixtureWorkspace("no-provision")
    const oldNoProvision = process.env.AVIBE_SHOW_RENDER_NO_PROVISION
    const oldNoDiscovery = process.env.VIBE_SHOW_RENDER_DISABLE_BROWSER_DISCOVERY
    process.env.AVIBE_SHOW_RENDER_NO_PROVISION = "1"
    process.env.VIBE_SHOW_RENDER_DISABLE_BROWSER_DISCOVERY = "1"
    const provision = vi.fn(async () => ({ ok: true }))
    const renderer = createMarkdownRenderer({
      launchBrowser: async () => { throw new Error("managed shell not installed") },
      provisionBrowser: provision
    })
    restoreEnvironment("AVIBE_SHOW_RENDER_NO_PROVISION", oldNoProvision)
    restoreEnvironment("VIBE_SHOW_RENDER_DISABLE_BROWSER_DISCOVERY", oldNoDiscovery)

    try {
      await expect(renderer.render(renderRequest(workspace))).rejects.toMatchObject({
        code: "renderer_unavailable",
        status: 503,
        message: expect.stringContaining("AVIBE_SHOW_RENDER_NO_PROVISION")
      })
      expect(provision).not.toHaveBeenCalled()
    } finally {
      await renderer.close()
    }
  })

  it("names the root-only Linux dependency remediation", async () => {
    const workspace = await fixtureWorkspace("missing-libraries")
    const renderer = createMarkdownRenderer({
      browserDiscoveryDisabled: true,
      launchBrowser: async () => { throw new Error("not installed") },
      provisionBrowser: async () => ({ ok: false, missingLinuxDependencies: true })
    })

    try {
      await expect(renderer.render(renderRequest(workspace))).rejects.toMatchObject({
        code: "renderer_unavailable",
        status: 503,
        message: expect.stringMatching(/playwright install --with-deps.*root/)
      })
    } finally {
      await renderer.close()
    }
  })

  it("closes an idle pooled browser and launches a replacement", async () => {
    const workspace = await fixtureWorkspace("idle-browser")
    const browsers: FakeBrowser[] = []
    const renderer = createMarkdownRenderer({
      browserIdleMs: 10,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        const browser = new FakeBrowser(() => ({ html: "<h1>Idle pool</h1>", mode: "success" }))
        browsers.push(browser)
        return browser
      },
      quietPeriodMs: 0
    })

    try {
      await renderer.render(renderRequest(workspace))
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(browsers[0].closeCount).toBe(1)

      await renderer.render(renderRequest(workspace, undefined, "/p/after-idle/"))
      expect(browsers).toHaveLength(2)
    } finally {
      await renderer.close()
    }
  })

  it("applies the hard timeout while preparing a cold session", async () => {
    const workspace = await fixtureWorkspace("prepare-timeout")
    const launch = vi.fn(async () => new FakeBrowser(() => ({ html: "<h1>Never reached</h1>", mode: "success" })))
    const renderer = createMarkdownRenderer({
      timeoutMs: 100,
      browserProvisioningDisabled: true,
      launchBrowser: launch
    })

    try {
      await expect(renderer.render(renderRequest(
        workspace,
        async () => await new Promise(() => undefined)
      ))).rejects.toMatchObject({ code: "render_timeout", status: 504 })
      expect(launch).not.toHaveBeenCalled()
    } finally {
      await renderer.close()
    }
  })

  it("applies the hard timeout to a stalled page and discards its browser", async () => {
    const workspace = await fixtureWorkspace("page-timeout")
    const browser = new FakeBrowser(() => ({ html: "<h1>Never reached</h1>", mode: "stalled" }))
    const renderer = createMarkdownRenderer({
      timeoutMs: 100,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      }
    })

    try {
      await expect(renderer.render(renderRequest(workspace))).rejects.toMatchObject({
        code: "render_timeout",
        status: 504
      })
      expect(browser.closeCount).toBe(1)
    } finally {
      await renderer.close()
    }
  })
})

describe("render-markdown HTTP contract", () => {
  it("serves capabilities, Markdown, cache invalidation, and every deterministic error shape", async () => {
    const workspaceRoot = await temporaryDirectory("server")
    const workspace = await fixtureWorkspace("page", workspaceRoot)
    let mode: FakePageMode = "success"
    const fixtureHtml = `
      <main id="root">
        <h1>Fixture release</h1>
        <table><thead><tr><th>Lane</th><th>Status</th></tr></thead><tbody><tr><td>A</td><td>Ready</td></tr></tbody></table>
        <a href="/p/public-share/details">Details</a>
        <blockquote>agent-note: Publish assets before repointing</blockquote>
      </main>
    `
    const pageState = () => ({
      html: mode === "large" ? `<p>${"x".repeat(2048)}</p>` : fixtureHtml,
      mode,
      expectedNavigationBody: "/sessions/page/app/src/main.tsx"
    })
    let browser = new FakeBrowser(pageState)
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      renderMaxOutputBytes: 512,
      renderTimeoutMs: 15_000
    }, {
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        if (!browser.isConnected()) browser = new FakeBrowser(pageState)
        return browser
      },
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0
    })

    try {
      const capabilities = await fetch(`${runtime.url}/capabilities`)
      expect(capabilities.status).toBe(200)
      expect(await capabilities.json()).toEqual({ render_markdown: true })

      const unknown = await fetch(`${runtime.url}/sessions/unknown/render-markdown`)
      await expectRenderError(unknown, 404, "session_unknown")

      const headers = {
        "X-Avibe-Show-Protocol": "1",
        "X-Avibe-Show-Context": "shared",
        "x-vibe-show-base": "/p/public-share/",
        "x-vibe-show-target": "/dashboard?view=week",
        authorization: "Bearer must-not-forward",
        cookie: "visitor=must-not-forward"
      }
      const first = await fetch(`${runtime.url}/sessions/page/render-markdown`, { headers })
      expect(first.status).toBe(200)
      expect(first.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
      expect(first.headers.get("x-avibe-render-cache")).toBe("miss")
      const firstMarkdown = await first.text()
      expect(firstMarkdown).toContain("# Fixture release")
      expect(firstMarkdown).toContain("| A | Ready |")
      expect(firstMarkdown).toContain("[Details](/p/public-share/details)")
      expect(firstMarkdown).toContain("> agent-note: Publish assets before repointing")
      expect(browser.newContextArguments).toEqual([[]])
      expect(browser.visitedUrls[0]).toMatch(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+\/sessions\/page\/app\/dashboard\?view=week$/)

      const cached = await fetch(`${runtime.url}/sessions/page/render-markdown`, { headers })
      expect(cached.headers.get("x-avibe-render-cache")).toBe("hit")
      expect(browser.contextCount).toBe(1)
      await cached.text()

      const rootHeaders = { ...headers }
      delete (rootHeaders as { "x-vibe-show-target"?: string })["x-vibe-show-target"]
      const root = await fetch(`${runtime.url}/sessions/page/render-markdown`, { headers: rootHeaders })
      expect(root.headers.get("x-avibe-render-cache")).toBe("miss")
      expect(browser.contextCount).toBe(2)
      expect(browser.visitedUrls[1]).toMatch(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+\/sessions\/page\/app\/$/)
      await root.text()

      for (const target of [
        "dashboard",
        "/reports/../secret",
        "/%2e%2e/secret",
        "/https://example.com",
        "//example.com/path"
      ]) {
        const invalid = await fetch(`${runtime.url}/sessions/page/render-markdown`, {
          headers: { ...headers, "x-vibe-show-target": target }
        })
        await expectRenderError(invalid, 400, "invalid_target")
      }

      await writeFile(join(workspace, "src", "App.tsx"), "document.getElementById('root')!.textContent = 'changed'\n")
      const invalidated = await fetch(`${runtime.url}/sessions/page/render-markdown`, { headers })
      expect(invalidated.headers.get("x-avibe-render-cache")).toBe("miss")
      expect(browser.contextCount).toBe(3)
      await invalidated.text()

      mode = "timeout"
      const timeout = await fetch(`${runtime.url}/sessions/page/render-markdown`, {
        headers: { ...headers, "x-vibe-show-base": "/p/timeout/" }
      })
      await expectRenderError(timeout, 504, "render_timeout")

      mode = "failed"
      const failed = await fetch(`${runtime.url}/sessions/page/render-markdown`, {
        headers: { ...headers, "x-vibe-show-base": "/p/failed/" }
      })
      await expectRenderError(failed, 502, "render_failed")

      mode = "large"
      const large = await fetch(`${runtime.url}/sessions/page/render-markdown`, {
        headers: { ...headers, "x-vibe-show-base": "/p/large/" }
      })
      await expectRenderError(large, 502, "output_too_large")
    } finally {
      await runtime.close()
    }
  }, 30_000)

  it("maps disabled discovery and provisioning to renderer_unavailable JSON", async () => {
    const workspaceRoot = await temporaryDirectory("unavailable-server")
    await fixtureWorkspace("page", workspaceRoot)
    const oldNoProvision = process.env.AVIBE_SHOW_RENDER_NO_PROVISION
    const oldNoDiscovery = process.env.VIBE_SHOW_RENDER_DISABLE_BROWSER_DISCOVERY
    process.env.AVIBE_SHOW_RENDER_NO_PROVISION = "1"
    process.env.VIBE_SHOW_RENDER_DISABLE_BROWSER_DISCOVERY = "1"
    const provision = vi.fn(async () => ({ ok: true }))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache")
    }, {
      launchBrowser: async () => { throw new Error("managed browser absent") },
      provisionBrowser: provision,
      renderQuietPeriodMs: 0
    })
    restoreEnvironment("AVIBE_SHOW_RENDER_NO_PROVISION", oldNoProvision)
    restoreEnvironment("VIBE_SHOW_RENDER_DISABLE_BROWSER_DISCOVERY", oldNoDiscovery)

    try {
      const response = await fetch(`${runtime.url}/sessions/page/render-markdown`, {
        headers: {
          "X-Avibe-Show-Protocol": "1",
          "X-Avibe-Show-Context": "private",
          "x-vibe-show-base": "/show/page/"
        }
      })
      const body = await expectRenderError(response, 503, "renderer_unavailable")
      expect(body.error.message).toMatch(/Chrome|Edge/)
      expect(body.error.message).toContain("AVIBE_SHOW_RENDER_NO_PROVISION")
      expect(provision).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  }, 30_000)
})

type FakePageMode = "success" | "timeout" | "stalled" | "failed" | "large"
type FakePageState = {
  html: string
  mode: FakePageMode
  expectedNavigationBody?: string
}

class FakeBrowser implements MarkdownBrowser {
  connected = true
  contextCount = 0
  closeCount = 0
  readonly newContextArguments: unknown[][] = []
  readonly visitedUrls: string[] = []
  private readonly disconnectListeners = new Set<() => void>()

  constructor(private readonly pageState: () => FakePageState) {}

  isConnected(): boolean {
    return this.connected
  }

  async newContext(...args: unknown[]): Promise<MarkdownBrowserContext> {
    this.newContextArguments.push(args)
    this.contextCount += 1
    return {
      newPage: async () => new FakePage(this.pageState, this.visitedUrls),
      close: async () => undefined
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1
    this.disconnect()
  }

  on(event: "disconnected", listener: () => void): void {
    if (event === "disconnected") this.disconnectListeners.add(listener)
  }

  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    for (const listener of this.disconnectListeners) listener()
  }
}

class FakePage implements MarkdownPage {
  constructor(
    private readonly pageState: () => FakePageState,
    private readonly visitedUrls: string[]
  ) {}

  async goto(url: string): Promise<{ ok(): boolean; status(): number } | null> {
    this.visitedUrls.push(url)
    const state = this.pageState()
    const mode = state.mode
    if (mode === "timeout") {
      const error = new Error("fixture navigation timed out")
      error.name = "TimeoutError"
      throw error
    }
    if (mode === "stalled") {
      return await new Promise(() => undefined)
    }
    if (mode === "failed") {
      throw new Error("fixture navigation failed")
    }
    if (state.expectedNavigationBody) {
      const response = await fetch(url)
      const body = await response.text()
      if (!body.includes(state.expectedNavigationBody)) {
        throw new Error(`anonymous navigation did not preserve loopback base: ${body}`)
      }
      return { ok: () => response.ok, status: () => response.status }
    }
    return { ok: () => true, status: () => 200 }
  }

  async waitForLoadState(): Promise<void> {}

  async evaluate<Result>(pageFunction: () => Result | Promise<Result>): Promise<Result>
  async evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result>
  async evaluate<Result, Argument>(
    pageFunction: (() => Result | Promise<Result>) | ((argument: Argument) => Result | Promise<Result>),
    argument?: Argument
  ): Promise<Result> {
    if (pageFunction === settleRenderedPage) return undefined as Result
    if (pageFunction === cleanupRenderedDocument) {
      return { html: this.pageState().html, mountEmpty: false } as Result
    }
    return await (pageFunction as (argument?: Argument) => Result | Promise<Result>)(argument)
  }
}

class FakeElement {
  removed = false
  insertedAfter: FakeElement | undefined
  textContent = ""
  private readonly attributes = new Map<string, string>()

  constructor(attributes: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  remove(): void {
    this.removed = true
  }

  insertAdjacentElement(_position: string, element: FakeElement): FakeElement {
    this.insertedAfter = element
    return element
  }

  append(element: FakeElement): void {
    this.insertedAfter = element
  }

  querySelector(): null {
    return null
  }
}

function withDocument<T>(fakeDocument: Document, operation: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument
  })
  try {
    return operation()
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "document", descriptor)
    } else {
      delete (globalThis as { document?: Document }).document
    }
  }
}

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `avibe-show-${name}-`))
  temporaryDirectories.push(directory)
  return directory
}

async function fixtureWorkspace(name: string, root?: string): Promise<string> {
  const workspaceRoot = root ?? await temporaryDirectory(`${name}-root`)
  const workspace = root ? join(root, name) : join(workspaceRoot, name)
  await mkdir(join(workspace, "src"), { recursive: true })
  await writeFile(join(workspace, "index.html"), '<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n')
  await writeFile(join(workspace, "src", "main.tsx"), "document.getElementById('root')!.textContent = 'fixture'\n")
  await writeFile(join(workspace, "src", "App.tsx"), "export default 'fixture'\n")
  return workspace
}

function renderRequest(
  workspace: string,
  prepare: (() => Promise<void>) | undefined = undefined,
  basePath = "/p/share/"
): MarkdownRenderRequest {
  return {
    sessionId: "fixture",
    context: "shared",
    basePath,
    target: "/",
    internalBasePath: "/sessions/fixture/app/",
    renderUrl: "http://127.0.0.1:4177/sessions/fixture/app/",
    workspace,
    prepare: prepare ?? (async () => undefined)
  }
}

async function expectRenderError(
  response: Response,
  status: number,
  code: string
): Promise<{ error: { code: string; message: string } }> {
  expect(response.status).toBe(status)
  expect(response.headers.get("content-type")).toContain("application/json")
  const body = await response.json() as { error: { code: string; message: string } }
  expect(body).toEqual({
    error: {
      code,
      message: expect.any(String)
    }
  })
  expect(Object.keys(body)).toEqual(["error"])
  expect(Object.keys(body.error).sort()).toEqual(["code", "message"])
  return body
}

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name]
  else process.env[name] = previous
}
