import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runtimePackages as packages, stageBundlePackages, verifyBundleInputs } from "./bundle-project.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(repoRoot, "dist")
const stage = mkdtempSync(join(tmpdir(), "vibe-show-runtime-bundle-"))
const platform = runtimePlatform()
const archivePath = join(outDir, `vibe-show-runtime-node-${platform}.tgz`)

const isWindows = process.platform === "win32"

try {
  const distribution = join(repoRoot, "distribution")
  const manifest = JSON.parse(readFileSync(join(distribution, "package.json"), "utf8"))
  const lock = JSON.parse(readFileSync(join(distribution, "package-lock.json"), "utf8"))
  verifyBundleInputs(repoRoot, manifest, lock)
  stageBundlePackages(repoRoot, stage)
  for (const name of ["package.json", "package-lock.json"]) cpSync(join(distribution, name), join(stage, name))

  execFileSync("npm", ["ci", "--ignore-scripts", "--omit=dev", "--include=optional", "--install-links=false", "--no-audit", "--no-fund"], {
    cwd: stage,
    stdio: "inherit",
    shell: isWindows
  })
  assertNoNestedPackageInstalls(stage)
  assertBundleDependencyRoot(stage)
  assertNoBrowserRuntime(stage)

  mkdirSync(outDir, { recursive: true })
  rmSync(archivePath, { force: true })
  execFileSync("tar", ["-czf", archivePath, "package.json", "package-lock.json", "packages", "node_modules"], {
    cwd: stage,
    stdio: "inherit"
  })
  console.log(`Wrote ${archivePath}`)
} finally {
  rmSync(stage, { recursive: true, force: true })
}

function assertNoNestedPackageInstalls(root) {
  const nested = []
  for (const name of packages) {
    const nodeModules = join(root, "packages", name, "node_modules")
    if (existsSync(nodeModules)) {
      nested.push(nodeModules)
    }
  }
  if (nested.length) {
    throw new Error(
      `Show Runtime bundle must use one shared dependency root; unexpected nested installs: ${nested.join(", ")}`
    )
  }
}

function assertBundleDependencyRoot(root) {
  const required = [
    "react",
    "react-dom",
    "turndown",
    "turndown-plugin-gfm",
    "@avibe/show-runtime",
    "@avibe/show-ui",
    "@avibe/show-sdk"
  ]
  const missing = required.filter((name) => !existsSync(join(root, "node_modules", ...name.split("/"), "package.json")))
  if (missing.length) {
    throw new Error(`Show Runtime bundle is missing shared dependencies: ${missing.join(", ")}`)
  }
}

function assertNoBrowserRuntime(root) {
  const forbidden = ["playwright", "playwright-core", "puppeteer", "puppeteer-core"]
  const present = forbidden.filter((name) => existsSync(join(root, "node_modules", name, "package.json")))
  if (present.length) {
    throw new Error(`Show Runtime bundle contains browser automation dependencies: ${present.join(", ")}`)
  }
}

function runtimePlatform() {
  const os = process.platform
  const arch = process.arch
  const supported = new Set([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64"
  ])
  const value = `${os}-${arch}`
  if (!supported.has(value)) {
    throw new Error(`Unsupported Show Runtime bundle platform: ${value}`)
  }
  return value
}
