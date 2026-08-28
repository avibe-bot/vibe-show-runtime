import { EventEmitter } from "node:events"
import { fork, spawn, type ChildProcess, type ForkOptions } from "node:child_process"
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { get as httpGet } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ViteDevServer } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createMarkdownRenderer,
  createModuleGraphSsrWorker,
  MarkdownRenderError,
  SsrWorkerUnavailableError,
  type MarkdownRenderRequest,
  type SsrMarkdownWorker
} from "./markdown-renderer.js"
import { convertSsrRenderedHtmlToMarkdown } from "./ssr-markdown-conversion.js"
import {
  startShowRuntimeServer,
  type ShowRuntimeServerDependencies
} from "./server.js"
import { SSR_MARKDOWN_ENVIRONMENT } from "./ssr-markdown-entry-plugin.js"
import { SsrSandboxEvaluator } from "./ssr-markdown-sandbox.js"
import type { ShowRuntimeOptions } from "./types.js"
import type { WorkspaceFingerprinter } from "./workspace-fingerprint.js"

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = join(sourceDirectory, "__fixtures__", "ssr-markdown")
const dependencyRoot = resolve(sourceDirectory, "../../..")
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function startFixtureServer(
  fixtures: string[],
  options: Partial<ShowRuntimeOptions> = {},
  dependencies: ShowRuntimeServerDependencies = {}
) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "avibe-show-ssr-endpoint-"))
  for (const fixture of fixtures) {
    await cp(join(fixtureRoot, fixture), join(workspaceRoot, fixture), { recursive: true })
  }
  const server = await startShowRuntimeServer({
    workspaceRoot,
    dependencyRoot,
    cacheRoot: join(workspaceRoot, ".vite-cache"),
    idlePruneIntervalMs: 0,
    ...options
  }, dependencies)
  cleanups.push(async () => {
    await server.close()
    await rm(workspaceRoot, { recursive: true, force: true })
  })
  return { ...server, workspaceRoot }
}

function markdownUrl(runtimeUrl: string, sessionId: string): string {
  return `${runtimeUrl}/sessions/${sessionId}/render-markdown`
}

function intrinsicReport(markdown: string): Record<string, any> {
  const match = /IntrinsicReportBegin`(.+)`IntrinsicReportEnd/.exec(markdown)
  if (!match) throw new Error(`Intrinsic report was absent from Markdown: ${markdown}`)
  return JSON.parse(match[1]) as Record<string, any>
}

function capturedError(operation: () => unknown) {
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

function hostEncodeInto(value: string, size: number) {
  const destination = new Uint8Array(size)
  return {
    result: new TextEncoder().encodeInto(value, destination),
    bytes: [...destination]
  }
}

function hostIntrinsicReport() {
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

  return {
    textEncoder: {
      encoded: [...new TextEncoder().encode("A\u00e9\ud83d\ude00\ud800")],
      shortMultibyte: hostEncodeInto("\u00e9", 1),
      mixedBoundary: hostEncodeInto("A\u00e9", 2),
      astralBoundary: hostEncodeInto("\ud83d\ude00", 3),
      replacementBoundary: hostEncodeInto("\ud800", 3)
    },
    textDecoder: {
      bom: decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])),
      ignoreBom: new TextDecoder("utf-8", { ignoreBOM: true })
        .decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])),
      utf16: new TextDecoder("utf-16le").decode(new Uint8Array([0x41, 0x00])),
      streaming: streamingText,
      fatalError: capturedError(() => {
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
      atobError: capturedError(() => atob("!!!!")),
      btoaError: capturedError(() => btoa("\u2713"))
    },
    url: {
      href: url.href,
      invalidError: capturedError(() => new URL("relative-only")),
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
    }
  }
}

async function renderError(response: Response) {
  return await response.json() as { error: { code: string, message: string } }
}

const permissionProbeSource = String.raw`
const { readFileSync } = require("node:fs")
if (!process.send) throw new Error("permission probe requires IPC")
let error
try {
  readFileSync(process.argv[process.argv.length - 1], "utf8")
  error = new Error("The SSR child read outside its permission profile")
} catch (candidate) {
  if (candidate && candidate.code !== "ERR_ACCESS_DENIED") error = candidate
}
if (error) {
  process.send({
    type: "boot-error",
    error: { name: error.name, message: error.message, code: error.code }
  })
} else {
  process.on("message", (message) => {
    if (!message || message.type !== "command") return
    process.send({
      type: "command-result",
      requestId: message.requestId,
      result: null
    })
  })
  process.send({ type: "ready" })
}
`

async function probeChildPermissionProfile(): Promise<ForkOptions["execArgv"]> {
  const workspace = await mkdtemp(join(tmpdir(), "avibe-show-permission-profile-"))
  const outsideRoot = await mkdtemp(join(tmpdir(), "avibe-show-permission-outside-"))
  const deniedPath = join(outsideRoot, "outside-root-sentinel.txt")
  await writeFile(deniedPath, "outside-root-read-must-be-denied")
  let execArgv: ForkOptions["execArgv"]
  const worker = createModuleGraphSsrWorker((_modulePath, _args, options) => {
    execArgv = options.execArgv
    return spawn(
      options.execPath ?? process.execPath,
      [...(options.execArgv ?? []), "-e", permissionProbeSource, deniedPath],
      {
        env: options.env,
        serialization: options.serialization,
        stdio: options.stdio
      }
    )
  }, workspace)
  try {
    await worker.load("permission-profile", {
      environments: {
        [SSR_MARKDOWN_ENVIRONMENT]: {
          config: {
            consumer: "server",
            env: {
              BASE_URL: "/show/permission-profile/",
              MODE: "development",
              DEV: true,
              PROD: false
            }
          }
        }
      }
    } as unknown as ViteDevServer)
    return execArgv
  } finally {
    await worker.close()
    await rm(workspace, { recursive: true, force: true })
    await rm(outsideRoot, { recursive: true, force: true })
  }
}

