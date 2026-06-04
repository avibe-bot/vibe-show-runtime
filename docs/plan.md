# Vibe Show Runtime Plan

## Summary

Vibe Show Runtime is a standalone Node project that powers service-mode Show
Pages for Vibe Remote.

It should let an agent write a small React app and optional backend handlers in
one session workspace, while avoiding per-session servers, per-session ports,
and per-session dependency installs. Vibe Remote owns product routing and
permissions; this runtime owns React/Vite execution.

## Product Role

Vibe Remote should feel like an AI colleague inside chat. Show Pages are the
visual collaboration surface for that colleague. This runtime makes that
surface interactive and live.

The runtime is not a general app hosting platform. It is a controlled,
session-scoped development and execution environment for agent-authored visual
services.

## First Runtime Mode: `service`

`service` supports both use cases with one stack:

- pure frontend React component work
- React UI plus optional backend handlers

There is no separate `static`, `react`, or `fullstack` mode in the target
model. Static output may exist as a publish artifact, but the development
runtime is service mode.

## Top-Level Architecture

```text
Vibe Remote
  -> starts sidecar
  -> authenticates user
  -> resolves session
  -> proxies /show/<session-id>/...

Vibe Show Runtime
  -> owns Vite contexts
  -> owns shared dependencies
  -> owns handler execution
  -> owns runtime logs/status

Session workspace
  -> contains agent-written app and handlers
```

The sidecar listens only on loopback. It is not public internet surface.

## Runtime API

Initial local API:

```text
GET  /health
POST /sessions/:sessionId/ensure
GET  /sessions/:sessionId/status
POST /sessions/:sessionId/suspend
ANY  /sessions/:sessionId/app/*
WS   /sessions/:sessionId/hmr
```

Vibe Remote calls `ensure` before proxying a cold session. The runtime may
return a warming state and complete startup asynchronously.

Current implementation status:

- `GET /health`
- `POST /sessions/:sessionId/ensure`
- `GET /sessions/:sessionId/status`
- `POST /sessions/:sessionId/suspend`
- `ANY /sessions/:sessionId/app/*`
- `ANY /sessions/:sessionId/app/api/*` method dispatch via Vite SSR module
  loading
- Vite HMR bound to the parent sidecar server with path `__vite_hmr`, so Vibe
  Remote can proxy `/show/<session-id>/__vite_hmr`

## Session Lifecycle

```text
created -> warming -> active -> idle -> suspended
```

Properties:

- created sessions have files and metadata only
- warming sessions are creating Vite context and dependency bindings
- active sessions can serve app requests and HMR
- idle sessions have no recent requests or browser clients
- suspended sessions have closed Vite contexts but retain source files

Policy:

- wake on request
- suspend on idle TTL
- evict by LRU when active context count exceeds the configured limit
- never start contexts for historical sessions until they are accessed

Suggested defaults:

```text
idleTtlMs = 24 hours
maxActiveContexts = 10
startupTimeoutMs = 10 seconds
```

These should be configurable by Vibe Remote.

## Vite Context Model

Use one Node process and one internal port. Inside that process, create one
Vite middleware context per active session.

Reasons:

- HMR and React Fast Refresh stay close to normal Vite behavior
- file system scope is naturally per session
- session errors and module graphs are isolated
- no port growth with session count
- resource growth is bounded by active context count, not total session count

Avoid for v1:

- one Vite server process or port per session
- one global module graph for all sessions

The global graph can be revisited later if active-session memory becomes a real
bottleneck, but it should not be the first design.

## Session Workspace

Default generated files:

```text
index.html
src/App.tsx
src/main.tsx
src/styles.css
api/health.ts       sample handler
```

Minimal app:

```tsx
export default function App() {
  return <main>Hello from this session</main>
}
```

Optional handler:

```ts
export async function GET(request: Request) {
  return Response.json({ ok: true })
}
```

Front-end code calls handlers through relative URLs:

```ts
const data = await fetch("./api/data").then((res) => res.json())
```

## Handler API Design

The runtime should expose familiar server-side ergonomics without letting
agents manage raw server processes.

Target shape:

```ts
export async function GET(request: Request, context: VibeContext) {
  return Response.json({ sessionId: context.session.id })
}

export async function POST(request: Request, context: VibeContext) {
  const body = await request.json()
  await context.kv.set("last-body", body)
  return Response.json({ ok: true })
}
```

`VibeContext` should grow carefully:

```ts
type VibeContext = {
  session: {
    id: string
    workspace: string
  }
  log: {
    info(message: string, data?: unknown): void
    warn(message: string, data?: unknown): void
    error(message: string, data?: unknown): void
  }
  kv: SessionKv
  files: SessionFiles
  fetch: typeof fetch
}
```

First version should support only the subset that can be enforced cleanly:

- method dispatch
- JSON request/response
- route path
- structured logging
- session workspace reads for allowed paths

Later versions can add:

- route params
- streaming responses
- upload handling
- session KV
- background jobs
- explicit outbound network permissions
- allowlisted secrets

## Dependency Strategy

Do not install dependencies per session.

Runtime layout:

```text
~/.vibe_remote/show-runtime/
  versions/
    0.1.0/
      package.json
      node_modules/
      templates/
      runtime/
      vite.config.base.ts
  current -> versions/0.1.0
```

Session imports resolve through the shared runtime dependency tree. This can be
implemented with Vite resolver configuration and/or a thin session-local
`node_modules` symlink to the selected runtime version.

