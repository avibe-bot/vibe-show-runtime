import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  LEGACY_THEME_MIGRATIONS,
  STANDARD_THEME_INITIAL_VALUES,
  themeCompatibilityClientScript
} from "./theme-compat"
import { SHOW_PORTAL_THEME_PROPERTIES } from "./theme-properties"

describe("legacy theme compatibility", () => {
  it("keeps the compatibility contract owned by Show UI", () => {
    expect(LEGACY_THEME_MIGRATIONS["--avs-primary"]).toEqual(["--primary"])
    expect(LEGACY_THEME_MIGRATIONS["--avs-background"]).toEqual(["--background", "--card", "--popover"])
    expect(themeCompatibilityClientScript()).toContain("__avibeShowThemeCompatInstalled")
    expect(themeCompatibilityClientScript()).toContain("avibe-show-theme-change")
    expect(themeCompatibilityClientScript()).toContain("registerProperty")
    expect(SHOW_PORTAL_THEME_PROPERTIES).toContain("--chart-1")
    expect(SHOW_PORTAL_THEME_PROPERTIES).toContain("--sidebar")
    for (const property of SHOW_PORTAL_THEME_PROPERTIES.filter((property) => property.startsWith("--") && !property.startsWith("--avs-"))) {
      expect(STANDARD_THEME_INITIAL_VALUES[property]).toBeTruthy()
    }
  })

  it("installs for direct component and ThemeProvider consumers", () => {
    for (const source of ["./utils.ts", "./switch.tsx", "./theme.tsx", "./animated-text.tsx", "./hmr-transition.ts"]) {
      const contents = readFileSync(new URL(source, import.meta.url), "utf8")
      expect(contents).toContain('import "./theme-compat"')
    }
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    expect(packageJson.sideEffects).toContain("./dist/theme-compat*.js")
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
    expect(script).toContain('"animationcancel"')
    expect(script).toContain('"transitioncancel"')
    expect(script).toContain("setCustomValidity")
    expect(script).toContain("stepUp")
    expect(script).toContain("opaqueContinuationPending")
    expect(script).toContain("opaqueImportAncestors")
    expect(script).toContain("sampleLocalThemeProperties")
    expect(script).toContain("syncAllOpaqueLegacyThemesNow")
    expect(script).toContain("patchPortalStyleProperty")
    expect(script).toContain("scheduleOpaqueLegacyRelationalScan")
    expect(script).toContain("CustomElementRegistry")
    expect(script).toContain("parentStyleSheet")
  })
})
