import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  LEGACY_THEME_MIGRATIONS,
  themeCompatibilityClientScript
} from "./theme-compat"

describe("legacy theme compatibility", () => {
  it("keeps the compatibility contract owned by Show UI", () => {
    expect(LEGACY_THEME_MIGRATIONS["--avs-primary"]).toEqual(["--primary"])
    expect(LEGACY_THEME_MIGRATIONS["--avs-background"]).toEqual(["--background", "--card", "--popover"])
    expect(themeCompatibilityClientScript()).toContain("__avibeShowThemeCompatInstalled")
  })

  it("installs for direct component and ThemeProvider consumers", () => {
    for (const source of ["./utils.ts", "./switch.tsx", "./theme.tsx"]) {
      const contents = readFileSync(new URL(source, import.meta.url), "utf8")
      expect(contents).toContain('import "./theme-compat"')
    }
  })
})
