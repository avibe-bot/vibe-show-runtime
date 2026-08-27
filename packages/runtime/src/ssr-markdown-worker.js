import { parentPort } from "node:worker_threads"
import { ModuleRunner } from "vite/module-runner"
import { convertSsrRenderedHtmlToMarkdown } from "./ssr-markdown-conversion.js"
import { SsrSandboxEvaluator } from "./ssr-markdown-sandbox.js"

if (!parentPort) throw new Error("The SSR Markdown worker requires a parent port")
const port = parentPort

/** @typedef {{ runner: ModuleRunner, evaluator: SsrSandboxEvaluator, generation: number, entry?: Record<string, unknown> }} SessionState */
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
        const evaluator = new SsrSandboxEvaluator(`avibe-show-ssr:${command.sessionId}`)
        state = {
          generation: command.generation,
          evaluator,
          runner: new ModuleRunner({
            transport: createParentTransport(command.sessionId, command.generation),
            createImportMeta: (modulePath) => evaluator.createImportMeta(modulePath),
            hmr: false,
            sourcemapInterceptor: false
          }, evaluator)
        }
        sessions.set(command.sessionId, state)
      }
      const entry = await state.runner.import(command.entryId)
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.render !== "function"
      ) {
        throw new Error("The Show Page SSR entry is incomplete")
      }
      state.entry = entry
      return undefined
    }
    case "render": {
      const state = sessionState(command)
      return state.entry.render(state.evaluator.cloneJson(command.location))
    }
    case "convert": {
      sessionState(command)
      return convertSsrRenderedHtmlToMarkdown(command.html, command.options)
    }
    case "invalidate": {
      const state = sessions.get(command.sessionId)
      sessions.delete(command.sessionId)
      await state?.runner.close()
      state?.evaluator.dispose()
      return undefined
    }
    case "close": {
      const closing = [...sessions.values()].map(({ runner }) => runner.close())
      for (const { evaluator } of sessions.values()) evaluator.dispose()
      sessions.clear()
      await Promise.allSettled(closing)
      return undefined
    }
    default:
      throw new Error(`Unknown SSR Markdown worker command: ${String(command.name)}`)
  }
}

/** @param {Record<string, any>} command */
function sessionState(command) {
  const state = sessions.get(command.sessionId)
  if (!state || state.generation !== command.generation || !state.entry) {
    throw new Error("The Show Page SSR entry is not loaded")
  }
  return /** @type {SessionState & { entry: Record<string, Function> }} */ (state)
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
  if (!value || typeof value !== "object") {
    return { name: "Error", message: String(value) }
  }
  const error = /** @type {Record<string, any>} */ (value)
  const code = "code" in value && typeof value.code === "string" ? value.code : undefined
  const status = "status" in value && typeof value.status === "number" ? value.status : undefined
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code,
    status
  }
}
