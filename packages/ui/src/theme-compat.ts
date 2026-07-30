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
  const migratedTargets = new Set(Object.values(migrations).flat())
  const ownedDeclarations = new WeakMap<CSSStyleDeclaration, Map<string, OwnedDeclaration>>()
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
    return legacySources.some((source) => style.getPropertyValue(source).trim())
  }

  function syncLegacyDeclaration(style: CSSStyleDeclaration, knownCandidate = false) {
    let owned = ownedDeclarations.get(style)
    if (!owned && !knownCandidate && !hasLegacyDeclaration(style)) return
    if (!owned) {
      owned = new Map()
      ownedDeclarations.set(style, owned)
    }

    for (const [source, targets] of Object.entries(migrations)) {
      const sourceValue = style.getPropertyValue(source).trim()
      const sourcePriority = style.getPropertyPriority(source)
      for (const target of targets) {
        const currentValue = style.getPropertyValue(target).trim()
        const currentPriority = style.getPropertyPriority(target)
        let previous = owned.get(target)
        if (!previous
          && style.getPropertyValue(ownershipMarker(target)).trim() === source
          && currentValue === migratedValue(source, target)) {
          previous = { value: currentValue, priority: currentPriority }
          owned.set(target, previous)
        }
        const stillOwned = previous?.value === currentValue && previous.priority === currentPriority

        if (!sourceValue) {
          if (stillOwned) {
            if (nativeRemoveProperty) nativeRemoveProperty.call(style, target)
            else style.removeProperty(target)
          }
          owned.delete(target)
          continue
        }

        if (!currentValue || stillOwned) {
          const value = migratedValue(source, target)
          if (currentValue !== value || currentPriority !== sourcePriority) {
            if (nativeSetProperty) nativeSetProperty.call(style, target, value, sourcePriority)
            else style.setProperty(target, value, sourcePriority)
          }
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

  function scanLegacyThemes(root: Node) {
    if (!(root instanceof Element)) return
    if (root.getAttribute("style")?.includes("--avs-")) syncLegacyTheme(root as HTMLElement)
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

  function scanLegacyStyleSheets(root: Node) {
    if (!(root instanceof Element)) return
    if (root.matches("style, link[rel~=stylesheet]")) {
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

  function patchAdoptedStyleSheets(input: object | undefined) {
    if (!input) return
    const descriptor = Object.getOwnPropertyDescriptor(input, "adoptedStyleSheets")
    if (!descriptor?.get || !descriptor.set) return
    Object.defineProperty(input, "adoptedStyleSheets", {
      ...descriptor,
      set(value: CSSStyleSheet[]) {
        descriptor.set?.call(this, value)
        for (const sheet of descriptor.get?.call(this) ?? []) syncLegacyStyleSheet(sheet)
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
          if (wasOwned || current.includes("--avs-")) syncLegacyDeclaration(this)
          if (this.parentRule && (previous.includes("--") || current.includes("--"))) notifyThemeChange()
        }
      })
    }
  }

  const sheetPrototype = globalThis.CSSStyleSheet?.prototype
  patchRuleContainer(sheetPrototype)
  patchRuleContainer(globalThis.CSSGroupingRule?.prototype)
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
  scanLegacyThemes(document.documentElement)
  for (const sheet of Array.from(document.styleSheets)) syncLegacyStyleSheet(sheet)
  for (const sheet of Array.from(document.adoptedStyleSheets ?? [])) syncLegacyStyleSheet(sheet)
  new MutationObserver((records) => {
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
          scanLegacyThemes(node)
          scanLegacyStyleSheets(node)
        }
      }
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "href", "rel", "media", "disabled"],
    characterData: true,
    childList: true,
    subtree: true
  })
  document.addEventListener("load", (event) => {
    const target = event.target
    if (target instanceof HTMLLinkElement && target.relList.contains("stylesheet")) {
      syncLegacyStyleSheet(target.sheet)
    }
  }, true)
}

export function installLegacyThemeCompatibility() {
  installLegacyThemeCompatibilityWithMigrations(LEGACY_THEME_MIGRATIONS, LEGACY_THEME_OWNERSHIP_PREFIX)
}

export function themeCompatibilityClientScript(): string {
  return `(${installLegacyThemeCompatibilityWithMigrations.toString()})(${JSON.stringify(LEGACY_THEME_MIGRATIONS)},${JSON.stringify(LEGACY_THEME_OWNERSHIP_PREFIX)});`
}

installLegacyThemeCompatibility()
