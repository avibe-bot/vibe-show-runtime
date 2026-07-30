import * as React from "react"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ThemeProvider } from "./theme"

describe("ThemeProvider", () => {
  it("does not shadow the standard root tokens unless a preset is requested", () => {
    const markup = renderToStaticMarkup(<ThemeProvider><span>content</span></ThemeProvider>)
    expect(markup).not.toContain("--primary")
    expect(markup).not.toContain("--avs-primary")
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

  it("normalizes literal and variable-backed HSL channels for old workspaces", () => {
    const markup = renderToStaticMarkup(
      <ThemeProvider theme={{ colors: { foreground: "var(--brand-color)", primary: "var(--brand-hsl)", ring: "199 89% 48%", warning: "32, 95%, 44%" } }}>content</ThemeProvider>
    )
    expect(markup).toContain("--foreground:var(--brand-color)")
    expect(markup).not.toContain("--avs-foreground:var(--brand-color)")
    expect(markup).toContain("--primary:hsl(var(--brand-hsl))")
    expect(markup).toContain("--avs-primary:var(--brand-hsl)")
    expect(markup).toContain("--ring:hsl(199 89% 48%)")
    expect(markup).toContain("--avs-ring:199 89% 48%")
    expect(markup).toContain("--warning:hsl(32, 95%, 44%)")
    expect(markup).toContain("--avs-warning:32, 95%, 44%")
  })

  it("delegates presets to dark-aware CSS instead of inline light colors", () => {
    const markup = renderToStaticMarkup(<ThemeProvider preset="zinc">content</ThemeProvider>)
    expect(markup).toContain('data-theme-preset="zinc"')
    expect(markup).not.toContain("--primary")
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
    expect(css).toContain("\n:root {\n  color-scheme: light;")
    expect(css).toContain("\n.dark,\n[data-theme=\"dark\"] {\n  color-scheme: dark;")
    expect(css).toContain("--background: hsl(")
  })

  it("supports dark utilities on theme roots and dark-aware presets", () => {
    expect(css).toContain('@custom-variant dark (&:is(.dark, .dark *, [data-theme="dark"], [data-theme="dark"] *))')
    expect(css).toContain('.dark .avs-theme[data-theme-preset="zinc"],')
    expect(css).toContain('[data-theme="dark"] .avs-theme[data-theme-preset="blue"]')
  })

})
