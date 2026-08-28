import { createContext, Script } from "node:vm"
import {
  createDefaultImportMeta,
  ssrDynamicImportKey,
  ssrExportAllKey,
  ssrExportNameKey,
  ssrImportKey,
  ssrImportMetaKey,
  ssrModuleExportsKey
} from "vite/module-runner"

const MODULE_PARAMETERS = [
  ssrModuleExportsKey,
  ssrImportMetaKey,
  ssrImportKey,
  ssrDynamicImportKey,
  ssrExportAllKey,
  ssrExportNameKey
]

/** @typedef {Readonly<Record<string, unknown>>} SsrImportMetaEnv */

const SANDBOX_BOOTSTRAP = String.raw`
(function bootstrap(bridge) {
  "use strict"

  function bridgeCall(operation, ...args) {
    try {
      return bridge(operation, ...args)
    } catch {
      throw new Error("The SSR sandbox bridge rejected an operation")
    }
  }

  const DOM_EXCEPTION_CODES = Object.freeze({
    IndexSizeError: 1,
    DOMStringSizeError: 2,
    HierarchyRequestError: 3,
    WrongDocumentError: 4,
    InvalidCharacterError: 5,
    NoDataAllowedError: 6,
    NoModificationAllowedError: 7,
    NotFoundError: 8,
    NotSupportedError: 9,
    InUseAttributeError: 10,
    InvalidStateError: 11,
    SyntaxError: 12,
    InvalidModificationError: 13,
    NamespaceError: 14,
    InvalidAccessError: 15,
    ValidationError: 16,
    TypeMismatchError: 17,
    SecurityError: 18,
    NetworkError: 19,
    AbortError: 20,
    URLMismatchError: 21,
    QuotaExceededError: 22,
    TimeoutError: 23,
    InvalidNodeTypeError: 24,
    DataCloneError: 25
  })
  const DOM_EXCEPTION_CONSTANTS = Object.freeze({
    INDEX_SIZE_ERR: 1,
    DOMSTRING_SIZE_ERR: 2,
    HIERARCHY_REQUEST_ERR: 3,
    WRONG_DOCUMENT_ERR: 4,
    INVALID_CHARACTER_ERR: 5,
    NO_DATA_ALLOWED_ERR: 6,
    NO_MODIFICATION_ALLOWED_ERR: 7,
    NOT_FOUND_ERR: 8,
    NOT_SUPPORTED_ERR: 9,
    INUSE_ATTRIBUTE_ERR: 10,
    INVALID_STATE_ERR: 11,
    SYNTAX_ERR: 12,
    INVALID_MODIFICATION_ERR: 13,
    NAMESPACE_ERR: 14,
    INVALID_ACCESS_ERR: 15,
    VALIDATION_ERR: 16,
    TYPE_MISMATCH_ERR: 17,
    SECURITY_ERR: 18,
    NETWORK_ERR: 19,
    ABORT_ERR: 20,
    URL_MISMATCH_ERR: 21,
    QUOTA_EXCEEDED_ERR: 22,
    TIMEOUT_ERR: 23,
    INVALID_NODE_TYPE_ERR: 24,
    DATA_CLONE_ERR: 25
  })

  // Errors must be recreated in this realm; returning a host Error would expose its Function.
  class SafeDOMException extends Error {
    constructor(message = "", name = "Error") {
      super(String(message))
      this.name = String(name)
    }

    get code() { return DOM_EXCEPTION_CODES[this.name] ?? 0 }
    get [Symbol.toStringTag]() { return "DOMException" }
  }
  for (const [name, code] of Object.entries(DOM_EXCEPTION_CONSTANTS)) {
    Object.defineProperty(SafeDOMException, name, {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false
    })
    Object.defineProperty(SafeDOMException.prototype, name, {
      value: code,
      writable: false,
      enumerable: true,
      configurable: false
    })
  }

  function platformCall(operation, ...args) {
    const result = JSON.parse(bridgeCall("platform", operation, JSON.stringify(args)))
    if (result.ok) return result.value
    const error = result.error
    if (error.kind === "DOMException") {
      throw new SafeDOMException(error.message, error.name)
    }
    if (error.name === "TypeError") throw new TypeError(error.message)
    if (error.name === "RangeError") throw new RangeError(error.message)
    if (error.name === "SyntaxError") throw new SyntaxError(error.message)
    throw new Error(error.message)
  }

  // WHATWG URL algorithms stay host-native; only strings and JSON cross into realm-owned facades.
  class SafeURLSearchParams {
    #query
    #onChange

    constructor(init = "", onChange) {
      if (init instanceof SafeURLSearchParams) {
        this.#query = init.toString()
      } else if (typeof init === "string") {
        this.#query = platformCall("params-normalize", init)
      } else {
        if (init != null && typeof init[Symbol.iterator] === "function") {
          const pairs = []
          for (const pair of init) {
            const values = Array.from(pair)
            if (values.length !== 2) {
              throw new TypeError("Each query pair must contain exactly two values")
            }
            pairs.push([String(values[0]), String(values[1])])
          }
          this.#query = platformCall("params-from-pairs", pairs)
        } else if (init != null && typeof init === "object") {
          this.#query = platformCall(
            "params-from-pairs",
            Object.entries(init).map(([key, value]) => [key, String(value)])
          )
        } else {
          this.#query = platformCall("params-normalize", init == null ? "" : String(init))
        }
      }
      this.#onChange = typeof onChange === "function" ? onChange : undefined
    }

    get size() {
      return this.#pairs().length
    }

    append(name, value) {
      this.#mutate("append", name, value)
    }

    delete(name, value) {
      this.#mutate("delete", name, value)
    }

    get(name) {
      return platformCall("params-get", this.#query, String(name))
    }

    getAll(name) {
      return platformCall("params-get-all", this.#query, String(name))
    }

    has(name, value) {
      return platformCall(
        "params-has",
        this.#query,
        String(name),
        value === undefined ? null : String(value)
      )
    }

    set(name, value) {
      this.#mutate("set", name, value)
    }

    sort() {
      this.#mutate("sort")
    }

    entries() {
      return this.#pairs()[Symbol.iterator]()
    }

    keys() {
      return this.#pairs().map(([key]) => key)[Symbol.iterator]()
    }

    values() {
      return this.#pairs().map(([, value]) => value)[Symbol.iterator]()
    }

    forEach(callback, thisArg) {
      for (const [key, value] of this.#pairs()) callback.call(thisArg, value, key, this)
    }

    toString() {
      return this.#query
    }

    [Symbol.iterator]() {
      return this.entries()
    }

    _replace(query) {
      this.#query = platformCall("params-normalize", query)
    }

    #pairs() {
      return platformCall("params-pairs", this.#query)
    }

    #mutate(operation, name, value) {
      this.#query = platformCall(
        "params-mutate",
        this.#query,
        operation,
        name === undefined ? null : String(name),
        value === undefined ? null : String(value)
      )
      this.#onChange?.(this.#query)
    }

    get [Symbol.toStringTag]() { return "URLSearchParams" }
  }

  class SafeURL {
    #href
    #searchParams

    constructor(input, base) {
      this.#href = platformCall(
        "url-create",
        String(input),
        base === undefined ? null : String(base)
      )
    }

    static canParse(input, base) {
      return platformCall(
        "url-can-parse",
        String(input),
        base === undefined ? null : String(base)
      )
    }

    static parse(input, base) {
      return SafeURL.canParse(input, base) ? new SafeURL(input, base) : null
    }

    get href() { return this.#get("href") }
    set href(value) { this.#set("href", value) }
    get origin() { return this.#get("origin") }
    get protocol() { return this.#get("protocol") }
    set protocol(value) { this.#set("protocol", value) }
    get username() { return this.#get("username") }
    set username(value) { this.#set("username", value) }
    get password() { return this.#get("password") }
    set password(value) { this.#set("password", value) }
    get host() { return this.#get("host") }
    set host(value) { this.#set("host", value) }
    get hostname() { return this.#get("hostname") }
    set hostname(value) { this.#set("hostname", value) }
    get port() { return this.#get("port") }
    set port(value) { this.#set("port", value) }
    get pathname() { return this.#get("pathname") }
    set pathname(value) { this.#set("pathname", value) }
    get search() { return this.#get("search") }
    set search(value) { this.#set("search", value) }
    get hash() { return this.#get("hash") }
    set hash(value) { this.#set("hash", value) }

    get searchParams() {
      this.#searchParams ??= new SafeURLSearchParams(this.search, (query) => {
        this.#set("search", query ? "?" + query : "")
      })
      return this.#searchParams
    }

    toString() { return this.href }
    toJSON() { return this.href }
    get [Symbol.toStringTag]() { return "URL" }

    #get(property) {
      return platformCall("url-get", this.#href, property)
    }

    #set(property, value) {
      this.#href = platformCall("url-set", this.#href, property, String(value))
      if (this.#searchParams) this.#searchParams._replace(this.search)
    }
  }

  // Encoding stays host-native; facades keep buffers, errors, and constructor identity in this realm.
  class SafeTextEncoder {
    get encoding() { return "utf-8" }

    encode(value = "") {
      return new Uint8Array(platformCall("text-encode", String(value)))
    }

    encodeInto(value, destination) {
      if (typeof value !== "string") throw new TypeError("TextEncoder source must be a string")
      if (!(destination instanceof Uint8Array)) {
        throw new TypeError("TextEncoder destination must be a Uint8Array")
      }
      const result = platformCall("text-encode-into", value, destination.byteLength)
      destination.set(result.bytes)
      return { read: result.read, written: result.written }
    }

    get [Symbol.toStringTag]() { return "TextEncoder" }
  }

  class SafeTextDecoder {
    #id
    #encoding
    #fatal
    #ignoreBOM

    constructor(label = "utf-8", options = {}) {
      const normalizedOptions = options == null ? {} : options
      const result = platformCall("text-decoder-create", String(label), {
        fatal: Boolean(normalizedOptions.fatal),
        ignoreBOM: Boolean(normalizedOptions.ignoreBOM)
      })
      this.#id = result.id
      this.#encoding = result.encoding
      this.#fatal = result.fatal
      this.#ignoreBOM = result.ignoreBOM
    }

    get encoding() { return this.#encoding }
    get fatal() { return this.#fatal }
    get ignoreBOM() { return this.#ignoreBOM }

    decode(value = undefined, options = {}) {
      let bytes
      if (value === undefined) bytes = []
      else if (value instanceof ArrayBuffer) bytes = [...new Uint8Array(value)]
      else if (ArrayBuffer.isView(value)) {
        bytes = [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]
      } else {
        throw new TypeError("TextDecoder input must be an ArrayBuffer or ArrayBuffer view")
      }
      const normalizedOptions = options == null ? {} : options
      return platformCall("text-decoder-decode", this.#id, bytes, {
        stream: Boolean(normalizedOptions.stream)
      })
    }

    get [Symbol.toStringTag]() { return "TextDecoder" }
  }

  // Scheduling is a policy shim so every callback can be retired with its render command.
  class SafeMessagePort {
    #peer
    #closed = false
    onmessage = null

    _connect(peer) { this.#peer = peer }
    start() {}
    close() { this.#closed = true }
    postMessage(data) {
      const peer = this.#peer
      if (this.#closed || !peer) return
      bridgeCall("microtask-set", () => {
        if (!peer.#closed && typeof peer.onmessage === "function") {
          peer.onmessage({ data })
        }
      })
    }
  }

  class SafeMessageChannel {
    constructor() {
      this.port1 = new SafeMessagePort()
      this.port2 = new SafeMessagePort()
      this.port1._connect(this.port2)
      this.port2._connect(this.port1)
    }
  }

  const safeProcess = Object.freeze(Object.assign(Object.create(null), {
    env: Object.freeze(Object.assign(Object.create(null), { NODE_ENV: "development" }))
  }))
  // The host monotonic clock is pure; only numeric samples cross the serialized bridge.
  const safePerformance = Object.freeze(Object.assign(Object.create(null), {
    now: () => platformCall("performance-now"),
    timeOrigin: platformCall("performance-time-origin"),
    [Symbol.toStringTag]: "Performance"
  }))

  Object.defineProperties(globalThis, {
    process: { value: safeProcess, writable: false, configurable: false },
    performance: { value: safePerformance, writable: false, configurable: false },
    URL: { value: SafeURL, writable: false, configurable: false },
    URLSearchParams: { value: SafeURLSearchParams, writable: false, configurable: false },
    TextEncoder: { value: SafeTextEncoder, writable: false, configurable: false },
    TextDecoder: { value: SafeTextDecoder, writable: false, configurable: false },
    atob: {
      value: function atob(value) {
        if (arguments.length === 0) throw new TypeError("atob requires an argument")
        return platformCall("atob", String(value))
      },
      writable: false,
      configurable: false
    },
    btoa: {
      value: function btoa(value) {
        if (arguments.length === 0) throw new TypeError("btoa requires an argument")
        return platformCall("btoa", String(value))
      },
      writable: false,
      configurable: false
    },
    MessageChannel: { value: SafeMessageChannel, writable: false, configurable: false },
    DOMException: { value: SafeDOMException, writable: false, configurable: false },
    // These delayed-work/authority primitives cannot be made command-bounded, so policy omits them.
    FinalizationRegistry: { value: undefined, writable: false, configurable: false },
    SharedArrayBuffer: { value: undefined, writable: false, configurable: false },
    Atomics: { value: undefined, writable: false, configurable: false },
    WebAssembly: { value: undefined, writable: false, configurable: false },
    setTimeout: {
      value: (callback, delay = 0, ...args) => bridgeCall(
        "timer-set",
        callback,
        Number(delay),
        false,
        args
      ),
      writable: false,
      configurable: false
    },
    clearTimeout: {
      value: (id) => bridgeCall("timer-clear", Number(id)),
      writable: false,
      configurable: false
    },
    setInterval: {
      value: (callback, delay = 0, ...args) => bridgeCall(
        "timer-set",
        callback,
        Number(delay),
        true,
        args
      ),
      writable: false,
      configurable: false
    },
    clearInterval: {
      value: (id) => bridgeCall("timer-clear", Number(id)),
      writable: false,
      configurable: false
    },
    queueMicrotask: {
      value: (callback) => bridgeCall("microtask-set", callback),
      writable: false,
      configurable: false
    }
  })

  function wrapModuleContext(importModule, dynamicImport, exportAll, exportName) {
    return Object.freeze(Object.assign(Object.create(null), {
      async importModule(id, metadata) {
        try {
          return await importModule(String(id), metadata)
        } catch (error) {
          const detail = error && typeof error.message === "string" ? error.message : String(error)
          throw new Error("The SSR sandbox denied a module import: " + detail)
        }
      },
      async dynamicImport(id) {
        try {
          return await dynamicImport(String(id))
        } catch (error) {
          const detail = error && typeof error.message === "string" ? error.message : String(error)
          throw new Error("The SSR sandbox denied a dynamic import: " + detail)
        }
      },
      exportAll(value) {
        try {
          exportAll(value)
        } catch {
          throw new Error("The SSR sandbox could not publish module exports")
        }
      },
      exportName(name, getter) {
        try {
          exportName(String(name), getter)
        } catch {
          throw new Error("The SSR sandbox could not publish a module export")
        }
      }
    }))
  }

  function parseJson(serialized) {
    return JSON.parse(serialized)
  }

  function createImportMeta(serialized) {
    const meta = JSON.parse(serialized)
    Object.setPrototypeOf(meta, null)
    Object.setPrototypeOf(meta.env, null)
    meta.resolve = () => { throw new Error("import.meta.resolve is unavailable during SSR") }
    meta.glob = () => { throw new Error("import.meta.glob must be transformed by Vite") }
    return meta
  }

  function createError(message) {
    return new Error(message)
  }

  return Object.freeze({ wrapModuleContext, parseJson, createImportMeta, createError })
})
`

