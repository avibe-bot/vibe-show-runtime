# SSR Markdown Renderer

Status: Phase 2 implementation for avibe#1617. This replaces the Markdown
browser renderer; it does not change the human-facing Vite application path.

## Production shape

The renderer uses the long-lived SSR module graph of each live session's Vite
server. It does not create an SSR build or a second Vite server.

```text
runtime main thread
  live session Vite `avibe_show_markdown` module graph
  workspace fingerprint and Markdown LRU
  one renderer-wide concurrency mutex
  Vite fetchModule policy owner
                  |
                  v
one long-lived, terminable Node child process
  process permission profile + boot self-check
  restricted VM realm + ModuleRunner cache per session
    React DOM Server render
  Runtime-owned trusted layer
    structured HTML cleanup
    Turndown + GFM conversion
```

The Runtime-owned virtual entry imports the page `App` and React DOM Server
through one session SSR graph. It also imports the router provider when
`src/router.tsx` exists; legacy App-only workspaces render `App` directly, and
the Runtime never creates a router for them. That preserves the session's
physical React instance across application, optional provider, and renderer.
Cleanup and conversion do not compose React values, so they run in the same
terminable child process's trusted Runtime layer rather than in the workspace VM.

The renderer uses a dedicated Vite environment inside the existing session
server. Its dependency graph is inlined, browser package conditions are used,
and browser-platform CJS entry points are prebundled before VM evaluation. The
ordinary Vite `ssr` environment is unchanged, so `api/*` handlers retain their
existing Node execution model.

Security boundaries are Runtime-owned; environment semantics are Vite-owned, so
the renderer transports the active SSR environment's complete resolved `env`
object plus its SSR consumer bit and never re-derives or enumerates Vite env keys.

CSS does not contribute to the semantic SSR tree. After validating the resolved
CSS entry against the workspace boundary, the Markdown environment substitutes
an empty stylesheet before Vite's CSS compiler runs. This keeps CSS imports valid
without letting nested `@import` or `url()` acquisition bypass the module boundary;
the human-facing Vite environment continues to compile the original CSS normally.
Small static assets follow Vite's normal SSR behavior and can become data URLs.
Filesystem asset URLs produced for non-inlined workspace assets are rewritten to
the caller's Show Page base; an unmappable `/@fs/` URL is removed rather than
leaking a local path.

## Workspace authority boundary

Workspace modules and their render-time dependencies do not execute in the
child process's ordinary Node realm. A custom Vite `ModuleEvaluator` runs transformed
modules in one `node:vm` context per session with string/Wasm code generation
disabled. It supplies only the initial-tree web primitives required by React,
the generated router, and Show UI. `window`, `document`, `fetch`, WebSocket,
host `process`, and inherited environment variables are absent; the exposed
`process.env` contains only the non-secret Vite mode.

The parent transport returns no Node built-in list and rejects every
externalized module request from workspace code. Runtime-owned cleanup and
conversion are imported directly by the child outside that transport, so the
workspace graph has no privileged module or built-in exception to reach.

The VM is backed by Node's process permission model as a second boundary. The
child receives a scrubbed environment and cannot create subprocesses, worker
threads, or native addons. Current Node releases may enforce permission flags on
a `worker_threads` instance, but the Node documentation disclaims inheritance of
the process permission model and process-affecting `execArgv` options there. The
security boundary therefore uses documented process-start flags on a child Node
process rather than relying on that observed but unsupported behavior.

The profile is selected by `process.allowedNodeEnvironmentFlags`, without Node
version parsing. When stable `--permission` is supported, filesystem reads stay
limited to the exact Runtime, Vite, and conversion dependency package roots plus
the configured Show workspace root. Older supported Node versions use
`--experimental-permission`; because that resolver probes package ancestors, its
four allowed paths are the monorepo packages root, installed `node_modules` root,
repository `package.json`, and configured Show workspace root. It does not allow
other repository or host files. Before accepting any command, every new child
must prove that a real file outside all allowed roots returns `ERR_ACCESS_DENIED`.
Any other result logs `ssr-markdown-child-permission-self-check-failed` without a
path or file contents and fails closed as `renderer_unavailable`.

Workspace code has no filesystem capability in either profile. Fixtures verify
that direct built-in imports, `eval`, `Function`, constructor chains from
URL/timers/encoders/Promises/import metadata, and a dynamic-import error cannot
recover a sentinel even when trusted conversion can read its containing workspace
root. Direct `node:fs` use maps to the existing `render_failed` envelope.

The evaluator does not hand host callables or objects to the VM. Pure platform
algorithms (`URL`, `URLSearchParams`, `TextEncoder`, stateful `TextDecoder`,
`atob`, `btoa`, and the monotonic performance clock) run through a
primitive/JSON-only bridge, while realm-local facades own returned objects,
buffers, and errors. This is the pass-through set: its conformance fixture
compares multibyte boundaries, decoder streaming/BOM/fatal modes, URL mutation,
base64 failures, and clock semantics with the active Node host on both supported
CI legs.

The justified shim set is deliberately smaller. `DOMException` is recreated
locally, including legacy codes, because a host Error would expose its host
constructor. `process.env` is a null-prototype object containing only
`NODE_ENV`. Timers, intervals, microtasks, and `MessageChannel` use the
per-command scheduling registry so callbacks cannot outlive a render.
`FinalizationRegistry`, `SharedArrayBuffer`, `Atomics`, and `WebAssembly` remain
unavailable because they cannot satisfy that authority/lifetime policy. Normal
ECMAScript intrinsics such as Array and Promise come directly from the VM realm;
the evaluator does not reconstruct them.

## Public contract

