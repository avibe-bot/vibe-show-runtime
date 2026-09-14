# Router SSR error contract

Companion to avibe-bot/avibe#1984. The Avibe orchestrator owns scaffold resource
generation, packaging, and the Python-to-Runtime integration test. This Runtime
change owns the typed failure boundary and read-only SSR compatibility for the
released stock Python History router. The scope was updated by the orchestrator
in Avibe commit `3a49e340d`, `docs/plans/show-router-ssr-scaffold.md`.

When a non-root Markdown request has no renderable `SsrRouterProvider`, the worker
must send `code: "router_not_ssr_capable"` through the existing error protocol.
The parent returns HTTP 502 with that code and this fixed public message:

> This Show Page router does not support Markdown for subpages. Export an SSR-capable SsrRouterProvider from src/router.tsx.

The structured `ssr-markdown-render-failed` log must expose that same code and
message. Arbitrary workspace exceptions and stacks remain sanitized. Root-only
fallback, browser HTML, and all workspace files retain their existing behavior.
Use real endpoint/worker tests for legacy, absent, and invalid providers; include
a log assertion and preserve generic-error sanitization coverage.

The existing SSR module plugin substitutes the current Runtime-authored router
only for the ordinary workspace `src/router.tsx` whose exact transform input
matches the released LF or CRLF SHA-256:

- LF: `1154739b3e21e2f1c7f45e3d0b7454dc5541fdf15e2c79bbc2f96f766338706e`
- CRLF: `ed7cbd0aa11a491ac8b7621b8a7ea64d7c83c0b53ec46e950cca95b7f4d0079e`

Reuse the existing `templates.ts` author; never copy its implementation, reread
another source snapshot for matching, or create temporary workspaces. The
compatibility is limited to the `avibe_show_markdown` environment: ordinary API
SSR and HTML/client modules keep their original exports and behavior, regardless
of which environment imports the router first. No files are written. Unknown,
custom, hash, routerless, and symlink routers retain their behavior. Later edits
must take effect through existing module/cache invalidation.

A request overlapping an editor save is not guaranteed a single filesystem
snapshot, but each transform must match its own supplied source. After the real
file-change handler and worker invalidation finish, a single subsequent request
must reflect the saved router. Regression tests observe those actual completion
promises, without triggering invalidation or retrying HTTP requests. HMR may
legitimately send no reload for a module still being analyzed; Vite's initial
request-crawl promise is not a later-edit completion boundary.

Keep the public template API and dependencies unchanged. The Avibe fresh
scaffold uses the already shipped `ensureSessionTemplate()` and SSR provider
contracts. Old-stock SSR compatibility additionally requires Runtime PR #70.
