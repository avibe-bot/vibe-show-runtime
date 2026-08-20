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
      <ThemeProvider theme={{ radius: "0.75rem", colors: { background: "oklch(1 0 0)", primary: "oklch(0.62 0.19 255)", cardForeground: "#102030" } }}>
        content
      </ThemeProvider>
    )
    expect(markup).toContain("--radius:0.75rem")
    expect(markup).toContain("--background:oklch(1 0 0)")
    expect(markup).toContain("--primary:oklch(0.62 0.19 255)")
    expect(markup).toContain("--card-foreground:#102030")
    expect(markup).not.toContain("--card:oklch(1 0 0)")
    expect(markup).not.toContain("--popover:oklch(1 0 0)")
  })

  it("normalizes literal HSL channels while preserving complete color references", () => {
    const markup = renderToStaticMarkup(
      <ThemeProvider theme={{ colors: {
        primary: "var(--brand-color)",
        ring: "199 89% 48%",
        warning: "hsl(var(--brand-hsl))"
      } }}>content</ThemeProvider>
    )
    expect(markup).toContain("--primary:var(--brand-color)")
    expect(markup).not.toContain("--avs-primary")
    expect(markup).toContain("--ring:hsl(199 89% 48%)")
    expect(markup).toContain("--avs-ring:199 89% 48%")
    expect(markup).toContain("--warning:hsl(var(--brand-hsl))")
    expect(markup).not.toContain("--avs-warning")
  })

  it("normalizes legacy HSL channels by top-level CSS structure", () => {
    const markup = renderToStaticMarkup(
      <ThemeProvider theme={{ colors: {
        primary: "221, 83%, 53%",
        ring: "var(--h)/**/var(--s)/**/var(--l)",
        success: "+158 64% 24%",
        warning: "3.2e1 95% 44%",
        destructive: "calc(360 - 360) 84% 60%"
      } }}>content</ThemeProvider>
    )
    expect(markup).toContain("--primary:hsl(221, 83%, 53%)")
    expect(markup).toContain("--avs-primary:221, 83%, 53%")
    expect(markup).toContain("--ring:hsl(var(--h)/**/var(--s)/**/var(--l))")
    expect(markup).toContain("--success:hsl(+158 64% 24%)")
    expect(markup).toContain("--warning:hsl(3.2e1 95% 44%)")
    expect(markup).toContain("--destructive:hsl(calc(360 - 360) 84% 60%)")
  })

  it("preserves legacy semantic fan-out while explicit standard tokens win", () => {
    const markup = renderToStaticMarkup(
      <ThemeProvider theme={{ colors: {
        background: "0 0% 0%",
        foreground: "0 0% 100%",
        muted: "210 40% 96%",
        border: "214 32% 91%",
        card: "oklch(0.2 0 0)",
        input: "#334455"
      } }}>content</ThemeProvider>
    )
    expect(markup).toContain("--background:hsl(0 0% 0%)")
    expect(markup).toContain("--popover:hsl(0 0% 0%)")
    expect(markup).toContain("--card:oklch(0.2 0 0)")
    expect(markup).toContain("--card-foreground:hsl(0 0% 100%)")
    expect(markup).toContain("--secondary:hsl(210 40% 96%)")
    expect(markup).toContain("--accent:hsl(210 40% 96%)")
    expect(markup).toContain("--input:#334455")
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
