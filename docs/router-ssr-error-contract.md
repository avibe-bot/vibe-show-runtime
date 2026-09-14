# Router SSR error contract

Companion to avibe-bot/avibe#1984. The Avibe orchestrator owns scaffold resource
generation, migration of byte-exact old Python templates, packaging, and the
Python-to-Runtime integration test. This Runtime change owns only the typed
failure boundary and its endpoint/log regression coverage.

When a non-root Markdown request has no renderable `SsrRouterProvider`, the worker
must send `code: "router_not_ssr_capable"` through the existing error protocol.
The parent returns HTTP 502 with that code and this fixed public message:

> This Show Page router does not support Markdown for subpages. Export an SSR-capable SsrRouterProvider from src/router.tsx.

The structured `ssr-markdown-render-failed` log must expose that same code and
message. Arbitrary workspace exceptions and stacks remain sanitized. Root-only
fallback, browser HTML, and all workspace files retain their existing behavior.
Use real endpoint/worker tests for legacy, absent, and invalid providers; include
a log assertion and preserve generic-error sanitization coverage.

Do not change the router template API or add dependencies. The companion Avibe
change uses the already shipped `ensureSessionTemplate()` and SSR provider
contracts, so neither PR needs to be stacked on the other.
