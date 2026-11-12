// Maintenance-only resolver. Release bundling never calls this script.
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { bundleManifest, stageBundlePackages, verifyBundleInputs } from "./bundle-project.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const distribution = join(repoRoot, "distribution")
const stage = mkdtempSync(join(tmpdir(), "avibe-show-lock-"))
try {
  stageBundlePackages(repoRoot, stage, { built: false })
  const manifest = bundleManifest(repoRoot)
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  // Seed from the reviewed source lock, not today's registry ranges. npm
  // normalizes/prunes it for the distribution graph in this maintenance step.
  const seed = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"))
  seed.name = manifest.name
  delete seed.version
  seed.packages[""] = { name: manifest.name, dependencies: manifest.dependencies, engines: manifest.engines }
  for (const [path, entry] of Object.entries(seed.packages)) {
    if (path.startsWith("examples/") || entry.resolved?.startsWith("examples/")) delete seed.packages[path]
  }
  writeFileSync(join(stage, "package-lock.json"), `${JSON.stringify(seed, null, 2)}\n`)
  // A clean node_modules-free stage retains all optional platforms in the
  // lock, rather than accidentally recording only the maintainer's machine.
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--include=optional", "--install-links=false", "--no-audit", "--no-fund"], {
    cwd: stage,
    stdio: "inherit",
    shell: process.platform === "win32"
  })
  verifyBundleInputs(repoRoot, manifest, JSON.parse(readFileSync(join(stage, "package-lock.json"), "utf8")))
  mkdirSync(distribution, { recursive: true })
  for (const name of ["package.json", "package-lock.json"]) cpSync(join(stage, name), join(distribution, name))
  console.log("Updated distribution/package{,-lock}.json. Review and commit both before bundling.")
} finally {
  rmSync(stage, { recursive: true, force: true })
}
