# SSR Markdown Renderer

Status: Phase 2 implementation for avibe#1617. This replaces the Markdown
browser renderer; it does not change the human-facing Vite application path.

## Production shape

The renderer uses the long-lived SSR module graph of each live session's Vite
server. It does not create an SSR build or a second Vite server.

```text
runtime main thread
  live session Vite SSR module graph
  workspace fingerprint and Markdown LRU
  one renderer-wide concurrency mutex
  Vite fetchModule RPC owner
                  |
                  v
one terminable Node worker
  Vite ModuleRunner evaluation cache per session
  React DOM Server render
  structured HTML cleanup
  Turndown + GFM conversion
```

The Runtime-owned virtual entry imports the page `App`, generated router
provider, React DOM Server, and conversion helper through one session SSR graph.
That preserves the session's physical React instance across application,
provider, and renderer.

CSS imports are transformed by Vite and do not contribute text to the SSR tree.
Small static assets follow Vite's normal SSR behavior and can become data URLs.
Filesystem asset URLs produced for non-inlined workspace assets are rewritten to
the caller's Show Page base; an unmappable `/@fs/` URL is removed rather than
leaking a local path.

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
endpoint on an Apple M1 Pro, Node 24.8.0, darwin-arm64. The cold request includes
session Vite warm-up and the first worker/module load. Warm misses vary the query
to bypass the Markdown result cache; cache hits still recompute the workspace
fingerprint.

| Measurement | Result |
| --- | ---: |
| cold request | 985-1,188 ms |
| cold load | 952-1,154 ms |
| cold render / conversion | 4.7-5.2 / 6.4-7.2 ms |
| warm miss median / p95 | 7.5-8.9 / 12.2-18.6 ms |
| cache hit median / p95 | 0.91-0.95 / 2.0-2.1 ms |
| RSS before cold | 110-114 MiB |
| RSS after cold (delta) | 252-270 MiB (+139-159 MiB) |
| RSS after 20 warm misses | 269-310 MiB |

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
