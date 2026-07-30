import { describe, expect, it } from "vitest"
import { runInNewContext } from "node:vm"
import { showThemeCompatibilityPlugin } from "./theme-compat-plugin.js"

class TestStyle {
  private declarations = new Map<string, { value: string; priority: string }>()
  reads = 0

  getPropertyPriority(name: string) {
    return this.declarations.get(name)?.priority ?? ""
  }

  getPropertyValue(name: string) {
    this.reads += 1
    return this.declarations.get(name)?.value ?? ""
  }

  removeProperty(name: string) {
    const value = this.getPropertyValue(name)
    this.declarations.delete(name)
    return value
  }

  setProperty(name: string, value: string, priority = "") {
    this.declarations.set(name, { value, priority })
  }
}

function loadClientCode() {
  const plugin = showThemeCompatibilityPlugin()
  const load = plugin.load as ((id: string) => unknown) | undefined
  const code = load?.("\0virtual:avibe-show-theme-compat-client")
  expect(typeof code).toBe("string")
  return code as string
}

function loadCompatibilityFunctions() {
  const code = loadClientCode()
  return Function(`${code}\nreturn { syncLegacyTheme, syncLegacyRuleList };`)() as {
    syncLegacyTheme: (element: { style: TestStyle }) => void
    syncLegacyRuleList: (rules: unknown[]) => void
  }
}

describe("dynamic legacy theme compatibility", () => {
  it("migrates inline legacy tokens one way without replacing authored standard tokens", () => {
    const { syncLegacyTheme: sync } = loadCompatibilityFunctions()
    const legacy = { style: new TestStyle() }
    legacy.style.setProperty("--avs-primary", "221 83% 53%", "important")
    legacy.style.setProperty("--avs-radius", "0.75rem")

    sync(legacy)
    expect(legacy.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(legacy.style.getPropertyPriority("--primary")).toBe("important")
    expect(legacy.style.getPropertyValue("--radius")).toBe("var(--avs-radius)")

    legacy.style.removeProperty("--avs-primary")
    sync(legacy)
    expect(legacy.style.getPropertyValue("--primary")).toBe("")

    const standard = { style: new TestStyle() }
    standard.style.setProperty("--avs-primary", "221 83% 53%")
    standard.style.setProperty("--primary", "oklch(0.62 0.19 255)")
    sync(standard)
    expect(standard.style.getPropertyValue("--primary")).toBe("oklch(0.62 0.19 255)")
  })

  it("migrates legacy tokens in dynamically created and nested stylesheet rules", () => {
    const { syncLegacyRuleList } = loadCompatibilityFunctions()
    const direct = new TestStyle()
    direct.setProperty("--avs-primary", "221 83% 53%")
    const nested = new TestStyle()
    nested.setProperty("--avs-radius", "0.75rem")
    const imported = new TestStyle()
    imported.setProperty("--avs-border", "214 32% 91%")

    syncLegacyRuleList([
      { style: direct },
      { cssRules: [{ style: nested }] },
      { styleSheet: { cssRules: [{ style: imported }] } }
    ])

    expect(direct.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(nested.getPropertyValue("--radius")).toBe("var(--avs-radius)")
    expect(imported.getPropertyValue("--input")).toBe("hsl(var(--avs-border))")

    direct.setProperty("--primary", "oklch(0.62 0.19 255)")
    syncLegacyRuleList([{ style: direct }])
    expect(direct.getPropertyValue("--primary")).toBe("oklch(0.62 0.19 255)")
  })

  it("installs CSSOM migration without scanning unrelated inline animations", () => {
    class TestElement {
      style = new TestStyle()
      parentElement = null

      getAttribute() { return null }
      matches() { return false }
      querySelectorAll() { return [] }
    }
    class TestStyleSheet {
      cssRules: Array<{ style: TestStyle }> = []
      nextStyle?: TestStyle

      insertRule(_rule?: string) {
        if (this.nextStyle) this.cssRules.push({ style: this.nextStyle })
        return this.cssRules.length - 1
      }
    }
    class TestMutationObserver {
      observe() {}
    }

    const root = new TestElement()
    const rule = new TestStyle()
    rule.setProperty("--avs-ring", "199 89% 48%")
    const context = {
      CSSStyleDeclaration: TestStyle,
      CSSStyleSheet: TestStyleSheet,
      Element: TestElement,
      HTMLLinkElement: class {},
      MutationObserver: TestMutationObserver,
      document: {
        adoptedStyleSheets: [],
        addEventListener() {},
        documentElement: root,
        styleSheets: []
      }
    }
    runInNewContext(loadClientCode(), context)

    const animated = new TestStyle()
    animated.setProperty("opacity", "0.5")
    expect(animated.reads).toBe(0)

    const dynamic = new TestStyle()
    dynamic.setProperty("--avs-primary", "221 83% 53%")
    expect(dynamic.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")

    const sheet = new TestStyleSheet()
    const unrelatedRule = new TestStyle()
    unrelatedRule.setProperty("opacity", "0.7")
    unrelatedRule.reads = 0
    sheet.cssRules.push({ style: unrelatedRule })
    sheet.nextStyle = rule
    sheet.insertRule(".brand {}")
    expect(rule.getPropertyValue("--ring")).toBe("hsl(var(--avs-ring))")
    expect(unrelatedRule.reads).toBe(0)
  })
})
