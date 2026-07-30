import { describe, expect, it } from "vitest"
import { runInNewContext } from "node:vm"
import { showThemeCompatibilityPlugin } from "./theme-compat-plugin.js"

class TestStyle {
  private declarations = new Map<string, { value: string; priority: string }>()
  reads = 0

  get length() {
    return this.declarations.size
  }

  item(index: number) {
    return Array.from(this.declarations.keys())[index] ?? ""
  }

  hasProperty(name: string) {
    return this.declarations.has(name)
  }

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
      descendants: TestElement[] = []
      shadowRoot: TestShadowRoot | null = null
      nextShadowRoot: TestShadowRoot | null = null

      getAttribute() { return null }
      matches() { return false }
      querySelectorAll(selector: string) { return selector === "*" ? this.descendants : [] }
      attachShadow() {
        this.shadowRoot = this.nextShadowRoot ?? new TestShadowRoot()
        return this.shadowRoot
      }
    }
    class TestShadowRoot {
      adoptedStyleSheets: TestStyleSheet[] = []
      parentElement = null

      addEventListener() {}
      querySelectorAll() { return [] }
    }
    class TestStyleSheet {
      cssRules: Array<Record<string, unknown>> = []
      nextStyle?: TestStyle
      private disabledValue = false

      get disabled() {
        return this.disabledValue
      }

      set disabled(value: boolean) {
        this.disabledValue = Boolean(value)
      }

      insertRule(_rule?: string) {
        if (this.nextStyle) this.cssRules.push({ style: this.nextStyle })
        return this.cssRules.length - 1
      }

      deleteRule(index: number) {
        this.cssRules.splice(index, 1)
      }
    }
    class TestKeyframesRule {
      cssRules: Array<Record<string, unknown>> = []
      nextStyle?: TestStyle

      appendRule() {
        if (this.nextStyle) this.cssRules.push({ style: this.nextStyle })
      }

      deleteRule() {
        this.cssRules.pop()
      }
    }
    class TestStyleRule {
      private selector = ".theme"

      get selectorText() { return this.selector }
      set selectorText(value: string) { this.selector = value }
    }
    class TestKeyframeRule {
      private key = "to"

      get keyText() { return this.key }
      set keyText(value: string) { this.key = value }
    }
    class TestMediaList {
      private text = "screen"

      get mediaText() { return this.text }
      set mediaText(value: string) { this.text = value }
      appendMedium(value: string) { this.text += `, ${value}` }
      deleteMedium(value: string) { this.text = this.text.replace(value, "") }
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
    const emptyLegacyRule = new TestStyle()
    emptyLegacyRule.setProperty("--avs-primary", "")
    const emptyStandardRule = new TestStyle()
    emptyStandardRule.setProperty("--avs-primary", "221 83% 53%")
    emptyStandardRule.setProperty("--primary", "")
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
      { style: emptyLegacyRule },
      { style: emptyStandardRule },
      { style: generatedRule },
      { style: unrelatedInitialRule },
      { cssRules: [{ style: nestedRule }] },
      { styleSheet: { cssRules: [{ style: importedRule }] } }
    )
    const shadowRule = new TestStyle()
    shadowRule.setProperty("--avs-ring", "199 89% 48%")
    const shadowSheet = new TestStyleSheet()
    shadowSheet.cssRules.push({ style: shadowRule })
    const existingShadow = new TestShadowRoot()
    existingShadow.adoptedStyleSheets.push(shadowSheet)
    const shadowHost = new TestElement()
    shadowHost.shadowRoot = existingShadow
    root.descendants.push(shadowHost)
    const events: string[] = []
    const lateAdoptedRule = new TestStyle()
    lateAdoptedRule.setProperty("--avs-success", "142 71% 45%")
    const lateAdoptedSheet = new TestStyleSheet()
    lateAdoptedSheet.cssRules.push({ style: lateAdoptedRule })
    const context = {
      CSSGroupingRule: TestGroupingRule,
      CSSKeyframeRule: TestKeyframeRule,
      CSSKeyframesRule: TestKeyframesRule,
      CSSStyleRule: TestStyleRule,
      CSSStyleDeclaration: TestStyle,
      CSSStyleSheet: TestStyleSheet,
      Element: TestElement,
      Event: class {
        constructor(public type: string) {}
      },
      HTMLLinkElement: class {},
      MutationObserver: TestMutationObserver,
      MediaList: TestMediaList,
      ShadowRoot: TestShadowRoot,
      StyleSheet: TestStyleSheet,
      document: {
        adoptedStyleSheets: [] as TestStyleSheet[],
        addEventListener() {},
        dispatchEvent(event: { type: string }) { events.push(event.type) },
        documentElement: root,
        styleSheets: [directSheet]
      }
    }
    runInNewContext(loadClientCode(), context)

    expect(directRule.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(emptyLegacyRule.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(emptyStandardRule.getPropertyValue("--primary")).toBe("")
    expect(emptyStandardRule.hasProperty("--primary")).toBe(true)
    expect(shadowRule.getPropertyValue("--ring")).toBe("hsl(var(--avs-ring))")
    const lateShadowRule = new TestStyle()
    lateShadowRule.setProperty("--avs-warning", "32 95% 44%")
    const lateShadowSheet = new TestStyleSheet()
    lateShadowSheet.cssRules.push({ style: lateShadowRule })
    const lateShadow = new TestShadowRoot()
    lateShadow.adoptedStyleSheets.push(lateShadowSheet)
    const lateHost = new TestElement()
    lateHost.nextShadowRoot = lateShadow
    lateHost.attachShadow()
    expect(lateShadowRule.getPropertyValue("--warning")).toBe("hsl(var(--avs-warning))")
    expect(unrelatedInitialRule.reads).toBe(0)
    generatedRule.setProperty("--avs-primary", "221 83% 53%", "important")
    expect(generatedRule.getPropertyPriority("--primary")).toBe("important")
    generatedRule.removeProperty("--avs-primary")
    expect(generatedRule.getPropertyValue("--primary")).toBe("")
    expect(nestedRule.getPropertyValue("--radius")).toBe("var(--avs-radius)")
    expect(importedRule.getPropertyValue("--input")).toBe("hsl(var(--avs-border))")

    const beforeAdoption = events.length
    context.document.adoptedStyleSheets.push(lateAdoptedSheet)
    expect(lateAdoptedRule.getPropertyValue("--success")).toBe("hsl(var(--avs-success))")
    expect(events.length).toBe(beforeAdoption + 1)

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

    const keyframes = new TestKeyframesRule()
    const keyframeRule = new TestStyle()
    keyframeRule.setProperty("--avs-warning", "32 95% 44%")
    keyframes.nextStyle = keyframeRule
    const beforeKeyframe = events.length
    keyframes.appendRule()
    expect(keyframeRule.getPropertyValue("--warning")).toBe("hsl(var(--avs-warning))")
    expect(events.length).toBe(beforeKeyframe + 1)
    keyframes.deleteRule()
    expect(events.length).toBe(beforeKeyframe + 2)

    const beforeDisabled = events.length
    sheet.disabled = true
    expect(events.length).toBe(beforeDisabled + 1)

    const styleRule = new TestStyleRule()
    const beforeSelector = events.length
    styleRule.selectorText = ".active-theme"
    expect(events.length).toBe(beforeSelector + 1)

    const keyframe = new TestKeyframeRule()
    keyframe.keyText = "50%"
    expect(events.length).toBe(beforeSelector + 2)

    const media = new TestMediaList()
    media.mediaText = "(prefers-color-scheme: dark)"
    media.appendMedium("print")
    media.deleteMedium("print")
    expect(events.length).toBe(beforeSelector + 5)

    const grouping = new TestGroupingRule()
    const groupedRule = new TestStyle()
    groupedRule.setProperty("--avs-border", "214 32% 91%")
    grouping.nextStyle = groupedRule
    grouping.insertRule(".nested {}")
    expect(groupedRule.getPropertyValue("--border")).toBe("hsl(var(--avs-border))")
  })
})
