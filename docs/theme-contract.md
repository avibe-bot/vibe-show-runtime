# Show UI Theme Contract

## Architecture Decision

Show UI uses a static CSS-variable contract. Standard shadcn variables are the
only public theme namespace; the runtime does not rewrite arbitrary authored
styles or emulate browser selector state.

This decision replaces the compatibility-polyfill direction explored in PR
[#60](https://github.com/avibe-bot/vibe-show-runtime/pull/60). At head
`36b83db99c883357cb6ec68a20e14b61bd15197e`, that branch contained 52 commits,
30 changed files, and about 5,252 additions for 191 deletions. Its 169 review
threads spanned 50 findings-bearing heads, with four P2 threads still open.
The repeated root-cause classes were runtime ownership of authored CSS,
cross-origin stylesheet inference, CSSOM mutation interception, selector-state
reconciliation, animation and layout sampling, Shadow DOM traversal, and portal
state copying. Those behaviors were not part of the published Show UI contract.

The smallest complete model is therefore:

1. standard variables own the palette;
2. Tailwind semantic utilities map directly to those variables;
3. normal CSS inheritance and `ThemeProvider` own static scope;
4. private aliases preserve ordinary legacy reads, but never drive the public
   namespace through runtime migration.

## Public Variables

The public contract includes the standard shadcn families:

- base surfaces: `--background`, `--foreground`, `--card`, `--popover` and
  their foreground pairs;
- actions and states: `--primary`, `--secondary`, `--muted`, `--accent`,
  `--destructive` and their foreground pairs;
- controls: `--border`, `--input`, `--ring`, and `--radius`;
- data and navigation: `--chart-1` through `--chart-5`, plus the standard
  sidebar token family;
- Show UI additions: `--success`, `--warning`, and their foreground pairs.

Every color variable contains a complete CSS color. Agent-authored code may
use either semantic Tailwind classes such as `bg-card`, `text-foreground`, and
`border-border`, or native CSS such as `color: var(--foreground)`.

The theme stylesheet must be imported after Tailwind in the workspace entry:

```css
@import "tailwindcss";
@import "@avibe/show-ui/theme.css";
```

## Light And Dark Modes

The light palette is defined on `:root`. A `.dark` class or
`data-theme="dark"` attribute activates the dark palette on that element and
its descendants. Tailwind `dark:*` utilities use the same two selectors.

Theme scopes follow normal CSS inheritance. A scoped value changes only that
subtree. Show UI dialogs created inside `ThemeProvider` portal back into that
provider container so the static scope remains intact.

## ThemeProvider

`ThemeProvider` is an optional convenience for presets and runtime-computed
values. It writes the same standard variables as inline styles. Complete CSS
colors are preferred. For compatibility with the originally documented API,
literal HSL channel values such as `221 83% 53%` are also accepted and emitted
as `hsl(221 83% 53%)`.

Presets are CSS-owned and mode-aware. Explicit `theme` values are inline and
therefore override the selected preset.

## Legacy Compatibility

`--avs-*` names remain private compatibility aliases for ordinary static
pages that still read values through expressions such as
`hsl(var(--avs-primary))`. Default light and dark palettes define those aliases,
and `ThemeProvider` mirrors literal HSL channel overrides where an old alias
exists.

Compatibility is intentionally one-way. A page that authors or mutates an
`--avs-*` declaration does not cause the corresponding public variable to be
created or changed. Existing pages should move authored theme overrides to the
standard namespace.

## Explicit Non-Goals

The theme contract does not promise real-time migration of:

- arbitrary legacy declarations in same-origin or cross-origin stylesheets;
- CSSOM, CSS Typed OM, adopted stylesheet, or imported stylesheet mutations;
- selector state across pseudo-classes, forms, media, containers, or history;
- animation, transition, layout, font, or resource-driven state;
- arbitrary Shadow DOM, closed-root, or portal state outside normal CSS
  inheritance and the Show UI `ThemeProvider` container.

Adding any of these behaviors requires a separately approved public contract
and evidence that the product needs it. They must not emerge as compatibility
patches.
