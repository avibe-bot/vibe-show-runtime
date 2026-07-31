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
    if (priority && priority.toLowerCase() !== "important") return
    this.declarations.set(name, { value, priority })
  }

  assignProperty(name: string, value: string, priority = "") {
    this.declarations.set(name, { value, priority })
  }

  deleteProperty(name: string) {
    this.declarations.delete(name)
  }

  clearProperties() {
    this.declarations.clear()
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

      addRule(_selector?: string, _style?: string, _index?: number) {
        if (this.nextStyle) this.cssRules.push({ style: this.nextStyle })
        return -1
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
    const retainedRule = new TestStyle()
    retainedRule.setProperty("--avs-border", "214 32% 91%")
    const retainedSheet = new TestStyleSheet()
    retainedSheet.cssRules.push({ style: retainedRule })
    class TestDocument {
      private adoptedSheets: TestStyleSheet[] = []
      documentElement = root
      styleSheets = [directSheet]
      addEventListener() {}
      get adoptedStyleSheets() { return this.adoptedSheets }
      set adoptedStyleSheets(value: TestStyleSheet[]) { this.adoptedSheets = Array.from(value) }
    }
    const testDocument = new TestDocument()
    const retainedAdoptedSheets = testDocument.adoptedStyleSheets
    const timers: Array<() => void> = []
    const context = {
      CSSGroupingRule: TestGroupingRule,
      CSSKeyframesRule: TestKeyframesRule,
      CSSStyleDeclaration: TestStyle,
      CSSStyleSheet: TestStyleSheet,
      Element: TestElement,
      HTMLLinkElement: class {},
      MutationObserver: TestMutationObserver,
      ShadowRoot: TestShadowRoot,
      Document: TestDocument,
      document: testDocument,
      setTimeout(callback: () => void) {
        timers.push(callback)
        return timers.length
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
    const indexedRule = new TestStyle()
    indexedRule.setProperty("--avs-warning", "32 95% 44%")
    const indexedSheet = new TestStyleSheet()
    indexedSheet.cssRules.push({ style: indexedRule })
    context.document.adoptedStyleSheets[0] = indexedSheet
    expect(indexedRule.getPropertyValue("--warning")).toBe("hsl(var(--avs-warning))")
    expect(timers.length).toBeGreaterThan(0)
    retainedAdoptedSheets[0] = retainedSheet
    expect(retainedRule.getPropertyValue("--border")).toBe("")
    for (const timer of timers.splice(0)) timer()
    expect(retainedRule.getPropertyValue("--border")).toBe("hsl(var(--avs-border))")

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
    const legacyAddRule = new TestStyle()
    legacyAddRule.setProperty("--avs-success", "142 71% 45%")
    sheet.nextStyle = legacyAddRule
    sheet.addRule(".legacy", "--avs-success: 142 71% 45%")
    expect(legacyAddRule.getPropertyValue("--success")).toBe("hsl(var(--avs-success))")

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
    class TestNode {
      parentElement: TestElement | null = null
      get parentNode() { return this.parentElement }
    }
    class TestElement extends TestNode {
      style = new TestStyle()
      isConnected = true
      shadowRoot: TestShadowRoot | null = null
      nextShadowRoot: TestShadowRoot | null = null
      rootNode: TestShadowRoot | null = null
      descendants: TestElement[] = []
      constructor(readonly standard = false) { super() }
      getAttribute() { return null }
      getRootNode() { return this.rootNode }
      matches() { return false }
      contains(node: TestNode): boolean {
        return node === this || this.descendants.some((element) => element.contains(node))
      }
      querySelectorAll(selector: string): TestElement[] {
        if (selector !== "*") return []
        return this.descendants.flatMap((element) => [element, ...element.querySelectorAll("*")])
      }
      attachShadow(init: ShadowRootInit) {
        const root = this.nextShadowRoot ?? new TestShadowRoot()
        root.host = this
        if (init.mode === "open") this.shadowRoot = root
        return root
      }
    }
    class TestShadowRoot extends TestNode {
      adoptedStyleSheets: OpaqueStyleSheet[] = []
      host!: TestElement
      descendants: TestElement[] = []
      addEventListener() {}
      querySelectorAll() { return this.descendants }
    }
    class OpaqueStyleSheet {
      private disabledValue = false
      disabledWrites = 0
      ownerRule: TestImportRule | null = null
      get disabled() { return this.disabledValue }
      set disabled(value: boolean) {
        this.disabledWrites += 1
        this.disabledValue = value
      }
      get cssRules(): never {
        throw Object.assign(new Error("opaque"), { name: "SecurityError" })
      }
    }
    class TestGroupingRule {
      cssRules: Array<{ style?: TestStyle; styleSheet?: OpaqueStyleSheet }> = []
      parentStyleSheet?: CSSStyleSheet
      nextStyle?: TestStyle
      nextStyleSheet?: OpaqueStyleSheet
      deferStyleSheet = false
      insertRule() {
        if (this.nextStyle) this.cssRules.push({ style: this.nextStyle })
        else if (this.nextStyleSheet) {
          this.cssRules.push({ styleSheet: this.deferStyleSheet ? undefined : this.nextStyleSheet })
          if (!this.deferStyleSheet && this.nextStyleSheet.ownerRule) {
            this.nextStyleSheet.ownerRule.parentStyleSheet = this.parentStyleSheet ?? null
          }
        }
        return this.cssRules.length - 1
      }

      deleteRule(index: number) {
        const removed = this.cssRules[index]
        if (removed?.styleSheet?.ownerRule) removed.styleSheet.ownerRule.parentStyleSheet = null
        this.cssRules.splice(index, 1)
      }
    }
    class TestMediaList {
      mediaText = ""
      appendMedium(value: string) { this.mediaText = value }
      deleteMedium() { this.mediaText = "" }
    }
    class TestImportRule {
      parentStyleSheet: CSSStyleSheet | null = null
      constructor(readonly media: TestMediaList) {}
    }
    class TestInputElement {
      private checkedValue = false
      private customValidity = ""
      value = "0"
      valueAsNumber = 0
      get checked() { return this.checkedValue }
      set checked(value: boolean) { this.checkedValue = value }
      get validity() { return { valid: !this.customValidity } }
      setCustomValidity(message: string) { this.customValidity = message }
      stepUp(amount = 1) {
        this.valueAsNumber += amount
        this.value = String(this.valueAsNumber)
      }
      stepDown(amount = 1) {
        this.valueAsNumber -= amount
        this.value = String(this.valueAsNumber)
      }
      setRangeText(replacement: string, start = 0, end = this.value.length) {
        this.value = `${this.value.slice(0, start)}${replacement}${this.value.slice(end)}`
      }
    }
    class TestTextAreaElement extends TestInputElement {}
    class TestHistory {
      pushState() {}
      replaceState() {}
    }
    class TestStylePropertyMap {
      constructor(private readonly style: TestStyle) {}
      set(name: string, value: unknown) { this.style.assignProperty(name, String(value)) }
      append(name: string, value: unknown) { this.style.assignProperty(name, String(value)) }
      delete(name: string) { this.style.deleteProperty(name) }
      clear() { this.style.clearProperties() }
    }
    class TestCustomElementRegistry {
      private definitions = new Set<string>()
      define(name: string) {
        if (this.definitions.has(name)) throw new Error("already defined")
        this.definitions.add(name)
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
    const ancestor = new TestElement()
    const ancestorMiddle = new TestElement()
    const ancestorChild = new TestElement()
    const ancestorPanel = new TestElement()
    const eventCard = new TestElement()
    const eventTarget = new TestElement()
    const eventPanel = new TestElement()
    const authoredPanel = new TestElement()
    const unrelatedEventSibling = new TestElement()
    const closedHost = new TestElement()
    const closedElement = new TestElement()
    const closedRoot = new TestShadowRoot()
    const closedOpaque = new OpaqueStyleSheet()
    const insertedClosedHost = new TestElement()
    const insertedClosedElement = new TestElement()
    const insertedClosedRoot = new TestShadowRoot()
    const insertedClosedParentSheet = { cssRules: [], disabled: false }
    const chainElements = Array.from({ length: 32 }, () => new TestElement())
    inlineStandard.style.setProperty("--primary", "oklch(0.7 0.15 255)")
    const root = new TestElement()
    standard.parentElement = root
    inlineStandard.parentElement = root
    inherited.parentElement = root
    ancestor.parentElement = root
    ancestorMiddle.parentElement = ancestor
    ancestorChild.parentElement = ancestorMiddle
    ancestorPanel.parentElement = ancestor
    ancestor.descendants.push(ancestorMiddle, ancestorPanel)
    ancestorMiddle.descendants.push(ancestorChild)
    eventCard.parentElement = root
    eventTarget.parentElement = eventCard
    eventPanel.parentElement = eventCard
    authoredPanel.parentElement = eventCard
    eventCard.descendants.push(eventTarget, eventPanel, authoredPanel)
    unrelatedEventSibling.parentElement = root
    closedHost.parentElement = root
    closedHost.nextShadowRoot = closedRoot
    closedRoot.host = closedHost
    closedRoot.adoptedStyleSheets.push(closedOpaque)
    closedRoot.descendants.push(closedElement)
    closedElement.rootNode = closedRoot
    insertedClosedHost.parentElement = root
    insertedClosedHost.nextShadowRoot = insertedClosedRoot
    insertedClosedRoot.host = insertedClosedHost
    insertedClosedRoot.adoptedStyleSheets.push(insertedClosedParentSheet as unknown as OpaqueStyleSheet)
    insertedClosedRoot.descendants.push(insertedClosedElement)
    insertedClosedElement.rootNode = insertedClosedRoot
    root.descendants.push(
      standard, inlineStandard, inherited, ancestor, eventCard, unrelatedEventSibling,
      closedHost, insertedClosedHost, ...chainElements
    )
    for (const element of chainElements) element.parentElement = root
    const opaque = new OpaqueStyleSheet()
    const importedOpaque = new OpaqueStyleSheet()
    const importedMedia = new TestMediaList()
    importedOpaque.ownerRule = new TestImportRule(importedMedia)
    const readableImportParent = {
      cssRules: [{ styleSheet: importedOpaque }],
      disabledValue: false,
      disabledWrites: 0,
      get disabled() { return this.disabledValue },
      set disabled(value: boolean) {
        this.disabledWrites += 1
        this.disabledValue = value
      }
    }
    importedOpaque.ownerRule.parentStyleSheet = readableImportParent as unknown as CSSStyleSheet
    const typedRule = new TestStyle()
    const typedStyleMap = new TestStylePropertyMap(typedRule)
    const readableThemeSheet = { cssRules: [{ style: typedRule, styleMap: typedStyleMap }], disabled: false }
    const insertedStandardRule = new TestStyle()
    insertedStandardRule.setProperty("--primary", "rgb(1 2 3)")
    const groupingRule = new TestGroupingRule()
    groupingRule.nextStyle = insertedStandardRule
    const frames: FrameRequestCallback[] = []
    const timers: Array<() => void> = []
    const listeners = new Map<string, EventListener>()
    const mediaListeners = new Map<string, EventListener>()
    const dispatchedEvents: string[] = []
    const registeredProperties: Array<{
      name: string
      initialValue: string
      inherits: boolean
      syntax: string
    }> = []
    let legacyActive = false
    let ancestorActive = false
    let eventPanelActive = false
    let chainActive = false
    let activeCssMotion = false
    let insertedClosedOpaque: OpaqueStyleSheet | null = null
    const computedReads = new Map<TestElement, number>()
    const computedProperty = (element: TestElement, name: string): string => {
      const inClosedRoot = element.rootNode === closedRoot
      const inInsertedClosedRoot = element.rootNode === insertedClosedRoot
      if (name === "--avs-primary") {
        if ((element === eventPanel || element === authoredPanel) && eventPanelActive && !opaque.disabled) {
          return "262 83% 58%"
        }
        return inClosedRoot || opaque.disabled || !legacyActive ? "222 47% 11%" : "221 83% 53%"
      }
      if (name === "--avs-warning") {
        const insertedImportActive = insertedClosedOpaque
          && insertedClosedOpaque.ownerRule?.media.mediaText !== "not all"
        if (inInsertedClosedRoot && insertedImportActive) {
          return "32 95% 44%"
        }
        return !inClosedRoot && !opaque.disabled && legacyActive && element.style.cssText ? "32 95% 44%" : ""
      }
      if (name === "--avs-ring") {
        const chainIndex = chainElements.indexOf(element)
        if (chainIndex >= 0) {
          const previous = chainElements[chainIndex - 1]
          if (chainActive && !opaque.disabled
            && (chainIndex === 0 || previous.style.getPropertyValue("--ring"))) return "280 65% 60%"
          return computedProperty(root, name)
        }
        return !opaque.disabled && ancestorActive && element === ancestorPanel ? "199 89% 48%" : ""
      }
      if (name === "--avs-success") {
        return inClosedRoot && !closedOpaque.disabled ? "142 71% 45%" : ""
      }
      if (name === "--avs-border") {
        if (element === root) return opaque.disabled ? "" : "214 32% 91%"
        const parent = element.parentElement ?? element.rootNode?.host
        return parent ? computedProperty(parent, name) : ""
      }
      const parent = element.parentElement ?? element.rootNode?.host
      if (name === "--primary") {
        const inline = element.style.getPropertyValue(name)
        if (inline === "hsl(var(--avs-primary))") {
          return opaque.disabled ? "" : "hsl(221 83% 53%)"
        }
        if (inline) return inline
        if (!opaque.disabled && legacyActive && element.standard) return "oklch(0.62 0.19 255)"
        return parent ? computedProperty(parent, name) : readableThemeSheet.disabled ? "" : "hsl(222 47% 11%)"
      }
      if (name === "--border") {
        const inline = element.style.getPropertyValue(name)
        if (inline) return inline
        if (element === root && !opaque.disabled) return "rgb(10 20 30)"
        return parent ? computedProperty(parent, name) : readableThemeSheet.disabled ? "" : "rgb(10 20 30)"
      }
      if (name === "--warning") {
        return element.style.getPropertyValue(name) || (parent ? computedProperty(parent, name) : "")
      }
      if (name === "--ring" || name === "--success") {
        const inline = element.style.getPropertyValue(name)
        if (!inline) return parent ? computedProperty(parent, name) : ""
        if (inline !== `hsl(var(--avs-${name.slice(2)}))`) return inline
        const sourceDisabled = name === "--success" ? closedOpaque.disabled : opaque.disabled
        return sourceDisabled ? "" : inline.replace(
          `var(--avs-${name.slice(2)})`,
          name === "--ring" ? "199 89% 48%" : "142 71% 45%"
        )
      }
      const inline = element.style.getPropertyValue(name)
      return inline || (parent ? computedProperty(parent, name) : "")
    }
    const context = {
      CSSStyleDeclaration: TestStyle,
      StylePropertyMap: TestStylePropertyMap,
      CSSStyleSheet: OpaqueStyleSheet,
      CSS: {
        registerProperty(definition: { name: string; initialValue: string; inherits: boolean; syntax: string }) {
          registeredProperties.push(definition)
        }
      },
      CSSImportRule: TestImportRule,
      CSSGroupingRule: TestGroupingRule,
      CSSAnimation: class {},
      CSSTransition: class {},
      CustomElementRegistry: TestCustomElementRegistry,
      Element: TestElement,
      Event: class { constructor(readonly type: string) {} },
      HTMLLinkElement: class {},
      HTMLInputElement: TestInputElement,
      HTMLTextAreaElement: TestTextAreaElement,
      HTMLStyleElement: class {},
      MutationObserver: TestMutationObserver,
      MediaList: TestMediaList,
      Node: TestNode,
      History: TestHistory,
      ShadowRoot: TestShadowRoot,
      addEventListener(name: string, listener: EventListener) { listeners.set(name, listener) },
      history: new TestHistory(),
      typedStyleMap,
      customElements: new TestCustomElementRegistry(),
      dispatchEvent(event: { type: string }) {
        dispatchedEvents.push(event.type)
        return true
      },
      getComputedStyle(element: TestElement) {
        computedReads.set(element, (computedReads.get(element) ?? 0) + 1)
        return {
          getPropertyValue(name: string) { return computedProperty(element, name) }
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
      setTimeout(callback: () => void) {
        timers.push(callback)
        return timers.length
      },
      document: {
        adoptedStyleSheets: [],
        addEventListener() {},
        documentElement: root,
        getAnimations() {
          return activeCssMotion
            ? [{ constructor: { name: "CSSAnimation" }, playState: "running", pending: false }]
            : []
        },
        querySelectorAll() { return root.querySelectorAll("*") },
        styleSheets: [readableThemeSheet, readableImportParent, opaque]
      }
    }

    runInNewContext(loadClientCode(), context)
    expect(frames).toHaveLength(1)
    const returnedClosedRoot = closedHost.attachShadow({ mode: "closed" })
    expect(returnedClosedRoot).toBe(closedRoot)
    expect(closedHost.shadowRoot).toBe(null)
    const returnedInsertedClosedRoot = insertedClosedHost.attachShadow({ mode: "closed" })
    expect(returnedInsertedClosedRoot).toBe(insertedClosedRoot)
    expect(insertedClosedHost.shadowRoot).toBe(null)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0)
    await Promise.resolve()
    dispatchedEvents.length = 0
    expect(root.style.getPropertyValue("--primary")).toBe("")
    expect(root.style.getPropertyValue("--border")).toBe("")
    expect(closedElement.style.getPropertyValue("--success")).toBe("hsl(var(--avs-success))")
    expect(listeners.has("pointerdown")).toBe(true)
    expect(listeners.has("pointerup")).toBe(true)
    expect(listeners.has("keydown")).toBe(true)
    expect(listeners.has("beforetoggle")).toBe(true)
    expect(listeners.has("toggle")).toBe(true)
    expect(listeners.has("reset")).toBe(true)
    expect(listeners.has("animationcancel")).toBe(true)
    expect(listeners.has("transitioncancel")).toBe(true)
    expect(listeners.has("fullscreenchange")).toBe(true)
    expect(listeners.has("beforeprint")).toBe(true)
    expect(listeners.has("invalid")).toBe(true)
    expect(listeners.get("pointerdown")).not.toBe(listeners.get("resize"))
    expect(listeners.get("pointerdown")).not.toBe(listeners.get("animationstart"))
    expect(mediaListeners.has("(any-pointer: coarse)")).toBe(true)
    expect(mediaListeners.has("(any-pointer: none)")).toBe(true)
    expect(registeredProperties).toContainEqual({
      name: "--background",
      initialValue: "hsl(0 0% 100%)",
      inherits: true,
      syntax: "*"
    })

    legacyActive = true
    listeners.get("beforeprint")?.({} as Event)
    expect(frames).toHaveLength(0)
    expect(root.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    legacyActive = false
    listeners.get("afterprint")?.({} as Event)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.0625)
    expect(root.style.getPropertyValue("--primary")).toBe("")

    computedReads.clear()
    eventPanelActive = true
    listeners.get("pointerdown")?.({ target: eventTarget } as unknown as Event)
    expect(frames).toHaveLength(2)
    frames.shift()?.(0.125)
    expect(eventPanel.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(authoredPanel.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(computedReads.get(unrelatedEventSibling)).toBeUndefined()
    frames.shift()?.(0.15)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.175)
    expect(computedReads.get(unrelatedEventSibling)).toBeGreaterThan(0)

    eventPanel.style.setProperty("--primary", "hsl(var(--avs-primary))", "important")
    authoredPanel.style.cssText = authoredPanel.style.cssText
    eventPanelActive = false
    listeners.get("reset")?.({ target: eventCard } as unknown as Event)
    expect(frames).toHaveLength(2)
    frames.shift()?.(0.18)
    expect(eventPanel.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(authoredPanel.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    frames.shift()?.(0.185)
    frames.shift()?.(0.19)

    computedReads.clear()
    listeners.get("fullscreenchange")?.({} as Event)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.1875)
    expect(computedReads.get(unrelatedEventSibling)).toBeGreaterThan(0)

    insertedClosedOpaque = new OpaqueStyleSheet()
    insertedClosedOpaque.ownerRule = new TestImportRule(new TestMediaList())
    const closedGroupingRule = new TestGroupingRule()
    closedGroupingRule.parentStyleSheet = insertedClosedParentSheet as unknown as CSSStyleSheet
    insertedClosedOpaque.ownerRule.parentStyleSheet = closedGroupingRule.parentStyleSheet
    closedGroupingRule.nextStyleSheet = insertedClosedOpaque
    closedGroupingRule.deferStyleSheet = true
    closedGroupingRule.insertRule()
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.2)
    expect(insertedClosedElement.style.getPropertyValue("--warning")).toBe("")
    closedGroupingRule.cssRules[0].styleSheet = insertedClosedOpaque
    timers.pop()?.()
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.21)
    expect(insertedClosedElement.style.getPropertyValue("--warning")).toBe("hsl(var(--avs-warning))")

    closedGroupingRule.deleteRule(0)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.225)
    expect(insertedClosedElement.style.getPropertyValue("--warning")).toBe("")
    computedReads.delete(insertedClosedElement)
    listeners.get("pointerdown")?.({ target: eventTarget } as unknown as Event)
    frames.shift()?.(0.23)
    frames.shift()?.(0.235)
    frames.shift()?.(0.24)
    expect(computedReads.get(insertedClosedElement)).toBeUndefined()

    groupingRule.insertRule()
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.25)
    const media = new TestMediaList()
    media.appendMedium("screen")
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.375)
    runInNewContext("const input = new HTMLInputElement(); input.checked = true", context)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.4375)
    runInNewContext("const validityInput = new HTMLInputElement(); validityInput.setCustomValidity('invalid')", context)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.45)
    runInNewContext("const stepInput = new HTMLInputElement(); stepInput.stepUp()", context)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.455)
    runInNewContext("const rangeInput = new HTMLInputElement(); rangeInput.setRangeText('changed')", context)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.4575)
    runInNewContext("const rangeTextArea = new HTMLTextAreaElement(); rangeTextArea.setRangeText('changed')", context)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.45775)
    runInNewContext("history.pushState({}, '', '#theme-panel')", context)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.458)
    runInNewContext("history.replaceState({}, '', '#other-theme-panel')", context)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.4585)
    listeners.get("invalid")?.({ target: eventTarget } as unknown as Event)
    expect(frames.length).toBeGreaterThan(0)
    while (frames.length) frames.shift()?.(0.459)
    runInNewContext("customElements.define('theme-swatch', class {})", context)
    expect(frames).toHaveLength(1)
    frames.shift()?.(0.46)

    insertedStandardRule.setProperty("--chart-1", "oklch(0.7 0.15 255)")
    await Promise.resolve()
    expect(dispatchedEvents).toContain("avibe-show-theme-change")

    typedStyleMap.set("--avs-muted", "210 40% 96%")
    expect(typedRule.getPropertyValue("--accent")).toBe("hsl(var(--avs-muted))")
    typedStyleMap.delete("--avs-muted")
    expect(typedRule.getPropertyValue("--accent")).toBe("")
    typedStyleMap.append("--avs-warning", "32 95% 44%")
    expect(typedRule.getPropertyValue("--warning")).toBe("hsl(var(--avs-warning))")
    typedStyleMap.clear()
    expect(typedRule.getPropertyValue("--warning")).toBe("")
    await Promise.resolve()
    expect(dispatchedEvents).toContain("avibe-show-theme-change")
    while (frames.length) frames.shift()?.(0.465)

    dispatchedEvents.length = 0
    const namedStyle = insertedStandardRule as TestStyle & { fontSize: string }
    namedStyle.fontSize = "20px"
    await Promise.resolve()
    expect(dispatchedEvents).toContain("avibe-show-theme-change")

    const opaqueWritesBeforeMotion = opaque.disabledWrites
    activeCssMotion = true
    legacyActive = true
    eventPanelActive = true
    listeners.get("pointerdown")?.({ target: eventTarget } as unknown as Event)
    frames.shift()?.(0.47)
    frames.shift()?.(0.475)
    frames.shift()?.(0.48)
    expect(opaque.disabledWrites).toBe(opaqueWritesBeforeMotion)
    expect(root.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(eventPanel.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    activeCssMotion = false
    legacyActive = false
    eventPanelActive = false
    listeners.get("animationcancel")?.({ target: eventTarget } as unknown as Event)
    frames.shift()?.(0.485)
    expect(opaque.disabledWrites).toBeGreaterThan(opaqueWritesBeforeMotion)
    expect(eventPanel.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")

    chainActive = true
    listeners.get("resize")?.({} as Event)
    let continuationFrames = 0
    while (frames.length && continuationFrames < 10) {
      continuationFrames += 1
      frames.shift()?.(0.49 + continuationFrames / 1000)
    }
    expect(continuationFrames).toBeGreaterThan(1)
    expect(chainElements.at(-1)?.style.getPropertyValue("--ring")).toBe("hsl(var(--avs-ring))")
    expect(readableImportParent.disabledWrites).toBe(0)

    mutationCallbacks[1]?.([{ type: "attributes", attributeName: "class", target: closedHost }] as unknown as MutationRecord[], {} as MutationObserver)
    expect(frames).toHaveLength(2)
    frames.shift()?.(0.5)
    expect(closedElement.style.getPropertyValue("--success")).toBe("hsl(var(--avs-success))")
    frames.shift()?.(0.51)
    frames.shift()?.(0.52)

    legacyActive = true
    expect(mediaListeners.has("(prefers-reduced-motion: reduce)")).toBe(true)
    mediaListeners.get("(prefers-reduced-motion: reduce)")?.({} as Event)
    expect(frames).toHaveLength(1)
    frames.shift()?.(1)
    let mediaContinuationFrames = 0
    while (frames.length && mediaContinuationFrames < 10) {
      mediaContinuationFrames += 1
      frames.shift()?.(1 + mediaContinuationFrames / 100)
    }
    expect(frames).toHaveLength(0)

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
    expect(frames).toHaveLength(2)
    frames.shift()?.(2)
    expect(root.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    frames.shift()?.(2.125)
    frames.shift()?.(2.25)

    await Promise.resolve()
    ancestorActive = true
    mutationCallbacks[1]?.([{ type: "attributes", attributeName: "class", target: ancestorChild }] as unknown as MutationRecord[], {} as MutationObserver)
    expect(frames).toHaveLength(2)
    frames.shift()?.(3)
    expect(ancestorPanel.style.getPropertyValue("--ring")).toBe("")
    frames.shift()?.(3.125)
    frames.shift()?.(3.25)
    expect(ancestorPanel.style.getPropertyValue("--ring")).toBe("hsl(var(--avs-ring))")

    root.isConnected = false
    listeners.get("focus")?.({ target: external } as unknown as Event)
    expect(frames).toHaveLength(2)
    frames.shift()?.(4)
    expect(root.style.getPropertyValue("--primary")).toBe("")
    frames.shift()?.(4.25)
    frames.shift()?.(4.5)
    root.isConnected = true

    root.style.cssText += "; color: red"
    expect(root.style.getPropertyValue("--primary")).toBe("")
    expect(root.style.getPropertyValue("color")).toBe("red")
    listeners.get("resize")?.({} as Event)
    frames.shift()?.(5)
    expect(root.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(root.style.getPropertyValue("--warning")).toBe("hsl(var(--avs-warning))")

    root.style.setProperty("--primary", "oklch(0.62 0.19 255)", "invalid")
    expect(root.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    opaque.disabled = true
    expect(frames).toHaveLength(1)
    frames.shift()?.(6)
    expect(root.style.getPropertyValue("--primary")).toBe("")
    expect(opaque.disabled).toBe(true)
  })
})
