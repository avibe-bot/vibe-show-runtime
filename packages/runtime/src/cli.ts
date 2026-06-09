#!/usr/bin/env node

import { resolve } from "node:path"
import { startShowRuntimeServer } from "./server.js"
import { buildVendor } from "./vendor.js"

const command = subcommand()

if (command === "build-vendor") {
  await runBuildVendor()
} else {
  await runServer()
}

async function runBuildVendor() {
  const dependencyRoot = resolve(getArg("--dependency-root") ?? ".")
  const outDir = resolve(getArg("--out-dir") ?? "dist-vendor")
  const uiPackageName = getArg("--ui-package-name")
  const result = await buildVendor({ dependencyRoot, outDir, uiPackageName })
  console.log(`Vendor bundle written to ${result.outDir}`)
  console.log(`Manifest: ${result.manifestPath}`)
  console.log(`Bundle hash: ${result.manifest.hash}`)
  console.log(`Specifiers: ${result.manifest.specifiers.length}, output files: ${result.outputFiles.length}`)
}

async function runServer() {
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
}

function subcommand() {
  const first = process.argv[2]
  if (first && !first.startsWith("-")) {
    return first
  }
  return undefined
}

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
