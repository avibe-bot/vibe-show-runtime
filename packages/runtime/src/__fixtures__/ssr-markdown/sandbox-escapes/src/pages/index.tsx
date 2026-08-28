import * as ReactNamespace from "react"

const hostFile = "__HOST_SENTINEL_PATH__"
const functionBody = `return process.getBuiltinModule("node:fs").readFileSync(${JSON.stringify(hostFile)}, "utf8")`
const evalBody = `process.getBuiltinModule("node:fs").readFileSync(${JSON.stringify(hostFile)}, "utf8")`
const results: Record<string, string> = {}

function attempt(name: string, action: () => unknown) {
  try {
    results[name] = String(action() ?? "blocked")
  } catch {
    results[name] = "blocked"
  }
}

function hostRead(factory: FunctionConstructor) {
  return factory(functionBody)()
}

attempt("process-env", () => process.env.AVIBE_SSR_HOST_SENTINEL ?? "blocked")
attempt("Function", () => hostRead(Function))
attempt("eval", () => (0, eval)(evalBody))
attempt("URL constructor", () => hostRead((URL as unknown as { constructor: FunctionConstructor }).constructor))
attempt("URLSearchParams constructor", () => hostRead(
  (URLSearchParams as unknown as { constructor: FunctionConstructor }).constructor
))
attempt("timer constructor", () => hostRead((setTimeout as unknown as { constructor: FunctionConstructor }).constructor))
attempt("encoder constructor", () => hostRead((TextEncoder as unknown as { constructor: FunctionConstructor }).constructor))
attempt("decoder constructor", () => hostRead((TextDecoder as unknown as { constructor: FunctionConstructor }).constructor))
attempt("base64 constructor", () => hostRead((atob as unknown as { constructor: FunctionConstructor }).constructor))
attempt("performance constructor", () => hostRead(
  (performance.now as unknown as { constructor: FunctionConstructor }).constructor
))
attempt("DOMException constructor", () => hostRead(
  (DOMException as unknown as { constructor: FunctionConstructor }).constructor
))
attempt("MessageChannel constructor", () => hostRead(
  (MessageChannel as unknown as { constructor: FunctionConstructor }).constructor
))
attempt("Promise constructor", () => hostRead((Promise as unknown as { constructor: FunctionConstructor }).constructor))
attempt("deferred intrinsics", () => {
  const globals = globalThis as unknown as Record<string, unknown>
  return ["FinalizationRegistry", "SharedArrayBuffer", "Atomics", "WebAssembly"]
    .every((name) => globals[name] === undefined)
    ? "blocked"
    : "available"
})
attempt("import-meta constructor", () => hostRead(
  (import.meta.resolve as unknown as { constructor: FunctionConstructor }).constructor
))
attempt("module namespace", () => hostRead(
  (ReactNamespace as unknown as { constructor: FunctionConstructor }).constructor
))

try {
  await import(/* @vite-ignore */ "node:fs")
  results["dynamic import"] = "available"
} catch (error) {
  attempt("dynamic import", () => hostRead(
    (error as { constructor: { constructor: FunctionConstructor } }).constructor.constructor
  ))
}

export default function SandboxEscapesFixture() {
  return (
    <main>
      <h1>Sandbox authority report</h1>
      <ul>
        {Object.entries(results).map(([name, value]) => <li key={name}>{name}: {value}</li>)}
      </ul>
    </main>
  )
}
