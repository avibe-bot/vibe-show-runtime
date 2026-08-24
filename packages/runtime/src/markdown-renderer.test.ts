import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
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
  type MarkdownNetworkRequest,
  type MarkdownNetworkResponse,
  type MarkdownPage,
  type MarkdownRenderRequest
} from "./markdown-renderer.js"
import { startShowRuntimeServer } from "./server.js"
import { createWorkspaceFingerprinter } from "./workspace-fingerprint.js"

const viteTestControl = vi.hoisted(() => ({
  beforeBuild: undefined as (() => Promise<void>) | undefined,
  beforeCreateServer: undefined as (() => Promise<void>) | undefined
}))

vi.mock("vite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vite")>()
  return {
    ...actual,
    async build(config?: Parameters<typeof actual.build>[0]) {
      await viteTestControl.beforeBuild?.()
      return await actual.build(config)
    },
    async createServer(config?: Parameters<typeof actual.createServer>[0]) {
      await viteTestControl.beforeCreateServer?.()
      return await actual.createServer(config)
    }
  }
})

const temporaryDirectories: string[] = []

afterEach(async () => {
  viteTestControl.beforeBuild = undefined
  viteTestControl.beforeCreateServer = undefined
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
      internalBasePath: "/sessions/demo/app/",
      maxOutputBytes: 1024
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
    expect(result).toEqual({
      html: "<main>Visible page content</main>",
      mountEmpty: false,
      outputTooLarge: false
    })
  })

  it("stops oversized DOM extraction before full HTML serialization", () => {
    let innerHtmlRead = false
    const body = {
      firstChild: undefined as unknown,
      get innerHTML() {
        innerHtmlRead = true
        throw new Error("full body serialization must not run")
      }
    }
    const text = {
      nodeType: 3,
      nodeValue: "x".repeat(256),
      firstChild: null,
      nextSibling: null,
      parentNode: body
    }
    body.firstChild = text
    const mount = {
      textContent: "visible",
      querySelector: () => null
    }
    let selectorQueries = 0
    const fakeDocument = {
      URL: "http://127.0.0.1:4177/sessions/demo/app/",
      baseURI: "http://127.0.0.1:4177/sessions/demo/app/",
      body,
      querySelector: () => mount,
      querySelectorAll: () => {
        selectorQueries += 1
        return []
      }
    }

    const result = withDocument(fakeDocument as unknown as Document, () => cleanupRenderedDocument({
      basePath: "/show/demo/",
      internalBasePath: "/sessions/demo/app/",
      maxOutputBytes: 64
    }))

    expect(result).toEqual({ html: "", mountEmpty: false, outputTooLarge: true })
    expect(innerHtmlRead).toBe(false)
    expect(selectorQueries).toBe(0)
  })

  it("serializes a DOM just below the browser-side byte limit", () => {
    const html = "x".repeat(63)
    const body = {
      firstChild: undefined as unknown,
      innerHTML: html
    }
    const text = {
      nodeType: 3,
      nodeValue: html,
      firstChild: null,
      nextSibling: null,
      parentNode: body
    }
    body.firstChild = text
    const fakeDocument = {
      URL: "http://127.0.0.1:4177/sessions/demo/app/",
      baseURI: "http://127.0.0.1:4177/sessions/demo/app/",
      body,
      querySelector: () => ({ textContent: "visible", querySelector: () => null }),
      querySelectorAll: () => []
    }

    const result = withDocument(fakeDocument as unknown as Document, () => cleanupRenderedDocument({
      basePath: "/show/demo/",
      internalBasePath: "/sessions/demo/app/",
      maxOutputBytes: 64
    }))

    expect(result).toEqual({ html, mountEmpty: false, outputTooLarge: false })
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
  it("memoizes file content hashes until metadata changes or the session is cleared", async () => {
    const workspace = await temporaryDirectory("fingerprint-memo")
    const firstPath = join(workspace, "first.txt")
    const secondPath = join(workspace, "second.txt")
    await writeFile(firstPath, "first version\n")
    await writeFile(secondPath, "second version\n")
    const reads: string[] = []
    const fingerprinter = createWorkspaceFingerprinter({
      readFile: async (path) => {
        reads.push(path)
        return await readFile(path)
      }
    })

    const initial = await fingerprinter.fingerprint("session", workspace)
    expect(reads).toEqual([firstPath, secondPath])

    expect(await fingerprinter.fingerprint("session", workspace)).toBe(initial)
    expect(reads).toEqual([firstPath, secondPath])

    await writeFile(firstPath, "first version with changed metadata\n")
    expect(await fingerprinter.fingerprint("session", workspace)).not.toBe(initial)
    expect(reads).toEqual([firstPath, secondPath, firstPath])

    fingerprinter.invalidateSession("session")
    await fingerprinter.fingerprint("session", workspace)
    expect(reads.slice(-2)).toEqual([firstPath, secondPath])

    fingerprinter.clear()
    await fingerprinter.fingerprint("session", workspace)
    expect(reads.slice(-2)).toEqual([firstPath, secondPath])
  })

  it("bounds content-hash memo entries per session and globally", async () => {
    const firstWorkspace = await temporaryDirectory("fingerprint-memo-first")
    const secondWorkspace = await temporaryDirectory("fingerprint-memo-second")
    const firstPath = join(firstWorkspace, "first.txt")
    const secondPath = join(firstWorkspace, "second.txt")
    const otherPath = join(secondWorkspace, "other.txt")
    await writeFile(firstPath, "first\n")
    await writeFile(secondPath, "second\n")
    await writeFile(otherPath, "other\n")

    const perSessionReads: string[] = []
    const perSession = createWorkspaceFingerprinter({
      entriesPerSession: 1,
      entriesGlobal: 8,
      readFile: async (path) => {
        perSessionReads.push(path)
        return await readFile(path)
      }
    })
    await perSession.fingerprint("session", firstWorkspace)
    await perSession.fingerprint("session", firstWorkspace)
    expect(perSessionReads).toEqual([firstPath, secondPath, firstPath, secondPath])

    const globalReads: string[] = []
    const global = createWorkspaceFingerprinter({
      entriesPerSession: 8,
      entriesGlobal: 1,
      readFile: async (path) => {
        globalReads.push(path)
        return await readFile(path)
      }
    })
    await global.fingerprint("first-session", firstWorkspace)
    await global.fingerprint("second-session", secondWorkspace)
    await global.fingerprint("first-session", firstWorkspace)
    expect(globalReads).toEqual([firstPath, secondPath, otherPath, firstPath, secondPath])
  })

  it("includes meaningful dotfiles while excluding dependencies, Git metadata, and build output", async () => {
    const workspace = await temporaryDirectory("fingerprint")
    await mkdir(join(workspace, "src"), { recursive: true })
    await mkdir(join(workspace, ".git"), { recursive: true })
    await mkdir(join(workspace, "node_modules", "fixture"), { recursive: true })
    await mkdir(join(workspace, "dist"), { recursive: true })
    await writeFile(join(workspace, "src", "App.tsx"), "export default 'one'\n")
    await writeFile(join(workspace, ".env"), "VITE_LABEL=one\n")
    await writeFile(join(workspace, ".git", "HEAD"), "private-one\n")
    await writeFile(join(workspace, "node_modules", "fixture", "index.js"), "ignored-one\n")
    await writeFile(join(workspace, "dist", "index.js"), "built-one\n")
    const initial = await workspaceFingerprint(workspace)

    await writeFile(join(workspace, ".git", "HEAD"), "private-two-with-a-different-size\n")
    await writeFile(join(workspace, "node_modules", "fixture", "index.js"), "ignored-two-with-a-different-size\n")
    await writeFile(join(workspace, "dist", "index.js"), "built-two-with-a-different-size\n")
    expect(await workspaceFingerprint(workspace)).toBe(initial)

    await writeFile(join(workspace, ".env"), "VITE_LABEL=changed\n")
    const dotfileFingerprint = await workspaceFingerprint(workspace)
    expect(dotfileFingerprint).not.toBe(initial)

    await writeFile(join(workspace, "src", "App.tsx"), "export default 'two-with-a-different-size'\n")
    expect(await workspaceFingerprint(workspace)).not.toBe(dotfileFingerprint)
  })

  it("includes nested source directories named like build artifacts", async () => {
    const workspace = await temporaryDirectory("fingerprint-nested-artifact-name")
    await mkdir(join(workspace, "packages", "widget", "dist"), { recursive: true })
    await writeFile(join(workspace, "packages", "widget", "dist", "index.ts"), "export const label = 'one'\n")
    const initial = await workspaceFingerprint(workspace)

    await writeFile(
      join(workspace, "packages", "widget", "dist", "index.ts"),
      "export const label = 'changed-source'\n"
    )

    expect(await workspaceFingerprint(workspace)).not.toBe(initial)
  })

  it("serializes concurrent misses and lets the second request use the first result", async () => {
    const workspace = await fixtureWorkspace("serialized")
    const browser = new FakeBrowser(() => ({ html: "<h1>Serialized</h1>", mode: "success" }))
    const launches: BrowserTarget[] = []
    const prepare = vi.fn(async () => ({ fingerprint: await workspaceFingerprint(workspace) }))
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

  it("restores the full render budget after queueing longer than the timeout", async () => {
    const workspace = await fixtureWorkspace("serialized-budget")
    let pageIndex = 0
    const browser = new FakeBrowser(() => pageIndex++ === 0
      ? { html: "<h1>Slow first</h1>", mode: "success" }
      : {
          html: "<h1>Loading second</h1>",
          completedHtml: "<h1>Fast second</h1>",
          initialDataDelayMs: 80,
          mode: "slow-initial-data"
        })
    let provisioningStarted!: () => void
    const provisioning = new Promise<void>((resolve) => {
      provisioningStarted = resolve
    })
    let releaseProvisioning!: () => void
    const provisioningGate = new Promise<void>((resolve) => {
      releaseProvisioning = resolve
    })
    let installed = false
    const renderer = createMarkdownRenderer({
      timeoutMs: 200,
      launchBrowser: async (target) => {
        if (target !== "managed" || !installed) throw new Error("not found")
        return browser
      },
      provisionBrowser: async () => {
        provisioningStarted()
        await provisioningGate
        installed = true
        return { ok: true }
      },
      quietPeriodMs: 0
    })
    const firstRequest = renderRequest(workspace)
    const secondRequest = renderRequest(workspace, undefined, "/p/second/")

    try {
      const first = renderer.render(firstRequest)
      await provisioning
      const second = renderer.render(secondRequest).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      )
      await new Promise((resolve) => setTimeout(resolve, 320))
      releaseProvisioning()

      await expect(first).resolves.toEqual({ markdown: "# Slow first\n", cache: "miss" })
      await expect(second).resolves.toEqual({
        result: { markdown: "# Fast second\n", cache: "miss" }
      })
      expect(browser.contextCount).toBe(2)
    } finally {
      releaseProvisioning()
      await renderer.close()
    }
  })

  it("still times out a stalled render after compensating its queue wait", async () => {
    const workspace = await fixtureWorkspace("serialized-real-timeout")
    let pageIndex = 0
    const browser = new FakeBrowser(() => pageIndex++ === 0
      ? { html: "<h1>Slow first</h1>", mode: "success" }
      : { html: "<h1>Never completes</h1>", mode: "stalled" })
    let firstPrepareStarted!: () => void
    const firstPreparing = new Promise<void>((resolve) => {
      firstPrepareStarted = resolve
    })
    const renderer = createMarkdownRenderer({
      timeoutMs: 180,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 0
    })
    const firstRequest = renderRequest(workspace, async () => {
      firstPrepareStarted()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { fingerprint: await workspaceFingerprint(workspace) }
    })
    const secondRequest = renderRequest(workspace, undefined, "/p/stalled/")

    try {
      const first = renderer.render(firstRequest)
      await firstPreparing
      const secondStartedAt = Date.now()
      const second = renderer.render(secondRequest)

      await expect(first).resolves.toEqual({ markdown: "# Slow first\n", cache: "miss" })
      await expect(second).rejects.toMatchObject({ code: "render_timeout", status: 504 })
      expect(Date.now() - secondStartedAt).toBeGreaterThanOrEqual(220)
      expect(browser.contextCount).toBe(2)
      expect(browser.closeCount).toBe(1)
    } finally {
      await renderer.close()
    }
  })

  it("keys entries by target and caller base and expires dynamic data at the TTL backstop", async () => {
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
    const alternateBaseRequest = { ...shared, basePath: "/p/alternate-share/" }

    try {
      await expect(renderer.render(shared)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(shared)).resolves.toMatchObject({ cache: "hit" })
      await expect(renderer.render(privateRequest)).resolves.toMatchObject({ cache: "hit" })
      await expect(renderer.render(nestedRequest)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(alternateBaseRequest)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(nestedRequest)).resolves.toMatchObject({ cache: "hit" })
      await expect(renderer.render(alternateBaseRequest)).resolves.toMatchObject({ cache: "hit" })
      expect(browser.contextCount).toBe(3)

      now += 30_000
      await expect(renderer.render(shared)).resolves.toMatchObject({ cache: "miss" })
      expect(browser.contextCount).toBe(4)
    } finally {
      await renderer.close()
    }
  })

  it("never cross-serves target or caller-base variants", async () => {
    const workspace = await fixtureWorkspace("cache-variants")
    const rendered = ["Target A", "Target B", "Alternate base"]
    let renderIndex = 0
    const browser = new FakeBrowser(() => ({
      html: `<h1>${rendered[renderIndex++]}</h1>`,
      mode: "success"
    }))
    const renderer = createMarkdownRenderer({
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 0
    })
    const targetA = renderRequest(workspace)
    const targetB = {
      ...targetA,
      target: "/dashboard?view=week",
      renderUrl: "http://127.0.0.1:4177/sessions/fixture/app/dashboard?view=week"
    }
    const alternateBase = { ...targetB, basePath: "/p/alternate-share/" }

    try {
      await expect(renderer.render(targetA)).resolves.toEqual({ markdown: "# Target A\n", cache: "miss" })
      await expect(renderer.render(targetB)).resolves.toEqual({ markdown: "# Target B\n", cache: "miss" })
      await expect(renderer.render(alternateBase)).resolves.toEqual({ markdown: "# Alternate base\n", cache: "miss" })
      await expect(renderer.render(targetA)).resolves.toEqual({ markdown: "# Target A\n", cache: "hit" })
      await expect(renderer.render(targetB)).resolves.toEqual({ markdown: "# Target B\n", cache: "hit" })
      await expect(renderer.render(alternateBase)).resolves.toEqual({ markdown: "# Alternate base\n", cache: "hit" })
      expect(browser.contextCount).toBe(3)
      expect(renderIndex).toBe(3)
    } finally {
      await renderer.close()
    }
  })

  it("evicts the least-recently-served entry at the per-session cap", async () => {
    const workspace = await fixtureWorkspace("cache-session-lru")
    const browser = new FakeBrowser(() => ({ html: "<h1>Session LRU</h1>", mode: "success" }))
    const renderer = createMarkdownRenderer({
      cacheEntriesPerSession: 2,
      cacheEntriesGlobal: 10,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 0
    })
    const first = cacheVariantRequest(workspace, "session-one", "first")
    const second = cacheVariantRequest(workspace, "session-one", "second")
    const third = cacheVariantRequest(workspace, "session-one", "third")

    try {
      await expect(renderer.render(first)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(second)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(first)).resolves.toMatchObject({ cache: "hit" })
      await expect(renderer.render(third)).resolves.toMatchObject({ cache: "miss" })

      await expect(renderer.render(first)).resolves.toMatchObject({ cache: "hit" })
      await expect(renderer.render(second)).resolves.toMatchObject({ cache: "miss" })
      expect(browser.contextCount).toBe(4)
    } finally {
      await renderer.close()
    }
  })

  it("evicts the global LRU across sessions", async () => {
    const workspace = await fixtureWorkspace("cache-global-lru")
    const browser = new FakeBrowser(() => ({ html: "<h1>Global LRU</h1>", mode: "success" }))
    const renderer = createMarkdownRenderer({
      cacheEntriesPerSession: 10,
      cacheEntriesGlobal: 3,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 0
    })
    const first = cacheVariantRequest(workspace, "session-one", "first")
    const second = cacheVariantRequest(workspace, "session-two", "second")
    const third = cacheVariantRequest(workspace, "session-one", "third")
    const fourth = cacheVariantRequest(workspace, "session-two", "fourth")

    try {
      await expect(renderer.render(first)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(second)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(third)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(first)).resolves.toMatchObject({ cache: "hit" })
      await expect(renderer.render(fourth)).resolves.toMatchObject({ cache: "miss" })

      await expect(renderer.render(first)).resolves.toMatchObject({ cache: "hit" })
      await expect(renderer.render(second)).resolves.toMatchObject({ cache: "miss" })
      expect(browser.contextCount).toBe(5)
    } finally {
      await renderer.close()
    }
  })

  it("deletes expired entries before enforcing capacity on write", async () => {
    const workspace = await fixtureWorkspace("cache-expired-write")
    const browser = new FakeBrowser(() => ({ html: "<h1>Expiry</h1>", mode: "success" }))
    let now = 0
    const renderer = createMarkdownRenderer({
      cacheTtlMs: 100,
      cacheEntriesPerSession: 10,
      cacheEntriesGlobal: 3,
      cacheMaintenanceIntervalMs: 60_000,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 0,
      now: () => now
    })
    const first = cacheVariantRequest(workspace, "session-one", "first")
    const second = cacheVariantRequest(workspace, "session-one", "second")
    const third = cacheVariantRequest(workspace, "session-one", "third")
    const fourth = cacheVariantRequest(workspace, "session-one", "fourth")

    try {
      await expect(renderer.render(first)).resolves.toMatchObject({ cache: "miss" })
      now = 10
      await expect(renderer.render(second)).resolves.toMatchObject({ cache: "miss" })
      now = 20
      await expect(renderer.render(first)).resolves.toMatchObject({ cache: "hit" })
      await expect(renderer.render(third)).resolves.toMatchObject({ cache: "miss" })

      // The hot first entry expires while the older LRU entry remains fresh.
      // Pruning before the fourth write prevents capacity eviction of second.
      now = 100
      await expect(renderer.render(fourth)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(second)).resolves.toMatchObject({ cache: "hit" })
      expect(browser.contextCount).toBe(4)
    } finally {
      await renderer.close()
    }
  })

  it("physically deletes expired entries during idle maintenance", async () => {
    const workspace = await fixtureWorkspace("cache-expired-idle")
    const browser = new FakeBrowser(() => ({ html: "<h1>Idle expiry</h1>", mode: "success" }))
    let now = 0
    const deleted = vi.spyOn(Map.prototype, "delete")
    const renderer = createMarkdownRenderer({
      cacheTtlMs: 10,
      cacheMaintenanceIntervalMs: 5,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 0,
      now: () => now
    })
    const request = cacheVariantRequest(workspace, "session-one", "idle")
    const cacheKey = JSON.stringify([request.sessionId, request.target, request.basePath])

    try {
      await expect(renderer.render(request)).resolves.toMatchObject({ cache: "miss" })
      deleted.mockClear()
      now = 10

      await vi.waitFor(() => {
        expect(deleted).toHaveBeenCalledWith(cacheKey)
      }, { timeout: 500, interval: 5 })
      expect(browser.contextCount).toBe(1)
    } finally {
      await renderer.close()
    }
  })

  it("invalidates only the requested session's cached entries", async () => {
    const workspace = await fixtureWorkspace("cache-session-invalidation")
    const browser = new FakeBrowser(() => ({ html: "<h1>Invalidation</h1>", mode: "success" }))
    const renderer = createMarkdownRenderer({
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 0
    })
    const firstSession = cacheVariantRequest(workspace, "session-one", "first")
    const secondSession = cacheVariantRequest(workspace, "session-two", "second")

    try {
      await expect(renderer.render(firstSession)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(secondSession)).resolves.toMatchObject({ cache: "miss" })
      await renderer.invalidateSession("session-one")

      await expect(renderer.render(firstSession)).resolves.toMatchObject({ cache: "miss" })
      await expect(renderer.render(secondSession)).resolves.toMatchObject({ cache: "hit" })
      expect(browser.contextCount).toBe(3)
    } finally {
      await renderer.close()
    }
  })

  it("invalidates cached Markdown when a workspace dotfile changes", async () => {
    const workspace = await fixtureWorkspace("cache-dotfile")
    await writeFile(join(workspace, ".env"), "VITE_LABEL=one\n")
    let label = "one"
    const browser = new FakeBrowser(() => ({ html: `<h1>Environment ${label}</h1>`, mode: "success" }))
    const renderer = createMarkdownRenderer({
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 0
    })
    const request = renderRequest(workspace)

    try {
      await expect(renderer.render(request)).resolves.toEqual({ markdown: "# Environment one\n", cache: "miss" })
      await expect(renderer.render(request)).resolves.toMatchObject({ cache: "hit" })

      await writeFile(join(workspace, ".env"), "VITE_LABEL=changed\n")
      label = "changed"
      await expect(renderer.render(request)).resolves.toEqual({ markdown: "# Environment changed\n", cache: "miss" })
      await expect(renderer.render(request)).resolves.toEqual({ markdown: "# Environment changed\n", cache: "hit" })
      expect(browser.contextCount).toBe(2)
    } finally {
      await renderer.close()
    }
  })

  it("invalidates cached Markdown when a nested source directory named dist changes", async () => {
    const workspace = await fixtureWorkspace("cache-nested-artifact-name")
    const nestedSource = join(workspace, "packages", "widget", "dist", "index.ts")
    await mkdir(join(workspace, "packages", "widget", "dist"), { recursive: true })
    await writeFile(nestedSource, "export const label = 'one'\n")
    let label = "one"
    const browser = new FakeBrowser(() => ({ html: `<h1>Nested source ${label}</h1>`, mode: "success" }))
    const renderer = createMarkdownRenderer({
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 0
    })
    const request = renderRequest(workspace)

    try {
      await expect(renderer.render(request)).resolves.toEqual({ markdown: "# Nested source one\n", cache: "miss" })
      await expect(renderer.render(request)).resolves.toMatchObject({ cache: "hit" })

      await writeFile(nestedSource, "export const label = 'changed-source'\n")
      label = "changed"
      await expect(renderer.render(request)).resolves.toEqual({
        markdown: "# Nested source changed\n",
        cache: "miss"
      })
      expect(browser.contextCount).toBe(2)
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

  it("settles after initial data while persistent streams and repeated polling stay open", async () => {
    const workspace = await fixtureWorkspace("persistent-network")
    const browser = new FakeBrowser(() => ({ html: "<h1>Stream-ready</h1>", mode: "persistent-network" }))
    const renderer = createMarkdownRenderer({
      timeoutMs: 500,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 0
    })

    try {
      await expect(renderer.render(renderRequest(workspace))).resolves.toMatchObject({
        markdown: "# Stream-ready\n",
        cache: "miss"
      })
    } finally {
      await renderer.close()
    }
  })

  it("renders promptly when a fetch response stays open as server-sent events", async () => {
    const workspace = await fixtureWorkspace("fetch-sse")
    const browser = new FakeBrowser(() => ({
      html: "<h1>Fetch SSE ready</h1>",
      mode: "fetch-stream",
      responseContentType: "TEXT/EVENT-STREAM; charset=utf-8"
    }))
    const renderer = createMarkdownRenderer({
      timeoutMs: 300,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 20
    })

    try {
      await expect(renderer.render(renderRequest(workspace))).resolves.toEqual({
        markdown: "# Fetch SSE ready\n",
        cache: "miss"
      })
    } finally {
      await renderer.close()
    }
  })

  it("renders promptly when a fetch response stays open as NDJSON", async () => {
    const workspace = await fixtureWorkspace("fetch-ndjson")
    const browser = new FakeBrowser(() => ({
      html: "<h1>NDJSON ready</h1>",
      mode: "fetch-stream",
      responseContentType: "Application/X-NDJSON; Charset=UTF-8"
    }))
    const renderer = createMarkdownRenderer({
      timeoutMs: 300,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 20
    })

    try {
      await expect(renderer.render(renderRequest(workspace))).resolves.toEqual({
        markdown: "# NDJSON ready\n",
        cache: "miss"
      })
    } finally {
      await renderer.close()
    }
  })

  it("reclassifies an unlabeled open response after the ambiguity budget", async () => {
    const workspace = await fixtureWorkspace("fetch-long-poll")
    const browser = new FakeBrowser(() => ({
      html: "<h1>Long poll ready</h1>",
      mode: "fetch-stream"
    }))
    const oldAmbiguityBudget = process.env.VIBE_SHOW_RENDER_AMBIGUITY_BUDGET_MS
    process.env.VIBE_SHOW_RENDER_AMBIGUITY_BUDGET_MS = "120"
    const renderer = createMarkdownRenderer({
      timeoutMs: 600,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 10
    })
    restoreEnvironment("VIBE_SHOW_RENDER_AMBIGUITY_BUDGET_MS", oldAmbiguityBudget)

    try {
      const startedAt = Date.now()
      await expect(renderer.render(renderRequest(workspace))).resolves.toEqual({
        markdown: "# Long poll ready\n",
        cache: "miss"
      })
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110)
    } finally {
      await renderer.close()
    }
  })

  it("waits for a slow finite initial request before extracting the page", async () => {
    const workspace = await fixtureWorkspace("slow-initial-data")
    const browser = new FakeBrowser(() => ({
      html: "<h1>Loading report</h1>",
      completedHtml: "<h1>Loaded report</h1>",
      initialDataDelayMs: 1_000,
      mode: "slow-initial-data",
      responseContentType: "application/json; charset=utf-8",
      responseContentLength: "4096"
    }))
    const renderer = createMarkdownRenderer({
      timeoutMs: 3_000,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 100,
      ambiguityBudgetMs: 100
    })

    try {
      await expect(renderer.render(renderRequest(workspace))).resolves.toEqual({
        markdown: "# Loaded report\n",
        cache: "miss"
      })
    } finally {
      await renderer.close()
    }
  })

  it("keeps the hard timeout for a request that never receives response headers", async () => {
    const workspace = await fixtureWorkspace("never-settling-request")
    const browser = new FakeBrowser(() => ({
      html: "<h1>Never ready</h1>",
      mode: "never-settling-request"
    }))
    const renderer = createMarkdownRenderer({
      timeoutMs: 150,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      quietPeriodMs: 20
    })

    try {
      await expect(renderer.render(renderRequest(workspace))).rejects.toMatchObject({
        code: "render_timeout",
        status: 504
      })
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

  it("renders a page just below the serialization limit", async () => {
    const workspace = await fixtureWorkspace("serialization-limit")
    const html = `<p>${"x".repeat(120)}</p>`
    const renderer = createMarkdownRenderer({
      maxOutputBytes: 128,
      browserProvisioningDisabled: true,
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return new FakeBrowser(() => ({ html, mode: "success" }))
      },
      quietPeriodMs: 0
    })

    try {
      await expect(renderer.render(renderRequest(workspace))).resolves.toEqual({
        markdown: `${"x".repeat(120)}\n`,
        cache: "miss"
      })
    } finally {
      await renderer.close()
    }
  })
})

describe("session dependency preparation", () => {
  it("installs session extras through the platform-safe npm entry point", async () => {
    const workspaceRoot = await temporaryDirectory("extras-warm")
    const workspace = await fixtureWorkspace("page", workspaceRoot)
    const dependencyRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
    const extraPackage = join(workspaceRoot, "fixture-extra")
    await mkdir(extraPackage, { recursive: true })
    await writeFile(join(extraPackage, "package.json"), JSON.stringify({
      name: "fixture-extra",
      version: "1.0.0",
      type: "module",
      main: "index.js"
    }))
    await writeFile(join(extraPackage, "index.js"), "export const fixtureExtra = true\n")
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      private: true,
      dependencies: {
        "fixture-extra": "file:../fixture-extra"
      }
    }))
    await writeFile(join(workspace, "src", "main.tsx"), `import React from "react"
import { fixtureExtra } from "fixture-extra"
document.getElementById("root")!.textContent = React.version + String(fixtureExtra)
`)
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      dependencyRoot,
      cacheRoot: join(workspaceRoot, ".cache")
    })

    try {
      await expect(runtime.runtime.ensureSession("page", "/show/page/"))
        .resolves.toMatchObject({ state: "active" })
      const nodeModules = join(workspace, "node_modules")
      expect((await lstat(nodeModules)).isDirectory()).toBe(true)
      expect((await lstat(nodeModules)).isSymbolicLink()).toBe(false)
      expect(await readFile(join(nodeModules, "fixture-extra", "index.js"), "utf8"))
        .toBe("export const fixtureExtra = true\n")
      const installed = JSON.parse(await readFile(join(workspace, ".show-extras.json"), "utf8")) as {
        signature?: string
        entries?: string[]
      }
      expect(installed.signature).toMatch(/^[0-9a-f]{16}$/)
      expect(installed.entries).toEqual([
        `fixture-extra@file:${extraPackage}`
      ])
      const snapshotOut = join(workspaceRoot, "snapshot-output")
      await expect(runtime.runtime.buildSessionSnapshot("page", {
        basePath: "/sessions/page/render-app/",
        outDir: snapshotOut
      })).resolves.toBeUndefined()
      expect(await readFile(join(snapshotOut, "index.html"), "utf8"))
        .toContain("/sessions/page/render-app/assets/")
    } finally {
      await runtime.close()
    }
  }, 60_000)

  it("waits for an in-flight warm before suspending the session", async () => {
    const workspaceRoot = await temporaryDirectory("warm-suspend-serialization")
    await fixtureWorkspace("page", workspaceRoot)
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache")
    })
    let signalWarmStarted!: () => void
    const warmStarted = new Promise<void>((resolveStarted) => {
      signalWarmStarted = resolveStarted
    })
    let releaseWarm!: () => void
    const warmGate = new Promise<void>((resolveWarm) => {
      releaseWarm = resolveWarm
    })
    viteTestControl.beforeCreateServer = async () => {
      signalWarmStarted()
      await warmGate
    }

    try {
      const warming = runtime.runtime.ensureSession("page", "/show/page/")
      await warmStarted
      let suspendSettled = false
      const suspend = runtime.runtime.suspendSession("page").then((status) => {
        suspendSettled = true
        return status
      })
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 0))
      expect(suspendSettled).toBe(false)
      expect(runtime.runtime.getSession("page")?.state).toBe("warming")

      releaseWarm()
      viteTestControl.beforeCreateServer = undefined
      await expect(warming).resolves.toMatchObject({ state: "active" })
      await expect(suspend).resolves.toMatchObject({ state: "suspended" })
      expect(runtime.runtime.getSession("page")?.warming).toBeUndefined()
    } finally {
      releaseWarm()
      viteTestControl.beforeCreateServer = undefined
      await runtime.close()
    }
  })
})

