import { mkdir, mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"
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
  // Same size, older mtime, atomic rename: Chokidar polling misses this save.
  await writeFile(join(temp, "replacement"), pageSource("final!"))
  await utimes(join(temp, "replacement"), 1_000, 1_000)
  await rename(join(temp, "replacement"), first)
  if (ws) await expect.poll(() => messages.some((m) => m.type === "full-reload" || m.updates?.some((u) => u.path === "/src/pages/first.tsx")), { timeout: 8_000 }).toBe(true)
  expect(await (await get(page)).text()).toContain('"final!"')
  for (const router of ["src/router.ts", "src/lazy.ts"]) expect(await (await get(router)).text()).not.toContain("second.tsx")
  messages.length = 0
  await writeFile(join(src, "pages/second.tsx"), "export default 2")
  if (ws) await expect.poll(() => messages.some((m) => m.type === "full-reload"), { timeout: 8_000 }).toBe(true)
  for (const router of ["src/router.ts", "src/lazy.ts"]) expect(await (await get(router)).text()).toContain("second.tsx")
  await rm(first)
  expect(await (await get("src/router.ts")).text()).not.toContain("first.tsx")
  expect((await get(page)).status).toBe(404)
  if (process.platform !== "win32") {
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
