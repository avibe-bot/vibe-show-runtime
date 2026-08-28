# Vibe Show Runtime

Vibe Show Runtime powers interactive Show Pages for Vibe Remote.

It is a managed local Node/Vite runtime for agent-authored visual services:
agents write React UI and optional Web-standard handlers, while Vibe Remote
owns authenticated routing, sharing, and session identity.

This repository is intentionally small and modular. The first milestone is to
make shadcn-style UI available to agents without asking every session to run
the shadcn CLI or install dependencies.

## Packages

```text
@avibe/show-runtime   Vite runtime helpers and, later, the managed sidecar
@avibe/show-ui        shadcn-style UI SDK published as normal npm imports
@avibe/show-sdk       Agent-facing client and handler API
```

## Agent UI Model

Agents can use the standard shadcn import style:

```tsx
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
```

The runtime maps those imports to the shared package:

```text
@/components/ui/* -> @avibe/show-ui/*
@/lib/utils       -> @avibe/show-ui/utils
```

This keeps generated code close to common shadcn examples while avoiding
per-session component scaffolding.

Direct package imports are also supported:

```tsx
import { Button } from "@avibe/show-ui/button"
```

## Show Page Interaction Model

`@avibe/show-sdk` owns the shared interaction contract between Show Pages,
Vibe Remote, and agents. It includes typed Show events, mark attributes,
anchor collection/resolution helpers, browser submit clients, and low-level
React primitives for product integrations.

Agent-authored pages should stay normal Show Pages. Agents should add stable
`mark-*` anchors to content that users or agents may need to reference, and use
ordinary page controls when the question or workflow is already structured.

```tsx
export default function App() {
  return (
    <main>
      <section mark-default="summary.conclusion">
        Quarterly conclusion
      </section>

      <form>
        <button name="decision" value="approve">Approve</button>
        <button name="decision" value="revise">Revise</button>
      </form>
    </main>
  )
}
```

The target product model is for the Vibe Remote Web UI shell around Show
Runtime to mount the live interaction layer, rather than asking every
agent-authored page to hand-wire it. That layer turns structured controls,
selections, area comments, annotations, and agent marks into the same session
event pipeline. The React exports under
`@avibe/show-sdk/react` are implementation primitives and escape hatches for
product code, not the default authoring style for agents.

Supported event families include `human.intent.submitted`,
`human.annotation.*`, `assistant.mark.*`, `assistant.page.updated`, and
`system.runtime.*`. Private Show Pages submit to `__show/events`; the runtime
also exposes the same endpoint as an SSE stream for replay and live updates.

## Theme Customization

The workspace theme import exposes the standard shadcn token contract. Define
complete CSS colors on `:root`, and override the same tokens under `.dark` (or
`[data-theme="dark"]`) for dark mode:

```css
:root {
  --radius: 0.75rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --primary: oklch(0.55 0.2 255);
  --primary-foreground: oklch(0.985 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
}
```

The same values drive Tailwind semantic utilities and native CSS:

```tsx
<main className="bg-background text-foreground">
  <section style={{ borderColor: "var(--border)" }} />
</main>
```

An optional provider is available through the normal component alias when a
subtree needs a preset or runtime-computed values. It writes the same standard
variables; complete CSS colors are preferred. Presets follow an ancestor
`.dark` class or `data-theme="dark"` attribute automatically, while explicit
`theme` values intentionally override either palette:

Literal legacy HSL channel lists are normalized during migration. A bare
`var(...)` is treated as a complete color reference; wrap a variable that
stores channels explicitly, for example `hsl(var(--brand-hsl))`.

```tsx
import { ThemeProvider } from "@/components/ui/theme"

export default function App() {
  return (
    <ThemeProvider
      preset="zinc"
      theme={{
        radius: "0.75rem",
        colors: {
          primary: "oklch(0.55 0.2 255)",
          background: "oklch(1 0 0)",
          foreground: "oklch(0.145 0 0)"
        }
      }}
    >
      <Dashboard />
    </ThemeProvider>
  )
}
```

Because the provider scopes those variables to its own element, overlays that
would otherwise portal to the document body render inside the nearest provider
instead, so a dialog carries the same preset and inline tokens as the page. Pass
an explicit `container` to opt out.

## Examples

```bash
npm install
npm run check
npm run smoke
npm run build -w @avibe/show-example-shadcn-alias
```

The `examples/shadcn-alias` app demonstrates the agent-facing alias model.
The `examples/service-handler` package demonstrates the first handler type
shape.

## Runtime Server

The first runtime server is available through `@avibe/show-runtime`:

```bash
npx avibe-show-runtime --workspace-root .show --port 4177
```

Local API:

```text
GET  /health
GET  /capabilities
POST /sessions/:sessionId/ensure
GET  /sessions/:sessionId/status
GET  /sessions/:sessionId/render-markdown
GET  /sessions/:sessionId/events
POST /sessions/:sessionId/events
GET  /sessions/:sessionId/messages
POST /sessions/:sessionId/suspend
ANY  /sessions/:sessionId/app/*
```

`render-markdown` loads a Runtime-owned virtual entry through the live session's
dedicated Vite SSR environment, renders the initial React tree in a terminable
permission-restricted Node child process, removes non-semantic and
annotation-overlay markup in the child's Runtime-owned layer, and returns GFM
Markdown.
React effects are not run. `x-vibe-show-target` selects a root-relative SPA path
and query; it defaults to the app root and rejects traversal or absolute targets.
The capability probe reports `render_markdown_ssr: true` for this representation.

The runtime's single renderer-wide queue owns SSR concurrency. Queue wait is
outside the phase budgets; module load, React render, and conversion have
independent defaults of 10 seconds, 5 seconds, and 5 seconds. Configure them with
`--render-load-timeout-ms`, `--render-react-timeout-ms`, and
`--render-conversion-timeout-ms`. Cache TTL and output size remain configurable
with `--render-cache-ttl-ms` and `--render-max-output-bytes` (defaults: 30 seconds
and 512 KiB). The Markdown cache is bounded to 64 entries per session and 256
globally, with Vite watcher invalidation and workspace fingerprint recomputation
as the correctness backstop. See [SSR Markdown Renderer](docs/ssr-markdown-renderer.md)
for the cache identity, cancellation model, legacy-router policy, and measured
fixture results.

`/sessions/:sessionId/app/api/*` dispatches to Web-standard handlers in the
session workspace:

```ts
export function GET(_request: Request, context: VibeContext) {
  return Response.json({ sessionId: context.session.id })
}
```

## Status

This project is pre-release. The current server is a minimal sidecar suitable
for integration work: it can create session workspaces, serve React through
Vite middleware, resolve shadcn aliases to `@avibe/show-ui`, and dispatch
basic method-based handlers. HMR proxying, LRU eviction, stronger isolation,
and Vibe Remote integration are still in progress.

## Design Docs

- [Runtime plan](docs/plan.md) covers the sidecar, Vite, package, and handler
  execution model.
- [Agent OS interaction design](docs/agent-os-interaction.md) covers the
  Show Page, interaction SDK, annotation, mark, session event, and Agentation
  reference model.
- [Agent OS implementation plan](docs/agent-os-implementation-plan.md) breaks
  the design into repo-scoped milestones, PR order, and acceptance criteria.
