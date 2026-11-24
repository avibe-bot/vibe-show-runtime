import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type ViteDevServer } from "vite"
import { afterEach, expect, it } from "vitest"
import { workspaceFreshnessPlugin, workspaceWatchOptions } from "./workspace-freshness.js"

let vite: ViteDevServer | undefined
let root: string
let ws: WebSocket | undefined

afterEach(async () => {
  ws?.close()
  await vite?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

async function start(polling: boolean) {
  root = await realpath(await mkdtemp(join(tmpdir(), "show-watch-")))
  await mkdir(join(root, "src/pages"), { recursive: true })
  await writeFile(join(root, "src/pages/first.tsx"), 'export default "before"; if (import.meta.hot) import.meta.hot.accept()')
  await writeFile(join(root, "src/sheet.css"), ".before { color: red }")
  await writeFile(join(root, "src/router.ts"), 'export const pages = import.meta.glob("./pages/**/*.tsx", { eager: true }); if (import.meta.hot) import.meta.hot.accept()')
  const server = await createServer({
    configFile: false, root, base: "/show/test/", appType: "custom",
    plugins: [workspaceFreshnessPlugin([root], "test")],
    server: { host: "127.0.0.1", port: 0, watch: polling ? workspaceWatchOptions([root]) : null },
    optimizeDeps: { noDiscovery: true }
  })
  vite = server
  await server.listen()
  const address = server.httpServer!.address()
  if (typeof address !== "object" || !address) throw new Error("Missing listening port")
  return `http://127.0.0.1:${address.port}/show/test/`
}

it("serves edits, glob additions and deletes on the very next GET, with NO watcher", async () => {
  const base = await start(false)
  const page = `${base}src/pages/first.tsx`
  const router = `${base}src/router.ts`
  const first = await fetch(page)
  expect(await first.text()).toContain('"before"')
  expect(await (await fetch(router)).text()).not.toContain("second.tsx")
  const etag = first.headers.get("etag")!
  expect((await fetch(page, { headers: { "If-None-Match": etag } })).status).toBe(304)
  await writeFile(join(root, "src/pages/first.tsx"), 'export default "after!"; if (import.meta.hot) import.meta.hot.accept()')
  expect(await (await fetch(page + "?raw")).text()).toContain("after!")
  const edited = await fetch(page, { headers: { "If-None-Match": etag } })
  expect(edited.status).toBe(200)
  expect(await edited.text()).toContain('"after!"')
  await writeFile(join(root, "src/pages/second.tsx"), "export default 2")
  expect(await (await fetch(router)).text()).toContain("second.tsx")
  const css = `${base}src/sheet.css`
  const style = await fetch(css, { headers: { accept: "text/css" } })
  expect(await style.text()).toContain(".before")
  await writeFile(join(root, "src/sheet.css"), ".edited { color: red }")
  expect(await (await fetch(css, { headers: { accept: "text/css", "if-none-match": style.headers.get("etag")! } })).text()).toContain(".edited")
  await rm(join(root, "src/pages/first.tsx"))
  expect(await (await fetch(router)).text()).not.toContain("first.tsx")
  expect((await fetch(page)).status).toBe(404)
})

// Node 20's built-in WebSocket is behind a flag; the CI Node 22 matrix runs
// the real socket case. No event injection: the only change signal is polling.
it.skipIf(typeof WebSocket === "undefined")("an open HMR client sees edits and page membership changes via polling", async () => {
  const base = await start(true)
  const client = await (await fetch(`${base}@vite/client`)).text()
  const token = client.match(/const wsToken = "([^"]+)"/)?.[1]
  expect(token).toBeTruthy()
  ws = new WebSocket(`${base.replace("http:", "ws:")}?token=${token}`, "vite-hmr")
  const messages: Array<{ type: string; updates?: Array<{ path: string }> }> = []
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))))
  await expect.poll(() => messages.some((msg) => msg.type === "connected")).toBe(true)
  await (await fetch(`${base}src/router.ts`)).text()
  await (await fetch(`${base}src/pages/first.tsx`)).text()
  async function expectUpdate(path: string, change: () => Promise<void>) {
    messages.length = 0
    await change()
    await expect.poll(() => messages.some((m) => m.type === "update" && m.updates?.some((u) => u.path === path)), { timeout: 8_000 }).toBe(true)
  }
  await expectUpdate("/src/pages/first.tsx", () => writeFile(join(root, "src/pages/first.tsx"), 'export default "edited"; if (import.meta.hot) import.meta.hot.accept()'))
  await expectUpdate("/src/router.ts", () => writeFile(join(root, "src/pages/second.tsx"), "export default 2"))
  expect(await (await fetch(`${base}src/router.ts`)).text()).toContain("second.tsx")
  await expectUpdate("/src/router.ts", () => rm(join(root, "src/pages/second.tsx")))
  expect(await (await fetch(`${base}src/router.ts`)).text()).not.toContain("second.tsx")
}, 30_000)
