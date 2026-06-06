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
import { ThemeProvider } from "@avibe/show-ui/theme"
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

`@avibe/show-ui` uses CSS-variable-backed tokens. Agents can use presets or
override tokens directly:

```tsx
import { ThemeProvider } from "@avibe/show-ui/theme"

export default function App() {
  return (
    <ThemeProvider
      preset="zinc"
      theme={{
        radius: "0.75rem",
        colors: {
          primary: "221 83% 53%",
          background: "0 0% 100%",
          foreground: "222 47% 11%"
        }
      }}
    >
      <Dashboard />
    </ThemeProvider>
  )
}
```

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
The `examples/local-decisions` app demonstrates a front-end-only template that
stores decisions in `localStorage` and copies the full decision JSON without
posting to the runtime server.

## Runtime Server

The first runtime server is available through `@avibe/show-runtime`:

```bash
npx avibe-show-runtime --workspace-root .show --port 4177
```

Local API:

```text
GET  /health
POST /sessions/:sessionId/ensure
GET  /sessions/:sessionId/status
GET  /sessions/:sessionId/events
POST /sessions/:sessionId/events
GET  /sessions/:sessionId/messages
POST /sessions/:sessionId/suspend
ANY  /sessions/:sessionId/app/*
```

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
