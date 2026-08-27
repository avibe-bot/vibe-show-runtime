import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createShowRuntime } from "./runtime.js"
import {
  createSsrMarkdownCacheKey,
  cleanupSsrRenderedHtml,
  renderSsrMarkdown,
  runSsrMarkdownPipeline,
  SSR_MARKDOWN_REPRESENTATION_VERSION
} from "./ssr-markdown.js"
import { workspaceFingerprint } from "./workspace-fingerprint.js"

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = join(sourceDirectory, "__fixtures__", "ssr-markdown")
const dependencyRoot = resolve(sourceDirectory, "../../..")
const fixtureNames = ["semantic", "module-window", "render-document"] as const

let workspaceRoot: string | undefined
let browserCache: string | undefined
let previousBrowserCache: string | undefined
let hostServer: Server | undefined
let runtime: ReturnType<typeof createShowRuntime> | undefined

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "avibe-show-ssr-markdown-"))
  browserCache = join(workspaceRoot, "browser-cache-must-stay-absent")
  previousBrowserCache = process.env.PLAYWRIGHT_BROWSERS_PATH
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache
  for (const fixture of fixtureNames) {
    await cp(join(fixtureRoot, fixture), join(workspaceRoot, fixture), { recursive: true })
  }
  const server = createServer()
  hostServer = server
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  runtime = createShowRuntime({
    workspaceRoot,
    dependencyRoot,
    cacheRoot: join(workspaceRoot, ".vite-cache"),
    server,
    idlePruneIntervalMs: 0
  })
}, 60_000)

afterAll(async () => {
  await runtime?.close()
  const server = hostServer
  if (server) {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose())
    })
  }
  if (previousBrowserCache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
  else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowserCache
  if (workspaceRoot) await rm(workspaceRoot, { force: true, recursive: true })
})

async function fixtureVite(fixture: typeof fixtureNames[number]) {
  if (!runtime) throw new Error("Fixture runtime was not created")
  await runtime.ensureSession(fixture, `/show/${fixture}/`)
  const vite = runtime.getSession(fixture)?.vite
  if (!vite) throw new Error(`Fixture ${fixture} did not create a Vite server`)
  return vite
}

