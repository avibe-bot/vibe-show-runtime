import { execFile, fork } from "node:child_process"
import { access, cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"
import { promisify } from "node:util"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDirectory, "..")
const repositoryRoot = resolve(packageRoot, "../..")
const fixture = join(packageRoot, "src", "__fixtures__", "ssr-markdown", "semantic")
const workspaceRoot = await mkdtemp(join(tmpdir(), "avibe-show-ssr-benchmark-"))
const browserCache = join(workspaceRoot, "browser-cache-must-stay-absent")
const previousBrowserCache = process.env.PLAYWRIGHT_BROWSERS_PATH
process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache
const activeChildren = new Set()
const execFileAsync = promisify(execFile)

const { startShowRuntimeServer } = await import("../dist/server.js")

const sessionId = "semantic"
const phaseTimings = []
await cp(fixture, join(workspaceRoot, sessionId), { recursive: true })
const runtime = await startShowRuntimeServer({
  workspaceRoot,
  dependencyRoot: repositoryRoot,
  cacheRoot: join(workspaceRoot, ".vite-cache"),
  idlePruneIntervalMs: 0
}, {
  markdownRendererOptions: {
    childFactory(modulePath, args, options) {
      const child = fork(modulePath, args, options)
      activeChildren.add(child)
      child.once("exit", () => activeChildren.delete(child))
      return child
    },
    onPhaseTiming(timing) {
      phaseTimings.push(timing)
    }
  }
})

async function collectRssMiB() {
  globalThis.gc?.()
  const pids = [process.pid, ...[...activeChildren]
    .map((child) => child.pid)
    .filter((pid) => pid !== undefined)]
  if (process.platform === "win32") return process.memoryUsage().rss / 1024 / 1024
  const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", pids.join(",")])
  const totalKiB = stdout.trim().split(/\s+/).reduce((total, value) => {
    const rss = Number(value)
    return Number.isFinite(rss) ? total + rss : total
  }, 0)
  return totalKiB / 1024
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits))
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

function latencySummary(values) {
  return {
    iterations: values.length,
    median: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values))
  }
}

function phaseSummary(samples) {
  return Object.fromEntries(["load", "render", "conversion"].map((phase) => {
    const values = samples
      .filter((sample) => sample.phase === phase)
      .map((sample) => sample.durationMs)
    return [phase, values.length ? latencySummary(values) : undefined]
  }))
}

async function render(target, expectedCache) {
  const phaseOffset = phaseTimings.length
  const started = performance.now()
  const response = await fetch(`${runtime.url}/sessions/${sessionId}/render-markdown`, {
    headers: {
      "x-avibe-show-protocol": "1",
      "x-avibe-show-context": "private",
      "x-vibe-show-base": `/show/${sessionId}/`,
      "x-vibe-show-target": target
    }
  })
  const markdown = await response.text()
  const durationMs = performance.now() - started
  if (!response.ok) {
    throw new Error(`Benchmark render failed (${response.status}): ${markdown}`)
  }
  const cache = response.headers.get("x-avibe-render-cache")
  if (cache !== expectedCache) {
    throw new Error(`Expected cache ${expectedCache}, received ${String(cache)}`)
  }
  return {
    durationMs,
    phaseTimings: phaseTimings.slice(phaseOffset),
    markdownBytes: Buffer.byteLength(markdown, "utf8")
  }
}

let report
try {
  const rssBaseline = await collectRssMiB()
  const cold = await render("/teams/acme?period=Q3&benchmark=cold", "miss")
  const rssAfterCold = await collectRssMiB()

  const warmMisses = []
  for (let iteration = 0; iteration < 20; iteration += 1) {
    warmMisses.push(await render(
      `/teams/acme?period=Q3&benchmark=warm-${iteration}`,
      "miss"
    ))
  }
  const rssAfterWarmMisses = await collectRssMiB()

  const cacheHits = []
  const cachedTarget = "/teams/acme?period=Q3&benchmark=warm-19"
  for (let iteration = 0; iteration < 20; iteration += 1) {
    cacheHits.push(await render(cachedTarget, "hit"))
  }
  const rssAfterCacheHits = await collectRssMiB()
  const browserCacheCreated = await access(browserCache).then(() => true).catch(() => false)

  report = {
    shape: "module-graph",
    path: "startShowRuntimeServer render-markdown endpoint",
    fixture: "semantic + nested dynamic route",
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    coldRequestMs: round(cold.durationMs),
    coldPhaseMs: Object.fromEntries(cold.phaseTimings.map(({ phase, durationMs }) => [
      phase,
      round(durationMs)
    ])),
    markdownBytes: cold.markdownBytes,
    warmMissMs: latencySummary(warmMisses.map(({ durationMs }) => durationMs)),
    warmMissPhaseMs: phaseSummary(warmMisses.flatMap(({ phaseTimings: samples }) => samples)),
    cacheHitMs: latencySummary(cacheHits.map(({ durationMs }) => durationMs)),
    rssScope: process.platform === "win32"
      ? "runtime parent process"
      : "runtime parent plus active SSR child processes",
    rssMiB: {
      baseline: round(rssBaseline, 1),
      afterCold: round(rssAfterCold, 1),
      afterWarmMisses: round(rssAfterWarmMisses, 1),
      afterCacheHits: round(rssAfterCacheHits, 1),
      coldDelta: round(rssAfterCold - rssBaseline, 1),
      warmMissDelta: round(rssAfterWarmMisses - rssAfterCold, 1),
      cacheHitDelta: round(rssAfterCacheHits - rssAfterWarmMisses, 1)
    },
    browserCacheCreated
  }
} finally {
  await runtime.close()
  if (previousBrowserCache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
  else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowserCache
  await rm(workspaceRoot, { force: true, recursive: true })
}

console.log(JSON.stringify(report, null, 2))
