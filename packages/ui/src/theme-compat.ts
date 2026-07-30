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
  deleteRule: (index: number) => void
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
  const observedAdoptedLists = new WeakSet<object>()
  const patchedDisabledPrototypes = new WeakSet<object>()
  const themeChangeEvent = "avibe:show-theme-change"
  const stylePrototype = globalThis.CSSStyleDeclaration?.prototype
  const nativeSetProperty = stylePrototype?.setProperty
  const nativeRemoveProperty = stylePrototype?.removeProperty

  function migratedValue(source: string, target: string) {
    return target === "--radius" ? `var(${source})` : `hsl(var(${source}))`
  }

  function ownershipMarker(target: string) {
    return `${ownershipPrefix}${target.slice(2)}`
  }

  function notifyThemeChange() {
    const EventConstructor = document.defaultView?.Event ?? globalThis.Event
    if (typeof EventConstructor === "function") {
      document.dispatchEvent(new EventConstructor(themeChangeEvent))
    }
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

  function syncLegacyStyleSheet(sheet: CSSStyleSheet | null | undefined) {
    try {
      if (sheet?.cssRules) syncLegacyRuleList(sheet.cssRules)
    } catch (error) {
      if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "SecurityError") return
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
        notifyThemeChange()
        return insertedIndex
      }
    }
    const deleteRule = prototype.deleteRule
    if (typeof deleteRule === "function") {
      prototype.deleteRule = function(this: RuleContainer, index: number) {
        deleteRule.call(this, index)
        notifyThemeChange()
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
        notifyThemeChange()
      }
    }
    const deleteRule = prototype.deleteRule
    if (typeof deleteRule === "function") {
      prototype.deleteRule = function(this: CSSKeyframesRule, select: string) {
        deleteRule.call(this, select)
        notifyThemeChange()
      }
    }
  }

  function patchStylesheetDisabled(input: object | undefined) {
    if (!input) return
    let prototype: object | null = input
    let descriptor = Object.getOwnPropertyDescriptor(prototype, "disabled")
    while (!descriptor && (prototype = Object.getPrototypeOf(prototype))) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, "disabled")
    }
    if (!descriptor?.get || !descriptor.set) return
    if (!prototype || patchedDisabledPrototypes.has(prototype)) return
    patchedDisabledPrototypes.add(prototype)
    Object.defineProperty(prototype, "disabled", {
      ...descriptor,
      set(value: boolean) {
        descriptor.set?.call(this, value)
        notifyThemeChange()
      }
    })
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
            notifyThemeChange()
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
        notifyThemeChange()
      }
    })
  }

  if (stylePrototype && nativeSetProperty && nativeRemoveProperty) {
    const cssText = Object.getOwnPropertyDescriptor(stylePrototype, "cssText")
    stylePrototype.setProperty = function(name: string, value: string | null, priority?: string) {
      nativeSetProperty.call(this, name, value, priority)
      const propertyName = String(name)
      if (legacySources.includes(propertyName) || (migratedTargets.has(propertyName) && (ownedDeclarations.has(this) || hasLegacyDeclaration(this)))) {
        syncLegacyDeclaration(this)
      }
      if (this.parentRule && propertyName.startsWith("--")) notifyThemeChange()
    }
    stylePrototype.removeProperty = function(name: string) {
      const value = nativeRemoveProperty.call(this, name)
      const propertyName = String(name)
      if (legacySources.includes(propertyName) || (migratedTargets.has(propertyName) && (ownedDeclarations.has(this) || hasLegacyDeclaration(this)))) {
        syncLegacyDeclaration(this)
      }
      if (this.parentRule && propertyName.startsWith("--")) notifyThemeChange()
      return value
    }
    if (cssText?.get && cssText.set) {
      Object.defineProperty(stylePrototype, "cssText", {
        ...cssText,
        set(value: string | null) {
          const wasOwned = ownedDeclarations.has(this)
          const previous = cssText.get?.call(this) ?? ""
          cssText.set?.call(this, value)
          const current = cssText.get?.call(this) ?? ""
          if (wasOwned || current.includes("--avs-")) syncLegacyDeclaration(this, current.includes("--avs-"))
          if (this.parentRule && (previous.includes("--") || current.includes("--"))) notifyThemeChange()
        }
      })
    }
  }

  const sheetPrototype = globalThis.CSSStyleSheet?.prototype
  patchRuleContainer(sheetPrototype)
  patchRuleContainer(globalThis.CSSGroupingRule?.prototype)
  patchKeyframesRule(globalThis.CSSKeyframesRule?.prototype)
  patchStylesheetDisabled(sheetPrototype)
  patchStylesheetDisabled(globalThis.StyleSheet?.prototype)
  if (sheetPrototype?.replaceSync) {
    const replaceSync = sheetPrototype.replaceSync
    sheetPrototype.replaceSync = function(text: string) {
      replaceSync.call(this, text)
      syncLegacyStyleSheet(this)
      notifyThemeChange()
    }
  }
  if (sheetPrototype?.replace) {
    const replace = sheetPrototype.replace
    sheetPrototype.replace = async function(text: string) {
      const result = await replace.call(this, text)
      syncLegacyStyleSheet(this)
      notifyThemeChange()
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
          if (record.target.getAttribute("style")?.includes("--avs-") || ownedDeclarations.has((record.target as HTMLElement).style)) {
            syncLegacyTheme(record.target as HTMLElement)
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
    root.addEventListener("load", stylesheetLoad, true)
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
