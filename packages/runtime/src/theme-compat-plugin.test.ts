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
    return Array.from(this.declarations, ([name, declaration]) =>
      `${name}: ${declaration.value}${declaration.priority ? ` !${declaration.priority}` : ""}`
    ).join("; ")
  }

  set cssText(value: string | null) {
    this.declarations.clear()
    for (const entry of String(value ?? "").split(";")) {
      const separator = entry.indexOf(":")
      if (separator < 0) continue
      const name = entry.slice(0, separator).trim()
      const raw = entry.slice(separator + 1).trim()
      const important = /\s*!important\s*$/i.test(raw)
      const propertyValue = important ? raw.replace(/\s*!important\s*$/i, "").trim() : raw
      if (name) this.declarations.set(name, { value: propertyValue, priority: important ? "important" : "" })
    }
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
    const relinquishedRule = new TestStyle()
    relinquishedRule.setProperty("--avs-primary", "221 83% 53%")
    relinquishedRule.setProperty("--primary", "hsl(var(--avs-primary))")
    relinquishedRule.setProperty("--avibe-show-theme-owner-primary", "--avs-primary")
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
      { style: relinquishedRule },
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
    const lateAdoptedRule = new TestStyle()
    lateAdoptedRule.setProperty("--avs-success", "142 71% 45%")
    const lateAdoptedSheet = new TestStyleSheet()
    lateAdoptedSheet.cssRules.push({ style: lateAdoptedRule })
    const context = {
      CSSGroupingRule: TestGroupingRule,
      CSSKeyframesRule: TestKeyframesRule,
      CSSStyleDeclaration: TestStyle,
      CSSStyleSheet: TestStyleSheet,
      Element: TestElement,
      HTMLLinkElement: class {},
      MutationObserver: TestMutationObserver,
      ShadowRoot: TestShadowRoot,
      document: {
        adoptedStyleSheets: [] as TestStyleSheet[],
        addEventListener() {},
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
    expect(generatedRule.getPropertyValue("--avibe-show-theme-owner-primary")).toBe("")
    relinquishedRule.setProperty("--primary", "oklch(0.62 0.19 255)")
    expect(relinquishedRule.getPropertyValue("--avibe-show-theme-owner-primary")).toBe("")
    relinquishedRule.setProperty("--primary", "hsl(var(--avs-primary))", "important")
    expect(relinquishedRule.getPropertyPriority("--primary")).toBe("important")
    expect(nestedRule.getPropertyValue("--radius")).toBe("var(--avs-radius)")
    expect(importedRule.getPropertyValue("--input")).toBe("hsl(var(--avs-border))")

    context.document.adoptedStyleSheets.push(lateAdoptedSheet)
    expect(lateAdoptedRule.getPropertyValue("--success")).toBe("hsl(var(--avs-success))")

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

    const keyframes = new TestKeyframesRule()
    const keyframeRule = new TestStyle()
    keyframeRule.setProperty("--avs-warning", "32 95% 44%")
    keyframes.nextStyle = keyframeRule
    keyframes.appendRule()
    expect(keyframeRule.getPropertyValue("--warning")).toBe("hsl(var(--avs-warning))")

    const grouping = new TestGroupingRule()
    const groupedRule = new TestStyle()
    groupedRule.setProperty("--avs-border", "214 32% 91%")
    grouping.nextStyle = groupedRule
    grouping.insertRule(".nested {}")
    expect(groupedRule.getPropertyValue("--border")).toBe("hsl(var(--avs-border))")
  })

  it("bridges opaque stylesheet legacy overrides without replacing authored standard tokens", async () => {
    class TestElement {
      style = new TestStyle()
      isConnected = true
      parentElement: TestElement | null = null
      shadowRoot = null
      descendants: TestElement[] = []
      constructor(readonly standard = false) {}
      get parentNode() { return this.parentElement }
      getAttribute() { return null }
      getRootNode() { return null }
      matches() { return false }
      querySelectorAll(selector: string) { return selector === "*" ? this.descendants : [] }
      attachShadow() { throw new Error("unused") }
    }
    class TestShadowRoot {
      adoptedStyleSheets = []
      addEventListener() {}
      querySelectorAll() { return [] }
    }
    class OpaqueStyleSheet {
      disabled = false
      get cssRules(): never {
        throw Object.assign(new Error("opaque"), { name: "SecurityError" })
      }
    }
    const mutationCallbacks: MutationCallback[] = []
    class TestMutationObserver {
      constructor(callback: MutationCallback) { mutationCallbacks.push(callback) }
      observe() {}
    }

    const standard = new TestElement(true)
    const inlineStandard = new TestElement()
    const inherited = new TestElement()
    const external = new TestElement()
    inlineStandard.style.setProperty("--primary", "oklch(0.7 0.15 255)")
    const root = new TestElement()
    standard.parentElement = root
    inlineStandard.parentElement = root
    inherited.parentElement = root
    root.descendants.push(standard, inlineStandard, inherited)
    const opaque = new OpaqueStyleSheet()
    const frames: FrameRequestCallback[] = []
    const listeners = new Map<string, EventListener>()
    const mediaListeners = new Map<string, EventListener>()
    let legacyActive = false
    const context = {
      CSSStyleDeclaration: TestStyle,
      CSSStyleSheet: OpaqueStyleSheet,
      Element: TestElement,
      HTMLLinkElement: class {},
      HTMLStyleElement: class {},
      MutationObserver: TestMutationObserver,
      Node: TestElement,
      ShadowRoot: TestShadowRoot,
      addEventListener(name: string, listener: EventListener) { listeners.set(name, listener) },
      getComputedStyle(element: TestElement) {
        return {
          getPropertyValue(name: string) {
            if (name === "--avs-primary") return opaque.disabled || !legacyActive ? "222 47% 11%" : "221 83% 53%"
            if (name === "--avs-warning") {
              return !opaque.disabled && legacyActive && element.style.cssText ? "32 95% 44%" : ""
            }
            if (name === "--primary") {
              const inline = element.style.getPropertyValue(name)
              if (inline === "hsl(var(--avs-primary))") {
                return opaque.disabled ? "" : "hsl(221 83% 53%)"
              }
              if (inline) return inline
              if (!opaque.disabled && legacyActive && element.standard) return "oklch(0.62 0.19 255)"
              return "hsl(222 47% 11%)"
            }
            if (name === "--warning") return element.style.getPropertyValue(name)
            return ""
          }
        }
      },
      matchMedia(query: string) {
        return {
          addEventListener(name: string, listener: EventListener) {
            if (name === "change") mediaListeners.set(query, listener)
          }
        }
      },
      requestAnimationFrame(callback: FrameRequestCallback) {
        frames.push(callback)
        return frames.length
      },
      document: {
        adoptedStyleSheets: [],
        addEventListener() {},
        documentElement: root,
        querySelectorAll() { return [standard, inlineStandard, inherited] },
        styleSheets: [opaque]
      }
    }

    runInNewContext(loadClientCode(), context)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0)
    expect(root.style.getPropertyValue("--primary")).toBe("")

    legacyActive = true
    expect(mediaListeners.has("(prefers-reduced-motion: reduce)")).toBe(true)
    mediaListeners.get("(prefers-reduced-motion: reduce)")?.({} as Event)
    expect(frames).toHaveLength(1)
    frames.shift()?.(1)

    expect(root.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(root.style.getPropertyPriority("--primary")).toBe("important")
    expect(root.style.getPropertyValue("--warning")).toBe("hsl(var(--avs-warning))")
    expect(standard.style.getPropertyValue("--primary")).toBe("")
    expect(inlineStandard.style.getPropertyValue("--primary")).toBe("oklch(0.7 0.15 255)")
    expect(inherited.style.getPropertyValue("--primary")).toBe("")

    mutationCallbacks[1]?.([{ type: "attributes", attributeName: "style", target: root }] as unknown as MutationRecord[], {} as MutationObserver)
    expect(frames).toHaveLength(0)
    await Promise.resolve()
    root.style.setProperty("color", "blue")
    mutationCallbacks[1]?.([{ type: "attributes", attributeName: "style", target: root }] as unknown as MutationRecord[], {} as MutationObserver)
    expect(frames).toHaveLength(1)
    frames.shift()?.(2)
    expect(root.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")

    root.isConnected = false
    listeners.get("focus")?.({ target: external } as unknown as Event)
    frames.shift()?.(3)
    expect(root.style.getPropertyValue("--primary")).toBe("")
    root.isConnected = true

    root.style.cssText += "; color: red"
    expect(root.style.getPropertyValue("--primary")).toBe("")
    expect(root.style.getPropertyValue("color")).toBe("red")
    listeners.get("resize")?.({} as Event)
    frames.shift()?.(4)
    expect(root.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(root.style.getPropertyValue("--warning")).toBe("hsl(var(--avs-warning))")

    opaque.disabled = true
    listeners.get("resize")?.({} as Event)
    frames.shift()?.(5)
    expect(root.style.getPropertyValue("--primary")).toBe("")
    expect(opaque.disabled).toBe(true)
  })
})
