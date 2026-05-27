# Contributing

Vibe Show Runtime is early-stage. Keep changes small, typed, and covered by
the existing workspace checks.

## Development

```bash
npm install
npm run check
```

## Package Boundaries

- `@avibe/show-runtime` owns runtime and Vite integration.
- `@avibe/show-ui` owns shadcn-style UI primitives and theme tokens.
- `@avibe/show-sdk` owns agent-facing client and handler APIs.

Avoid moving UI implementation details into the runtime package. Avoid making
the SDK depend on the UI package.
