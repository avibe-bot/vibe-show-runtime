import { readFileSync } from "node:fs"
import { ModuleRunner } from "vite/module-runner"
import {
  cleanupSsrRenderedHtml,
  convertCleanedSsrHtmlToMarkdown
} from "./ssr-markdown-conversion.js"
import {
  assertSsrMarkdownIpcValue,
  serializeSsrMarkdownError,
  SSR_MARKDOWN_IPC_CONTROL_MAX_BYTES,
  SSR_MARKDOWN_IPC_MODULE_MAX_BYTES
} from "./ssr-markdown-protocol.js"
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
    try {
      assertSsrMarkdownIpcValue(
        record,
        SSR_MARKDOWN_IPC_CONTROL_MAX_BYTES,
        "command input"
      )
    } catch (error) {
      sendCommandError(record, error)
      return
    }
    void executeCommand(record).then(
      (result) => sendCommandResult(record, result),
      (error) => sendCommandError(record, error)
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
      await disposeSession(command.sessionId)
      const evaluator = new SsrSandboxEvaluator(
        `avibe-show-ssr:${command.sessionId}`,
        command.importMetaEnv
      )
      const state = /** @type {SessionState} */ ({
        generation: command.generation,
        evaluator,
        runner: new ModuleRunner({
          transport: createParentTransport(command.sessionId, command.generation),
          createImportMeta: (modulePath) => evaluator.createImportMeta(modulePath),
          hmr: false,
          sourcemapInterceptor: false
        }, evaluator)
      })
      sessions.set(command.sessionId, state)
      try {
        const entry = await runWorkspaceCommand(
          command,
          state.evaluator,
          () => state.runner.import(command.entryId)
        )
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof entry.render !== "function" ||
          typeof entry.hasSsrRouterProvider !== "boolean"
        ) {
          throw new Error("The Show Page SSR entry is incomplete")
        }
        state.entry = entry
        return undefined
      } catch (error) {
        await disposeSession(command.sessionId)
        throw error
      }
    }
    case "render-markdown": {
      const state = sessionState(command)
      try {
        if (
          !state.entry.hasSsrRouterProvider &&
          command.location?.pathname !== "/"
        ) {
          throw new Error(
            "This Show Page router supports SSR Markdown only for the root document"
          )
        }
        const html = await runWorkspaceCommand(
          command,
          state.evaluator,
          () => state.entry.render(state.evaluator.cloneJson(command.location))
        )
        await sendAndWait({
          type: "command-phase",
          requestId: command.requestId,
          phase: "cleanup"
        })
        const cleanedHtml = cleanupSsrRenderedHtml(html, command.options)
        await sendAndWait({
          type: "command-phase",
          requestId: command.requestId,
          phase: "conversion"
        })
        const markdown = convertCleanedSsrHtmlToMarkdown(
          cleanedHtml,
          command.options.maxOutputBytes
        )
        return { markdown }
      } finally {
        await disposeSession(command.sessionId)
      }
    }
    case "invalidate": {
      await disposeSession(command.sessionId)
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
      const message = {
        type: "vite-rpc",
        rpcId,
        sessionId,
        generation,
        payload
      }
      assertSsrMarkdownIpcValue(
        message,
        SSR_MARKDOWN_IPC_CONTROL_MAX_BYTES,
        "module request"
      )
      const request = new Promise((resolve, reject) => {
        pendingRpc.set(rpcId, { resolve, reject })
        send(message)
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

/** @param {string} sessionId */
async function disposeSession(sessionId) {
  const state = sessions.get(sessionId)
  sessions.delete(sessionId)
  if (!state) return
  try {
    await state.runner.close()
  } finally {
    state.evaluator.dispose()
  }
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
  const message = {
    type: "boot-error",
    error: serializeSsrMarkdownError(error)
  }
  assertSsrMarkdownIpcValue(
    message,
    SSR_MARKDOWN_IPC_CONTROL_MAX_BYTES,
    "boot error"
  )
  process.send(message, () => process.exit(1))
}

/**
 * @param {Record<string, unknown>} message
 * @param {number} [maxBytes]
 * @param {string} [boundary]
 */
function send(
  message,
  maxBytes = SSR_MARKDOWN_IPC_CONTROL_MAX_BYTES,
  boundary = "control message"
) {
  if (!process.send) throw new Error("The SSR Markdown worker IPC channel closed")
  assertSsrMarkdownIpcValue(message, maxBytes, boundary)
  process.send(message)
}

/** @param {Record<string, unknown>} message */
async function sendAndWait(message) {
  if (!process.send) throw new Error("The SSR Markdown worker IPC channel closed")
  assertSsrMarkdownIpcValue(
    message,
    SSR_MARKDOWN_IPC_CONTROL_MAX_BYTES,
    "phase transition"
  )
  await new Promise((resolveSend, rejectSend) => {
    process.send?.(message, (error) => error ? rejectSend(error) : resolveSend(undefined))
  })
}

/** @param {Record<string, any>} command @param {unknown} result */
function sendCommandResult(command, result) {
  const configuredMaxBytes = Number(command.options?.maxOutputBytes)
  const maxBytes = command.name === "render-markdown" &&
    Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
    ? Math.min(configuredMaxBytes, Number.MAX_SAFE_INTEGER - 1024) + 1024
    : SSR_MARKDOWN_IPC_CONTROL_MAX_BYTES
  send({
    type: "command-result",
    requestId: command.requestId,
    result
  }, maxBytes, "command result")
}

/** @param {Record<string, any>} command @param {unknown} error */
function sendCommandError(command, error) {
  send({
    type: "command-result",
    requestId: command.requestId,
    error: serializeSsrMarkdownError(error)
  })
}

/** @param {Record<string, any>} message */
function settleRpc(message) {
  const pending = pendingRpc.get(message.rpcId)
  if (!pending) return
  pendingRpc.delete(message.rpcId)
  try {
    assertSsrMarkdownIpcValue(
      message,
      SSR_MARKDOWN_IPC_MODULE_MAX_BYTES + SSR_MARKDOWN_IPC_CONTROL_MAX_BYTES,
      "module response"
    )
    pending.resolve(message.response)
  } catch (error) {
    pending.reject(error instanceof Error ? error : new Error(String(error)))
  }
}