function recordingChildFactory(children: ChildProcess[]) {
  return (modulePath: string, args: string[], options: ForkOptions): ChildProcess => {
    const child = fork(modulePath, args, options)
    children.push(child)
    return child
  }
}

describe("SSR sandbox evaluator", () => {
  it("uses the Vite environment supplied by its execution owner", () => {
    const expected = {
      BASE_URL: "/internal/vite-env/",
      MODE: "staging",
      DEV: false,
      PROD: true,
      SSR: true
    }
    const evaluator = new SsrSandboxEvaluator("avibe-show-ssr:test", expected)
    try {
      const meta = evaluator.createImportMeta("/workspace/src/page.tsx")
      expect(JSON.parse(JSON.stringify(meta.env))).toEqual(expected)
    } finally {
      evaluator.dispose()
    }
  })
})

describe("SSR Markdown endpoint", () => {
  it("renders legacy App-only workspaces without creating a router", async () => {
    const runtime = await startFixtureServer(["legacy-routerless", "semantic"])
    const legacy = await fetch(markdownUrl(runtime.url, "legacy-routerless"))
    const legacyMarkdown = await legacy.text()

    expect(legacy.status, legacyMarkdown).toBe(200)
    expect(legacyMarkdown).toContain("# Legacy routerless app")
    expect(legacyMarkdown).toContain("The Runtime rendered App.tsx without creating a router.")
    await expect(access(
      join(runtime.workspaceRoot, "legacy-routerless", "src", "router.tsx")
    )).rejects.toMatchObject({ code: "ENOENT" })

    const routed = await fetch(markdownUrl(runtime.url, "semantic"), {
      headers: { "x-vibe-show-target": "/teams/acme?period=Q3" }
    })
    expect(routed.status).toBe(200)
    expect(await routed.text()).toContain("# Team acme")

    await cp(
      join(fixtureRoot, "legacy-routerless"),
      join(runtime.workspaceRoot, "missing-entry"),
      { recursive: true }
    )
    await runtime.runtime.ensureSession("missing-entry", "/show/missing-entry/")
    await rm(join(runtime.workspaceRoot, "missing-entry", "src", "App.tsx"))
    const missing = await fetch(markdownUrl(runtime.url, "missing-entry"))
    expect(missing.status).toBe(502)
    expect(await renderError(missing)).toEqual({
      error: { code: "render_failed", message: "Show Page rendering failed." }
    })
    await expect(access(
      join(runtime.workspaceRoot, "missing-entry", "src", "router.tsx")
    )).rejects.toMatchObject({ code: "ENOENT" })
  }, 60_000)

  it("matches host intrinsic behavior at the SSR realm boundary", async () => {
    const runtime = await startFixtureServer(["intrinsic-conformance"])
    const response = await fetch(markdownUrl(runtime.url, "intrinsic-conformance"))
    const markdown = await response.text()

    expect(response.status, markdown).toBe(200)
    const report = intrinsicReport(markdown)
    const host = hostIntrinsicReport()
    expect(report.textEncoder).toEqual(host.textEncoder)
    expect(report.textDecoder).toEqual(host.textDecoder)
    expect(report.base64).toEqual(host.base64)
    expect(report.url).toEqual(host.url)
    expect(report.domException).toEqual(host.domException)
    expect(report.performance).toEqual({
      finite: true,
      monotonic: true,
      relativeClock: true,
      epochOrigin: true,
      tag: "[object Performance]"
    })
    expect(report.scheduling).toEqual(["microtask", "message", "timeout"])
    expect(report.policy).toEqual({
      nodeEnvironment: "development",
      delayedIntrinsicsUnavailable: true
    })
  }, 60_000)

  it("preserves the endpoint contract and advertises the SSR capability", async () => {
    const runtime = await startFixtureServer(["semantic"])
    const capabilities = await fetch(`${runtime.url}/capabilities`)
    expect(await capabilities.json()).toEqual({
      protocol: 1,
      render_markdown: true,
      render_markdown_ssr: true
    })

    const headers = {
      "x-avibe-show-protocol": "1",
      "x-avibe-show-context": "shared",
      "x-vibe-show-base": "/p/public-token/",
      "x-vibe-show-target": "/teams/acme?period=Q3&vibe-embed=1"
    }
    const first = await fetch(markdownUrl(runtime.url, "semantic"), { headers })
    expect(first.status).toBe(200)
    expect(first.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(first.headers.get("cache-control")).toBe("no-store")
    expect(first.headers.get("x-avibe-render-cache")).toBe("miss")
    const markdown = await first.text()
    expect(markdown).toContain("# Team acme")
    expect(markdown).toContain("Period: Q3")
    expect(markdown).toContain(
      "[Open details](/p/public-token/teams/acme/details?from=Q3&vibe-embed=1)"
    )
    expect(markdown).toContain("[Change period](/p/public-token/teams/acme?period=Q4)")
    expect(markdown).toContain("![Relative chart](/p/public-token/teams/assets/chart.png)")

    const second = await fetch(markdownUrl(runtime.url, "semantic"), { headers })
    expect(second.status).toBe(200)
    expect(second.headers.get("x-avibe-render-cache")).toBe("hit")
    expect(await second.text()).toBe(markdown)
  }, 60_000)

  it("renders Show UI and the pre-effect tree while applying structured cleanup", async () => {
    const runtime = await startFixtureServer(["semantic"])
    const response = await fetch(markdownUrl(runtime.url, "semantic"))
    const markdown = await response.text()

    expect(response.status).toBe(200)
    expect(markdown).toContain("# SSR fixture report")
    expect(markdown).toContain("Built-in Show UI")
    expect(markdown).toContain("SSR safe")
    expect(markdown).toContain("Loading...")
    expect(markdown).toContain("> agent-note: Verify the audited total")
    expect(markdown).toContain("![Fixture chart](data:image/svg+xml,")
    expect(markdown).toContain("![Fixture asset URL](/show/semantic/src/pages/fixture.svg?no-inline)")
    expect(markdown).not.toContain("Loaded in a browser")
    expect(markdown).not.toContain("Private visual-only detail")
    expect(markdown).not.toContain("SSR_SCRIPT_RAN")
    expect(markdown).not.toContain("fixture-only")

    const runtimeModulePath = join(sourceDirectory, "ssr-markdown-conversion.ts").replaceAll("\\", "/")
    const humanRequest = await fetch(
      `${runtime.url}/sessions/semantic/app/@fs/${runtimeModulePath}`
    )
    expect(humanRequest.status).toBe(404)
  }, 60_000)

  it("uses the active Vite SSR environment for import.meta.env", async () => {
    const runtime = await startFixtureServer(["vite-env"])
    await runtime.runtime.ensureSession("vite-env", "/internal/vite-env/")
    const environment = runtime.runtime.getSession("vite-env")?.vite
      ?.environments[SSR_MARKDOWN_ENVIRONMENT]
    expect(environment).toBeDefined()
    if (!environment) throw new Error("Expected the active Vite SSR environment")
    expect(environment.config.env.BASE_URL).toBe("/internal/vite-env/")

    const response = await fetch(markdownUrl(runtime.url, "vite-env"), {
      headers: { "x-vibe-show-base": "/p/public-token/" }
    })
    const markdown = await response.text()

    expect(response.status, markdown).toBe(200)
    expect(markdown).toContain("[Environment base link](/p/public-token/guide)")
    expect(markdown).toContain("![Environment base asset](/p/public-token/assets/chart.png)")
    expect(markdown).toContain(`MODE: ${String(environment.config.env.MODE)}`)
    expect(markdown).toContain(`DEV: ${String(environment.config.env.DEV)}`)
    expect(markdown).toContain(`PROD: ${String(environment.config.env.PROD)}`)
    expect(markdown).toContain(
      `SSR: ${String(environment.config.consumer === "server")}`
    )
  }, 60_000)

  it("returns session_unknown and rejects every target that escapes the session app", async () => {
    const runtime = await startFixtureServer(["semantic"])
    const unknown = await fetch(markdownUrl(runtime.url, "missing"))
    expect(unknown.status).toBe(404)
    expect(await renderError(unknown)).toMatchObject({ error: { code: "session_unknown" } })

    for (const target of [
      "https://example.com/escape",
      "//example.com/escape",
      "/../escape",
      "/%2e%2e/escape",
      "/%252e%252e/escape"
    ]) {
      const response = await fetch(markdownUrl(runtime.url, "semantic"), {
        headers: { "x-vibe-show-target": target }
      })
      expect(response.status, target).toBe(400)
      expect(await renderError(response)).toMatchObject({ error: { code: "invalid_target" } })
    }
  })

  it("maps page and custom-router browser globals to render_failed without rewriting the router", async () => {
    const runtime = await startFixtureServer([
      "module-window",
      "render-document",
      "render-abort",
      "custom-router-window"
    ])

    for (const sessionId of [
      "module-window",
      "render-document",
      "render-abort",
      "custom-router-window"
    ]) {
      const response = await fetch(markdownUrl(runtime.url, sessionId))
      expect(response.status, sessionId).toBe(502)
      expect(await renderError(response)).toEqual({
        error: {
          code: "render_failed",
          message: "Show Page rendering failed."
        }
      })
    }

    const routerPath = join(runtime.workspaceRoot, "custom-router-window", "src", "router.tsx")
    expect(await readFile(routerPath, "utf8")).toContain("const browserWidth = window.innerWidth")
    expect(await readFile(routerPath, "utf8")).not.toContain("SsrRouterContext")
  }, 60_000)

  it("denies workspace access to host builtins, environment secrets, and VM escape constructors", async () => {
    const sentinel = "AVIBE_SSR_HOST_AUTHORITY_MUST_NOT_LEAK"
    vi.stubEnv("AVIBE_SSR_HOST_SENTINEL", sentinel)
    const runtime = await startFixtureServer(["module-node-fs", "sandbox-escapes"])
    const sentinelPath = join(runtime.workspaceRoot, "host-readable-sentinel.txt")
    await writeFile(sentinelPath, sentinel)

    for (const fixture of ["module-node-fs", "sandbox-escapes"]) {
      const pagePath = join(runtime.workspaceRoot, fixture, "src", "pages", "index.tsx")
      const source = await readFile(pagePath, "utf8")
      await writeFile(
        pagePath,
        source.replace('"__HOST_SENTINEL_PATH__"', JSON.stringify(sentinelPath))
      )
    }

    const builtin = await fetch(markdownUrl(runtime.url, "module-node-fs"))
    expect(builtin.status).toBe(502)
    expect(await renderError(builtin)).toEqual({
      error: {
        code: "render_failed",
        message: "Show Page rendering failed."
      }
    })

    const escapes = await fetch(markdownUrl(runtime.url, "sandbox-escapes"))
    const markdown = await escapes.text()
    expect(escapes.status, markdown).toBe(200)
    for (const attempt of [
      "process-env",
      "Function",
      "eval",
      "URL constructor",
      "URLSearchParams constructor",
      "timer constructor",
      "encoder constructor",
      "decoder constructor",
      "base64 constructor",
      "performance constructor",
      "DOMException constructor",
      "MessageChannel constructor",
      "Promise constructor",
      "deferred intrinsics",
      "import-meta constructor",
      "module namespace",
      "dynamic import"
    ]) {
      expect(markdown).toContain(`${attempt}: blocked`)
    }
    expect(markdown).not.toContain(sentinel)
  }, 60_000)

  it("enforces the workspace boundary before SSR loaders can read module content", async () => {
    const siblingSecret = "SIBLING_SESSION_SECRET_MUST_NOT_LEAK"
    const cssSecret = "SIBLING_CSS_SECRET_MUST_NOT_LEAK"
    const assetSecret = "SIBLING_ASSET_SECRET_MUST_NOT_LEAK"
    const hostSecret = "HOST_FILE_SECRET_MUST_NOT_LEAK"
    const hostRoot = await mkdtemp(join(tmpdir(), "avibe-show-ssr-host-secret-"))
    cleanups.push(async () => rm(hostRoot, { recursive: true, force: true }))
    const hostFile = join(hostRoot, "value.txt")
    await writeFile(hostFile, hostSecret)

    const runtime = await startFixtureServer([
      "boundary-sibling",
      "boundary-host",
      "boundary-symlink",
      "boundary-css",
      "boundary-asset",
      "semantic"
    ])
    const siblingRoot = join(runtime.workspaceRoot, "sibling-secret")
    await mkdir(siblingRoot, { recursive: true })
    await writeFile(join(siblingRoot, "value.txt"), siblingSecret)
    await writeFile(
      join(siblingRoot, "secret.css"),
      `.leak::before { content: "${cssSecret}"; }\n`
    )
    await writeFile(
      join(siblingRoot, "secret.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg"><text>${assetSecret}</text></svg>\n`
    )
    await symlink(
      hostRoot,
      join(runtime.workspaceRoot, "boundary-symlink", "src", "pages", "linked-outside"),
      process.platform === "win32" ? "junction" : "dir"
    )

    const hostSpecifier = `/@fs/${hostFile.replaceAll("\\", "/").replace(/^\/+/, "")}?raw`
    const attacks = new Map([
      ["boundary-sibling", "../../../sibling-secret/value.txt?raw"],
      ["boundary-host", hostSpecifier],
      ["boundary-symlink", "./linked-outside/value.txt?raw"],
      ["boundary-asset", "../../../sibling-secret/secret.svg?url"]
    ])
    for (const [sessionId, specifier] of attacks) {
      const pagePath = join(runtime.workspaceRoot, sessionId, "src", "pages", "index.tsx")
      const source = await readFile(pagePath, "utf8")
      await writeFile(pagePath, source.replace("__BOUNDARY_IMPORT__", specifier))
    }

    for (const sessionId of attacks.keys()) {
      const response = await fetch(markdownUrl(runtime.url, sessionId))
      const body = await response.text()
      expect(response.status, `${sessionId}: ${body}`).toBe(502)
      expect(JSON.parse(body)).toEqual({
        error: {
          code: "render_failed",
          message: "Show Page rendering failed."
        }
      })
      expect(body).not.toContain(siblingSecret)
      expect(body).not.toContain(cssSecret)
      expect(body).not.toContain(assetSecret)
      expect(body).not.toContain(hostSecret)
    }

    const css = await fetch(markdownUrl(runtime.url, "boundary-css"))
    const cssMarkdown = await css.text()
    expect(css.status, cssMarkdown).toBe(200)
    expect(cssMarkdown).toContain("CSS import loaded")
    expect(cssMarkdown).not.toContain(cssSecret)

    const allowed = await fetch(markdownUrl(runtime.url, "semantic"))
    const allowedMarkdown = await allowed.text()
    expect(allowed.status, allowedMarkdown).toBe(200)
    expect(allowedMarkdown).toContain("Built-in Show UI")
    expect(allowedMarkdown).toContain("![Fixture chart](data:image/svg+xml,")
    expect(allowedMarkdown).toContain(
      "![Fixture asset URL](/show/semantic/src/pages/fixture.svg?no-inline)"
    )
  }, 60_000)

  it("keeps API handlers on Vite's ordinary Node SSR environment", async () => {
    const runtime = await startFixtureServer(["api-node"])
    const response = await fetch(`${runtime.url}/sessions/api-node/app/api/read`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ value: "ordinary-node-ssr" })
  }, 60_000)

  it("returns output_too_large after enforcing the intermediate and Markdown caps", async () => {
    const runtime = await startFixtureServer(["semantic"], { renderMaxOutputBytes: 128 })
    const response = await fetch(markdownUrl(runtime.url, "semantic"))
    expect(response.status).toBe(502)
    expect(await renderError(response)).toMatchObject({ error: { code: "output_too_large" } })
  }, 60_000)

  it("returns renderer_unavailable when the terminable SSR owner cannot start", async () => {
    const worker = new FakeSsrWorker({
      load: async () => {
        throw new SsrWorkerUnavailableError("worker startup failed")
      }
    })
    const runtime = await startFixtureServer(["semantic"], {}, { markdownWorker: worker })
    const response = await fetch(markdownUrl(runtime.url, "semantic"))
    expect(response.status).toBe(503)
    expect(await renderError(response)).toEqual({
      error: {
        code: "renderer_unavailable",
        message: "The SSR Markdown worker is unavailable."
      }
    })
  }, 60_000)

  it("returns renderer_unavailable when the child permission self-check fails", async () => {
    const worker = createModuleGraphSsrWorker((modulePath, args, options) => {
      const child = fork(modulePath, args, {
        ...options,
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      })
      child.stderr?.resume()
      return child
    })
    const runtime = await startFixtureServer(["semantic"], {}, { markdownWorker: worker })

    const response = await fetch(markdownUrl(runtime.url, "semantic"))

    expect(response.status).toBe(503)
    expect(await renderError(response)).toEqual({
      error: {
        code: "renderer_unavailable",
        message: "The SSR Markdown worker is unavailable."
      }
    })
  }, 60_000)

  it("returns renderer_unavailable when Node has no permission-model flag", async () => {
    vi.spyOn(process, "allowedNodeEnvironmentFlags", "get").mockReturnValue(new Set())
    const runtime = await startFixtureServer(["semantic"])

    const response = await fetch(markdownUrl(runtime.url, "semantic"))

    expect(response.status).toBe(503)
    expect(await renderError(response)).toEqual({
      error: {
        code: "renderer_unavailable",
        message: "The SSR Markdown worker is unavailable."
      }
    })
  }, 60_000)

  it.runIf(process.allowedNodeEnvironmentFlags.has("--permission"))(
    "denies reads outside the stable permission profile",
    async () => {
      const execArgv = await probeChildPermissionProfile()
      expect(execArgv?.[0]).toBe("--permission")
      expect(execArgv).not.toContain(`--allow-fs-read=${join(dependencyRoot, "packages")}`)
      expect(execArgv).not.toContain(`--allow-fs-read=${join(dependencyRoot, "node_modules")}`)
      expect(execArgv).not.toContain(`--allow-fs-read=${join(dependencyRoot, "package.json")}`)
    }
  )

  it.runIf(
    !process.allowedNodeEnvironmentFlags.has("--permission") &&
    process.allowedNodeEnvironmentFlags.has("--experimental-permission")
  )("denies reads outside the experimental permission profile", async () => {
    const execArgv = await probeChildPermissionProfile()
    expect(execArgv).toEqual([
      "--experimental-permission",
      `--allow-fs-read=${join(dependencyRoot, "packages")}`,
      `--allow-fs-read=${join(dependencyRoot, "node_modules")}`,
      `--allow-fs-read=${join(dependencyRoot, "package.json")}`,
      expect.stringMatching(/^--allow-fs-read=/)
    ])
  })

  it("kills a hung child at its phase deadline, respawns, and keeps the runtime usable", async () => {
    const children: ChildProcess[] = []
    const runtime = await startFixtureServer(
      ["hung-load", "semantic"],
      { renderLoadTimeoutMs: 3_000 },
      { markdownRendererOptions: { childFactory: recordingChildFactory(children) } }
    )
    await runtime.runtime.ensureSession("hung-load", "/show/hung-load/")
    await runtime.runtime.ensureSession("semantic", "/show/semantic/")

    const started = performance.now()
    const timedOut = await fetch(markdownUrl(runtime.url, "hung-load"))
    expect(timedOut.status).toBe(504)
    expect(await renderError(timedOut)).toMatchObject({ error: { code: "render_timeout" } })
    expect(performance.now() - started).toBeLessThan(6_000)
    expect(children).toHaveLength(1)
    expect(children[0]?.killed).toBe(true)

    const recovered = await fetch(markdownUrl(runtime.url, "semantic"))
    expect(recovered.status).toBe(200)
    expect(await recovered.text()).toContain("# SSR fixture report")
    expect(children).toHaveLength(2)
  }, 60_000)

  it("kills a hung React render at its deadline and respawns for the next render", async () => {
    const children: ChildProcess[] = []
    const runtime = await startFixtureServer(
      ["hung-render", "semantic"],
      { renderReactTimeoutMs: 3_000 },
      { markdownRendererOptions: { childFactory: recordingChildFactory(children) } }
    )
    await runtime.runtime.ensureSession("hung-render", "/show/hung-render/")
    await runtime.runtime.ensureSession("semantic", "/show/semantic/")

    const started = performance.now()
    const timedOut = await fetch(markdownUrl(runtime.url, "hung-render"))
    expect(timedOut.status).toBe(504)
    expect(await renderError(timedOut)).toMatchObject({ error: { code: "render_timeout" } })
    expect(performance.now() - started).toBeLessThan(8_000)
    expect(children).toHaveLength(1)
    expect(children[0]?.killed).toBe(true)

    const recovered = await fetch(markdownUrl(runtime.url, "semantic"))
    expect(recovered.status).toBe(200)
    expect(await recovered.text()).toContain("# SSR fixture report")
    expect(children).toHaveLength(2)
  }, 60_000)

  it("disposes module-level scheduled work when its command completes", async () => {
    const children: ChildProcess[] = []
    const runtime = await startFixtureServer(
      ["scheduled-work"],
      { renderLoadTimeoutMs: 5_000 },
      { markdownRendererOptions: { childFactory: recordingChildFactory(children) } }
    )
    await runtime.runtime.ensureSession("scheduled-work", "/show/scheduled-work/")

    const first = await fetch(markdownUrl(runtime.url, "scheduled-work"))
    const firstMarkdown = await first.text()
    expect(first.status, firstMarkdown).toBe(200)
    expect(first.headers.get("x-avibe-render-cache")).toBe("miss")
    expect(firstMarkdown).toContain("# Scheduled work fixture")
    expect(firstMarkdown).toContain("Deferred callbacks: none")
    expect(children).toHaveLength(1)

    await new Promise((resolveWait) => setTimeout(resolveWait, 2_350))
    const nextStarted = performance.now()
    const next = await fetch(markdownUrl(runtime.url, "scheduled-work"), {
      headers: { "x-vibe-show-target": "/?request=2" }
    })
    const nextMarkdown = await next.text()
    expect(next.status, nextMarkdown).toBe(200)
    expect(next.headers.get("x-avibe-render-cache")).toBe("miss")
    expect(nextMarkdown).toContain("Deferred callbacks: none")
    expect(performance.now() - nextStarted).toBeLessThan(5_000)
    expect(children).toHaveLength(1)
  }, 60_000)

  it("propagates caller disconnect, kills the child, and respawns on the next render", async () => {
    const children: ChildProcess[] = []
    const runtime = await startFixtureServer(
      ["hung-load", "semantic"],
      {},
      { markdownRendererOptions: { childFactory: recordingChildFactory(children) } }
    )
    await runtime.runtime.ensureSession("hung-load", "/show/hung-load/")
    await runtime.runtime.ensureSession("semantic", "/show/semantic/")

    await new Promise<void>((resolveDisconnect) => {
      const request = httpGet(markdownUrl(runtime.url, "hung-load"))
      request.on("error", () => undefined)
      request.once("close", resolveDisconnect)
      setTimeout(() => request.destroy(), 200).unref?.()
    })
    await vi.waitFor(() => expect(children[0]?.killed).toBe(true))

    const recovered = await fetch(markdownUrl(runtime.url, "semantic"), {
      signal: AbortSignal.timeout(5_000)
    })
    expect(recovered.status).toBe(200)
    expect(await recovered.text()).toContain("# SSR fixture report")
    expect(children).toHaveLength(2)
  }, 60_000)

  it("invalidates on workspace change and clears session entries on suspend", async () => {
    const runtime = await startFixtureServer(["semantic"])
    const url = markdownUrl(runtime.url, "semantic")
    expect((await fetch(url)).headers.get("x-avibe-render-cache")).toBe("miss")
    expect((await fetch(url)).headers.get("x-avibe-render-cache")).toBe("hit")

    const pagePath = join(runtime.workspaceRoot, "semantic", "src", "pages", "index.tsx")
    const watcher = runtime.runtime.getSession("semantic")?.vite?.watcher
    expect(watcher).toBeDefined()
    const watcherChange = new Promise<void>((resolveChange) => {
      const targetSuffix = join("src", "pages", "index.tsx")
      const listener = (changedPath: string) => {
        if (!changedPath.endsWith(targetSuffix)) return
        watcher?.off("change", listener)
        resolveChange()
      }
      watcher?.on("change", listener)
    })
    const original = await readFile(pagePath, "utf8")
    await writeFile(pagePath, original.replace(
      "The initial React tree is semantic.",
      "The initial React tree changed on disk."
    ))
    await watcherChange

    const changed = await fetch(url)
    expect(changed.status, await changed.clone().text()).toBe(200)
    expect(changed.headers.get("x-avibe-render-cache")).toBe("miss")
    expect(await changed.text()).toContain("The initial React tree changed on disk.")
    expect((await fetch(url)).headers.get("x-avibe-render-cache")).toBe("hit")

    const suspended = await fetch(`${runtime.url}/sessions/semantic/suspend`, { method: "POST" })
    expect(suspended.status).toBe(200)
    const afterSuspend = await fetch(url)
    expect(afterSuspend.status).toBe(200)
    expect(afterSuspend.headers.get("x-avibe-render-cache")).toBe("miss")
  }, 60_000)

  it("uses the 30-second TTL as a backstop without extending it on hits", async () => {
    const runtime = await startFixtureServer(["semantic"], { renderCacheTtlMs: 40 })
    const url = markdownUrl(runtime.url, "semantic")
    expect((await fetch(url)).headers.get("x-avibe-render-cache")).toBe("miss")
    expect((await fetch(url)).headers.get("x-avibe-render-cache")).toBe("hit")
    await new Promise((resolveWait) => setTimeout(resolveWait, 60))
    expect((await fetch(url)).headers.get("x-avibe-render-cache")).toBe("miss")
  }, 60_000)

  it("clears the session cache and worker state when the runtime prunes it as idle", async () => {
    const runtime = await startFixtureServer(["semantic"], { idleTtlMs: 50 })
    const url = markdownUrl(runtime.url, "semantic")
    expect((await fetch(url)).headers.get("x-avibe-render-cache")).toBe("miss")
    expect((await fetch(url)).headers.get("x-avibe-render-cache")).toBe("hit")

    const session = runtime.runtime.getSession("semantic")
    expect(session).toBeDefined()
    session!.lastAccessedAt = new Date(Date.now() - 1_000)
    expect(await runtime.runtime.pruneIdleSessions()).toMatchObject([{
      sessionId: "semantic",
      state: "idle"
    }])

    const afterPrune = await fetch(url)
    expect(afterPrune.status).toBe(200)
    expect(afterPrune.headers.get("x-avibe-render-cache")).toBe("miss")
  }, 60_000)
})

type FakeWorkerHooks = {
  load?(sessionId: string, vite: ViteDevServer): Promise<void>
  render?(sessionId: string, location: Parameters<SsrMarkdownWorker["render"]>[1]): Promise<string>
  convert?(
    sessionId: string,
    html: string,
    options: Parameters<SsrMarkdownWorker["convert"]>[2]
  ): Promise<ReturnType<typeof convertSsrRenderedHtmlToMarkdown>>
}

class FakeSsrWorker implements SsrMarkdownWorker {
  readonly loadCalls: string[] = []
  readonly renderCalls: Array<{ sessionId: string, pathname: string }> = []
  readonly convertCalls: string[] = []
  readonly invalidations: string[] = []
  terminateCount = 0

  constructor(private readonly hooks: FakeWorkerHooks = {}) {}

  async load(sessionId: string, vite: ViteDevServer): Promise<void> {
    this.loadCalls.push(sessionId)
    await this.hooks.load?.(sessionId, vite)
  }

  async render(
    sessionId: string,
    location: Parameters<SsrMarkdownWorker["render"]>[1]
  ): Promise<string> {
    this.renderCalls.push({ sessionId, pathname: location.pathname })
    return this.hooks.render
      ? await this.hooks.render(sessionId, location)
      : `<h1>${sessionId}:${location.pathname}</h1><p>${location.search || "no query"}</p>`
  }

  async convert(
    sessionId: string,
    html: string,
    options: Parameters<SsrMarkdownWorker["convert"]>[2]
  ) {
    this.convertCalls.push(sessionId)
    return this.hooks.convert
      ? await this.hooks.convert(sessionId, html, options)
      : convertSsrRenderedHtmlToMarkdown(html, options)
  }

  async invalidateSession(sessionId: string): Promise<void> {
    this.invalidations.push(sessionId)
  }

  async terminate(): Promise<void> {
    this.terminateCount += 1
  }

  async close(): Promise<void> {}
}

class StubFingerprinter implements WorkspaceFingerprinter {
  readonly versions = new Map<string, string>()
  readonly invalidations: string[] = []

  async fingerprint(sessionId: string): Promise<string> {
    return this.versions.get(sessionId) ?? "workspace-v1"
  }

  invalidateSession(sessionId: string): void {
    this.invalidations.push(sessionId)
  }

  clear(): void {}
}

async function rendererHarness(options: {
  worker?: FakeSsrWorker
  fingerprinter?: StubFingerprinter
  now?: () => number
  cacheEntriesPerSession?: number
  cacheEntriesGlobal?: number
  cacheTtlMs?: number
  loadTimeoutMs?: number
  reactTimeoutMs?: number
  conversionTimeoutMs?: number
} = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "avibe-show-renderer-unit-"))
  const watcher = new EventEmitter()
  const vite = { watcher } as unknown as ViteDevServer
  const worker = options.worker ?? new FakeSsrWorker()
  const fingerprinter = options.fingerprinter ?? new StubFingerprinter()
  const renderer = createMarkdownRenderer({
    worker,
    workspaceFingerprinter: fingerprinter,
    now: options.now,
    cacheEntriesPerSession: options.cacheEntriesPerSession,
    cacheEntriesGlobal: options.cacheEntriesGlobal,
    cacheTtlMs: options.cacheTtlMs,
    loadTimeoutMs: options.loadTimeoutMs,
    reactTimeoutMs: options.reactTimeoutMs,
    conversionTimeoutMs: options.conversionTimeoutMs,
    cacheMaintenanceIntervalMs: 10
  })
  cleanups.push(async () => {
    await renderer.close()
    await rm(workspace, { recursive: true, force: true })
  })

  const request = (
    sessionId: string,
    target: string,
    signal?: AbortSignal
  ): MarkdownRenderRequest => ({
    sessionId,
    context: "private",
    basePath: `/show/${sessionId}/`,
    target,
    workspace,
    signal,
    async prepare() {
      return {
        vite,
        internalBasePath: `/show/${sessionId}/`,
        origin: "http://127.0.0.1:4010"
      }
    }
  })
  return { renderer, request, worker, fingerprinter, watcher, workspace }
}

describe("SSR Markdown orchestrator", () => {
  it("enforces per-session and global LRU caps", async () => {
    const perSession = await rendererHarness({ cacheEntriesPerSession: 2, cacheEntriesGlobal: 10 })
    expect((await perSession.renderer.render(perSession.request("one", "/a"))).cache).toBe("miss")
    expect((await perSession.renderer.render(perSession.request("one", "/b"))).cache).toBe("miss")
    expect((await perSession.renderer.render(perSession.request("one", "/a"))).cache).toBe("hit")
    expect((await perSession.renderer.render(perSession.request("one", "/c"))).cache).toBe("miss")
    expect((await perSession.renderer.render(perSession.request("one", "/b"))).cache).toBe("miss")

    const global = await rendererHarness({ cacheEntriesPerSession: 10, cacheEntriesGlobal: 2 })
    await global.renderer.render(global.request("one", "/"))
    await global.renderer.render(global.request("two", "/"))
    await global.renderer.render(global.request("three", "/"))
    expect((await global.renderer.render(global.request("one", "/"))).cache).toBe("miss")
  })

  it("uses fingerprint recomputation and watcher events as independent invalidation signals", async () => {
    const harness = await rendererHarness()
    expect((await harness.renderer.render(harness.request("page", "/"))).cache).toBe("miss")
    expect((await harness.renderer.render(harness.request("page", "/"))).cache).toBe("hit")

    harness.fingerprinter.versions.set("page", "workspace-v2")
    expect((await harness.renderer.render(harness.request("page", "/"))).cache).toBe("miss")
    expect(harness.worker.invalidations).toContain("page")

    const priorInvalidations = harness.worker.invalidations.length
    harness.watcher.emit("change", join(harness.workspace, "src", "page.tsx"))
    await vi.waitFor(() => {
      expect(harness.worker.invalidations.length).toBeGreaterThan(priorInvalidations)
    })
    expect((await harness.renderer.render(harness.request("page", "/"))).cache).toBe("miss")
  })

  it.each(["load", "render", "conversion"] as const)(
    "hard-stops a hung %s phase with its independent deadline",
    async (phase) => {
      const never = new Promise<never>(() => undefined)
      const worker = new FakeSsrWorker({
        ...(phase === "load" ? { load: async () => await never } : {}),
        ...(phase === "render" ? { render: async () => await never } : {}),
        ...(phase === "conversion" ? { convert: async () => await never } : {})
      })
      const harness = await rendererHarness({
        worker,
        loadTimeoutMs: 25,
        reactTimeoutMs: 25,
        conversionTimeoutMs: 25
      })

      await expect(harness.renderer.render(harness.request("page", "/"))).rejects.toMatchObject({
        code: "render_timeout",
        status: 504
      })
      expect(worker.terminateCount).toBe(1)
    }
  )

  it("does not charge queue wait against a render's phase budgets", async () => {
    let releaseSlow!: () => void
    const slow = new Promise<void>((resolveSlow) => {
      releaseSlow = resolveSlow
    })
    const worker = new FakeSsrWorker({
      render: async (_sessionId, location) => {
        if (location.pathname === "/slow") await slow
        return `<h1>${location.pathname}</h1>`
      }
    })
    const harness = await rendererHarness({
      worker,
      loadTimeoutMs: 20,
      reactTimeoutMs: 200,
      conversionTimeoutMs: 20
    })

    const first = harness.renderer.render(harness.request("page", "/slow"))
    await vi.waitFor(() => expect(worker.renderCalls).toHaveLength(1))
    const queued = harness.renderer.render(harness.request("page", "/fast"))
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    releaseSlow()

    expect((await first).cache).toBe("miss")
    expect((await queued).cache).toBe("miss")
  })

  it("terminates active worker work when the request signal is cancelled", async () => {
    const never = new Promise<never>(() => undefined)
    const worker = new FakeSsrWorker({ render: async () => await never })
    const harness = await rendererHarness({ worker })
    const controller = new AbortController()
    const pending = harness.renderer.render(harness.request("page", "/", controller.signal))
    await vi.waitFor(() => expect(worker.renderCalls).toHaveLength(1))

    controller.abort(new DOMException("caller left", "AbortError"))

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(worker.terminateCount).toBe(1)
    expect(worker.convertCalls).toHaveLength(0)
  })

  it("keeps Playwright absent from package and lockfile dependencies", async () => {
    const packageJson = JSON.parse(await readFile(join(sourceDirectory, "..", "package.json"), "utf8"))
    const lockfile = JSON.parse(await readFile(join(dependencyRoot, "package-lock.json"), "utf8"))
    expect(packageJson.dependencies?.["playwright-core"]).toBeUndefined()
    expect(lockfile.packages?.["node_modules/playwright-core"]).toBeUndefined()

    const browserCache = join(await mkdtemp(join(tmpdir(), "avibe-show-no-browser-cache-")), "cache")
    cleanups.push(async () => rm(dirname(browserCache), { recursive: true, force: true }))
    await expect(access(browserCache)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

it("keeps the public error type stable", () => {
  const error = new MarkdownRenderError("render_failed", 502, "failed")
  expect(error).toMatchObject({ code: "render_failed", status: 502 })
})
