#!/usr/bin/env node

import { resolve } from "node:path"
import { startShowRuntimeServer } from "./server.js"

const workspaceRoot = resolve(getArg("--workspace-root") ?? ".show")
const cacheRoot = getArg("--cache-root")
const port = Number(getArg("--port") ?? "0")
const host = getArg("--host") ?? "127.0.0.1"
const fallbackDelaySeconds = numberArg("--fallback-delay-seconds")

const runtime = await startShowRuntimeServer({
  workspaceRoot,
  cacheRoot: cacheRoot ? resolve(cacheRoot) : undefined,
  host,
  port,
  fallbackDelaySeconds
})

console.log(`Vibe Show Runtime listening at ${runtime.url}`)
console.log(`Workspace root: ${workspaceRoot}`)
if (cacheRoot) {
  console.log(`Cache root: ${resolve(cacheRoot)}`)
}

process.on("SIGINT", () => {
  void runtime.close().then(() => process.exit(0))
})

process.on("SIGTERM", () => {
  void runtime.close().then(() => process.exit(0))
})

function getArg(name: string) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function numberArg(name: string) {
  const raw = getArg(name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
  return parsed
}
