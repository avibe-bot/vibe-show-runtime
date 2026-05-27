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
npm run build
npm run build -w @avibe/show-example-shadcn-alias
```

The `examples/shadcn-alias` app demonstrates the agent-facing alias model.
The `examples/service-handler` package demonstrates the first handler type
shape.

## Status

This project is pre-release. The package names and high-level boundaries are
intended to be stable, but runtime sidecar APIs will evolve as Vibe Remote
integration starts.
