import { createServer } from "node:http"
import { access, cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDirectory, "..")
const repositoryRoot = resolve(packageRoot, "../..")
const fixture = join(packageRoot, "src", "__fixtures__", "ssr-markdown", "semantic")
const workspaceRoot = await mkdtemp(join(tmpdir(), "avibe-show-ssr-benchmark-"))
const browserCache = join(workspaceRoot, "browser-cache-must-stay-absent")
process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache

const { createShowRuntime } = await import("../dist/runtime.js")
const { renderSsrMarkdown } = await import("../dist/ssr-markdown.js")

const sessionId = "semantic"
await cp(fixture, join(workspaceRoot, sessionId), { recursive: true })
const hostServer = createServer()
await new Promise((resolveListen) => hostServer.listen(0, "127.0.0.1", resolveListen))
const runtime = createShowRuntime({
  workspaceRoot,
  dependencyRoot: repositoryRoot,
  cacheRoot: join(workspaceRoot, ".vite-cache"),
  server: hostServer,
  idlePruneIntervalMs: 0
})

function collectRssMiB() {
  globalThis.gc?.()
  return process.memoryUsage().rss / 1024 / 1024
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits))
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

let report
try {
  const rssBaseline = collectRssMiB()
  const sessionStarted = performance.now()
  await runtime.ensureSession(sessionId, `/show/${sessionId}/`)
  const sessionWarmMs = performance.now() - sessionStarted
  const rssAfterSessionWarm = collectRssMiB()
  const vite = runtime.getSession(sessionId)?.vite
  if (!vite) throw new Error("Benchmark fixture did not create a Vite server")

  const firstStarted = performance.now()
  const first = await renderSsrMarkdown({
    vite,
    target: "/teams/acme?period=Q3",
    basePath: `/show/${sessionId}/`
  })
  const firstSsrMs = performance.now() - firstStarted
  const rssAfterFirstSsr = collectRssMiB()

  const warmDurations = []
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const started = performance.now()
    await renderSsrMarkdown({
      vite,
      target: "/teams/acme?period=Q3",
      basePath: `/show/${sessionId}/`
    })
    warmDurations.push(performance.now() - started)
  }
  const rssAfterWarmRuns = collectRssMiB()
  const browserCacheCreated = await access(browserCache).then(() => true).catch(() => false)

  report = {
    shape: "module-graph",
    fixture: "semantic + nested dynamic route",
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    sessionWarmMs: round(sessionWarmMs),
    firstSsrMs: round(firstSsrMs),
    firstPhaseMs: Object.fromEntries(
      Object.entries(first.timings).map(([name, value]) => [name, round(value)])
    ),
    warmSsrMs: {
      iterations: warmDurations.length,
      median: round(percentile(warmDurations, 0.5)),
      p95: round(percentile(warmDurations, 0.95)),
      min: round(Math.min(...warmDurations)),
      max: round(Math.max(...warmDurations))
    },
    rssMiB: {
      baseline: round(rssBaseline, 1),
      afterSessionWarm: round(rssAfterSessionWarm, 1),
      afterFirstSsr: round(rssAfterFirstSsr, 1),
      afterWarmRuns: round(rssAfterWarmRuns, 1),
      sessionDelta: round(rssAfterSessionWarm - rssBaseline, 1),
      firstSsrDelta: round(rssAfterFirstSsr - rssAfterSessionWarm, 1),
      warmRunsDelta: round(rssAfterWarmRuns - rssAfterFirstSsr, 1)
    },
    browserCacheCreated
  }
} finally {
  await runtime.close()
  await new Promise((resolveClose, rejectClose) => {
    hostServer.close((error) => error ? rejectClose(error) : resolveClose())
  })
  await rm(workspaceRoot, { force: true, recursive: true })
}

console.log(JSON.stringify(report, null, 2))
