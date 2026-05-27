import { resolve } from "node:path"
import { startShowRuntimeServer } from "./server.js"

const workspaceRoot = resolve(getArg("--workspace-root") ?? ".show")
const port = Number(getArg("--port") ?? "0")
const host = getArg("--host") ?? "127.0.0.1"

const runtime = await startShowRuntimeServer({
  workspaceRoot,
  host,
  port
})

console.log(`Vibe Show Runtime listening at ${runtime.url}`)
console.log(`Workspace root: ${workspaceRoot}`)

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
