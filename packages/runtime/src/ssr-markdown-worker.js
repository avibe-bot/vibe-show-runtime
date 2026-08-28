import { readFileSync } from "node:fs"
import { ModuleRunner } from "vite/module-runner"
import { convertSsrRenderedHtmlToMarkdown } from "./ssr-markdown-conversion.js"
import { SsrSandboxEvaluator } from "./ssr-markdown-sandbox.js"

if (!process.send) throw new Error("The SSR Markdown worker requires an IPC channel")

/** @typedef {{ runner: ModuleRunner, evaluator: SsrSandboxEvaluator, generation: number, entry?: Record<string, unknown> }} SessionState */
/** @type {Map<string, SessionState>} */
const sessions = new Map()
/** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
const pendingRpc = new Map()
/** @type {{ sessionId: string, generation: number, pending: Set<Promise<unknown>> } | undefined} */
let activeWorkspaceCommand
let nextRpcId = 1

if (permissionSelfCheck(process.argv[2])) {
  process.on("message", (message) => {
    if (!message || typeof message !== "object") return
    const record = /** @type {Record<string, any>} */ (message)
    if (record.type === "vite-rpc-result") {
      settleRpc(record)
      return
    }
    if (record.type !== "command") return
    void executeCommand(record).then(
      (result) => send({
        type: "command-result",
        requestId: record.requestId,
        result
      }),
      (error) => send({
        type: "command-result",
        requestId: record.requestId,
        error: serializeError(error)
      })
    )
  })
  process.once("disconnect", () => {
    void closeSessions().finally(() => process.exit(0))
  })
  send({ type: "ready" })
}

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
      const entry = await runWorkspaceCommand(
        command,
        state.evaluator,
        () => state.runner.import(command.entryId)
      )
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
      return runWorkspaceCommand(
        command,
        state.evaluator,
        () => state.entry.render(state.evaluator.cloneJson(command.location))
      )
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
      await closeSessions()
      return undefined
    }
    default:
      throw new Error(`Unknown SSR Markdown worker command: ${String(command.name)}`)
  }
}

/**
 * @template T
 * @param {Record<string, any>} command
 * @param {SsrSandboxEvaluator} evaluator
 * @param {() => T | Promise<T>} operation
 * @returns {Promise<T>}
 */
async function runWorkspaceCommand(command, evaluator, operation) {
  if (activeWorkspaceCommand) {
    throw new Error("The SSR Markdown child cannot run overlapping workspace commands")
  }
  const scope = {
    sessionId: String(command.sessionId),
    generation: Number(command.generation),
    pending: new Set()
  }
  activeWorkspaceCommand = scope
  let failed = false
  let failure
  let result
  try {
    try {
      result = await evaluator.runCommand(operation)
    } catch (error) {
      failed = true
      failure = error
    }
    await settleWorkspaceCommand(scope)
    if (failed) throw failure
    return /** @type {T} */ (result)
  } finally {
    if (activeWorkspaceCommand === scope) activeWorkspaceCommand = undefined
  }
}

/** @param {{ pending: Set<Promise<unknown>> }} scope */
async function settleWorkspaceCommand(scope) {
  // Dropped dynamic imports can enqueue more module and Promise jobs after
  // render returns, so require one transport-idle event-loop turn before reply.
  for (;;) {
    if (scope.pending.size > 0) {
      await Promise.allSettled([...scope.pending])
    }
    await new Promise((resolveTurn) => setImmediate(resolveTurn))
    if (scope.pending.size === 0) return
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
      const scope = activeWorkspaceCommand
      if (
        !scope ||
        scope.sessionId !== sessionId ||
        scope.generation !== generation
      ) {
        return Promise.reject(new Error(
          "The SSR sandbox requested a module outside its active command"
        ))
      }
      const rpcId = nextRpcId++
      const request = new Promise((resolve, reject) => {
        pendingRpc.set(rpcId, { resolve, reject })
        send({
          type: "vite-rpc",
          rpcId,
          sessionId,
          generation,
          payload
        })
      })
      scope.pending.add(request)
      void request.then(
        () => scope.pending.delete(request),
        () => scope.pending.delete(request)
      )
      return request
    }
  }
}

async function closeSessions() {
  const closing = [...sessions.values()].map(({ runner }) => runner.close())
  for (const { evaluator } of sessions.values()) evaluator.dispose()
  sessions.clear()
  await Promise.allSettled(closing)
}

/** @param {string | undefined} probePath */
function permissionSelfCheck(probePath) {
  if (!probePath) {
    failBoot("missing_probe")
    return false
  }
  try {
    readFileSync(probePath)
    failBoot("outside_read_allowed")
    return false
  } catch (error) {
    const record = error && typeof error === "object"
      ? /** @type {Record<string, any>} */ (error)
      : undefined
    if (record?.code === "ERR_ACCESS_DENIED") return true
    failBoot(
      typeof record?.code === "string"
        ? record.code
        : "outside_read_failed_unexpectedly"
    )
    return false
  }
}

/** @param {string} reason */
function failBoot(reason) {
  console.error(JSON.stringify({
    level: "error",
    source: "show-runtime",
    event: "ssr-markdown-child-permission-self-check-failed",
    reason
  }))
  const error = new Error("The SSR Markdown child permission self-check failed")
  if (!process.send) {
    process.exit(1)
    return
  }
  process.send({ type: "boot-error", error: serializeError(error) }, () => process.exit(1))
}

/** @param {Record<string, unknown>} message */
function send(message) {
  if (!process.send) throw new Error("The SSR Markdown worker IPC channel closed")
  process.send(message)
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
