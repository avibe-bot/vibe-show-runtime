export const LEGACY_THEME_MIGRATIONS: Record<string, readonly string[]> = {
  "--avs-background": ["--background", "--card", "--popover"],
  "--avs-foreground": ["--foreground", "--card-foreground", "--popover-foreground", "--secondary-foreground", "--accent-foreground"],
  "--avs-muted": ["--secondary", "--muted", "--accent"],
  "--avs-muted-foreground": ["--muted-foreground"],
  "--avs-border": ["--border", "--input"],
  "--avs-primary": ["--primary"],
  "--avs-primary-foreground": ["--primary-foreground"],
  "--avs-ring": ["--ring"],
  "--avs-success": ["--success"],
  "--avs-warning": ["--warning"],
  "--avs-destructive": ["--destructive"],
  "--avs-radius": ["--radius"]
}

export const LEGACY_THEME_OWNERSHIP_PREFIX = "--avibe-show-theme-owner-"

export function legacyThemeOwnershipMarker(target: string): string {
  return `${LEGACY_THEME_OWNERSHIP_PREFIX}${target.slice(2)}`
}

type OwnedDeclaration = { value: string; priority: string }
type RuleContainer = {
  cssRules: CSSRuleList
  insertRule: (rule: string, index?: number) => number
}

