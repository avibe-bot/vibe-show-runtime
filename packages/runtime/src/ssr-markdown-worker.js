import { parentPort } from "node:worker_threads"
import {
  ModuleRunner,
  createNodeImportMeta
} from "vite/module-runner"

if (!parentPort) throw new Error("The SSR Markdown worker requires a parent port")
const port = parentPort

/** @typedef {{ runner: ModuleRunner, generation: number, entry?: Record<string, unknown> }} SessionState */
/** @type {Map<string, SessionState>} */
const sessions = new Map()
/** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
const pendingRpc = new Map()
let nextRpcId = 1

port.on("message", (message) => {
  if (!message || typeof message !== "object") return
  if (message.type === "vite-rpc-result") {
    settleRpc(message)
    return
  }
  if (message.type !== "command") return
  void executeCommand(message).then(
    (result) => port.postMessage({
      type: "command-result",
      requestId: message.requestId,
      result
    }),
    (error) => port.postMessage({
      type: "command-result",
      requestId: message.requestId,
      error: serializeError(error)
    })
  )
})

/** @param {Record<string, any>} command */
async function executeCommand(command) {
  switch (command.name) {
    case "load": {
      let state = sessions.get(command.sessionId)
      if (state?.generation !== command.generation) {
        await state?.runner.close()
        state = undefined
        sessions.delete(command.sessionId)
      }
      if (!state) {
        state = {
          generation: command.generation,
          runner: new ModuleRunner({
            transport: createParentTransport(command.sessionId, command.generation),
            createImportMeta: createNodeImportMeta,
            hmr: false,
            sourcemapInterceptor: false
          })
        }
        sessions.set(command.sessionId, state)
      }
      const entry = await state.runner.import(command.entryId)
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.render !== "function" ||
        typeof entry.convert !== "function"
      ) {
        throw new Error("The Show Page SSR entry is incomplete")
      }
      state.entry = entry
      return undefined
    }
    case "render": {
      const entry = sessionEntry(command)
      return entry.render(command.location)
    }
    case "convert": {
      const entry = sessionEntry(command)
      return entry.convert(command.html, command.options)
    }
    case "invalidate": {
      const state = sessions.get(command.sessionId)
      sessions.delete(command.sessionId)
      await state?.runner.close()
      return undefined
    }
    case "close": {
      const closing = [...sessions.values()].map(({ runner }) => runner.close())
      sessions.clear()
      await Promise.allSettled(closing)
      return undefined
    }
    default:
      throw new Error(`Unknown SSR Markdown worker command: ${String(command.name)}`)
  }
}

/** @param {Record<string, any>} command */
function sessionEntry(command) {
  const state = sessions.get(command.sessionId)
  if (!state || state.generation !== command.generation || !state.entry) {
    throw new Error("The Show Page SSR entry is not loaded")
  }
  return /** @type {Record<string, Function>} */ (state.entry)
}

/** @param {string} sessionId @param {number} generation */
function createParentTransport(sessionId, generation) {
  return {
    /** @param {Parameters<NonNullable<import("vite/module-runner").ModuleRunnerTransport["invoke"]>>[0]} payload */
    invoke(payload) {
      const rpcId = nextRpcId++
      return new Promise((resolve, reject) => {
        pendingRpc.set(rpcId, { resolve, reject })
        port.postMessage({
          type: "vite-rpc",
          rpcId,
          sessionId,
          generation,
          payload
        })
      })
    }
  }
}

/** @param {Record<string, any>} message */
function settleRpc(message) {
  const pending = pendingRpc.get(message.rpcId)
  if (!pending) return
  pendingRpc.delete(message.rpcId)
  pending.resolve(message.response)
}

/** @param {unknown} value */
function serializeError(value) {
  if (!(value instanceof Error)) {
    return { name: "Error", message: String(value) }
  }
  const code = "code" in value && typeof value.code === "string" ? value.code : undefined
  const status = "status" in value && typeof value.status === "number" ? value.status : undefined
  return {
    name: value.name,
    message: value.message,
    stack: value.stack,
    code,
    status
  }
}