describe("render-markdown HTTP contract", () => {
  it("renders Markdown through a production build snapshot and plain static route", async () => {
    const workspaceRoot = await temporaryDirectory("snapshot-e2e")
    const workspace = await fixtureWorkspace("page", workspaceRoot)
    await writeFile(join(workspace, "index.html"), `<!doctype html>
<html><head><title>Snapshot fixture</title></head><body>
  <main id="root"><h1>Built snapshot</h1><p>Production HTML reached Markdown.</p></main>
  <script type="module" src="/src/main.tsx"></script>
</body></html>\n`)
    await writeFile(join(workspace, "src", "main.tsx"), "document.body.dataset.snapshot = 'ready'\n")
    const browser = new FakeBrowser(() => ({
      html: "",
      mode: "success",
      expectedNavigationBody: "/sessions/page/render-app/assets/",
      useNavigationBody: true
    }))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      renderTimeoutMs: 15_000
    }, {
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0
    })
    const buildSnapshot = vi.spyOn(runtime.runtime, "buildSessionSnapshot")

    try {
      const response = await fetch(`${runtime.url}/sessions/page/render-markdown`, {
        headers: {
          "x-vibe-show-base": "/p/snapshot-share/",
          "x-vibe-show-target": "/dashboard?view=week"
        }
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("x-avibe-render-cache")).toBe("miss")
      const markdown = await response.text()
      expect(markdown).toContain("# Built snapshot")
      expect(markdown).toContain("Production HTML reached Markdown.")

      const secondTarget = await fetch(`${runtime.url}/sessions/page/render-markdown`, {
        headers: {
          "x-vibe-show-base": "/p/snapshot-share/",
          "x-vibe-show-target": "/reports?view=month"
        }
      })
      expect(secondTarget.headers.get("x-avibe-render-cache")).toBe("miss")
      expect(await secondTarget.text()).toContain("# Built snapshot")
      expect(buildSnapshot).toHaveBeenCalledTimes(1)

      const snapshot = runtime.renderSnapshots.get("page")
      expect(snapshot).toBeDefined()
      const builtHtml = await readFile(join(snapshot!.outDir, "index.html"), "utf8")
      expect(builtHtml).toContain("globalThis.__AVIBE_SHOW__")
      expect(builtHtml).toContain('"sessionId":"page"')
      expect(builtHtml).toContain('"basePath":"/sessions/page/render-app/"')
      const assetPath = builtHtml.match(/(?:src|href)="([^"]*\/assets\/[^"]+)"/)?.[1]
      expect(assetPath).toBeDefined()
      const asset = await fetch(new URL(assetPath!, runtime.url))
      expect(asset.status).toBe(200)
      expect(asset.headers.get("cache-control")).toBe("no-store")
    } finally {
      await runtime.close()
    }
  }, 30_000)

  it("keeps active live HTML, assets, and API responsive during a snapshot build", async () => {
    const workspaceRoot = await temporaryDirectory("snapshot-live-fast-path")
    const workspace = await fixtureWorkspace("page", workspaceRoot)
    await mkdir(join(workspace, "api"), { recursive: true })
    await writeFile(join(workspace, "api", "status.ts"), `export function GET() {
  return Response.json({ status: "ready" })
}\n`)
    const browser = new FakeBrowser(() => ({
      html: "<main id=\"root\"><h1>Snapshot complete</h1></main>",
      mode: "success",
      expectedNavigationBody: "/sessions/page/render-app/assets/"
    }))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      renderTimeoutMs: 15_000
    }, {
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0
    })
    const liveHeaders = { "x-vibe-show-base": "/show/page/" }
    let signalBuildStarted!: () => void
    const buildStarted = new Promise<void>((resolveStarted) => {
      signalBuildStarted = resolveStarted
    })
    let releaseBuild!: () => void
    const buildGate = new Promise<void>((resolveBuild) => {
      releaseBuild = resolveBuild
    })

    try {
      const warmDocument = await fetch(`${runtime.url}/sessions/page/app/`, { headers: liveHeaders })
      expect(warmDocument.status).toBe(200)
      await warmDocument.text()
      const warmAsset = await fetch(`${runtime.url}/sessions/page/app/src/main.tsx`, { headers: liveHeaders })
      expect(warmAsset.status).toBe(200)
      await warmAsset.text()
      const warmApi = await fetch(`${runtime.url}/sessions/page/app/api/status`, { headers: liveHeaders })
      expect(await warmApi.json()).toEqual({ status: "ready" })

      viteTestControl.beforeBuild = async () => {
        signalBuildStarted()
        await buildGate
      }
      const render = fetch(`${runtime.url}/sessions/page/render-markdown`)
      await buildStarted

      let timeout: ReturnType<typeof setTimeout> | undefined
      const liveResponses = await Promise.race([
        Promise.all([
          fetch(`${runtime.url}/sessions/page/app/dashboard`, { headers: liveHeaders }),
          fetch(`${runtime.url}/sessions/page/app/src/main.tsx`, { headers: liveHeaders }),
          fetch(`${runtime.url}/sessions/page/app/api/status`, { headers: liveHeaders })
        ]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("active live requests stalled behind snapshot build")), 1_000)
        })
      ]).finally(() => {
        if (timeout) clearTimeout(timeout)
      })
      const [documentResponse, assetResponse, apiResponse] = liveResponses
      expect(documentResponse.status).toBe(200)
      expect(await documentResponse.text()).toContain("/show/page/src/main.tsx")
      expect(assetResponse.status).toBe(200)
      expect(await assetResponse.text()).toContain("document.getElementById")
      expect(await apiResponse.json()).toEqual({ status: "ready" })

      releaseBuild()
      viteTestControl.beforeBuild = undefined
      const renderResponse = await render
      expect(renderResponse.status).toBe(200)
      expect(await renderResponse.text()).toContain("# Snapshot complete")
    } finally {
      releaseBuild()
      viteTestControl.beforeBuild = undefined
      await runtime.close()
    }
  }, 30_000)

  it("returns render_failed with a concise production build error", async () => {
    const workspaceRoot = await temporaryDirectory("snapshot-build-failure")
    const workspace = await fixtureWorkspace("page", workspaceRoot)
    await writeFile(join(workspace, "src", "main.tsx"), 'import "./does-not-exist"\n')
    const launchBrowser = vi.fn(async () => new FakeBrowser(() => ({
      html: "<h1>Never reached</h1>",
      mode: "success"
    })))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      renderTimeoutMs: 15_000
    }, {
      launchBrowser,
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0
    })

    try {
      const response = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      const body = await expectRenderError(response, 502, "render_failed")
      expect(body.error.message).toContain("Show Page build failed:")
      expect(body.error.message).toMatch(/does-not-exist|resolve/i)
      expect(body.error.message.length).toBeLessThanOrEqual(324)
      expect(runtime.renderSnapshots.get("page")).toBeUndefined()
      expect(launchBrowser).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  }, 30_000)

  it("blocks snapshot inputs that resolve outside the workspace boundary", async () => {
    const workspaceRoot = await temporaryDirectory("snapshot-file-boundary")
    const workspace = await fixtureWorkspace("page", workspaceRoot)
    await writeFile(join(workspaceRoot, "secret.pem"), "PRIVATE SNAPSHOT FIXTURE\n")
    await writeFile(join(workspace, "src", "main.tsx"), `import leaked from "../../secret.pem?raw"
document.getElementById("root")!.textContent = leaked
`)
    const launchBrowser = vi.fn(async () => new FakeBrowser(() => ({
      html: "<h1>Never reached</h1>",
      mode: "success"
    })))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      renderTimeoutMs: 15_000
    }, {
      launchBrowser,
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0
    })

    try {
      const traversal = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      const traversalError = await expectRenderError(traversal, 502, "render_failed")
      expect(traversalError.error.message).toMatch(/workspace boundary/i)

      const outsideSource = join(workspaceRoot, "outside-source")
      await mkdir(outsideSource)
      await writeFile(join(outsideSource, "index.ts"), 'export const leaked = "outside"\n')
      await symlink(
        outsideSource,
        join(workspace, "src", "linked-source"),
        process.platform === "win32" ? "junction" : "dir"
      )
      await writeFile(join(workspace, "src", "main.tsx"), `import { leaked } from "./linked-source/index.ts"
document.getElementById("root")!.textContent = leaked
`)

      const linked = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      const linkedError = await expectRenderError(linked, 502, "render_failed")
      expect(linkedError.error.message).toMatch(/workspace boundary/i)

      const outsidePublic = join(workspaceRoot, "outside-public")
      await mkdir(outsidePublic)
      await writeFile(join(outsidePublic, "leaked.txt"), "outside public asset\n")
      await mkdir(join(workspace, "public"))
      await symlink(
        outsidePublic,
        join(workspace, "public", "linked-assets"),
        process.platform === "win32" ? "junction" : "dir"
      )
      await writeFile(join(workspace, "src", "main.tsx"), 'document.getElementById("root")!.textContent = "safe"\n')

      const publicLink = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      const publicError = await expectRenderError(publicLink, 502, "render_failed")
      expect(publicError.error.message).toMatch(/workspace boundary/i)
      expect(runtime.renderSnapshots.get("page")).toBeUndefined()
      expect(launchBrowser).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  }, 30_000)

  it("rebuilds the snapshot after a workspace file change and renders the new bytes", async () => {
    const workspaceRoot = await temporaryDirectory("snapshot-invalidation")
    const workspace = await fixtureWorkspace("page", workspaceRoot)
    const writePage = (label: string) => writeFile(join(workspace, "index.html"), `<!doctype html>
<html><body><main id="root"><h1>${label}</h1></main><script type="module" src="/src/main.tsx"></script></body></html>\n`)
    await writePage("Snapshot version one")
    const browser = new FakeBrowser(() => ({
      html: "",
      mode: "success",
      expectedNavigationBody: "/sessions/page/render-app/assets/",
      useNavigationBody: true
    }))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      renderTimeoutMs: 15_000
    }, {
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0
    })
    const buildSnapshot = vi.spyOn(runtime.runtime, "buildSessionSnapshot")

    try {
      const first = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      expect(first.headers.get("x-avibe-render-cache")).toBe("miss")
      expect(await first.text()).toContain("# Snapshot version one")
      const cached = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      expect(cached.headers.get("x-avibe-render-cache")).toBe("hit")
      await cached.text()
      expect(buildSnapshot).toHaveBeenCalledTimes(1)

      await writePage("Snapshot version two changed")
      const changed = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      expect(changed.headers.get("x-avibe-render-cache")).toBe("miss")
      expect(await changed.text()).toContain("# Snapshot version two changed")
      expect(buildSnapshot).toHaveBeenCalledTimes(2)
      expect(browser.contextCount).toBe(2)
    } finally {
      await runtime.close()
    }
  }, 30_000)

  it("rebuilds when file bytes change without changing size or mtime", async () => {
    const workspaceRoot = await temporaryDirectory("snapshot-content-invalidation")
    const workspace = await fixtureWorkspace("page", workspaceRoot)
    const pagePath = join(workspace, "index.html")
    const writePage = (label: string) => writeFile(pagePath, `<!doctype html>
<html><body><main id="root"><h1>${label}</h1></main><script type="module" src="/src/main.tsx"></script></body></html>\n`)
    const preservedTime = new Date("2026-01-02T03:04:05.000Z")
    await writePage("Snapshot version one")
    await utimes(pagePath, preservedTime, preservedTime)
    const originalMetadata = await lstat(pagePath, { bigint: true })
    const browser = new FakeBrowser(() => ({
      html: "",
      mode: "success",
      expectedNavigationBody: "/sessions/page/render-app/assets/",
      useNavigationBody: true
    }))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      renderTimeoutMs: 15_000
    }, {
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0
    })
    const buildSnapshot = vi.spyOn(runtime.runtime, "buildSessionSnapshot")

    try {
      const first = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      expect(first.headers.get("x-avibe-render-cache")).toBe("miss")
      expect(await first.text()).toContain("# Snapshot version one")

      await writePage("Snapshot version two")
      await utimes(pagePath, preservedTime, preservedTime)
      const changedMetadata = await lstat(pagePath, { bigint: true })
      expect(changedMetadata.size).toBe(originalMetadata.size)
      expect(changedMetadata.mtimeNs).toBe(originalMetadata.mtimeNs)

      const changed = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      expect(changed.headers.get("x-avibe-render-cache")).toBe("miss")
      expect(await changed.text()).toContain("# Snapshot version two")
      expect(buildSnapshot).toHaveBeenCalledTimes(2)
      expect(browser.contextCount).toBe(2)
    } finally {
      await runtime.close()
    }
  }, 30_000)

  it("retries a snapshot when the workspace changes before the build is committed", async () => {
    const workspaceRoot = await temporaryDirectory("snapshot-build-race")
    const workspace = await fixtureWorkspace("page", workspaceRoot)
    const writePage = (label: string) => writeFile(join(workspace, "index.html"), `<!doctype html>
<html><body><main id="root"><h1>${label}</h1></main><script type="module" src="/src/main.tsx"></script></body></html>\n`)
    await writePage("Snapshot before build race")
    const browser = new FakeBrowser(() => ({
      html: "",
      mode: "success",
      expectedNavigationBody: "/sessions/page/render-app/assets/",
      useNavigationBody: true
    }))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      renderTimeoutMs: 15_000
    }, {
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0
    })
    const originalBuild = runtime.runtime.buildSessionSnapshot.bind(runtime.runtime)
    const buildSnapshot = vi.spyOn(runtime.runtime, "buildSessionSnapshot")
      .mockImplementationOnce(async (sessionId, snapshot) => {
        await originalBuild(sessionId, snapshot)
        await writePage("Snapshot after build race")
      })

    try {
      const response = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      expect(response.status).toBe(200)
      expect(response.headers.get("x-avibe-render-cache")).toBe("miss")
      expect(await response.text()).toContain("# Snapshot after build race")
      expect(buildSnapshot).toHaveBeenCalledTimes(2)
      expect(browser.contextCount).toBe(1)
      expect(runtime.renderSnapshots.get("page")?.fingerprint)
        .toBe(await workspaceFingerprint(workspace))

      const cached = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      expect(cached.headers.get("x-avibe-render-cache")).toBe("hit")
      expect(await cached.text()).toContain("# Snapshot after build race")
    } finally {
      await runtime.close()
    }
  }, 30_000)

  it("keys rendered Markdown to the prepared snapshot when the workspace changes after prepare", async () => {
    const workspaceRoot = await temporaryDirectory("snapshot-post-prepare-race")
    const workspace = await fixtureWorkspace("page", workspaceRoot)
    const writePage = (label: string) => writeFile(join(workspace, "index.html"), `<!doctype html>
<html><body><main id="root"><h1>${label}</h1></main><script type="module" src="/src/main.tsx"></script></body></html>\n`)
    await writePage("Snapshot before prepare change")
    const browser = new FakeBrowser(() => ({
      html: "",
      mode: "success",
      useNavigationBody: true
    }))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      renderTimeoutMs: 15_000
    }, {
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0
    })
    const originalPrepare = runtime.renderSnapshots.prepare.bind(runtime.renderSnapshots)
    vi.spyOn(runtime.renderSnapshots, "prepare").mockImplementationOnce(async (...args) => {
      const snapshot = await originalPrepare(...args)
      await writePage("Snapshot after prepare change with new bytes")
      return snapshot
    })
    const buildSnapshot = vi.spyOn(runtime.runtime, "buildSessionSnapshot")

    try {
      const first = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      expect(first.headers.get("x-avibe-render-cache")).toBe("miss")
      expect(await first.text()).toContain("# Snapshot before prepare change")

      const changed = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      expect(changed.headers.get("x-avibe-render-cache")).toBe("miss")
      expect(await changed.text()).toContain("# Snapshot after prepare change with new bytes")

      const cached = await fetch(`${runtime.url}/sessions/page/render-markdown`)
      expect(cached.headers.get("x-avibe-render-cache")).toBe("hit")
      expect(await cached.text()).toContain("# Snapshot after prepare change with new bytes")
      expect(buildSnapshot).toHaveBeenCalledTimes(2)
      expect(browser.contextCount).toBe(2)
    } finally {
      await runtime.close()
    }
  }, 30_000)

  it("routes snapshot API requests through the live handler without caller identity", async () => {
    const workspaceRoot = await temporaryDirectory("snapshot-api")
    const workspace = await fixtureWorkspace("page", workspaceRoot)
    await mkdir(join(workspace, "api"), { recursive: true })
    await writeFile(join(workspace, "api", "data.ts"), `export function GET(request: Request) {
  return Response.json({
    label: "Anonymous API data",
    authorization: request.headers.get("authorization"),
    cookie: request.headers.get("cookie")
  })
}\n`)
    const browser = new FakeBrowser(() => ({
      html: "",
      mode: "success",
      expectedNavigationBody: "/sessions/page/render-app/assets/",
      apiPath: "api/data",
      renderApiBody(body) {
        const data = JSON.parse(body) as { label: string; authorization: string | null; cookie: string | null }
        return `<main id="root"><h1>${data.label}</h1><p>authorization: ${data.authorization}</p><p>cookie: ${data.cookie}</p></main>`
      }
    }))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      renderTimeoutMs: 15_000
    }, {
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0
    })

    try {
      const response = await fetch(`${runtime.url}/sessions/page/render-markdown`, {
        headers: {
          authorization: "Bearer caller-must-not-forward",
          cookie: "visitor=caller-must-not-forward"
        }
      })
      expect(response.status).toBe(200)
      const markdown = await response.text()
      expect(markdown).toContain("# Anonymous API data")
      expect(markdown).toContain("authorization: null")
      expect(markdown).toContain("cookie: null")
      expect(browser.newContextArguments).toEqual([[]])
    } finally {
      await runtime.close()
    }
  }, 30_000)

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
      expectedNavigationBody: "/sessions/page/render-app/assets/"
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
      const liveBefore = await fetch(`${runtime.url}/sessions/page/app/`, {
        headers: { "x-vibe-show-base": "/p/live-view/" }
      })
      expect(await liveBefore.text()).toContain("/p/live-view/src/main.tsx")
      const liveSession = runtime.runtime.getSession("page")
      const liveVite = liveSession?.vite
      expect(liveSession?.basePath).toBe("/p/live-view/")

      const [first, concurrentViewer] = await Promise.all([
        fetch(`${runtime.url}/sessions/page/render-markdown`, { headers }),
        fetch(`${runtime.url}/sessions/page/app/dashboard?view=week`, {
          headers: { "x-vibe-show-base": "/p/live-view/" }
        })
      ])
      expect(await concurrentViewer.text()).toContain("/p/live-view/src/main.tsx")
      expect(first.status).toBe(200)
      expect(first.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
      expect(first.headers.get("cache-control")).toBe("no-store")
      expect(first.headers.get("x-avibe-render-cache")).toBe("miss")
      const firstMarkdown = await first.text()
      expect(firstMarkdown).toContain("# Fixture release")
      expect(firstMarkdown).toContain("| A | Ready |")
      expect(firstMarkdown).toContain("[Details](/p/public-share/details)")
      expect(firstMarkdown).toContain("> agent-note: Publish assets before repointing")
      expect(browser.newContextArguments).toEqual([[]])
      expect(browser.visitedUrls[0]).toMatch(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+\/sessions\/page\/render-app\/dashboard\?view=week$/)
      expect(runtime.runtime.getSession("page")?.basePath).toBe("/p/live-view/")
      expect(runtime.runtime.getSession("page")?.vite).toBe(liveVite)

      const cached = await fetch(`${runtime.url}/sessions/page/render-markdown`, { headers })
      expect(cached.headers.get("x-avibe-render-cache")).toBe("hit")
      expect(browser.contextCount).toBe(1)
      await cached.text()

      const rootHeaders = { ...headers }
      delete (rootHeaders as { "x-vibe-show-target"?: string })["x-vibe-show-target"]
      const root = await fetch(`${runtime.url}/sessions/page/render-markdown`, { headers: rootHeaders })
      expect(root.headers.get("x-avibe-render-cache")).toBe("miss")
      expect(browser.contextCount).toBe(2)
      expect(browser.visitedUrls[1]).toMatch(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+\/sessions\/page\/render-app\/$/)
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

  it("releases the snapshot and cache when a session is suspended, then rebuilds cleanly", async () => {
    const workspaceRoot = await temporaryDirectory("suspend-render")
    const workspace = await fixtureWorkspace("page", workspaceRoot)
    const fingerprintReads: string[] = []
    const workspaceFingerprinter = createWorkspaceFingerprinter({
      readFile: async (path) => {
        fingerprintReads.push(path)
        return await readFile(path)
      }
    })
    const browser = new FakeBrowser(() => ({
      html: "<h1>Suspend fixture</h1>",
      mode: "success",
      expectedNavigationBody: "/sessions/page/render-app/assets/"
    }))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      renderTimeoutMs: 15_000
    }, {
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0,
      workspaceFingerprinter
    })
    const headers = {
      "X-Avibe-Show-Protocol": "1",
      "X-Avibe-Show-Context": "private",
      "x-vibe-show-base": "/show/page/"
    }
    const buildSnapshot = vi.spyOn(runtime.runtime, "buildSessionSnapshot")

    try {
      const first = await fetch(`${runtime.url}/sessions/page/render-markdown`, { headers })
      expect(first.headers.get("x-avibe-render-cache")).toBe("miss")
      await first.text()
      const initialSnapshot = runtime.renderSnapshots.get("page")
      expect(initialSnapshot).toBeDefined()
      expect(buildSnapshot).toHaveBeenCalledTimes(1)
      const initialFingerprintReads = fingerprintReads.filter((path) => path.startsWith(workspace)).length
      expect(initialFingerprintReads).toBeGreaterThan(0)

      const cached = await fetch(`${runtime.url}/sessions/page/render-markdown`, { headers })
      expect(cached.headers.get("x-avibe-render-cache")).toBe("hit")
      await cached.text()
      expect(fingerprintReads.filter((path) => path.startsWith(workspace))).toHaveLength(initialFingerprintReads)

      const suspended = await fetch(`${runtime.url}/sessions/page/suspend`, { method: "POST" })
      expect(suspended.status).toBe(200)
      expect(await suspended.json()).toMatchObject({ sessionId: "page", state: "suspended" })
      expect(runtime.renderSnapshots.get("page")).toBeUndefined()
      expect(runtime.runtime.getSession("page")).toMatchObject({ state: "suspended", vite: undefined })

      const relaunched = await fetch(`${runtime.url}/sessions/page/render-markdown`, { headers })
      expect(relaunched.headers.get("x-avibe-render-cache")).toBe("miss")
      await relaunched.text()
      expect(browser.contextCount).toBe(2)
      expect(runtime.renderSnapshots.get("page")).toBeDefined()
      expect(runtime.runtime.getSession("page")?.state).toBe("active")
      expect(buildSnapshot).toHaveBeenCalledTimes(2)
      expect(fingerprintReads.filter((path) => path.startsWith(workspace)))
        .toHaveLength(initialFingerprintReads * 2)
    } finally {
      await runtime.close()
    }
  }, 30_000)

  it("prunes only the idle session snapshot and Markdown cache", async () => {
    const workspaceRoot = await temporaryDirectory("idle-render-pruning")
    const idleWorkspace = await fixtureWorkspace("idle-page", workspaceRoot)
    const activeWorkspace = await fixtureWorkspace("active-page", workspaceRoot)
    await writeFile(join(idleWorkspace, "index.html"), "<main id=\"root\"><h1>Idle snapshot</h1></main>\n")
    await writeFile(join(activeWorkspace, "index.html"), "<main id=\"root\"><h1>Active snapshot</h1></main>\n")
    const fingerprintReads: string[] = []
    const workspaceFingerprinter = createWorkspaceFingerprinter({
      readFile: async (path) => {
        fingerprintReads.push(path)
        return await readFile(path)
      }
    })
    const browser = new FakeBrowser(() => ({ html: "", mode: "success", useNavigationBody: true }))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      idleTtlMs: 50,
      idlePruneIntervalMs: 0,
      renderTimeoutMs: 15_000
    }, {
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0,
      workspaceFingerprinter
    })
    const buildSnapshot = vi.spyOn(runtime.runtime, "buildSessionSnapshot")

    try {
      for (const sessionId of ["idle-page", "active-page"]) {
        const miss = await fetch(`${runtime.url}/sessions/${sessionId}/render-markdown`)
        expect(miss.headers.get("x-avibe-render-cache")).toBe("miss")
        await miss.text()
        const hit = await fetch(`${runtime.url}/sessions/${sessionId}/render-markdown`)
        expect(hit.headers.get("x-avibe-render-cache")).toBe("hit")
        await hit.text()
      }

      const idleSnapshot = runtime.renderSnapshots.get("idle-page")
      const activeSnapshot = runtime.renderSnapshots.get("active-page")
      const idleReadsBeforePrune = fingerprintReads.filter((path) => path.startsWith(idleWorkspace)).length
      const activeReadsBeforePrune = fingerprintReads.filter((path) => path.startsWith(activeWorkspace)).length
      expect(idleSnapshot).toBeDefined()
      expect(activeSnapshot).toBeDefined()
      runtime.runtime.getSession("idle-page")!.lastAccessedAt = new Date(Date.now() - 1_000)
      runtime.runtime.getSession("active-page")!.lastAccessedAt = new Date()

      const pruned = await runtime.runtime.pruneIdleSessions()

      expect(pruned.map((status) => status.sessionId)).toEqual(["idle-page"])
      expect(runtime.renderSnapshots.get("idle-page")).toBeUndefined()
      await expect(lstat(idleSnapshot!.outDir)).rejects.toMatchObject({ code: "ENOENT" })
      expect(runtime.renderSnapshots.get("active-page")).toBe(activeSnapshot)
      await expect(lstat(join(activeSnapshot!.outDir, "index.html"))).resolves.toMatchObject({})

      const active = await fetch(`${runtime.url}/sessions/active-page/render-markdown`)
      expect(active.headers.get("x-avibe-render-cache")).toBe("hit")
      await active.text()
      expect(fingerprintReads.filter((path) => path.startsWith(activeWorkspace)))
        .toHaveLength(activeReadsBeforePrune)
      const idle = await fetch(`${runtime.url}/sessions/idle-page/render-markdown`)
      expect(idle.headers.get("x-avibe-render-cache")).toBe("miss")
      await idle.text()
      expect(fingerprintReads.filter((path) => path.startsWith(idleWorkspace)))
        .toHaveLength(idleReadsBeforePrune * 2)
      expect(buildSnapshot).toHaveBeenCalledTimes(3)
    } finally {
      await runtime.close()
    }
  }, 30_000)

  it("fences suspension ahead of a render queued behind an active snapshot build", async () => {
    const workspaceRoot = await temporaryDirectory("suspend-queued-render")
    await fixtureWorkspace("page", workspaceRoot)
    const browser = new FakeBrowser(() => ({
      html: "<main id=\"root\"><h1>Queued render</h1></main>",
      mode: "success",
      expectedNavigationBody: "/sessions/page/render-app/assets/"
    }))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache"),
      renderTimeoutMs: 15_000
    }, {
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0
    })
    const originalBuild = runtime.runtime.buildSessionSnapshot.bind(runtime.runtime)
    let firstBuildStarted!: () => void
    const buildStarted = new Promise<void>((resolveStarted) => {
      firstBuildStarted = resolveStarted
    })
    let releaseFirstBuild!: () => void
    const buildGate = new Promise<void>((resolveGate) => {
      releaseFirstBuild = resolveGate
    })
    let buildCount = 0
    vi.spyOn(runtime.runtime, "buildSessionSnapshot").mockImplementation(async (...args) => {
      buildCount += 1
      if (buildCount === 1) {
        firstBuildStarted()
        await buildGate
      }
      await originalBuild(...args)
    })

    try {
      const first = fetch(`${runtime.url}/sessions/page/render-markdown`, {
        headers: { "x-vibe-show-base": "/p/first/" }
      })
      await buildStarted
      const suspend = fetch(`${runtime.url}/sessions/page/suspend`, { method: "POST" })
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
      const queued = fetch(`${runtime.url}/sessions/page/render-markdown`, {
        headers: { "x-vibe-show-base": "/p/queued/" }
      })
      releaseFirstBuild()

      const firstResponse = await first
      expect(firstResponse.status).toBe(200)
      await firstResponse.text()
      const suspendResponse = await suspend
      expect(await suspendResponse.json()).toMatchObject({ state: "suspended" })
      const queuedResponse = await queued
      expect(queuedResponse.status).toBe(200)
      expect(queuedResponse.headers.get("x-avibe-render-cache")).toBe("miss")
      expect(await queuedResponse.text()).toContain("# Queued render")
      expect(buildCount).toBe(2)
      expect(runtime.runtime.getSession("page")?.state).toBe("active")
      expect(runtime.renderSnapshots.get("page")).toBeDefined()
    } finally {
      releaseFirstBuild()
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

  it("keeps query bytes opaque while containing decoded target pathnames", async () => {
    const workspaceRoot = await temporaryDirectory("render-targets")
    await fixtureWorkspace("page", workspaceRoot)
    const browser = new FakeBrowser(() => ({ html: "<h1>Target page</h1>", mode: "success" }))
    const runtime = await startShowRuntimeServer({
      workspaceRoot,
      cacheRoot: join(workspaceRoot, ".cache")
    }, {
      launchBrowser: async (target) => {
        if (target !== "chrome") throw new Error("not found")
        return browser
      },
      browserProvisioningDisabled: true,
      renderQuietPeriodMs: 0
    })
    const headers = {
      "X-Avibe-Show-Protocol": "1",
      "X-Avibe-Show-Context": "private",
      "x-vibe-show-base": "/show/page/"
    }

    try {
      for (const target of [
        "/search?q=version..2&next=../secret",
        "/callback?return=https://example.com/path"
      ]) {
        const response = await fetch(`${runtime.url}/sessions/page/render-markdown`, {
          headers: { ...headers, "x-vibe-show-target": target }
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("x-avibe-render-cache")).toBe("miss")
        await response.text()
      }

      expect(browser.visitedUrls.map((url) => {
        const rendered = new URL(url)
        return `${rendered.pathname}${rendered.search}`
      })).toEqual([
        "/sessions/page/render-app/search?q=version..2&next=../secret",
        "/sessions/page/render-app/callback?return=https://example.com/path"
      ])

      for (const target of [
        "dashboard",
        "https://evil.example/path",
        "//evil.example/path",
        "/reports/../secret",
        "/%2e%2e/secret",
        "/%252e%252e/secret",
        "/https://evil.example/path"
      ]) {
        const invalid = await fetch(`${runtime.url}/sessions/page/render-markdown`, {
          headers: { ...headers, "x-vibe-show-target": target }
        })
        await expectRenderError(invalid, 400, "invalid_target")
      }
      expect(browser.contextCount).toBe(2)
    } finally {
      await runtime.close()
    }
  }, 30_000)
})