Agents should use real dependency names:

```tsx
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Line } from "react-chartjs-2"
import mermaid from "mermaid"
```

Do not invent custom aliases for common packages unless the package is truly a
Vibe-owned API such as `@avibe/show-ui` or `@avibe/show-sdk`. The shadcn-style
`@/components/ui/*` aliases are intentionally supported to match common agent
priors while still resolving to the shared `@avibe/show-ui` package.

## Package Structure

The project should publish three first-class npm packages under the `@avibe`
organization:

```text
@avibe/show-runtime
@avibe/show-ui
@avibe/show-sdk
```

Responsibilities:

- `@avibe/show-runtime`: sidecar server, Vite contexts, HMR, session lifecycle,
  handler loading, routing, dependency resolution, and alias injection.
- `@avibe/show-ui`: Vibe-owned shadcn-style UI SDK, implemented from shadcn /
  Radix / CSS-variable primitives and published as normal npm imports.
- `@avibe/show-sdk`: agent-facing runtime API for client helpers and controlled
  service handlers.

Recommended monorepo layout:

```text
packages/
  runtime/
  ui/
  sdk/
examples/
  shadcn-alias/
  service-handler/
```

## UI Library Direction

The default UI direction is shadcn-style, but agents should not run the shadcn
CLI inside each session. The runtime should own and publish a shared UI SDK:

```tsx
import { Button } from "@avibe/show-ui/button"
import { Card, CardContent } from "@avibe/show-ui/card"
import { Dialog, DialogContent } from "@avibe/show-ui/dialog"
```

To reduce prompt context and use existing model priors, the runtime should also
support standard shadcn import paths:

```tsx
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
```

Those paths resolve to the shared package:

```text
@/components/ui/* -> @avibe/show-ui/*
@/lib/utils       -> @avibe/show-ui/utils
```

This gives agents the familiar shadcn usage model while preserving shared
dependency management and avoiding per-session source generation.

The project can still include Mantine, MUI, Ant Design, Chakra, or daisyUI as
optional user-installed dependencies later, but they should not be the default
visual system for the runtime.

## Theme Customization

The UI package should expose token-based theming through CSS variables.
Agents should be able to use a preset:

```tsx
import { ThemeProvider } from "@avibe/show-ui/theme"

export default function App() {
  return <ThemeProvider preset="zinc"><Dashboard /></ThemeProvider>
}
```

or override selected tokens:

```tsx
<ThemeProvider
  theme={{
    radius: "0.75rem",
    colors: {
      primary: "221 83% 53%",
      background: "0 0% 100%",
      foreground: "222 47% 11%",
    },
  }}
>
  <Dashboard />
</ThemeProvider>
```

The theme implementation should write CSS variables onto a root element rather
than requiring component source edits. This keeps per-page customization
flexible and cheap, while keeping generated Tailwind class names predictable.

## Default Visualization Dependencies

The default dependency set should align with the current Show Page prompt,
which mentions diagrams, flowcharts, mind maps, timelines, charts, dashboards,
comparison views, React Flow, Mermaid, Markmap, Chart.js, and Cytoscape.js.

Recommended first bundle:

- `mermaid` for text-to-diagram rendering
- `@xyflow/react` for interactive node/edge flows
- `chart.js` plus `react-chartjs-2` for common charts
- `recharts` as an agent-friendly React chart option
- `cytoscape` for graph/network visualization and analysis
- `markmap-lib` and `markmap-view` for Markdown mind maps
- `lucide-react` or `@tabler/icons-react` for icons, depending on UI library

The runtime can expose examples and templates, but agents should import the
real packages directly.

## Security And Isolation

First-version hard rules:

- bind runtime only to `127.0.0.1`
- never expose sidecar directly through Avibe Cloud
- Vibe Remote must authenticate and authorize before proxying
- no `server.listen()` in session code
- no arbitrary process execution from handlers
- session file APIs are scoped to that session workspace
- public sharing should not proxy live handlers until a policy exists

Vite configuration should use strict file-system serving rules and explicit
allow lists. A session must not be able to import another session's source by
path.

## Runtime Updates

The runtime should be versioned independently from Vibe Remote.

Update model:

- runtime releases are npm package versions or signed tarballs
- Vibe Remote records a desired channel and installed versions
- new sessions use the current runtime version
- active sessions keep their current runtime until idle or restart
- suspended sessions can be upgraded lazily on wake if migration is safe
- templates and generated files use explicit migration steps

This allows Vibe Remote to pick up runtime improvements without a Python
package release when the integration contract is unchanged.

Limits:

- changes to Vibe Remote routing, storage, auth, CLI, or prompt behavior still
  require a Vibe Remote release
- breaking runtime API changes require compatibility shims or manifest version
  gates

## Implementation Milestones

### M0: Project Skeleton

- package metadata
- runtime HTTP server
- health endpoint
- logging format
- test harness

### M1: Service App HMR

- session workspace template
- shared dependency store
- one Vite context per active session
- HMR WebSocket under session path
- idle suspend

### M2: Handler Runtime

- `api/index.ts` loader
- method dispatch
- `Request` / `Response` support
- structured errors and logs

### M3: Vibe Remote Integration

- sidecar supervision contract
- proxy contract
- status API
- lifecycle tests

### M4: Publish Snapshot

- build service app to static output
- let Vibe Remote serve public `/p/<share-id>/` from snapshot
- keep live service private by default
