import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(repoRoot, "dist")
const stage = mkdtempSync(join(tmpdir(), "vibe-show-runtime-bundle-"))
const platform = runtimePlatform()
const archivePath = join(outDir, `vibe-show-runtime-node-${platform}.tgz`)

const packages = ["runtime", "ui", "sdk"]
const isWindows = process.platform === "win32"

try {
  mkdirSync(join(stage, "packages"), { recursive: true })
  for (const name of packages) {
    const source = join(repoRoot, "packages", name)
    const target = join(stage, "packages", name)
    const dist = join(source, "dist")
    if (!existsSync(dist)) {
      throw new Error(`Missing built package: ${dist}. Run npm run build first.`)
    }
    mkdirSync(target, { recursive: true })
    cpSync(join(source, "package.json"), join(target, "package.json"))
    cpSync(dist, join(target, "dist"), { recursive: true })
  }

  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@avibe/show-runtime": "file:./packages/runtime",
          "@avibe/show-ui": "file:./packages/ui",
          "@avibe/show-sdk": "file:./packages/sdk",
          "@vitejs/plugin-react": "^5.1.1",
          react: "^19.2.0",
          "react-dom": "^19.2.0",
          vite: "^7.2.4"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  )

  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: stage,
    stdio: "inherit",
    shell: isWindows
  })

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