describe("Vite SSR Markdown spike", () => {
  it("renders semantic React, Show UI, pre-effect state, cleanup, CSS, and an asset without a browser", async () => {
    const vite = await fixtureVite("semantic")
    const result = await renderSsrMarkdown({
      vite,
      target: "/",
      basePath: "/show/semantic/"
    })

    expect(result.markdown).toContain("# SSR fixture report")
    expect(result.markdown).toContain("The initial React tree is semantic.")
    expect(result.markdown).toContain("Built-in Show UI")
    expect(result.markdown).toContain("SSR safe")
    expect(result.markdown).toContain("Loading...")
    expect(result.markdown).toContain("Visible audited total")
    expect(result.markdown).toContain("> agent-note: Verify the audited total")
    expect(result.markdown).toContain("![Fixture chart](data:image/svg+xml,")
    expect(result.markdown).toContain(
      "![Fixture asset URL](/show/semantic/src/pages/fixture.svg?no-inline)"
    )
    expect(result.markdown).not.toContain("Loaded in a browser")
    expect(result.markdown).not.toContain("Private visual-only detail")
    expect(result.markdown).not.toContain("SSR_SCRIPT_RAN")
    expect(result.markdown).not.toContain("fixture-only")
    expect(result.html).not.toContain("data-agent-hidden")
    expect(result.html).not.toContain("<script")
    expect(result.html).not.toContain("<style")
    expect(result.html).not.toContain("/@fs/")
    expect(result.html).not.toContain(workspaceRoot)
    expect("window" in globalThis).toBe(false)
    expect("document" in globalThis).toBe(false)
    if (!browserCache) throw new Error("Fixture browser cache path was not created")
    await expect(access(browserCache)).rejects.toMatchObject({ code: "ENOENT" })
  }, 60_000)

  it("uses server route params and query while resolving Link hrefs", async () => {
    const vite = await fixtureVite("semantic")
    const result = await renderSsrMarkdown({
      vite,
      target: "/teams/acme?period=Q3&vibe-embed=1",
      basePath: "/show/semantic/"
    })

    expect(result.markdown).toContain("# Team acme")
    expect(result.markdown).toContain("Period: Q3")
    expect(result.markdown).toContain(
      "[Open details](/show/semantic/teams/acme/details?from=Q3&vibe-embed=1)"
    )
    expect(result.markdown).toContain(
      "[Change period](/show/semantic/teams/acme?period=Q4)"
    )
  })

  it("does not expose an unmappable Vite filesystem asset URL", async () => {
    if (!workspaceRoot) throw new Error("Fixture workspace was not created")
    const outsideAsset = join(workspaceRoot, "outside.svg")
    await writeFile(outsideAsset, "<svg xmlns=\"http://www.w3.org/2000/svg\" />")

    const html = cleanupSsrRenderedHtml(
      `<img src="/@fs/${outsideAsset}" alt="Outside asset">`,
      {
        documentUrl: "http://show-runtime.local/show/semantic/",
        basePath: "/show/semantic/",
        internalBasePath: "/show/semantic/",
        workspace: join(workspaceRoot, "semantic"),
        maxOutputBytes: 1024
      }
    )

    expect(html).toBe("<img alt=\"Outside asset\">")
    expect(html).not.toContain("/@fs/")
    expect(html).not.toContain(workspaceRoot)
  })

  it.each([
    ["module evaluation", "module-window"],
    ["React render", "render-document"]
  ] as const)("maps browser-only access during %s to render_failed", async (_phase, fixture) => {
    const vite = await fixtureVite(fixture)
    await expect(renderSsrMarkdown({
      vite,
      target: "/",
      basePath: `/show/${fixture}/`
    })).rejects.toMatchObject({
      code: "render_failed",
      status: 502,
      message: "Show Page rendering failed."
    })
  }, 60_000)

  it("pins the exact cache identity to contract, session, workspace content, route, and link base", () => {
    expect(SSR_MARKDOWN_REPRESENTATION_VERSION).toBe("ssr-initial-tree-v1")
    expect(createSsrMarkdownCacheKey({
      sessionId: "semantic",
      workspaceVersion: "workspace-sha256",
      context: "private",
      target: "/teams/acme?period=Q3",
      basePath: "/show/semantic"
    })).toBe(
      '["ssr-initial-tree-v1","semantic","workspace-sha256","private","/teams/acme?period=Q3","/show/semantic/"]'
    )
  })

  it("stops after an abort instead of entering render or conversion", async () => {
    const controller = new AbortController()
    let finishLoad!: (value: string) => void
    const load = vi.fn(() => new Promise<string>((resolveLoad) => {
      finishLoad = resolveLoad
    }))
    const render = vi.fn(() => "<h1>must not render</h1>")
    const cleanup = vi.fn((html: string) => html)
    const convert = vi.fn(() => "# must not convert\n")

    const pending = runSsrMarkdownPipeline({ load, render, cleanup, convert }, controller.signal)
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    finishLoad("loaded after cancellation")
    await Promise.resolve()
    expect(render).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    expect(convert).not.toHaveBeenCalled()
  })

  it("uses the Vite watcher as the module-graph invalidation signal", async () => {
    const vite = await fixtureVite("semantic")
    if (!workspaceRoot) throw new Error("Fixture workspace was not created")
    const workspace = join(workspaceRoot, "semantic")
    const pagePath = join(workspace, "src", "pages", "index.tsx")
    const beforeVersion = await workspaceFingerprint(workspace)
    const beforeKey = createSsrMarkdownCacheKey({
      sessionId: "semantic",
      workspaceVersion: beforeVersion,
      context: "private",
      target: "/",
      basePath: "/show/semantic/"
    })
    const watcherChange = new Promise<void>((resolveChange) => {
      const onChange = (changedPath: string) => {
        if (resolve(changedPath) !== resolve(pagePath)) return
        vite.watcher.off("change", onChange)
        resolveChange()
      }
      vite.watcher.on("change", onChange)
    })
    const source = await readFile(pagePath, "utf8")
    await writeFile(pagePath, source.replace(
      "The initial React tree is semantic.",
      "The invalidated React tree is semantic."
    ))
    await watcherChange
    await new Promise<void>((resolveTick) => setImmediate(resolveTick))

    const afterVersion = await workspaceFingerprint(workspace)
    const afterKey = createSsrMarkdownCacheKey({
      sessionId: "semantic",
      workspaceVersion: afterVersion,
      context: "private",
      target: "/",
      basePath: "/show/semantic/"
    })
    const rerendered = await renderSsrMarkdown({
      vite,
      target: "/",
      basePath: "/show/semantic/"
    })

    expect(afterVersion).not.toBe(beforeVersion)
    expect(afterKey).not.toBe(beforeKey)
    expect(rerendered.markdown).toContain("The invalidated React tree is semantic.")
    expect(rerendered.markdown).not.toContain("The initial React tree is semantic.")
  })
})
