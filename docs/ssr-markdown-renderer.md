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
  canonical module + optimizer provenance owner
                  |
                  v
one long-lived, terminable Node child process
  process permission profile + boot self-check
  fresh restricted VM realm + ModuleRunner graph per cache miss
    React DOM Server render
  Runtime-owned trusted layer
    structured HTML cleanup
    Turndown + GFM conversion
```

The Runtime-owned virtual entry imports the page `App` and React DOM Server
through one session SSR graph. If `src/router.tsx` exists, the entry imports its
namespace and detects a function or React exotic `SsrRouterProvider` export.
Current routers use that provider for full target fidelity; older routers and
App-only workspaces render `App` directly at the root document. That preserves
the session's physical React instance across application, optional provider,
and renderer.
Cleanup and conversion do not compose React values, so they run in the same
terminable child process's trusted Runtime layer rather than in the workspace VM.
React render, raw-output enforcement, cleanup, and Turndown run as one child
command. Raw and cleaned HTML never cross IPC; only bounded Markdown or a bounded
serialized error returns to the Runtime parent.

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
modules in a fresh `node:vm` context for each uncached render with string/Wasm
code generation disabled. It supplies only the initial-tree web primitives
required by React, the generated router, and Show UI. `window`, `document`,
`fetch`, WebSocket, host `process`, and inherited environment variables are
absent; the exposed `process.env` contains only the non-secret Vite mode.

`WorkspaceFileBoundary` is the single source-file authority for the Markdown
environment. Direct module loads, raw/static-asset loaders, and every file input
to dependency prebundling call the same resolved/canonical target validator
before a loader reads bytes. The optimizer is retained because an explicit
no-optimizer experiment made the fully inlined React/Show UI graph and a CJS
declared extra fail: Vite's development transform does not convert those CJS
entries for the authority-free evaluator, and external modules are deliberately
unavailable. Extras sessions therefore link the pinned shared React packages
into their private install and prebundle that one physical singleton.

Optimizer provenance is bounded in both directions. Its entry targets are
validated before Vite inspects exports, its esbuild file loader validates every
transitive input, and only `deps_avibe_show_markdown` is readable later; client,
temporary, or arbitrary cache artifacts are denied even though the human Vite
server may use them. The Vite cache identity includes
`ssr-markdown-acquisition-v1`, so artifacts produced before this policy cannot
be reused under the new boundary.

A configured dependency root may be a symlink forest. Its canonical package
targets are accepted only as Markdown dependency origins after the same target
validation; they are not added to the human HTTP request roots. Direct requests
for unrelated Runtime or repository source therefore remain denied.

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

### Content acquisition audit

Every subsystem that can supply bytes or executable source to the Markdown
environment is either governed by the canonical validator or removed from that
environment's content path:

| Subsystem | Ownership or elimination | Regression evidence |
| --- | --- | --- |
| Vite module transport and in-memory transforms | Resolved/canonical source target is validated in the pre-load hook before raw, asset, or normal loaders run; transform caches can only be populated after that load | Sibling-session raw, host-file raw, symlink escape, and direct static-asset attacks return the generic `render_failed` envelope |
| Dependency optimizer inputs | Required for React and CJS compatibility; every manual entry is validated before export inspection and every esbuild `file` load calls the same canonical validator | A declared extra importing `../../../optimizer-secret/secret.js` is rejected before its secret can enter an artifact |
| Optimizer and other Vite cache artifacts | Only the contract-versioned `deps_avibe_show_markdown` provenance root is readable; client, temporary, stale-contract, and arbitrary cache artifacts are denied | A synthetic client-cache module containing a sentinel returns `render_failed` without disclosure |
| CSS pipeline | The canonical entry is validated, then replaced with an empty module before Vite CSS processing; nested `@import` and `url()` acquisition is eliminated | A CSS entry importing a sibling secret still renders semantic page content and never acquires the secret |
| Raw and static-asset pipeline | Canonical source target is validated before Vite's query/asset loader reads or inlines it | Denied sibling asset plus allowed SVG inline and caller-base URL fixtures |
| Shared-package and declared-extra resolution | Resolvers supply IDs only; optimizer/module bytes still pass through the validator. Pinned React links preserve one physical instance; configured symlink targets are scoped to Markdown and do not widen HTTP roots | Legitimate ESM/CommonJS extras render on both Node legs; the custom dependency-root smoke passes while direct Runtime-source HTTP access remains denied |
| Runtime virtual entry and Vite-generated wrapper namespaces | No workspace-origin bytes: sources are Runtime/Vite-owned constants; any file they subsequently import returns to a governed path | Routed and App-only entry fixtures, plus the Runtime virtual-entry regression |
| Human client optimizer/cache | Remains available to the browser environment but is not a readable Markdown origin | The explicit cross-environment cache-artifact fixture is denied |
| `import.meta.env` | Not module content: the complete object is supplied by Vite after its `envPrefix` filtering; Runtime neither reads arbitrary host env nor reconstructs keys | Custom `VITE_` branch/URL matches the human environment while a non-prefixed host variable stays absent |
| Cleanup URL handling | Conversion resolves filesystem URLs with `realpath` only; it never reads asset bytes, and removes paths outside the rendered workspace | Unmappable `/@fs/` URLs are removed; workspace asset URLs rewrite to the caller base |

The ordinary `api/*` Node SSR environment and the human client pipeline do not
consume this Markdown module graph and remain unchanged.

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

Every failed render emits exactly one `ssr-markdown-render-failed` JSON event.
It records the session, the failing `load`, `render`, `cleanup`, or `conversion`
phase, a bounded error class, and at most 512 UTF-8 bytes of the normalized
public-safe error message. Arbitrary workspace and Vite error text is never used
for those fields, so the event cannot log a stack or module/file body. The public
error envelope remains unchanged.

Every cache miss creates a new evaluator and `ModuleRunner`, imports the entry,
renders once, and closes that graph in a `finally` path. The live session Vite
environment keeps its transform/module graph caches, so fresh module instances
do not require a second Vite server or build. A Markdown result-cache hit does
not contact the child at all. Module-level state from one target therefore cannot
be observed by a later uncached target in the same session.

### Child-process seam audit

Every value crossing between workspace-evaluated code and the Runtime parent has
an explicit size, lifetime, or reset owner:

| Seam | Bound or reset | Regression evidence |
| --- | --- | --- |
| Module instances | Fresh evaluator and runner for each uncached render; close on load failure and after render success/failure | Module counter resets to one; target-A store state is absent from target B; cache hits bypass evaluation |
| Parent to child commands | 64 KiB logical UTF-8/control budget, bounded depth and entry count, checked before send and again on receipt | Oversized resolved Vite env is rejected before `fetchModule` runs |
| Child to parent module requests | 64 KiB control budget before send and on receipt | Workspace-generated oversized dynamic-import specifier returns `render_failed` without crossing or leaking the specifier |
| Parent to child module responses | 16 MiB per transformed module and 64 MiB cumulative per render, enforced before send | Oversized transformed-module integration test plus cumulative-budget unit test |
| Child to parent result | Existing configured raw/cleaned/Markdown cap plus fixed framing; only `{markdown}` crosses | Oversized raw HTML returns `output_too_large`; captured IPC contains neither HTML nor page text |
| Errors in either direction | 8 KiB serialized-error budget; bounded name/message/stack/code fields; public response remains the generic existing envelope | A workspace-thrown oversized error is truncated in IPC and absent from the response |
| Scheduling and module transport jobs | Per-command registry disposes timers, intervals, immediates, microtasks, and message tasks; transport promises quiesce before reply | Busy module-level interval cannot fire after its command or delay the next render |
| Phase time and cancellation | Independent 10 s load, 5 s render, and 5 s conversion budgets; child flushes a phase transition before conversion; timeout/disconnect hard-kills it | Hung load/render and fake conversion each time out; caller disconnect kills; next request respawns and succeeds |
| Session and process lifecycle | Watcher/fingerprint/suspend/idle invalidation closes session state; crash rejects all pending RPC and drops all child state | Existing invalidation suite plus kill/respawn integration tests |

The control/module/error budgets are internal protocol limits, not new public
configuration or error codes. A protocol overflow maps through the existing
`render_failed` envelope; a raw, cleaned, or Markdown overflow remains
`output_too_large`.

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
memoization, and child evaluation state. Every
lookup also recomputes the workspace fingerprint; a mismatch invalidates the
Vite SSR graph and child state even if a watcher event was missed. Session
suspend and idle pruning clear the same state before releasing
the live Vite server.

## Router compatibility

Full SSR fidelity requires the current router contract; older workspaces render
root-only; the Runtime never modifies user workspace files. A router exporting
a renderable function or React exotic `SsrRouterProvider` receives the requested
path, params, and query. A router without that export, or an App-only workspace,
renders `src/App.tsx` only for
`/`; a non-root target returns `render_failed` rather than misrepresenting the
root route. If neither App nor router exists, the unchanged module-load failure
maps to `render_failed`.

## Measured fixture result

Measured in three fresh processes through the production `render-markdown`
endpoint on an Apple M1 Pro, Node 24.8.0, darwin-arm64. The cold request includes
session Vite warm-up and the first child/module load. Warm misses vary the query
to bypass the Markdown result cache and therefore create a fresh module-instance
graph while reusing Vite transforms; cache hits still recompute the workspace
fingerprint but never contact the child.

| Measurement | Result |
| --- | ---: |
| cold request | 1,840-1,998 ms |
| cold load | 1,806-1,964 ms |
| cold render / conversion | 5.6-5.9 / 6.6-7.1 ms |
| warm miss median / p95 | 113.82-123.84 / 137.82-173.57 ms |
| cache hit median / p95 | 1.04-1.13 / 1.68-2.04 ms |
| RSS before cold | 112.2-116.2 MiB |
| RSS after cold (delta) | 502.6-506.0 MiB (+386.4-393.8 MiB) |
| RSS after 20 warm misses | 835.3-861.1 MiB |

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