type FakePageMode =
  | "success"
  | "timeout"
  | "stalled"
  | "failed"
  | "large"
  | "persistent-network"
  | "fetch-stream"
  | "never-settling-request"
  | "slow-initial-data"
type FakePageState = {
  html: string
  mode: FakePageMode
  expectedNavigationBody?: string
  useNavigationBody?: boolean
  apiPath?: string
  renderApiBody?: (body: string) => string
  completedHtml?: string
  initialDataDelayMs?: number
  responseContentType?: string
  responseContentLength?: string
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
      newPage: async () => new FakePage(this.pageState(), this.visitedUrls),
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
  private readonly listeners = new Map<
    string,
    Set<(payload: MarkdownNetworkRequest | MarkdownNetworkResponse) => void>
  >()
  private renderedHtml: string

  constructor(
    private readonly state: FakePageState,
    private readonly visitedUrls: string[]
  ) {
    this.renderedHtml = state.html
  }

  async goto(url: string): Promise<{ ok(): boolean; status(): number } | null> {
    this.visitedUrls.push(url)
    const mode = this.state.mode
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
    if (mode === "persistent-network") {
      this.emit("request", new FakeNetworkRequest("GET", "eventsource", `${url}__show/events?stream=1`))
      const firstPoll = new FakeNetworkRequest("GET", "fetch", `${url}api/status`)
      this.emit("request", firstPoll)
      setTimeout(() => {
        this.emit("requestfinished", firstPoll)
        this.emit("request", new FakeNetworkRequest("GET", "fetch", `${url}api/status`))
      }, 20)
    }
    if (mode === "fetch-stream") {
      const stream = new FakeNetworkRequest("GET", "fetch", `${url}api/stream`)
      this.emit("request", stream)
      const headers: Record<string, string> = {}
      if (this.state.responseContentType) headers["Content-Type"] = this.state.responseContentType
      if (this.state.responseContentLength) {
        headers["content-length"] = this.state.responseContentLength
      }
      this.emit("response", new FakeNetworkResponse(stream, headers))
    }
    if (mode === "never-settling-request") {
      this.emit("request", new FakeNetworkRequest("GET", "fetch", `${url}api/never-settles`))
    }
    if (mode === "slow-initial-data") {
      const initialData = new FakeNetworkRequest("GET", "fetch", `${url}api/initial-data`)
      this.emit("request", initialData)
      if (this.state.responseContentType || this.state.responseContentLength) {
        const headers: Record<string, string> = {}
        if (this.state.responseContentType) headers["content-type"] = this.state.responseContentType
        if (this.state.responseContentLength) {
          headers["Content-Length"] = this.state.responseContentLength
        }
        this.emit("response", new FakeNetworkResponse(initialData, headers))
      }
      setTimeout(() => {
        this.renderedHtml = this.state.completedHtml ?? this.state.html
        this.emit("requestfinished", initialData)
      }, this.state.initialDataDelayMs ?? 0)
    }
    if (this.state.expectedNavigationBody || this.state.useNavigationBody || this.state.apiPath) {
      const response = await fetch(url)
      const body = await response.text()
      if (this.state.expectedNavigationBody && !body.includes(this.state.expectedNavigationBody)) {
        throw new Error(`anonymous navigation did not preserve loopback base: ${body}`)
      }
      if (this.state.useNavigationBody) {
        this.renderedHtml = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(body)?.[1] ?? body
      }
      if (this.state.apiPath) {
        const apiResponse = await fetch(new URL(this.state.apiPath, url))
        const apiBody = await apiResponse.text()
        if (!apiResponse.ok) {
          throw new Error(`anonymous API request failed: ${apiResponse.status} ${apiBody}`)
        }
        this.renderedHtml = this.state.renderApiBody?.(apiBody) ?? apiBody
      }
      return { ok: () => response.ok, status: () => response.status }
    }
    return { ok: () => true, status: () => 200 }
  }

  on(
    event: "request" | "requestfinished" | "requestfailed",
    listener: (request: MarkdownNetworkRequest) => void
  ): void
  on(event: "response", listener: (response: MarkdownNetworkResponse) => void): void
  on(
    event: string,
    listener: (
      (request: MarkdownNetworkRequest) => void
    ) | (
      (response: MarkdownNetworkResponse) => void
    )
  ): void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener as (payload: MarkdownNetworkRequest | MarkdownNetworkResponse) => void)
    this.listeners.set(event, listeners)
  }

  off(
    event: "request" | "requestfinished" | "requestfailed",
    listener: (request: MarkdownNetworkRequest) => void
  ): void
  off(event: "response", listener: (response: MarkdownNetworkResponse) => void): void
  off(
    event: string,
    listener: (
      (request: MarkdownNetworkRequest) => void
    ) | (
      (response: MarkdownNetworkResponse) => void
    )
  ): void {
    this.listeners.get(event)?.delete(
      listener as (payload: MarkdownNetworkRequest | MarkdownNetworkResponse) => void
    )
  }

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
      const maxOutputBytes = (argument as { maxOutputBytes: number }).maxOutputBytes
      const outputTooLarge = Buffer.byteLength(this.renderedHtml, "utf8") > maxOutputBytes
      return {
        html: outputTooLarge ? "" : this.renderedHtml,
        mountEmpty: false,
        outputTooLarge
      } as Result
    }
    return await (pageFunction as (argument?: Argument) => Result | Promise<Result>)(argument)
  }

  private emit(event: string, payload: MarkdownNetworkRequest | MarkdownNetworkResponse): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }
}

