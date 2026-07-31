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
    for (const source of ["./utils.ts", "./switch.tsx", "./theme.tsx", "./animated-text.tsx", "./hmr-transition.ts"]) {
      const contents = readFileSync(new URL(source, import.meta.url), "utf8")
      expect(contents).toContain('import "./theme-compat"')
    }
  })

  it("serializes the opaque stylesheet state observers", () => {
    const script = themeCompatibilityClientScript()
    for (const event of [
      "pointerdown", "pointerup", "pointercancel", "keydown", "keyup", "beforetoggle", "toggle", "fullscreenchange"
    ]) {
      expect(script).toContain(`"${event}"`)
    }
    for (const query of [
      "(pointer: coarse)",
      "(pointer: none)",
      "(any-pointer: coarse)",
      "(any-pointer: none)"
    ]) {
      expect(script).toContain(`"${query}"`)
    }
    expect(script).toContain("new Proxy(list")
    expect(script).toContain("rootCandidates")
    expect(script).toContain("scheduleAdoptedListPoll")
    expect(script).toContain("patchMediaList")
    expect(script).toContain("selectorText")
    expect(script).toContain("addRule")
    expect(script).toContain('"removeRule"')
    for (const property of ["checked", "indeterminate", "valueAsDate", "selectedIndex", "selected"]) {
      expect(script).toContain(`"${property}"`)
    }
    expect(script).toContain("opaqueStyleSheetScopes.values()")
    expect(script).toContain("addEventListener?.(event, scheduleOpaqueLegacyEventScan, true)")
    expect(script).toContain("addEventListener?.(event, scheduleOpaqueLegacyRelationalEventScan, true)")
    expect(script).toContain('"reset"')
    expect(script).toContain('"hashchange"')
    expect(script).toContain('"popstate"')
  })
})