The endpoint remains `GET /sessions/<session_id>/render-markdown`. It accepts the
existing protocol, context, caller-base, and target headers and returns
`text/markdown; charset=utf-8`, `Cache-Control: no-store`, and
`X-Avibe-Render-Cache: hit|miss`. Target paths are validated against the
loopback session application before any SSR work.

Capabilities are:

```json
{"protocol":1,"render_markdown":true,"render_markdown_ssr":true}
```

Errors retain the existing JSON envelope and codes:

| Code | Status | Meaning |
| --- | ---: | --- |
| `session_unknown` | 404 | No session workspace exists |
| `invalid_target` | 400 | Target escapes or is not rooted in the session app |
| `render_failed` | 502 | Module evaluation or rendering is SSR-incompatible |
| `render_timeout` | 504 | A phase deadline expired |
| `output_too_large` | 502 | Raw, cleaned, or Markdown output exceeds the cap |
| `renderer_unavailable` | 503 | The terminable child cannot start or continue |

There is no HTML or browser fallback. Effects and event handlers do not run.

## Bounds and cancellation

The single renderer-wide mutex is the concurrency owner. Queue wait is outside
all phase budgets. Once admitted, these independent defaults apply:

| Phase | Default | Environment | CLI |
| --- | ---: | --- | --- |
| module/session load | 10 s | `VIBE_SHOW_RENDER_LOAD_TIMEOUT_MS` | `--render-load-timeout-ms` |
| React render | 5 s | `VIBE_SHOW_RENDER_REACT_TIMEOUT_MS` | `--render-react-timeout-ms` |
| cleanup + conversion | 5 s | `VIBE_SHOW_RENDER_CONVERSION_TIMEOUT_MS` | `--render-conversion-timeout-ms` |

Caller disconnect and runtime shutdown signals race every phase wait. A timeout
or cancellation during child work kills the process, which hard-stops synchronous
module evaluation, React rendering, and conversion. An unexpected child exit fails
the active request; the next request lazily starts a fresh child, repeats the
permission self-check, and reloads only the needed session. Main-thread
fingerprinting and live-Vite preparation use the load budget; a late result is
discarded after cancellation or timeout.

Workspace-scheduled work cannot outlive its load or render command: exposed
timers, microtasks, and `MessageChannel` callbacks share one command registry,
Promise and module-transport jobs quiesce before reply, delayed host intrinsics
are absent, and a deadline kills the child.

Raw HTML, cleaned HTML, and final Markdown use the existing 512 KiB default
limit (`VIBE_SHOW_RENDER_MAX_BYTES` / `--render-max-output-bytes`). Phase timing
events record `ok`, `error`, `timeout`, or `cancelled` without exposing page
source or stack traces to the caller.

## Cache and invalidation

The exact key is the JSON encoding of:

```text
["ssr-initial-tree-v1", sessionId, workspaceFingerprint,
 context, normalizedTarget, normalizedCallerBasePath]
```

The LRU holds at most 64 entries per session and 256 globally. Entries retain
their creation timestamp across hits and expire after 30 seconds. Expired
entries are removed during lookup, write, and the five-second idle maintenance
pass.

Workspace watcher events evict the session's Markdown entries, fingerprint
memoization, and child evaluation state. Every lookup also recomputes the
workspace fingerprint; a mismatch invalidates the Vite SSR graph and child
state even if a watcher event was missed. Session suspend and idle pruning clear
the same state before releasing the live Vite server.

## Router migration

Runtime migrates only byte-identical, hash-known generated routers. The current
ledger contains the History-mode router shipped from runtime#53 through
runtime#65:

```text
631249e584e3cd2464d28fcba2f5b9dad2ba7991a5f42479002ae3405ce86a2a
```

Any byte modification makes the router workspace-owned and ineligible. A custom
router remains untouched; browser-global access during its module evaluation or
render returns `render_failed`. An existing App-only workspace remains
routerless and renders `src/App.tsx` directly. If neither App nor router exists,
the unchanged module-load failure maps to `render_failed`.

## Measured fixture result

Measured in three fresh processes through the production `render-markdown`
endpoint on an Apple M1 Pro, Node 24.8.0, darwin-arm64. The cold request includes
session Vite warm-up and the first child/module load. Warm misses vary the query
to bypass the Markdown result cache; cache hits still recompute the workspace
fingerprint.

| Measurement | Result |
| --- | ---: |
| cold request | 1,571-1,680 ms |
| cold load | 1,539-1,644 ms |
| cold render / conversion | 4.9-5.3 / 6.7-7.1 ms |
| warm miss median / p95 | 6.81-7.82 / 10.71-10.87 ms |
| cache hit median / p95 | 0.80-0.86 / 1.54-1.64 ms |
| RSS before cold | 110.3-110.6 MiB |
| RSS after cold (delta) | 467.6-500.5 MiB (+357.3-389.9 MiB) |
| RSS after 20 warm misses | 484.5-508.5 MiB |

RSS after child startup is the OS-reported sum for the Runtime parent and active
SSR child, rather than the parent's `process.memoryUsage()` alone. The benchmark
created no browser cache. Run `npm run benchmark:ssr-markdown` to reproduce the
endpoint, phase, memory, and sentinel check.

## Removed surface

Phase 2 removes Playwright discovery, provisioning, pooling, navigation and
settling; the production snapshot builder and `render-app` route;
`render-snapshot.ts`; browser timeout/CLI policy; and the `playwright-core`
dependency. Bundle verification rejects Playwright or Puppeteer packages.

Release ordering remains external to this repository: publish and verify a new
Runtime prerelease, then let Avibe Phase 3 gate on `render_markdown_ssr` and pin
that verified asset. Never pair the new Avibe path with an older runtime that
only advertises `render_markdown`.