function installLegacyThemeCompatibilityWithMigrations(
  migrations: Record<string, readonly string[]>,
  ownershipPrefix: string
) {
  if (typeof document === "undefined") return

  const runtime = globalThis as typeof globalThis & {
    __avibeShowThemeCompatInstalled?: boolean
  }
  if (runtime.__avibeShowThemeCompatInstalled) return
  runtime.__avibeShowThemeCompatInstalled = true

  const legacySources = Object.keys(migrations)
  const legacySourceSet = new Set(legacySources)
  const migratedTargets = new Set(Object.values(migrations).flat())
  const ownedDeclarations = new WeakMap<CSSStyleDeclaration, Map<string, OwnedDeclaration>>()
  const opaqueOwnedDeclarations = new Map<CSSStyleDeclaration, Map<string, OwnedDeclaration>>()
  const opaqueBridgeSignatures = new WeakMap<CSSStyleDeclaration, string>()
  const opaqueStyleSheets = new Set<CSSStyleSheet>()
  const observedAdoptedLists = new WeakSet<object>()
  const stylePrototype = globalThis.CSSStyleDeclaration?.prototype
  const nativeSetProperty = stylePrototype?.setProperty
  const nativeRemoveProperty = stylePrototype?.removeProperty
  let opaqueScanFrame = 0
  let mutatingOpaqueBridge = false

  function migratedValue(source: string, target: string) {
    return target === "--radius" ? `var(${source})` : `hsl(var(${source}))`
  }

  function ownershipMarker(target: string) {
    return `${ownershipPrefix}${target.slice(2)}`
  }

  function removeOwnershipMarker(style: CSSStyleDeclaration, source: string, target: string) {
    const marker = ownershipMarker(target)
    if (style.getPropertyValue(marker).trim() !== source) return
    if (nativeRemoveProperty) nativeRemoveProperty.call(style, marker)
    else style.removeProperty(marker)
  }

  function hasLegacyDeclaration(style: CSSStyleDeclaration) {
    for (let index = 0; index < style.length; index += 1) {
      if (legacySourceSet.has(style.item(index))) return true
    }
    return false
  }

  function declaredProperties(style: CSSStyleDeclaration) {
    const properties = new Set<string>()
    for (let index = 0; index < style.length; index += 1) {
      properties.add(style.item(index))
    }
    return properties
  }

  function syncLegacyDeclaration(style: CSSStyleDeclaration, knownCandidate = false) {
    let owned = ownedDeclarations.get(style)
    if (!owned && !knownCandidate && !hasLegacyDeclaration(style)) return
    if (!owned) {
      owned = new Map()
      ownedDeclarations.set(style, owned)
    }
    const declared = declaredProperties(style)

    for (const [source, targets] of Object.entries(migrations)) {
      const sourcePriority = style.getPropertyPriority(source)
      const sourceDeclared = declared.has(source)
      for (const target of targets) {
        const currentValue = style.getPropertyValue(target).trim()
        const currentPriority = style.getPropertyPriority(target)
        const currentDeclared = declared.has(target)
        let previous = owned.get(target)
        if (!previous
          && style.getPropertyValue(ownershipMarker(target)).trim() === source
          && currentValue === migratedValue(source, target)) {
          previous = { value: currentValue, priority: currentPriority }
          owned.set(target, previous)
        }
        const stillOwned = previous?.value === currentValue && previous.priority === currentPriority

        if (!sourceDeclared) {
          if (stillOwned) {
            if (nativeRemoveProperty) nativeRemoveProperty.call(style, target)
            else style.removeProperty(target)
            declared.delete(target)
          }
          owned.delete(target)
          removeOwnershipMarker(style, source, target)
          continue
        }

        if (!currentDeclared || stillOwned) {
          const value = migratedValue(source, target)
          if (currentValue !== value || currentPriority !== sourcePriority) {
            if (nativeSetProperty) nativeSetProperty.call(style, target, value, sourcePriority)
            else style.setProperty(target, value, sourcePriority)
          }
          declared.add(target)
          owned.set(target, { value, priority: sourcePriority })
        } else if (previous) {
          owned.delete(target)
          removeOwnershipMarker(style, source, target)
        }
      }
    }
    if (!owned.size) ownedDeclarations.delete(style)
  }

  function syncLegacyTheme(element: Element & { style: CSSStyleDeclaration }) {
    syncLegacyDeclaration(element.style, true)
  }

  function scanLegacyThemes(root: Node & ParentNode) {
    if (root instanceof Element && root.getAttribute("style")?.includes("--avs-")) {
      syncLegacyTheme(root as HTMLElement)
    }
    for (const element of root.querySelectorAll<HTMLElement>('[style*="--avs-"]')) {
      syncLegacyTheme(element)
    }
  }

  function syncLegacyRuleList(rules: CSSRuleList | CSSRule[]) {
    for (const rule of Array.from(rules)) {
      const candidate = rule as CSSRule & {
        style?: CSSStyleDeclaration
        cssRules?: CSSRuleList
        styleSheet?: CSSStyleSheet | null
      }
      if (candidate.style && (ownedDeclarations.has(candidate.style) || candidate.style.cssText.includes("--avs-"))) {
        syncLegacyDeclaration(candidate.style, true)
      }
      if (candidate.cssRules) syncLegacyRuleList(candidate.cssRules)
      if (candidate.styleSheet) syncLegacyStyleSheet(candidate.styleSheet)
    }
  }

  function scheduleOpaqueLegacyScan() {
    if (!opaqueStyleSheets.size || opaqueScanFrame) return
    const requestFrame = globalThis.requestAnimationFrame
      ?? ((callback: FrameRequestCallback) => globalThis.setTimeout(() => callback(performance.now()), 0) as unknown as number)
    opaqueScanFrame = requestFrame(() => {
      opaqueScanFrame = 0
      syncOpaqueLegacyThemes()
    })
  }

  function registerOpaqueStyleSheet(sheet: CSSStyleSheet) {
    opaqueStyleSheets.add(sheet)
    scheduleOpaqueLegacyScan()
  }

  function clearOpaqueOwnedDeclarations() {
    mutatingOpaqueBridge = true
    try {
      for (const [style, owned] of opaqueOwnedDeclarations) {
        for (const [target, previous] of owned) {
          if (style.getPropertyValue(target).trim() === previous.value
            && style.getPropertyPriority(target) === previous.priority) {
            if (nativeRemoveProperty) nativeRemoveProperty.call(style, target)
            else style.removeProperty(target)
          }
        }
        opaqueBridgeSignatures.delete(style)
      }
      opaqueOwnedDeclarations.clear()
    } finally {
      mutatingOpaqueBridge = false
    }
  }

  function compatibilityElements() {
    const elements: Array<Element & { style: CSSStyleDeclaration }> = []
    const seenRoots = new Set<Document | ShadowRoot>()
    const visit = (root: Document | ShadowRoot) => {
      if (seenRoots.has(root)) return
      seenRoots.add(root)
      const candidates = root === document
        ? [document.documentElement, ...document.querySelectorAll("*")]
        : Array.from(root.querySelectorAll("*"))
      for (const element of candidates) {
        if (element && "style" in element) {
          elements.push(element as Element & { style: CSSStyleDeclaration })
        }
        if (element?.shadowRoot) visit(element.shadowRoot)
      }
    }
    visit(document)
    return elements
  }

  function sampleThemeValues(elements: Array<Element & { style: CSSStyleDeclaration }>) {
    const properties = [...legacySources, ...migratedTargets]
    const samples = new Map<Element, Map<string, string>>()
    for (const element of elements) {
      if (!element.isConnected) continue
      const computed = getComputedStyle(element)
      samples.set(element, new Map(properties.map((property) => [property, computed.getPropertyValue(property).trim()])))
    }
    return samples
  }

  function composedParentElement(element: Element): Element | null {
    if (element.assignedSlot) return element.assignedSlot
    if (element.parentElement) return element.parentElement
    const root = element.getRootNode()
    return typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot ? root.host : null
  }

  // Cross-origin rules are opaque to CSSOM. Compare their computed effect with the
  // sheets disabled, then bridge only legacy deltas that did not also set a standard token.
  function syncOpaqueLegacyThemes() {
    const activeSheets: Array<{ sheet: CSSStyleSheet; disabled: boolean }> = []
    for (const sheet of opaqueStyleSheets) {
      try {
        if (sheet.disabled) continue
        const disabled = sheet.disabled
        sheet.disabled = true
        activeSheets.push({ sheet, disabled })
      } catch {
        // A stylesheet that cannot be toggled cannot be compared without changing page semantics.
        opaqueStyleSheets.delete(sheet)
      }
    }
    if (!activeSheets.length) return

    clearOpaqueOwnedDeclarations()
    const elements = compatibilityElements()
    let baseline: Map<Element, Map<string, string>>
    try {
      baseline = sampleThemeValues(elements)
    } finally {
      for (const { sheet, disabled } of activeSheets) sheet.disabled = disabled
    }
    const actual = sampleThemeValues(elements)
    mutatingOpaqueBridge = true
    try {
      for (const element of elements) {
        const before = baseline.get(element)
        const after = actual.get(element)
        if (!before || !after) continue
        const parent = composedParentElement(element)
        const parentBefore = parent ? baseline.get(parent) : undefined
        const parentAfter = parent ? actual.get(parent) : undefined
        const owned = new Map<string, OwnedDeclaration>()
        const inlineDeclarations = declaredProperties(element.style)
        for (const [source, targets] of Object.entries(migrations)) {
          if (before.get(source) === after.get(source)) continue
          if (parentBefore?.get(source) === before.get(source)
            && parentAfter?.get(source) === after.get(source)) continue
          for (const target of targets) {
            if (inlineDeclarations.has(target)) continue
            if (parentBefore && parentBefore.get(target) !== before.get(target)) continue
            if (before.get(target) !== after.get(target)) continue
            const value = migratedValue(source, target)
            if (nativeSetProperty) nativeSetProperty.call(element.style, target, value, "important")
            else element.style.setProperty(target, value, "important")
            owned.set(target, { value, priority: "important" })
          }
        }
        if (owned.size) {
          opaqueOwnedDeclarations.set(element.style, owned)
          opaqueBridgeSignatures.set(element.style, element.style.cssText)
        }
      }
    } finally {
      mutatingOpaqueBridge = false
    }
  }

  function opaqueBridgeIsCurrent(style: CSSStyleDeclaration) {
    const owned = opaqueOwnedDeclarations.get(style)
    if (!owned || opaqueBridgeSignatures.get(style) !== style.cssText) return false
    for (const [target, previous] of owned) {
      if (style.getPropertyValue(target).trim() !== previous.value
        || style.getPropertyPriority(target) !== previous.priority) return false
    }
    return true
  }

  function relinquishOpaqueOwnership(style: CSSStyleDeclaration, target?: string) {
    const owned = opaqueOwnedDeclarations.get(style)
    if (!owned) return
    if (target) owned.delete(target)
    else owned.clear()
    opaqueBridgeSignatures.delete(style)
    if (!owned.size) opaqueOwnedDeclarations.delete(style)
  }

  function syncLegacyStyleSheet(sheet: CSSStyleSheet | null | undefined) {
    try {
      if (sheet?.cssRules) syncLegacyRuleList(sheet.cssRules)
    } catch (error) {
      if (sheet && typeof error === "object" && error && "name" in error && error.name === "SecurityError") {
        registerOpaqueStyleSheet(sheet)
        return
      }
      throw error
    }
  }

  function scanLegacyStyleSheets(root: Node & ParentNode) {
    if (root instanceof Element && root.matches("style, link[rel~=stylesheet]")) {
      syncLegacyStyleSheet((root as HTMLStyleElement | HTMLLinkElement).sheet)
    }
    for (const element of root.querySelectorAll<HTMLStyleElement | HTMLLinkElement>("style, link[rel~=stylesheet]")) {
      syncLegacyStyleSheet(element.sheet)
    }
  }

  function patchRuleContainer(input: object | undefined) {
    if (!input) return
    const prototype = input as RuleContainer
    const insertRule = prototype.insertRule
    if (typeof insertRule === "function") {
      prototype.insertRule = function(this: RuleContainer, rule: string, index?: number) {
        const insertedIndex = insertRule.call(this, rule, index)
        const insertedRule = this.cssRules[insertedIndex]
        if (insertedRule) syncLegacyRuleList([insertedRule])
        return insertedIndex
      }
    }
  }

  function patchKeyframesRule(input: object | undefined) {
    if (!input) return
    const prototype = input as CSSKeyframesRule
    const appendRule = prototype.appendRule
    if (typeof appendRule === "function") {
      prototype.appendRule = function(this: CSSKeyframesRule, rule: string) {
        const previousLength = this.cssRules.length
        appendRule.call(this, rule)
        for (let index = previousLength; index < this.cssRules.length; index += 1) {
          const insertedRule = this.cssRules[index]
          if (insertedRule) syncLegacyRuleList([insertedRule])
        }
      }
    }
  }

  function observeAdoptedStyleSheetList(list: CSSStyleSheet[]) {
    if (observedAdoptedLists.has(list)) return
    observedAdoptedLists.add(list)
    const methods = ["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"] as const
    for (const name of methods) {
      const method = list[name]
      if (typeof method !== "function") continue
      try {
        Object.defineProperty(list, name, {
          configurable: true,
          writable: true,
          value: function(this: CSSStyleSheet[], ...args: unknown[]) {
            const result = (method as (...values: unknown[]) => unknown).apply(this, args)
            for (const sheet of Array.from(this)) syncLegacyStyleSheet(sheet)
            return result
          }
        })
      } catch {
        // Older FrozenArray implementations cannot be mutated in place.
      }
    }
  }

  function patchAdoptedStyleSheets(input: object | undefined) {
    if (!input) return
    const descriptor = Object.getOwnPropertyDescriptor(input, "adoptedStyleSheets")
    if (!descriptor?.get || !descriptor.set) return
    Object.defineProperty(input, "adoptedStyleSheets", {
      ...descriptor,
      set(value: CSSStyleSheet[]) {
        descriptor.set?.call(this, value)
        const list = descriptor.get?.call(this) ?? []
        observeAdoptedStyleSheetList(list)
        for (const sheet of list) syncLegacyStyleSheet(sheet)
      }
    })
  }

  if (stylePrototype && nativeSetProperty && nativeRemoveProperty) {
    const cssText = Object.getOwnPropertyDescriptor(stylePrototype, "cssText")
    stylePrototype.setProperty = function(name: string, value: string | null, priority?: string) {
      const propertyName = String(name)
      if (!mutatingOpaqueBridge && migratedTargets.has(propertyName)) relinquishOpaqueOwnership(this, propertyName)
      nativeSetProperty.call(this, name, value, priority)
      if (legacySources.includes(propertyName) || (migratedTargets.has(propertyName) && (ownedDeclarations.has(this) || hasLegacyDeclaration(this)))) {
        syncLegacyDeclaration(this)
      }
      if (!mutatingOpaqueBridge && opaqueStyleSheets.size) scheduleOpaqueLegacyScan()
    }
    stylePrototype.removeProperty = function(name: string) {
      const propertyName = String(name)
      if (!mutatingOpaqueBridge && migratedTargets.has(propertyName)) relinquishOpaqueOwnership(this, propertyName)
      const value = nativeRemoveProperty.call(this, name)
      if (legacySources.includes(propertyName) || (migratedTargets.has(propertyName) && (ownedDeclarations.has(this) || hasLegacyDeclaration(this)))) {
        syncLegacyDeclaration(this)
      }
      if (!mutatingOpaqueBridge && opaqueStyleSheets.size) scheduleOpaqueLegacyScan()
      return value
    }
    if (cssText?.get && cssText.set) {
      Object.defineProperty(stylePrototype, "cssText", {
        ...cssText,
        set(value: string | null) {
          const wasOwned = ownedDeclarations.has(this)
          if (!mutatingOpaqueBridge) relinquishOpaqueOwnership(this)
          cssText.set?.call(this, value)
          const current = cssText.get?.call(this) ?? ""
          if (wasOwned || current.includes("--avs-")) syncLegacyDeclaration(this, current.includes("--avs-"))
          if (!mutatingOpaqueBridge && opaqueStyleSheets.size) scheduleOpaqueLegacyScan()
        }
      })
    }
  }

  const sheetPrototype = globalThis.CSSStyleSheet?.prototype
  patchRuleContainer(sheetPrototype)
  patchRuleContainer(globalThis.CSSGroupingRule?.prototype)
  patchKeyframesRule(globalThis.CSSKeyframesRule?.prototype)
  if (sheetPrototype?.replaceSync) {
    const replaceSync = sheetPrototype.replaceSync
    sheetPrototype.replaceSync = function(text: string) {
      replaceSync.call(this, text)
      syncLegacyStyleSheet(this)
    }
  }
  if (sheetPrototype?.replace) {
    const replace = sheetPrototype.replace
    sheetPrototype.replace = async function(text: string) {
      const result = await replace.call(this, text)
      syncLegacyStyleSheet(this)
      return result
    }
  }

  patchAdoptedStyleSheets(globalThis.Document?.prototype)
  patchAdoptedStyleSheets(globalThis.ShadowRoot?.prototype)
  const observedRoots = new WeakSet<Document | ShadowRoot>()
  const stylesheetLoad = (event: Event) => {
    const target = event.target
    if (target instanceof HTMLLinkElement && target.relList.contains("stylesheet")) {
      syncLegacyStyleSheet(target.sheet)
    }
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        if (!(record.target instanceof Element)) continue
        if (record.attributeName === "style") {
          const target = record.target as HTMLElement
          if (record.target.getAttribute("style")?.includes("--avs-") || ownedDeclarations.has(target.style)) {
            syncLegacyTheme(target)
          }
        } else {
          scanLegacyStyleSheets(record.target)
        }
      } else {
        const owner = record.target.parentElement?.closest("style")
          ?? (record.target instanceof Element ? record.target.closest("style") : null)
        if (owner instanceof HTMLStyleElement) syncLegacyStyleSheet(owner.sheet)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          scanLegacyThemes(node)
          scanLegacyStyleSheets(node)
          scanShadowRoots(node)
        }
      }
    }
  })
  const opaqueObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.attributeName === "style"
        && record.target instanceof Element
        && opaqueBridgeIsCurrent((record.target as HTMLElement).style)) continue
      scheduleOpaqueLegacyScan()
      return
    }
  })

  function scanShadowRoots(root: Node & ParentNode) {
    const hosts = root instanceof Element ? [root, ...root.querySelectorAll("*")] : Array.from(root.querySelectorAll("*"))
    for (const host of hosts) {
      if (host.shadowRoot) observeCompatibilityRoot(host.shadowRoot)
    }
  }

  function observeCompatibilityRoot(root: Document | ShadowRoot) {
    if (observedRoots.has(root)) return
    const container = root === document ? document.documentElement : root
    if (!container) return
    observedRoots.add(root)
    scanLegacyThemes(container)
    scanLegacyStyleSheets(container)
    const styleSheets = root === document ? document.styleSheets : []
    for (const sheet of Array.from(styleSheets)) syncLegacyStyleSheet(sheet)
    const adoptedStyleSheets = root.adoptedStyleSheets ?? []
    observeAdoptedStyleSheetList(adoptedStyleSheets)
    for (const sheet of Array.from(adoptedStyleSheets)) syncLegacyStyleSheet(sheet)
    scanShadowRoots(container)
    observer.observe(container, {
      attributes: true,
      attributeFilter: ["style", "href", "rel", "media", "disabled"],
      characterData: true,
      childList: true,
      subtree: true
    })
    opaqueObserver.observe(container, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    })
    root.addEventListener("load", stylesheetLoad, true)
  }

  for (const event of [
    "resize", "orientationchange", "pageshow", "focus", "pointerover", "pointerout",
    "focusin", "focusout", "input", "change", "animationstart", "animationiteration",
    "animationend", "transitionrun", "transitionend"
  ]) {
    globalThis.addEventListener?.(event, scheduleOpaqueLegacyScan, true)
  }

  const elementPrototype = globalThis.Element?.prototype
  if (elementPrototype?.attachShadow) {
    const attachShadow = elementPrototype.attachShadow
    elementPrototype.attachShadow = function(init: ShadowRootInit) {
      const root = attachShadow.call(this, init)
      observeCompatibilityRoot(root)
      return root
    }
  }
  observeCompatibilityRoot(document)
}

export function installLegacyThemeCompatibility() {
  installLegacyThemeCompatibilityWithMigrations(LEGACY_THEME_MIGRATIONS, LEGACY_THEME_OWNERSHIP_PREFIX)
}

export function themeCompatibilityClientScript(): string {
  return `(${installLegacyThemeCompatibilityWithMigrations.toString()})(${JSON.stringify(LEGACY_THEME_MIGRATIONS)},${JSON.stringify(LEGACY_THEME_OWNERSHIP_PREFIX)});`
}

installLegacyThemeCompatibility()