class FakeNetworkRequest implements MarkdownNetworkRequest {
  constructor(
    private readonly requestMethod: string,
    private readonly requestResourceType: string,
    private readonly requestUrl: string
  ) {}

  method(): string {
    return this.requestMethod
  }

  resourceType(): string {
    return this.requestResourceType
  }

  url(): string {
    return this.requestUrl
  }
}

class FakeNetworkResponse implements MarkdownNetworkResponse {
  constructor(
    private readonly networkRequest: MarkdownNetworkRequest,
    private readonly responseHeaders: Record<string, string>
  ) {}

  request(): MarkdownNetworkRequest {
    return this.networkRequest
  }

  headers(): Record<string, string> {
    return this.responseHeaders
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
  prepare: MarkdownRenderRequest["prepare"] | undefined = undefined,
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
    prepare: prepare ?? (async () => ({ fingerprint: await workspaceFingerprint(workspace) }))
  }
}

function cacheVariantRequest(
  workspace: string,
  sessionId: string,
  variant: string
): MarkdownRenderRequest {
  const target = `/${variant}`
  const internalBasePath = `/sessions/${sessionId}/app/`
  return {
    ...renderRequest(workspace, undefined, `/p/${variant}/`),
    sessionId,
    target,
    internalBasePath,
    renderUrl: `http://127.0.0.1:4177${internalBasePath}${variant}`
  }
}

async function expectRenderError(
  response: Response,
  status: number,
  code: string
): Promise<{ error: { code: string; message: string } }> {
  expect(response.status).toBe(status)
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(response.headers.get("cache-control")).toBe("no-store")
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
