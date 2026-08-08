import * as React from "react"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ThemeProvider } from "./theme"

const themeCss = readFileSync(new URL("./theme.css", import.meta.url), "utf8")

describe("public theme CSS", () => {
  it("maps semantic colors directly to the matching standard variables", () => {
    const themeBlock = themeCss.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(themeBlock).toBeDefined()
    expect(themeBlock).not.toContain("--avs-")

    for (const token of [
      "background",
      "foreground",
      "card",
      "primary",
      "muted",
      "border",
      "ring",
      "chart-5",
      "sidebar-ring"
    ]) {
      expect(themeBlock).toContain(`--color-${token}: var(--${token});`)
      expect(themeCss).toMatch(new RegExp(`\\n  --${token}: [^;]+;`))
    }
  })

  it("uses the same class and data-attribute roots for the palette and dark utilities", () => {
    expect(themeCss).toContain('@custom-variant dark (&:where(.dark, .dark *, [data-theme="dark"], [data-theme="dark"] *));')
    expect(themeCss).toContain('.dark,\n[data-theme="dark"] {')
  })
})

describe("ThemeProvider", () => {
  it("writes the public standard variables and mirrors documented HSL channels", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider
        preset="blue"
        theme={{
          radius: "0.75rem",
          colors: {
            primary: "221 83% 53%",
            card: "oklch(0.98 0.01 255)"
          }
        }}
      >
        <span>content</span>
      </ThemeProvider>
    )

    expect(html).toContain('data-show-theme-preset="blue"')
    expect(html).toContain("--radius:0.75rem")
    expect(html).toContain("--avs-radius:0.75rem")
    expect(html).toContain("--primary:hsl(221 83% 53%)")
    expect(html).toContain("--avs-primary:221 83% 53%")
    expect(html).toContain("--card:oklch(0.98 0.01 255)")
  })

  it("keeps complete colors and custom-property references unchanged", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider theme={{ colors: { primary: "var(--brand-color)", ring: "#2563eb" } }}>
        <span>content</span>
      </ThemeProvider>
    )

    expect(html).toContain("--primary:var(--brand-color)")
    expect(html).toContain("--ring:#2563eb")
    expect(html).not.toContain("--avs-primary")
    expect(html).not.toContain("--avs-ring")
  })
})
