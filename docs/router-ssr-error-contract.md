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

## Compatibility review decision

The orchestrator independently diagnosed two findings-bearing review heads:
`17637f8` changed the old router's exported route fields in ordinary API SSR;
`0c9d99c` still changed them for Markdown consumers and removed the legacy root
location facade. A real root Motion consumer also changed from static to
non-static. These share the root cause of replacing a legacy module without
preserving its observable contract. The repeated-class circuit breaker stopped
lane edits, and the orchestrator explicitly authorized the bounded correction
below. Any further findings-bearing head after this correction requires a new
orchestrator diagnosis before editing or pushing.

The existing router author has one internal legacy-SSR variant. It preserves
the old route fields, including `dynamic`, segments, ordering, page-component
identity, and existing function exports. Provider/query support is additive.
Its default fresh-scaffold output remains byte-identical, SHA-256
`8c52b21c4b71edfc1dcfefaa8c02d61c3f67ad741719dce6d9dbe78e5240c489`.
Do not create a second router implementation or change the public template API.

An internal module marker identifies the legacy-compatible render context in
the existing entry/worker flow. It is compatibility metadata, never a trust or
privilege grant. Both legacy fallback and compatibility keep Motion static
rendering. Only their root render command gets the existing request-scoped,
frozen, null-prototype, location-only facade. No facade exists during module
loading, in compatibility subpage renders, or for an unmarked modern provider.
History, document, event APIs, mutable browser state, and sandbox authority
remain unavailable. The marker does not change file validation, permissions,
provider capability checks, error sanitization, or the invalidation owner.

Red-before-green evidence at `0c9d99c`: six real HTTP cases (LF/CRLF for route
exports, root location, and Motion) failed on the described contracts while
three semantically equivalent custom-router baseline cases passed. Tests cover
root/nested consumers, private/public bases, Unicode queries, repeated requests,
unchanged router bytes, and the existing modern-provider isolation regression.
Self-review also found that the modern not-found markup removed the legacy
RouterView's inline-code formatting. Two stock LF/CRLF root-without-index cases
failed while the custom baseline passed; the internal variant retains the old
fallback markup as part of the same existing-root contract.
