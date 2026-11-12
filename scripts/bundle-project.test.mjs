import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { bundleManifest, runtimePackages, stageBundlePackages, verifyBundleInputs } from "./bundle-project.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(readFileSync(join(repoRoot, "distribution/package.json"), "utf8"))
const lock = JSON.parse(readFileSync(join(repoRoot, "distribution/package-lock.json"), "utf8"))

test("committed distribution inputs match the source and contain all supported native platforms", () => {
  verifyBundleInputs(repoRoot, manifest, lock)
  assert.deepEqual(manifest, bundleManifest(repoRoot))
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]) {
    const nativePlatform = platform.startsWith("linux-") ? `${platform}-gnu` : platform.startsWith("win32-") ? `${platform}-msvc` : platform
    for (const name of [`@esbuild/${platform}`, `@tailwindcss/oxide-${nativePlatform}`, `lightningcss-${nativePlatform}`]) {
      const entry = lock.packages[`node_modules/${name}`]
      assert.ok(entry?.optional && entry.integrity, `Missing optional platform package ${name}`)
    }
  }
  for (const name of ["typescript", "vitest", "playwright", "playwright-core", "puppeteer"]) {
    assert.equal(lock.packages[`node_modules/${name}`], undefined, `Unexpected production dependency ${name}`)
  }
})

for (const change of ["root", "link", "metadata", "integrity", "git", "unowned-bundle"]) {
  test(`stale or unpinned ${change} fails before install`, () => {
    const changedManifest = structuredClone(manifest)
    const changedLock = structuredClone(lock)
    if (change === "root") changedManifest.dependencies.react = "999.0.0"
    if (change === "link") changedLock.packages["node_modules/@avibe/show-runtime"].resolved = "../../outside"
    if (change === "metadata") changedLock.packages["packages/runtime"].dependencies.vite = "*"
    if (change === "integrity") delete changedLock.packages["node_modules/esbuild"].integrity
    if (change === "git") changedLock.packages["node_modules/esbuild"].resolved = "git+https://example.invalid/esbuild"
    if (change === "unowned-bundle") changedLock.packages["node_modules/unpinned"] = { version: "1.0.0", inBundle: true }
    assert.throws(() => verifyBundleInputs(repoRoot, changedManifest, changedLock), /npm run lock:bundle/)
  })
}

test("linked source requirement changes invalidate the distribution lock", () => {
  const root = mkdtempSync(join(tmpdir(), "avibe-bundle-source-test-"))
  try {
    for (const name of ["package.json", "package-lock.json"]) cpSync(join(repoRoot, name), join(root, name))
    stageBundlePackages(repoRoot, root, { built: false })
    const sourcePath = join(root, "packages/runtime/package.json")
    const source = JSON.parse(readFileSync(sourcePath, "utf8"))
    source.dependencies.extra = "^1.0.0"
    writeFileSync(sourcePath, JSON.stringify(source))
    assert.throws(() => verifyBundleInputs(root, manifest, lock), /packages\/runtime dependencies/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("source-lock transitive security updates cannot leave the distribution on older artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "avibe-bundle-lock-test-"))
  try {
    cpSync(join(repoRoot, "package.json"), join(root, "package.json"))
    stageBundlePackages(repoRoot, root, { built: false })
    const source = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"))
    source.packages["node_modules/turndown"].version = "999.0.0"
    writeFileSync(join(root, "package-lock.json"), JSON.stringify(source))
    assert.throws(() => verifyBundleInputs(root, manifest, lock), /source dependency node_modules\/turndown/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("package staging copies only manifests and built output, never source-owned install configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "avibe-bundle-stage-test-"))
  const stage = join(root, "stage")
  try {
    for (const name of runtimePackages) {
      const source = join(root, "source/packages", name)
      mkdirSync(join(source, "dist"), { recursive: true })
      writeFileSync(join(source, "package.json"), "{}\n")
      writeFileSync(join(source, "dist/index.js"), "export {}\n")
      writeFileSync(join(source, ".npmrc"), "ignore-scripts=false\n")
      writeFileSync(join(source, "source.ts"), "not a bundle input")
    }
    stageBundlePackages(join(root, "source"), stage)
    for (const name of runtimePackages) {
      assert.equal(readFileSync(join(stage, "packages", name, "dist/index.js"), "utf8"), "export {}\n")
      assert.throws(() => readFileSync(join(stage, "packages", name, ".npmrc")), { code: "ENOENT" })
      assert.throws(() => readFileSync(join(stage, "packages", name, "source.ts")), { code: "ENOENT" })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
