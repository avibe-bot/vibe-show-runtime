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

  get cssText() {
    return Array.from(this.declarations, ([name, declaration]) => `${name}: ${declaration.value}`).join("; ")
  }

  set cssText(value: string | null) {
    this.declarations.clear()
    if (value) this.declarations.set("text", { value: String(value), priority: "" })
  }
}

function loadClientCode() {
  const plugin = showThemeCompatibilityPlugin()
  const load = plugin.load as ((id: string) => unknown) | undefined
  const code = load?.("\0virtual:avibe-show-theme-compat-client")
  expect(typeof code).toBe("string")
  return code as string
}

describe("dynamic legacy theme compatibility", () => {
  it("installs CSSOM migration without scanning unrelated inline animations", () => {
    class TestElement {
      style = new TestStyle()
      parentElement = null

      getAttribute() { return null }
      matches() { return false }
      querySelectorAll() { return [] }
    }
    class TestStyleSheet {
      cssRules: Array<Record<string, unknown>> = []
      nextStyle?: TestStyle

      insertRule(_rule?: string) {
        if (this.nextStyle) this.cssRules.push({ style: this.nextStyle })
        return this.cssRules.length - 1
      }

      deleteRule(index: number) {
        this.cssRules.splice(index, 1)
      }
    }
    class TestGroupingRule {
      cssRules: Array<Record<string, unknown>> = []
      nextStyle?: TestStyle

      insertRule(_rule?: string) {
        if (this.nextStyle) this.cssRules.push({ style: this.nextStyle })
        return this.cssRules.length - 1
      }

      deleteRule(index: number) {
        this.cssRules.splice(index, 1)
      }
    }
    class TestMutationObserver {
      observe() {}
    }

    const root = new TestElement()
    const rule = new TestStyle()
    rule.setProperty("--avs-ring", "199 89% 48%")
    const directRule = new TestStyle()
    directRule.setProperty("--avs-primary", "221 83% 53%")
    const generatedRule = new TestStyle()
    generatedRule.setProperty("--avs-primary", "221 83% 53%")
    generatedRule.setProperty("--primary", "hsl(var(--avs-primary))")
    generatedRule.setProperty("--avibe-show-theme-owner-primary", "--avs-primary")
    const unrelatedInitialRule = new TestStyle()
    unrelatedInitialRule.setProperty("color", "red")
    unrelatedInitialRule.reads = 0
    const nestedRule = new TestStyle()
    nestedRule.setProperty("--avs-radius", "0.75rem")
    const importedRule = new TestStyle()
    importedRule.setProperty("--avs-border", "214 32% 91%")
    const directSheet = new TestStyleSheet()
    directSheet.cssRules.push(
      { style: directRule },
      { style: generatedRule },
      { style: unrelatedInitialRule },
      { cssRules: [{ style: nestedRule }] },
      { styleSheet: { cssRules: [{ style: importedRule }] } }
    )
    const events: string[] = []
    const context = {
      CSSGroupingRule: TestGroupingRule,
      CSSStyleDeclaration: TestStyle,
      CSSStyleSheet: TestStyleSheet,
      Element: TestElement,
      Event: class {
        constructor(public type: string) {}
      },
      HTMLLinkElement: class {},
      MutationObserver: TestMutationObserver,
      document: {
        adoptedStyleSheets: [],
        addEventListener() {},
        dispatchEvent(event: { type: string }) { events.push(event.type) },
        documentElement: root,
        styleSheets: [directSheet]
      }
    }
    runInNewContext(loadClientCode(), context)

    expect(directRule.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(unrelatedInitialRule.reads).toBe(0)
    generatedRule.setProperty("--avs-primary", "221 83% 53%", "important")
    expect(generatedRule.getPropertyPriority("--primary")).toBe("important")
    generatedRule.removeProperty("--avs-primary")
    expect(generatedRule.getPropertyValue("--primary")).toBe("")
    expect(nestedRule.getPropertyValue("--radius")).toBe("var(--avs-radius)")
    expect(importedRule.getPropertyValue("--input")).toBe("hsl(var(--avs-border))")

    const animated = new TestStyle()
    animated.setProperty("opacity", "0.5")
    expect(animated.reads).toBe(0)
    expect(() => { animated.cssText = null }).not.toThrow()

    const dynamic = new TestStyle()
    dynamic.setProperty("--avs-primary", "221 83% 53%", "important")
    expect(dynamic.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(dynamic.getPropertyPriority("--primary")).toBe("important")
    dynamic.removeProperty("--avs-primary")
    expect(dynamic.getPropertyValue("--primary")).toBe("")
    expect(() => dynamic.setProperty(null as unknown as string, "ignored")).not.toThrow()
    expect(() => dynamic.removeProperty(null as unknown as string)).not.toThrow()

    const standard = new TestStyle()
    standard.setProperty("--avs-primary", "221 83% 53%")
    standard.setProperty("--primary", "oklch(0.62 0.19 255)")
    expect(standard.getPropertyValue("--primary")).toBe("oklch(0.62 0.19 255)")

    const sheet = new TestStyleSheet()
    const unrelatedRule = new TestStyle()
    unrelatedRule.setProperty("opacity", "0.7")
    unrelatedRule.reads = 0
    sheet.cssRules.push({ style: unrelatedRule })
    sheet.nextStyle = rule
    sheet.insertRule(".brand {}")
    expect(rule.getPropertyValue("--ring")).toBe("hsl(var(--avs-ring))")
    expect(unrelatedRule.reads).toBe(0)
    expect(events).toContain("avibe:show-theme-change")

    const beforeDelete = events.length
    sheet.deleteRule(0)
    expect(events.length).toBe(beforeDelete + 1)

    const grouping = new TestGroupingRule()
    const groupedRule = new TestStyle()
    groupedRule.setProperty("--avs-border", "214 32% 91%")
    grouping.nextStyle = groupedRule
    grouping.insertRule(".nested {}")
    expect(groupedRule.getPropertyValue("--border")).toBe("hsl(var(--avs-border))")
  })
})