export class SsrSandboxEvaluator {
  startOffset = 2

  #context
  #helpers
  /** @type {Readonly<SsrImportMetaEnv>} */
  #importMetaEnv
  /** @type {{ active: boolean, timers: Map<number, NodeJS.Timeout> } | undefined} */
  #activeCommand
  #nextTimerId = 1
  /** @type {Map<number, TextDecoder>} */
  #textDecoders = new Map()
  #nextTextDecoderId = 1

  /** @param {string} name @param {SsrImportMetaEnv} importMetaEnv */
  constructor(name, importMetaEnv) {
    this.#importMetaEnv = Object.freeze({ ...importMetaEnv })
    this.#context = createContext(Object.create(null), {
      name,
      codeGeneration: { strings: false, wasm: false }
    })
    const bootstrap = new Script(SANDBOX_BOOTSTRAP, {
      filename: "avibe-show-ssr-sandbox-bootstrap.js"
    }).runInContext(this.#context)
    this.#helpers = bootstrap(
      /** @param {string} operation @param {...unknown} args */
      (operation, ...args) => this.#bridge(operation, args)
    )
  }

  /**
   * @param {import("vite/module-runner").ModuleRunnerContext} context
   * @param {string} code
   * @param {Readonly<import("vite/module-runner").EvaluatedModuleNode>} module
   */
  async runInlinedModule(context, code, module) {
    const wrapped = this.#helpers.wrapModuleContext(
      context[ssrImportKey],
      context[ssrDynamicImportKey],
      context[ssrExportAllKey],
      context[ssrExportNameKey]
    )
    const deniedDynamicImport = this.#helpers.createError(
      "Native dynamic imports are unavailable during Show Page SSR"
    )
    const compiled = new Script(
      `(async function(${MODULE_PARAMETERS.join(",")}) {\n"use strict";\n${code}\n})`,
      {
        filename: module.file || "avibe-show-ssr-module.js",
        importModuleDynamically: () => Promise.reject(deniedDynamicImport)
      }
    ).runInContext(this.#context)
    await compiled(
      context[ssrModuleExportsKey],
      context[ssrImportMetaKey],
      wrapped.importModule,
      wrapped.dynamicImport,
      wrapped.exportAll,
      wrapped.exportName
    )
    Object.seal(context[ssrModuleExportsKey])
  }

  /** @template T @param {() => T | Promise<T>} operation @returns {Promise<T>} */
  async runCommand(operation) {
    if (this.#activeCommand) {
      throw new Error("The SSR sandbox cannot run overlapping commands")
    }
    const command = { active: true, timers: new Map() }
    this.#activeCommand = command
    try {
      return await operation()
    } finally {
      this.#disposeCommand(command)
    }
  }

  /** @param {string} filepath */
  async runExternalModule(filepath) {
    throw new Error(`External module ${filepath} is unavailable during Show Page SSR`)
  }

  /** @param {string} modulePath */
  createImportMeta(modulePath) {
    const viteMeta = createDefaultImportMeta(modulePath)
    return this.#helpers.createImportMeta(JSON.stringify({
      filename: viteMeta.filename,
      dirname: viteMeta.dirname,
      url: viteMeta.url,
      main: false,
      env: this.#importMetaEnv
    }))
  }

  /** @template T @param {T} value @returns {T} */
  cloneJson(value) {
    return this.#helpers.parseJson(JSON.stringify(value))
  }

  dispose() {
    if (this.#activeCommand) this.#disposeCommand(this.#activeCommand)
    this.#textDecoders.clear()
  }

  /** @param {string} operation @param {unknown[]} args @returns {any} */
  #bridge(operation, args) {
    switch (operation) {
      case "timer-set": {
        const [callback, rawDelay, repeat, callbackArgs] = args
        if (typeof callback !== "function") throw new TypeError("Timer callback must be a function")
        const command = this.#activeCommand
        if (!command) return 0
        const delay = Number.isFinite(rawDelay) ? Math.max(0, Number(rawDelay)) : 0
        const id = this.#nextTimerId++
        const invoke = () => {
          if (!command.active) return
          if (!repeat) command.timers.delete(id)
          try {
            callback(.../** @type {unknown[]} */ (callbackArgs))
          } catch {
            // Timer side effects are outside the initial React tree represented by SSR.
          }
        }
        const timer = repeat ? setInterval(invoke, delay) : setTimeout(invoke, delay)
        timer.unref?.()
        command.timers.set(id, timer)
        return id
      }
      case "timer-clear": {
        const id = Number(args[0])
        const timer = this.#activeCommand?.timers.get(id)
        if (timer) {
          clearTimeout(timer)
          clearInterval(timer)
          this.#activeCommand?.timers.delete(id)
        }
        return undefined
      }
      case "microtask-set": {
        const [callback] = args
        if (typeof callback !== "function") {
          throw new TypeError("Microtask callback must be a function")
        }
        const command = this.#activeCommand
        if (!command) return undefined
        queueMicrotask(() => {
          if (!command.active) return
          try {
            callback()
          } catch {
            // Scheduled side effects are outside the initial React tree represented by SSR.
          }
        })
        return undefined
      }
      case "platform":
        return this.#platformCall(String(args[0]), JSON.parse(String(args[1])))
      default:
        throw new Error(`Unsupported SSR sandbox operation: ${operation}`)
    }
  }

  /** @param {string} operation @param {unknown[]} args */
  #platformCall(operation, args) {
    try {
      let value
      switch (operation) {
        case "url-create":
          value = args[1] === null
            ? new URL(String(args[0])).href
            : new URL(String(args[0]), String(args[1])).href
          break
        case "url-can-parse":
          value = args[1] === null
            ? URL.canParse(String(args[0]))
            : URL.canParse(String(args[0]), String(args[1]))
          break
        case "url-get":
          value = /** @type {any} */ (new URL(String(args[0])))[String(args[1])]
          break
        case "url-set": {
          const targetUrl = new URL(String(args[0]))
          ;/** @type {any} */ (targetUrl)[String(args[1])] = args[2]
          value = targetUrl.href
          break
        }
        case "params-normalize":
          value = new URLSearchParams(String(args[0]).replace(/^\?/, "")).toString()
          break
        case "params-from-pairs":
          value = new URLSearchParams(/** @type {[string, string][]} */ (args[0])).toString()
          break
        case "params-get":
          value = new URLSearchParams(String(args[0])).get(String(args[1]))
          break
        case "params-get-all":
          value = new URLSearchParams(String(args[0])).getAll(String(args[1]))
          break
        case "params-has": {
          const params = new URLSearchParams(String(args[0]))
          value = args[2] === null
            ? params.has(String(args[1]))
            : params.has(String(args[1]), String(args[2]))
          break
        }
        case "params-pairs":
          value = [...new URLSearchParams(String(args[0]))]
          break
        case "params-mutate": {
          const [query, mutation, name, mutationValue] = args
          const params = new URLSearchParams(String(query))
          if (mutation === "append") params.append(String(name), String(mutationValue))
          else if (mutation === "delete") {
            if (mutationValue === null) params.delete(String(name))
            else params.delete(String(name), String(mutationValue))
          } else if (mutation === "set") params.set(String(name), String(mutationValue))
          else if (mutation === "sort") params.sort()
          else throw new Error("Unsupported URLSearchParams mutation")
          value = params.toString()
          break
        }
        case "text-encode":
          value = [...new TextEncoder().encode(String(args[0]))]
          break
        case "text-encode-into": {
          const destination = new Uint8Array(Number(args[1]))
          const result = new TextEncoder().encodeInto(String(args[0]), destination)
          value = { ...result, bytes: [...destination.subarray(0, result.written)] }
          break
        }
        case "text-decoder-create": {
          const options = /** @type {{ fatal?: boolean, ignoreBOM?: boolean }} */ (args[1])
          const decoder = new TextDecoder(String(args[0]), options)
          const id = this.#nextTextDecoderId++
          this.#textDecoders.set(id, decoder)
          value = {
            id,
            encoding: decoder.encoding,
            fatal: decoder.fatal,
            ignoreBOM: decoder.ignoreBOM
          }
          break
        }
        case "text-decoder-decode": {
          const decoder = this.#textDecoders.get(Number(args[0]))
          if (!decoder) throw new Error("Unknown SSR TextDecoder")
          const bytes = Uint8Array.from(/** @type {number[]} */ (args[1]))
          value = decoder.decode(bytes, /** @type {TextDecodeOptions} */ (args[2]))
          break
        }
        case "atob":
          value = atob(String(args[0]))
          break
        case "btoa":
          value = btoa(String(args[0]))
          break
        case "performance-now":
          value = performance.now()
          break
        case "performance-time-origin":
          value = performance.timeOrigin
          break
        default:
          throw new Error(`Unsupported SSR platform operation: ${operation}`)
      }
      return JSON.stringify({ ok: true, value })
    } catch (error) {
      const candidate = /** @type {{ name?: unknown, message?: unknown }} */ (error)
      return JSON.stringify({
        ok: false,
        error: {
          kind: error instanceof DOMException ? "DOMException" : "Error",
          name: String(candidate?.name ?? "Error"),
          message: String(candidate?.message ?? "Platform operation failed")
        }
      })
    }
  }

  /** @param {{ active: boolean, timers: Map<number, NodeJS.Timeout> }} command */
  #disposeCommand(command) {
    command.active = false
    for (const timer of command.timers.values()) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    command.timers.clear()
    if (this.#activeCommand === command) this.#activeCommand = undefined
  }
}
