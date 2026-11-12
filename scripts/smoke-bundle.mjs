// Smoke the actual distributable, never the checkout's node_modules.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const archive = join(repoRoot, "dist", `vibe-show-runtime-node-${process.platform}-${process.arch}.tgz`)
const root = await mkdtemp(join(tmpdir(), "avibe-bundle-smoke-"))
const bundle = join(root, "bundle")
let runtime
try {
  await mkdir(bundle)
  execFileSync("tar", ["-xzf", archive, "-C", bundle], { stdio: "inherit" })
  for (const name of ["package.json", "package-lock.json"]) {
    assert.deepEqual(await readFile(join(bundle, name)), await readFile(join(repoRoot, "distribution", name)), `${name} changed during bundling`)
  }
  const require = createRequire(join(bundle, "package.json"))
  // On Windows the JS realpath preserves RUNNER~1 while Node's resolver
  // expands it to runneradmin. Compare native spellings on both sides, never
  // weaken containment or accidentally accept the checkout's dependencies.
  const realBundle = realpathSync.native(bundle)
  for (const name of ["esbuild", "lightningcss", "@tailwindcss/oxide", "vite"]) {
    const resolved = realpathSync.native(require.resolve(name))
    const path = relative(realBundle, resolved)
    assert.ok(!isAbsolute(path) && !path.startsWith(".."), `${name} escaped the extracted archive: ${resolved} (root ${realBundle})`)
  }
  const esbuild = require("esbuild")
  const transformed = await esbuild.transform("const value: number = 42", { loader: "ts" })
  assert.match(transformed.code, /value = 42/)
  const css = require("lightningcss").transform({ filename: "smoke.css", code: Buffer.from(".smoke { color: red; }") })
  assert.match(css.code.toString(), /color:/)
  const { startShowRuntimeServer } = await import(pathToFileURL(join(bundle, "packages/runtime/dist/server.js")).href)
  const workspaceRoot = join(root, "workspaces")
  const src = join(workspaceRoot, "smoke", "src")
  await mkdir(src, { recursive: true })
  await writeFile(join(src, "App.tsx"), `import { Button } from "@/components/ui/button"
export default function App() {
  return <main className="flex gap-4 p-6"><Button>Locked archive smoke</Button></main>
}
`)
  runtime = await startShowRuntimeServer({ workspaceRoot, cacheRoot: join(root, "cache") })
  const get = (path, init) => fetch(`${runtime.url}${path}`, { ...init, signal: AbortSignal.timeout(30000) })
  assert.equal((await get("/health")).status, 200)
  const ensured = await (await get("/sessions/smoke/ensure", { method: "POST" })).json()
  assert.equal(ensured.state, "active", JSON.stringify(ensured))
  const app = await get("/sessions/smoke/app/src/App.tsx")
  assert.equal(app.status, 200, await app.text())
  const styles = await get("/sessions/smoke/app/src/styles.css?direct")
  assert.equal(styles.status, 200)
  const source = await styles.text()
  for (const rule of [".flex", ".gap-4", ".p-6"]) assert.ok(source.includes(rule), `Missing native Tailwind utility ${rule}`)
  console.log("Extracted locked archive: esbuild, Lightning CSS, Tailwind oxide, runtime and shadcn page passed.")
} finally {
  await runtime?.close()
  await rm(root, { recursive: true, force: true })
}
