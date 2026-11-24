import { access, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"
import { startShowRuntimeServer } from "./server.js"
import { workspaceSnapshot } from "./workspace-freshness.js"

const dependencyRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
let server: Awaited<ReturnType<typeof startShowRuntimeServer>> | undefined
let temp: string
let ws: WebSocket | undefined

afterEach(async () => {
  ws?.close()
  await server?.close()
  server = undefined
  ws = undefined
  if (temp) await rm(temp, { recursive: true, force: true })
})

it("keeps cached HTTP/ETags, route membership and an open HMR client current with native watching disabled", async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "show-watch-")))
  const root = join(temp, "workspaces/test")
  const src = join(root, "src")
  await mkdir(join(src, "pages"), { recursive: true })
  const first = join(src, "pages/first.tsx")
  const pageSource = (s: string) => `export default "${s}"; if (import.meta.hot) import.meta.hot.accept()`
  await writeFile(first, pageSource("before"))
  await writeFile(join(src, "App.tsx"), 'export default function App() { return null }')
  await writeFile(join(src, "router.ts"), 'export const pages = import.meta.glob("./pages/**/*.tsx", { eager: true })')
  await writeFile(join(src, "lazy.ts"), 'export const load = (name: string) => import(`./pages/${name}.tsx`)')
  await writeFile(join(src, "sheet.css"), '@import "./theme.css";')
  await writeFile(join(src, "theme.css"), ".before { color: red }")
  await mkdir(join(root, "public"))
  await writeFile(join(root, "public/asset.txt"), "unchanged")
  await writeFile(join(root, "public/widget.js"), "window.widget = 1")
  // A root symlink must still be scanned, but never descend into nested links.
  const workspaceRoot = join(temp, "linked")
  await symlink(join(temp, "workspaces"), workspaceRoot, process.platform === "win32" ? "junction" : "dir")
  server = await startShowRuntimeServer({ workspaceRoot, dependencyRoot, cacheRoot: join(temp, "cache") })
  const base = `${server.url}/sessions/test/app/`
  const get = (path: string, headers?: Record<string, string>) => fetch(base + path, { headers })
  const page = "src/pages/first.tsx"
  const original = await get(page)
  const etag = original.headers.get("etag")!
  expect(await original.text()).toContain('"before"')
  expect(server.runtime.getSession("test")!.vite!.config.server.watch).toBeNull()
  expect((await get(page, { "If-None-Match": etag })).status).toBe(304)
  await writeFile(first, pageSource("after!"))
  const edited = await get(page, { "If-None-Match": etag })
  expect(edited.status).toBe(200)
  expect(await edited.text()).toContain('"after!"')
  await writeFile(first, pageSource("again!"))
  expect(await (await get(`@fs/${first.replaceAll("\\", "/")}`)).text()).toContain('"again!"')
  expect(await (await get(page + "?raw")).text()).toContain("again!")
  const style = await get("src/sheet.css", { accept: "text/css" })
  expect(await style.text()).toContain(".before")
  await writeFile(join(src, "theme.css"), ".edited { color: red }")
  expect(await (await get("src/sheet.css", { accept: "text/css", "if-none-match": style.headers.get("etag")! })).text()).toContain(".edited")
  expect(await (await get("asset.txt?discount=50%")).text()).toBe("unchanged")

  const messages: Array<{ type: string; updates?: Array<{ path: string }> }> = []
  // Node 20's WebSocket is behind a flag; all three Node 22 CI jobs exercise it.
  async function connect() {
    if (typeof WebSocket === "undefined") return
    const client = await (await get("@vite/client")).text()
    const token = client.match(/const wsToken = "([^"]+)"/)?.[1]
    expect(token).toBeTruthy()
    const vite = server!.runtime.getSession("test")!.vite!
    ws = new WebSocket(`${server!.url.replace("http:", "ws:")}${vite.config.base}__vite_hmr?token=${token}`, "vite-hmr")
    messages.length = 0
    ws.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data))))
    await expect.poll(() => messages.some((m) => m.type === "connected")).toBe(true)
  }
  await connect()
  await (await get("widget.js")).text()
  await writeFile(join(root, "public/widget.js"), "window.widget = 2")
  if (ws) await expect.poll(() => messages.some((m) => m.type === "full-reload"), { timeout: 8_000 }).toBe(true)
  messages.length = 0
  // Same size, older mtime, atomic rename: Chokidar polling misses this save.
  await writeFile(join(temp, "replacement"), pageSource("final!"))
  await utimes(join(temp, "replacement"), 1_000, 1_000)
  await rename(join(temp, "replacement"), first)
  if (ws) await expect.poll(() => messages.some((m) => m.type === "full-reload" || m.updates?.some((u) => u.path === "/src/pages/first.tsx")), { timeout: 8_000 }).toBe(true)
  expect(await (await get(page)).text()).toContain('"final!"')
  await connect() // A preserved-mtime replacement starts a new Vite generation.
  for (const router of ["src/router.ts", "src/lazy.ts"]) expect(await (await get(router)).text()).not.toContain("second.tsx")
  messages.length = 0
  await writeFile(join(src, "pages/second.tsx"), "export default 2")
  if (ws) await expect.poll(() => messages.some((m) => m.type === "full-reload"), { timeout: 8_000 }).toBe(true)
  for (const router of ["src/router.ts", "src/lazy.ts"]) expect(await (await get(router)).text()).toContain("second.tsx")
  await rm(first)
  expect(await (await get("src/router.ts")).text()).not.toContain("first.tsx")
  expect((await get(page)).status).toBe(404)
  // Weak static validators based only on mtime and size must not produce 304.
  const asset = join(root, "public/asset.txt")
  await utimes(asset, 1000, 1000)
  const before = await get("asset.txt")
  expect(await before.text()).toBe("unchanged")
  expect((await get("asset.txt", { "if-none-match": before.headers.get("etag")! })).status).toBe(304)
  await writeFile(asset, "modified!")
  await utimes(asset, 1000, 1000)
  expect(await (await get("asset.txt", { "if-none-match": before.headers.get("etag")! })).text()).toBe("modified!")
  // One live refresh; racing ensure calls must not re-scaffold the deleted file.
  const config = join(src, "show-runtime-config.ts")
  await rm(config)
  const invalidConfig = join(root, "vite.config.mjs")
  await writeFile(invalidConfig, "export default !")
  expect((await get("asset.txt")).status).toBe(500)
  await rm(invalidConfig)
  const session = server.runtime.getSession("test")!
  const generations = await Promise.all([1, 2, 3].map(async () => {
    await server!.runtime.ensureSession("test", session.basePath)
    return session.vite
  }))
  expect(new Set(generations).size).toBe(1)
  await expect(access(config)).rejects.toMatchObject({ code: "ENOENT" })
  await writeFile(config, "// restored by the author")
  // Resolver metadata and env/config are generation inputs, not modules.
  const pkg = join(src, "pkg")
  await mkdir(pkg)
  await writeFile(join(pkg, "a.js"), 'export default "pkgA"')
  await writeFile(join(pkg, "b.js"), 'export default "pkgB"')
  await writeFile(join(pkg, "package.json"), '{"main":"a.js"}')
  expect(await (await get("src/pkg")).text()).toContain("pkgA")
  await writeFile(join(pkg, "package.json"), '{"main":"b.js"}')
  expect(await (await get("src/pkg")).text()).toContain("pkgB")
  await writeFile(join(src, "env.ts"), "export default import.meta.env.VITE_SHOW_FRESH_FIXTURE")
  await writeFile(join(root, ".env"), "VITE_SHOW_FRESH_FIXTURE=alpha")
  expect(await (await get("src/env.ts")).text()).toContain("alpha")
  await writeFile(join(root, ".env"), "VITE_SHOW_FRESH_FIXTURE=bravo")
  expect(await (await get("src/env.ts")).text()).toContain("bravo")
  const css = join(src, "styles.css")
  const prefix = await readFile(css, "utf8")
  await writeFile(css, prefix + "\n.precise { color: red }")
  const red = await get("src/styles.css", { accept: "text/css" })
  expect(await red.text()).toContain(".precise")
  await writeFile(css, prefix + "\n.updated { color: red }")
  await utimes(css, 1000, 1000)
  expect(await (await get("src/styles.css", { accept: "text/css", "if-none-match": red.headers.get("etag")! })).text()).toContain(".updated")
  if (process.platform !== "win32") {
    const unreadable = join(root, "unreadable")
    await mkdir(unreadable)
    await chmod(unreadable, 0)
    try { expect(await (await get("asset.txt")).text()).toBe("modified!") }
    finally { await chmod(unreadable, 0o700) }
    await symlink("pages/second.tsx", join(src, "alias.tsx"))
    expect(await (await get("src/alias.tsx")).text()).toContain("default 2")
    await rm(join(src, "alias.tsx"))
    await symlink("App.tsx", join(src, "alias.tsx"))
    expect(await (await get("src/alias.tsx")).text()).toContain("function App()")
  }
}, 90_000)

it("does not scan dependencies, caches, generated output, or external directory links", async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "show-watch-scope-")))
  const root = join(temp, "workspace")
  for (const dir of ["node_modules/pkg", "src/dist", "build", ".git", ".vite-cache/old/deps", "custom-cache/active"]) {
    await mkdir(join(root, dir), { recursive: true })
    await writeFile(join(root, dir, "ignored.js"), "ignored")
  }
  await mkdir(join(temp, "outside"))
  await writeFile(join(temp, "outside/hidden.js"), "ignored")
  await symlink(join(temp, "outside"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir")
  expect([...(await workspaceSnapshot(root, join(root, "custom-cache"))).keys()].map((s) => basename(s))).toEqual(["alias"])
})
