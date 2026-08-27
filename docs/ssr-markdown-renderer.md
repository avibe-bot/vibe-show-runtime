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
one terminable Node worker
  restricted VM realm + ModuleRunner cache per session
    React DOM Server render
  Runtime-owned trusted layer
    structured HTML cleanup
    Turndown + GFM conversion
```

The Runtime-owned virtual entry imports the page `App`, generated router
provider, and React DOM Server through one session SSR graph. That preserves the
session's physical React instance across application, provider, and renderer.
Cleanup and conversion do not compose React values, so they run in the same
terminable worker's trusted Runtime layer rather than in the workspace VM.

The renderer uses a dedicated Vite environment inside the existing session
server. Its dependency graph is inlined, browser package conditions are used,
and browser-platform CJS entry points are prebundled before VM evaluation. The
ordinary Vite `ssr` environment is unchanged, so `api/*` handlers retain their
existing Node execution model.

CSS imports are transformed by Vite and do not contribute text to the SSR tree.
Small static assets follow Vite's normal SSR behavior and can become data URLs.
Filesystem asset URLs produced for non-inlined workspace assets are rewritten to
the caller's Show Page base; an unmappable `/@fs/` URL is removed rather than
leaking a local path.

## Workspace authority boundary

Workspace modules and their render-time dependencies do not execute in the
worker's ordinary Node realm. A custom Vite `ModuleEvaluator` runs transformed
modules in one `node:vm` context per session with string/Wasm code generation
disabled. It supplies only the initial-tree web primitives required by React,
the generated router, and Show UI. `window`, `document`, `fetch`, WebSocket,
host `process`, and inherited environment variables are absent; the exposed
`process.env` contains only the non-secret Vite mode.

The parent transport returns no Node built-in list and rejects every
externalized module request from workspace code. Runtime-owned cleanup and
conversion are imported directly by the worker outside that transport, so the
workspace graph has no privileged module or built-in exception to reach.

The VM is backed by Node's worker permission model as a second boundary. The
worker receives a scrubbed environment, cannot create subprocesses, nested
workers, or native addons, and may read only the Runtime/Vite packages, the
conversion dependency packages, and configured Show workspace root. The last
permission lets trusted conversion canonicalize asset paths; workspace code has
no filesystem capability. A fixture places a sentinel inside that allowed root
and verifies that direct built-in imports, `eval`, `Function`, constructor chains
from URL/timers/encoders/Promises/import metadata, and a dynamic-import error
cannot read it. Direct `node:fs` use maps to the existing `render_failed`
envelope.

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
| `renderer_unavailable` | 503 | The terminable worker cannot start or continue |

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
or cancellation during worker work terminates the worker, which hard-stops
synchronous module evaluation, React rendering, and conversion. The next
request creates a fresh worker and reloads only the needed session. Main-thread
fingerprinting and live-Vite preparation use the load budget; a late result is
discarded after cancellation or timeout.

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
memoization, and worker evaluation state. Every lookup also recomputes the
workspace fingerprint; a mismatch invalidates the Vite SSR graph and worker
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
render returns `render_failed`.

## Measured fixture result

Measured in three fresh processes through the production `render-markdown`
endpoint on an Apple M1 Pro, Node 22.19.0, darwin-arm64. The cold request includes
session Vite warm-up and the first worker/module load. Warm misses vary the query
to bypass the Markdown result cache; cache hits still recompute the workspace
fingerprint.

| Measurement | Result |
| --- | ---: |
| cold request | 1,510-1,687 ms |
| cold load | 1,476-1,653 ms |
| cold render / conversion | 5.5-5.7 / 7.8-8.3 ms |
| warm miss median / p95 | 7.0-7.2 / 13.5-14.5 ms |
| cache hit median / p95 | 0.85-0.97 / 2.15-2.18 ms |
| RSS before cold | 99-100 MiB |
| RSS after cold (delta) | 327-372 MiB (+227-272 MiB) |
| RSS after 20 warm misses | 337-383 MiB |

The benchmark created no browser cache. Run `npm run benchmark:ssr-markdown`
to reproduce the endpoint, phase, memory, and sentinel check.

## Removed surface

Phase 2 removes Playwright discovery, provisioning, pooling, navigation and
settling; the production snapshot builder and `render-app` route;
`render-snapshot.ts`; browser timeout/CLI policy; and the `playwright-core`
dependency. Bundle verification rejects Playwright or Puppeteer packages.

Release ordering remains external to this repository: publish and verify a new
Runtime prerelease, then let Avibe Phase 3 gate on `render_markdown_ssr` and pin
that verified asset. Never pair the new Avibe path with an older runtime that
only advertises `render_markdown`.
