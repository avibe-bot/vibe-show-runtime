import * as React from "react"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ThemeProvider } from "./theme"
import { SHOW_PORTAL_THEME_PROPERTIES } from "./theme-properties"

describe("ThemeProvider", () => {
  it("preserves the zinc default and allows the standard root palette explicitly", () => {
    const defaultMarkup = renderToStaticMarkup(<ThemeProvider><span>content</span></ThemeProvider>)
    expect(defaultMarkup).toContain('data-theme-preset="zinc"')
    expect(defaultMarkup).not.toContain("--primary")
    const rootMarkup = renderToStaticMarkup(<ThemeProvider preset={null}><span>content</span></ThemeProvider>)
    expect(rootMarkup).not.toContain("data-theme-preset")
    expect(rootMarkup).not.toContain("avs-theme")
  })

  it("writes complete CSS colors to the standard shadcn variables", () => {
    const markup = renderToStaticMarkup(
      <ThemeProvider theme={{ radius: "0.75rem", colors: { primary: "oklch(0.62 0.19 255)", cardForeground: "#102030" } }}>
        content
      </ThemeProvider>
    )
    expect(markup).toContain("--radius:0.75rem")
    expect(markup).toContain("--primary:oklch(0.62 0.19 255)")
    expect(markup).toContain("--card-foreground:#102030")
  })

  it("normalizes literal, expression, and variable-backed HSL channels for old workspaces", () => {
    const markup = renderToStaticMarkup(
      <ThemeProvider theme={{ colors: {
        foreground: "var(--brand-color)",
        primary: "var(--brand-hsl)",
        accent: "221deg calc(83%) var(--lightness) / calc(var(--alpha))",
        ring: "hsl(199 89% 48%)",
        warning: "32, 95%, 44%",
        success: "158 /* hue */ 64% 24%"
      } }}>content</ThemeProvider>
    )
    expect(markup).toContain("--foreground:var(--brand-color)")
    expect(markup).not.toContain("--avs-foreground:var(--brand-color)")
    expect(markup).toContain("--primary:hsl(var(--brand-hsl))")
    expect(markup).toContain("--avs-primary:var(--brand-hsl)")
    expect(markup).toContain("--accent:hsl(221deg calc(83%) var(--lightness) / calc(var(--alpha)))")
    expect(markup).toContain("--ring:hsl(199 89% 48%)")
    expect(markup).toContain("--avs-ring:199 89% 48%")
    expect(markup).toContain("--warning:hsl(32, 95%, 44%)")
    expect(markup).toContain("--avs-warning:32, 95%, 44%")
    expect(markup).toContain("--success:hsl(158 /* hue */ 64% 24%)")
    expect(markup).toContain("--avs-success:158 /* hue */ 64% 24%")
  })

  it("treats only documented variable suffixes as legacy HSL channels", () => {
    const markup = renderToStaticMarkup(
      <ThemeProvider theme={{ colors: {
        primary: "var(--brand-hsl-color)",
        ring: "var(--brand-hsl)",
        warning: "var(--brand-channels)"
      } }}>content</ThemeProvider>
    )
    expect(markup).toContain("--primary:var(--brand-hsl-color)")
    expect(markup).toContain("--ring:hsl(var(--brand-hsl))")
    expect(markup).toContain("--warning:hsl(var(--brand-channels))")
  })

  it("fans out legacy channel shorthands without replacing explicit standard companions", () => {
    const markup = renderToStaticMarkup(
      <ThemeProvider theme={{ colors: {
        background: "222 47% 11%",
        foreground: "210 40% 98%",
        muted: "217 33% 18%",
        border: "217 33% 22%",
        card: "oklch(0.3 0.02 250)",
        popover: undefined
      } }}>content</ThemeProvider>
    )
    expect(markup).toContain("--background:hsl(222 47% 11%)")
    expect(markup).toContain("--popover:hsl(222 47% 11%)")
    expect(markup).toContain("--card:oklch(0.3 0.02 250)")
    expect(markup).toContain("--card-foreground:hsl(210 40% 98%)")
    expect(markup).toContain("--secondary:hsl(217 33% 18%)")
    expect(markup).toContain("--input:hsl(217 33% 22%)")
  })

  it("delegates presets to dark-aware CSS instead of inline light colors", () => {
    const markup = renderToStaticMarkup(<ThemeProvider preset="zinc">content</ThemeProvider>)
    expect(markup).toContain('data-theme-preset="zinc"')
    expect(markup).not.toContain("--primary")
  })

  it("follows the flattened slot tree when resolving dark preset context", () => {
    const source = readFileSync(new URL("./theme.tsx", import.meta.url), "utf8")
    expect(source.indexOf("node.assignedSlot")).toBeLessThan(source.indexOf("node.parentElement"))
    expect(source).toContain('node.addEventListener("slotchange", update)')
    expect(source).toContain('node.classList.contains("avs-dark")')
  })
})

describe("theme.css", () => {
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8")

  it("publishes the complete standard shadcn token families", () => {
    for (const token of [
      "background", "foreground", "card", "popover", "primary", "secondary", "muted", "accent",
      "destructive", "border", "input", "ring", "chart-1", "chart-5", "sidebar", "sidebar-ring"
    ]) {
      expect(css).toContain(`--color-${token}: var(--${token})`)
    }
    expect(css).toContain("--radius-lg: var(--radius)")
    expect(css).not.toMatch(/--color-[^:]+:\s*[^;]*--avs-/)
  })

  it("defines light and class/data-attribute dark palettes with complete colors", () => {
    expect(css).toContain("\n:root,\n.avs-theme {\n  color-scheme: light;")
    expect(css).not.toContain("\n:root,\n:host,\n.avs-theme {")
    expect(css).toContain("\n.dark,\n[data-theme=\"dark\"],\n:host(.dark),")
    expect(css).toContain("[data-theme=\"dark\"] .avs-theme {\n  color-scheme: dark;")
    expect(css).toContain("--background: hsl(")
  })

  it("provides shadow defaults without reserving consumer-owned standard properties", () => {
    expect(css).toContain(":where(:host) > :where(*) {")
    for (const property of SHOW_PORTAL_THEME_PROPERTIES.filter(
      (property) => property.startsWith("--") && !property.startsWith("--avs-")
    )) {
      const name = property.slice(2)
      expect(css).toContain(`--avibe-show-host-${name}: var(${property},`)
      expect(css).toContain(`${property}: var(--avibe-show-host-${name});`)
    }
  })

  it("supports dark utilities on theme roots and dark-aware presets", () => {
    expect(css).toContain(":host(.dark) *")
    expect(css).toContain(".avs-dark *")
    expect(css).toContain('.dark .avs-theme[data-theme-preset="zinc"],')
    expect(css).toContain('.avs-theme.dark[data-theme-preset="zinc"],')
    expect(css).toContain('.avs-theme.avs-dark[data-theme-preset="zinc"],')
    expect(css).toContain('[data-theme="dark"] .avs-theme[data-theme-preset="blue"]')
  })

})
