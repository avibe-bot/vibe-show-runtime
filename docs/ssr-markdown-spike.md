# SSR Markdown Phase 1 Spike Findings

Issue: [avibe-bot/avibe#1617](https://github.com/avibe-bot/avibe/issues/1617)

Status: the repository fixtures prove that the initial Show Page React tree can be
loaded through Vite SSR, rendered by React DOM Server, cleaned, and converted by
Turndown without starting or provisioning a browser. The existing Playwright path
remains the active public endpoint path for this bounded spike; it is not deleted.

## Chosen Production Shape

Choose one long-lived Vite SSR module graph per live Show session. Do not add an SSR
build fallback.

The Runtime already owns this graph for the human Vite path, including dependency
preparation, aliases, the workspace file boundary, Tailwind/CSS transformation,
static assets, and file watching. Calling `ssrLoadModule` on that graph adds one
server evaluation mode without creating a second artifact lifecycle. An SSR build
would duplicate dependency preparation, cache storage, invalidation, and cleanup
while the live graph still has to exist for the human path.

A Runtime virtual SSR entry imports React, React DOM Server, App, and its router
provider, then performs the render inside that module. Each request loads that entry
once, so the renderer and complete tree use one session module-graph snapshot and one
React/context identity even while the watcher invalidates modules. A fixture runtime
whose dependency root contains a physically separate React installation passes; the
Runtime package does not bind SSR to its own React copy.

The measured incremental cost supports this choice. On an already-live session, the
first SSR module load took about 61-65 ms and subsequent complete render/clean/convert
runs had a median around 1 ms. The Vite watcher also invalidated a changed
route module and the next SSR request returned the new content.

## Production Cache Identity

The exact proposed Markdown cache key is the JSON serialization of this ordered
tuple:

```text
[
  "ssr-initial-tree-v1",
  sessionId,
  workspaceFingerprint,
  "private" | "shared",
  normalizedPathnameAndQuery,
  normalizedCallerBasePath
]
```

`ssr-initial-tree-v1` is the representation-contract version. The session ID is an
isolation boundary, the SHA-256 workspace fingerprint is the content version, the
target preserves pathname and query ordering, and context/base path cover
caller-visible link rewriting. A representation behavior change increments the
contract version.

The invalidation signal is a Vite workspace watcher `add`, `change`, `unlink`,
`addDir`, or `unlinkDir` event under the canonical session workspace. Vite invalidates
the affected SSR module graph itself. Phase 2 should use the same event to evict that
session's Markdown entries and invalidate its fingerprint memo. Recomputing the
workspace fingerprint before a cache lookup remains the correctness backstop for a
missed/coalesced watcher event. A dependency signature change already causes the
Runtime to replace the live Vite session.

## CSS And Static Assets

Vite owns both behaviors; SSR does not invent another asset pipeline.

- A route-level CSS import is transformed and watched by Vite but produces no
  semantic HTML and therefore no Markdown. The fixture CSS import completed without
  a crash.
- The fixture's imported SVG was below Vite's inline threshold, so SSR returned a
  `data:image/svg+xml` URL and the Markdown image preserved it. A forced non-inline
  import returned Vite's canonical `/@fs/` URL; cleanup proved containment in the
  canonical workspace, removed the absolute local path, and emitted a caller-base
  URL (`/show/<session>/src/...`) instead.
- The browser-only vendor import-map plugin now steps aside for `options.ssr`; the
  session Vite graph resolves the real React, React DOM Server, and Show UI packages
  from the prepared dependency root. Browser transforms retain the existing import-map
  behavior.

## Cancellation And Bounds

The spike accepts an `AbortSignal`, races asynchronous module loading, and checks the
signal before and after every phase. The cancellation test aborts a pending load and
proves that React render, cleanup, and conversion never start.

| Phase | Spike behavior | Phase 2 hard bound |
| --- | --- | --- |
| Session warm / module load | Abort race plus boundary checks; a Vite transform already running may finish in the background, but its result is discarded | Independent load deadline and caller-disconnect signal; close/recycle a poisoned session after timeout |
| React render | Signal checked immediately before and after synchronous `renderToStaticMarkup` | Run server evaluation/render in a worker so timeout or disconnect can terminate CPU-bound or non-returning page code |
| HTML cleanup | Signal checked immediately before and after structured parse/cleanup; raw and cleaned HTML have byte caps | Run in the same terminable worker with an independent cleanup deadline |
| Turndown conversion | Signal checked immediately before and after conversion; Markdown has a final byte cap | Independent conversion deadline in the worker and final response-size enforcement in the owner process |

Boundary checks are sufficient to prove cancellation propagation and skipped work,
but they cannot interrupt synchronous JavaScript while it holds the event loop. Phase
2 must not claim hard cancellation until the worker boundary exists.

## Measurements

Measured across five independent runs on 2026-08-27 with Node v22.19.0 on an
Apple M1 Pro (32 GiB, macOS arm64), using a new empty temporary Vite/vendor cache
for each run and the repository semantic + nested-route fixture:

| Measurement | Result |
| --- | ---: |
| Completely cold session warm | 0.68-0.77 s |
| First SSR after session warm | 73.37-78.21 ms |
| Completely cold total | about 0.75-0.85 s |
| First SSR module load | 60.81-64.76 ms |
| First React render | 4.77-5.75 ms |
| First cleanup | 2.90-2.99 ms |
| First Turndown conversion | 4.30-4.85 ms |
| Warm complete SSR, median of 20 | 0.96-1.11 ms |
| Warm complete SSR, p95 of 20 | 3.58-4.54 ms |
| RSS added by cold live session | 85.0-89.6 MiB |
| RSS added by first SSR | 7.3-8.7 MiB |
| RSS added by 20 warm SSR runs | 0.4-0.5 MiB |

The benchmark created no Playwright browser cache. Reproduce it with
`npm run benchmark:ssr-markdown`.

## Error Contract

The existing exact error for browser-only access at module evaluation or React render
time is `render_failed`, HTTP 502. Both `window` at module evaluation and `document`
during render are fixture-tested. A page-originated error named `AbortError` also maps
to this envelope unless the request's own signal has actually been cancelled. There is
no browser or HTML fallback.

## Fixture Matrix

| Fixture | Proven behavior |
| --- | --- |
| Semantic index | `h1`/paragraph Markdown, built-in Card/Badge, CSS import, SVG import, pre-effect `Loading...` tree |
| Nested `teams/[team]` | Server pathname, dynamic param, query, generated Link, and page-base relative URL resolution |
| Cleanup markup | `data-agent-hidden`, script, and style removal; `agent-note` blockquote preservation |
| Module-window | Top-level `window` maps to deterministic `render_failed` |
| Render-document | Render-time `document` maps to deterministic `render_failed` |
| Render-abort | A page-owned `AbortError` maps to `render_failed` while the request is active |
| Session-react | A hook renders with a physically independent dependency-root React installation |
| Cancellation harness | Abort stops the pipeline before render and conversion |
| Watcher mutation | Workspace fingerprint/cache key changes and Vite SSR returns edited content |

## Phase 2 Replacement

Replace the implementation behind `render-markdown` with the module-graph SSR
orchestrator, per-session result cache, worker boundary, and structured phase
diagnostics. Then remove the superseded browser surface in one release:

- delete browser discovery, provisioning, pooling, navigation, network-idle, frame
  settling, and browser timeout code from `markdown-renderer.ts`;
- delete `render-snapshot.ts` and the internal `render-app` snapshot-serving route;
- remove `playwright-core`, browser CLI/options/types, provisioning messages, and
  browser-specific tests and README text;
- retain `markdown-core.ts`, Turndown/GFM behavior, the workspace fingerprinter,
  cleanup rules, output limits, and the public error envelope.

Phase 2.1 replaced the spike's proposed file migration with runtime feature
detection. Full SSR fidelity requires the current router contract; older
workspaces render root-only; the Runtime never modifies user workspace files.
A custom router that reads browser globals during module evaluation or render
remains outside the SSR contract and fails with `render_failed`.
