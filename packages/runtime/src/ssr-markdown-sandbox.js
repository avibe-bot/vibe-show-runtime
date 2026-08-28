import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import { createContext, Script } from "node:vm"
import {
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

  class SafeURLSearchParams {
    #query
    #onChange

    constructor(init = "", onChange) {
      if (init instanceof SafeURLSearchParams) {
        this.#query = init.toString()
      } else if (typeof init === "string") {
        this.#query = bridgeCall("params-normalize", init)
      } else {
        this.#query = ""
        if (init != null && typeof init[Symbol.iterator] === "function") {
          for (const pair of init) this.append(pair[0], pair[1])
        } else if (init != null && typeof init === "object") {
          for (const [key, value] of Object.entries(init)) this.append(key, value)
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
      return bridgeCall("params-get", this.#query, String(name))
    }

    getAll(name) {
      return JSON.parse(bridgeCall("params-get-all", this.#query, String(name)))
    }

    has(name, value) {
      return bridgeCall(
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
      this.#query = bridgeCall("params-normalize", query)
    }

    #pairs() {
      return JSON.parse(bridgeCall("params-pairs", this.#query))
    }

    #mutate(operation, name, value) {
      this.#query = bridgeCall(
        "params-mutate",
        this.#query,
        operation,
        name === undefined ? null : String(name),
        value === undefined ? null : String(value)
      )
      this.#onChange?.(this.#query)
    }
  }

  class SafeURL {
    #href
    #searchParams

    constructor(input, base) {
      this.#href = bridgeCall(
        "url-create",
        String(input),
        base === undefined ? null : String(base)
      )
    }

    static canParse(input, base) {
      return bridgeCall(
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

    #get(property) {
      return bridgeCall("url-get", this.#href, property)
    }

    #set(property, value) {
      this.#href = bridgeCall("url-set", this.#href, property, String(value))
      if (this.#searchParams) this.#searchParams._replace(this.search)
    }
  }

  class SafeTextEncoder {
    get encoding() { return "utf-8" }

    encode(value = "") {
      const bytes = []
      for (const character of String(value)) {
        let point = character.codePointAt(0)
        if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd
        if (point <= 0x7f) bytes.push(point)
        else if (point <= 0x7ff) {
          bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f))
        } else if (point <= 0xffff) {
          bytes.push(
            0xe0 | (point >> 12),
            0x80 | ((point >> 6) & 0x3f),
            0x80 | (point & 0x3f)
          )
        } else {
          bytes.push(
            0xf0 | (point >> 18),
            0x80 | ((point >> 12) & 0x3f),
            0x80 | ((point >> 6) & 0x3f),
            0x80 | (point & 0x3f)
          )
        }
      }
      return new Uint8Array(bytes)
    }

    encodeInto(value, destination) {
      const bytes = this.encode(value)
      const written = Math.min(bytes.length, destination.length)
      destination.set(bytes.subarray(0, written))
      return { read: String(value).length, written }
    }
  }

  class SafeTextDecoder {
    get encoding() { return "utf-8" }
    decode(value = new Uint8Array()) {
      return bridgeCall("text-decode", JSON.stringify(Array.from(value)))
    }
  }

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

  class SafeDOMException extends Error {
    constructor(message = "", name = "Error") {
      super(String(message))
      this.name = String(name)
    }

    get code() { return 0 }
  }

  const safeProcess = Object.freeze(Object.assign(Object.create(null), {
    env: Object.freeze(Object.assign(Object.create(null), { NODE_ENV: "development" }))
  }))
  const safePerformance = Object.freeze(Object.assign(Object.create(null), {
    now: () => Date.now()
  }))

  Object.defineProperties(globalThis, {
    process: { value: safeProcess, writable: false, configurable: false },
    performance: { value: safePerformance, writable: false, configurable: false },
    URL: { value: SafeURL, writable: false, configurable: false },
    URLSearchParams: { value: SafeURLSearchParams, writable: false, configurable: false },
    TextEncoder: { value: SafeTextEncoder, writable: false, configurable: false },
    TextDecoder: { value: SafeTextDecoder, writable: false, configurable: false },
    atob: {
      value: (value) => bridgeCall("atob", String(value)),
      writable: false,
      configurable: false
    },
    btoa: {
      value: (value) => {
        const input = String(value)
        if ([...input].some((character) => character.charCodeAt(0) > 255)) {
          throw new TypeError("btoa only accepts Latin-1 input")
        }
        return bridgeCall("btoa", input)
      },
      writable: false,
      configurable: false
    },
    MessageChannel: { value: SafeMessageChannel, writable: false, configurable: false },
    DOMException: { value: SafeDOMException, writable: false, configurable: false },
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
  /** @type {{ active: boolean, timers: Map<number, NodeJS.Timeout> } | undefined} */
  #activeCommand
  #nextTimerId = 1

  /** @param {string} name */
  constructor(name) {
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
    return this.#helpers.createImportMeta(JSON.stringify({
      filename: modulePath,
      dirname: dirname(modulePath),
      url: pathToFileURL(modulePath).href,
      env: {
        BASE_URL: "/",
        MODE: "development",
        DEV: true,
        PROD: false,
        SSR: true
      }
    }))
  }

  /** @template T @param {T} value @returns {T} */
  cloneJson(value) {
    return this.#helpers.parseJson(JSON.stringify(value))
  }

  dispose() {
    if (this.#activeCommand) this.#disposeCommand(this.#activeCommand)
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
      case "url-create":
        return args[1] === null
          ? new URL(String(args[0])).href
          : new URL(String(args[0]), String(args[1])).href
      case "url-can-parse":
        return args[1] === null
          ? URL.canParse(String(args[0]))
          : URL.canParse(String(args[0]), String(args[1]))
      case "url-get":
        return /** @type {any} */ (new URL(String(args[0])))[String(args[1])]
      case "url-set": {
        const targetUrl = new URL(String(args[0]))
        ;/** @type {any} */ (targetUrl)[String(args[1])] = args[2]
        return targetUrl.href
      }
      case "params-normalize":
        return new URLSearchParams(String(args[0]).replace(/^\?/, "")).toString()
      case "params-get":
        return new URLSearchParams(String(args[0])).get(String(args[1]))
      case "params-get-all":
        return JSON.stringify(new URLSearchParams(String(args[0])).getAll(String(args[1])))
      case "params-has": {
        const params = new URLSearchParams(String(args[0]))
        return args[2] === null
          ? params.has(String(args[1]))
          : params.has(String(args[1]), String(args[2]))
      }
      case "params-pairs":
        return JSON.stringify([...new URLSearchParams(String(args[0]))])
      case "params-mutate": {
        const [query, mutation, name, value] = args
        const params = new URLSearchParams(String(query))
        if (mutation === "append") params.append(String(name), String(value))
        else if (mutation === "delete") {
          if (value === null) params.delete(String(name))
          else params.delete(String(name), String(value))
        } else if (mutation === "set") params.set(String(name), String(value))
        else if (mutation === "sort") params.sort()
        else throw new Error("Unsupported URLSearchParams mutation")
        return params.toString()
      }
      case "atob":
        return Buffer.from(String(args[0]), "base64").toString("latin1")
      case "btoa":
        return Buffer.from(String(args[0]), "latin1").toString("base64")
      case "text-decode":
        return Buffer.from(JSON.parse(String(args[0]))).toString("utf8")
      default:
        throw new Error(`Unsupported SSR sandbox operation: ${operation}`)
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
