import { SHOW_PORTAL_THEME_PROPERTIES } from "./theme-properties"

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
export const SHOW_THEME_CHANGE_EVENT = "avibe-show-theme-change"

export function legacyThemeOwnershipMarker(target: string): string {
  return `${LEGACY_THEME_OWNERSHIP_PREFIX}${target.slice(2)}`
}

type OwnedDeclaration = { value: string; priority: string }
type ThemeElement = Element & { style: CSSStyleDeclaration }
type OpaqueOwnedDeclarations = {
  element: ThemeElement
  declarations: Map<string, OwnedDeclaration>
}
type OpaqueStyleSheetState = {
  sheet: CSSStyleSheet
  disabled: boolean
  scope?: Document | ShadowRoot
  importMedia?: MediaList
  importMediaText?: string
}
type RuleContainer = {
  cssRules: CSSRuleList
  insertRule: (rule: string, index?: number) => number
  parentStyleSheet?: CSSStyleSheet | null
  addRule?: (selector?: string, style?: string, index?: number) => number
  deleteRule?: (index: number) => void
  removeRule?: (index: number) => void
}

function installLegacyThemeCompatibilityWithMigrations(
  migrations: Record<string, readonly string[]>,
  ownershipPrefix: string,
  themeChangeEvent: string,
  portalThemeProperties: readonly string[]
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
  const portalThemeMutationPropertySet = new Set([...portalThemeProperties, "all", "font"])
  const ownedDeclarations = new WeakMap<CSSStyleDeclaration, Map<string, OwnedDeclaration>>()
  const opaqueOwnedDeclarations = new Map<CSSStyleDeclaration, OpaqueOwnedDeclarations>()
  const opaqueBridgeSignatures = new WeakMap<CSSStyleDeclaration, string>()
  const knownOpaqueStandardTargets = new WeakMap<Element, Set<string>>()
  const stableThemeValues = new WeakMap<Element, Map<string, string>>()
  const pendingOpaqueBridgeMutations = new Set<Element>()
  const opaqueStyleSheets = new Set<CSSStyleSheet>()
  const opaqueStyleSheetScopes = new Map<CSSStyleSheet, Document | ShadowRoot | undefined>()
  const styleSheetScopes = new WeakMap<CSSStyleSheet, Document | ShadowRoot | undefined>()
  const ruleStyleDeclarations = new WeakSet<CSSStyleDeclaration>()
  const patchedRuleStyleDeclarations = new WeakSet<CSSStyleDeclaration>()
  const patchedCustomStateSets = new WeakSet<object>()
  const stylePropertyMapOwners = new WeakMap<object, CSSStyleDeclaration>()
  const adoptedListProxies = new WeakMap<object, CSSStyleSheet[]>()
  const observedAdoptedLists = new Map<CSSStyleSheet[], {
    scope?: Document | ShadowRoot
    snapshot: CSSStyleSheet[]
  }>()
  const knownShadowRoots = new WeakMap<Element, ShadowRoot>()
  const activeShadowRoots = new Set<ShadowRoot>()
  const inactiveShadowRoots = new WeakSet<ShadowRoot>()
  const shadowHostThemeProperties = portalThemeProperties.filter(
    (property) => property.startsWith("--") && !property.startsWith("--avs-")
  )
  const stylePrototype = globalThis.CSSStyleDeclaration?.prototype
  const nativeSetProperty = stylePrototype?.setProperty
  const nativeRemoveProperty = stylePrototype?.removeProperty
  let opaqueScanFrame = 0
  let opaqueRelationalScanFrame = 0
  let opaqueFullScanPending = false
  let opaqueContinuationPending = false
  let opaqueMutationCleanupPending = false
  let themeChangePending = false
  let adoptedListPollTimer = 0
  let mutatingOpaqueSheetState = false
  let inspectingRuleStyles = false
  const opaqueScanRoots = new Set<Node>()
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

  function syncLegacyRuleList(rules: CSSRuleList | CSSRule[], scope?: Document | ShadowRoot) {
    const wasInspectingRuleStyles = inspectingRuleStyles
    inspectingRuleStyles = true
    try {
      for (const rule of Array.from(rules)) {
        const candidate = rule as CSSRule & {
          style?: CSSStyleDeclaration
          styleMap?: object
          cssRules?: CSSRuleList
          styleSheet?: CSSStyleSheet | null
        }
        const style = candidate.style
        if (style) ruleStyleDeclarations.add(style)
        if (style && candidate.styleMap) stylePropertyMapOwners.set(candidate.styleMap, style)
        if (style && (ownedDeclarations.has(style) || style.cssText.includes("--avs-"))) {
          syncLegacyDeclaration(style, true)
        }
        if (candidate.cssRules) syncLegacyRuleList(candidate.cssRules, scope)
        if (candidate.styleSheet) syncLegacyStyleSheet(candidate.styleSheet, scope)
      }
    } finally {
      inspectingRuleStyles = wasInspectingRuleStyles
    }
  }

  function requestCompatibilityFrame(callback: FrameRequestCallback) {
    const requestFrame = globalThis.requestAnimationFrame
      ?? ((callback: FrameRequestCallback) => globalThis.setTimeout(
        () => callback(globalThis.performance?.now() ?? Date.now()), 0
      ) as unknown as number)
    return requestFrame(callback)
  }

  function snapshotShadowHostTheme(root: ShadowRoot) {
    const host = root.host as HTMLElement
    if (!host.isConnected) {
      activeShadowRoots.delete(root)
      return
    }
    activeShadowRoots.add(root)
    const computed = getComputedStyle(host)
    for (const property of shadowHostThemeProperties) {
      const alias = `--avibe-show-host-${property.slice(2)}`
      const value = computed.getPropertyValue(property).trim()
      if (value) {
        if (host.style.getPropertyValue(alias).trim() === value) continue
        if (nativeSetProperty) nativeSetProperty.call(host.style, alias, value)
        else host.style.setProperty(alias, value)
      } else if (host.style.getPropertyValue(alias)) {
        if (nativeRemoveProperty) nativeRemoveProperty.call(host.style, alias)
        else host.style.removeProperty(alias)
      }
    }
  }

  function refreshShadowHostThemes() {
    for (const root of activeShadowRoots) snapshotShadowHostTheme(root)
  }

  function notifyThemeChange() {
    if (themeChangePending) return
    themeChangePending = true
    const enqueue = globalThis.queueMicrotask
      ?? ((callback: VoidFunction) => void Promise.resolve().then(callback))
    enqueue(() => {
      themeChangePending = false
      if (typeof Event !== "undefined") globalThis.dispatchEvent?.(new Event(themeChangeEvent))
    })
  }

  function scheduleOpaqueLegacyScan(root?: Node) {
    notifyThemeChange()
    if (!opaqueStyleSheets.size) return
    if (root && root !== document) {
      opaqueScanRoots.add(root)
    } else {
      opaqueFullScanPending = true
    }
    if (opaqueScanFrame) return
    opaqueScanFrame = requestCompatibilityFrame(() => {
      opaqueScanFrame = 0
      syncOpaqueLegacyThemes()
    })
  }

  function registerOpaqueStyleSheet(sheet: CSSStyleSheet, scope?: Document | ShadowRoot) {
    opaqueStyleSheets.add(sheet)
    const ownerRoot = sheet.ownerNode?.getRootNode()
    const knownRoot = ownerRoot === document
      || (typeof ShadowRoot !== "undefined" && ownerRoot instanceof ShadowRoot)
      ? ownerRoot as Document | ShadowRoot
      : scope ?? opaqueStyleSheetScopes.get(sheet)
    opaqueStyleSheetScopes.set(sheet, knownRoot)
    scheduleOpaqueLegacyScan(knownRoot)
  }

  function scheduleAllOpaqueLegacyScans() {
    scheduleOpaqueLegacyScan()
    for (const scope of opaqueStyleSheetScopes.values()) {
      if (typeof ShadowRoot !== "undefined" && scope instanceof ShadowRoot) {
        scheduleOpaqueLegacyScan(scope)
      }
    }
  }

  function scheduleOpaqueLegacyEventScan(event: Event) {
    const target = event.target
    const element = target instanceof Element
      ? target
      : (typeof Node !== "undefined" && target instanceof Node ? target.parentElement : null)
    if (!element) {
      scheduleAllOpaqueLegacyScans()
      return
    }
    let scanRoot = element
    for (let parent = composedParentElement(element);
      parent && parent !== document.body && parent !== document.documentElement;
      parent = composedParentElement(parent)) {
      scanRoot = parent
    }
    scheduleOpaqueLegacyScan(scanRoot)
    const targetRoot = element.getRootNode()
    for (const scope of opaqueStyleSheetScopes.values()) {
      if (typeof ShadowRoot === "undefined" || !(scope instanceof ShadowRoot)) continue
      const host = scope.host
      if (scope === targetRoot || element === host || element.contains(host) || host.contains(element)) {
        scheduleOpaqueLegacyScan(scope)
      }
    }
  }

  function scheduleOpaqueLegacyRelationalEventScan(event: Event) {
    scheduleOpaqueLegacyEventScan(event)
    scheduleOpaqueLegacyRelationalScan()
  }

  function scheduleMediaStateEventScan(event: Event) {
    if (typeof HTMLMediaElement !== "undefined" && !(event.target instanceof HTMLMediaElement)) return
    scheduleOpaqueLegacyRelationalEventScan(event)
  }

  function scheduleOpaqueLegacyRelationalScan() {
    if (!opaqueStyleSheets.size || opaqueRelationalScanFrame) return
    opaqueRelationalScanFrame = requestCompatibilityFrame(() => {
      opaqueRelationalScanFrame = 0
      scheduleAllOpaqueLegacyScans()
    })
  }

  function markOpaqueBridgeMutation(element: Element) {
    pendingOpaqueBridgeMutations.add(element)
  }

  function scheduleOpaqueMutationCleanup() {
    if (opaqueMutationCleanupPending || !pendingOpaqueBridgeMutations.size) return
    opaqueMutationCleanupPending = true
    const enqueue = globalThis.queueMicrotask
      ?? ((callback: VoidFunction) => void Promise.resolve().then(callback))
    enqueue(() => {
      pendingOpaqueBridgeMutations.clear()
      opaqueMutationCleanupPending = false
    })
  }

  function clearOpaqueOwnedDeclarations(styles?: Set<CSSStyleDeclaration>) {
    mutatingOpaqueBridge = true
    try {
      for (const [style, ownership] of opaqueOwnedDeclarations) {
        if (styles && !styles.has(style)) continue
        for (const [target, previous] of ownership.declarations) {
          if (style.getPropertyValue(target).trim() === previous.value
            && style.getPropertyPriority(target) === previous.priority) {
            markOpaqueBridgeMutation(ownership.element)
            if (nativeRemoveProperty) nativeRemoveProperty.call(style, target)
            else style.removeProperty(target)
          }
        }
        opaqueBridgeSignatures.delete(style)
        opaqueOwnedDeclarations.delete(style)
      }
    } finally {
      mutatingOpaqueBridge = false
      scheduleOpaqueMutationCleanup()
    }
  }

  function compatibilityElements(roots: Set<Node> | null) {
    const affected = new Set<ThemeElement>()
    const seenRoots = new Set<Document | ShadowRoot>()
    const addElement = (element: Element) => {
      if ("style" in element) affected.add(element as ThemeElement)
      if (element.shadowRoot) visitRoot(element.shadowRoot)
      if (typeof HTMLSlotElement !== "undefined" && element instanceof HTMLSlotElement) {
        for (const assigned of element.assignedElements({ flatten: true })) addTree(assigned)
      }
    }
    const addTree = (element: Element) => {
      addElement(element)
      for (const descendant of element.querySelectorAll("*")) addElement(descendant)
    }
    const visitRoot = (root: Document | ShadowRoot) => {
      if (seenRoots.has(root)) return
      seenRoots.add(root)
      if (root === document && document.documentElement) addTree(document.documentElement)
      else for (const element of root.querySelectorAll("*")) addElement(element)
    }
    if (!roots) {
      visitRoot(document)
    } else {
      for (const root of roots) {
        if (root === document || (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot)) {
          visitRoot(root as Document | ShadowRoot)
        } else if (root instanceof Element) {
          addTree(root)
        } else if (root.parentElement) {
          addTree(root.parentElement)
        }
      }
    }

    for (const element of Array.from(affected)) {
      for (let parent = composedParentElement(element); parent; parent = composedParentElement(parent)) {
        if ("style" in parent) affected.add(parent as ThemeElement)
      }
    }
    return { affected: Array.from(affected), elements: Array.from(affected) }
  }

  function sampleThemeValues(elements: ThemeElement[]) {
    const properties = [...legacySources, ...migratedTargets]
    const samples = new Map<Element, Map<string, string>>()
    for (const element of elements) {
      if (!element.isConnected) continue
      const computed = getComputedStyle(element)
      samples.set(element, new Map(properties.map((property) => [property, computed.getPropertyValue(property).trim()])))
    }
    return samples
  }

  function sampleLocalThemeProperties(
    elements: ThemeElement[],
    samples: Map<Element, Map<string, string>>
  ) {
    const localProperties = new Map<Element, Set<string>>()
    const inheritedCandidates = new Map<ThemeElement, Map<string, ThemeElement[]>>()
    const markLocal = (element: Element, property: string) => {
      const local = localProperties.get(element) ?? new Set<string>()
      local.add(property)
      localProperties.set(element, local)
    }

    for (const element of elements) {
      const values = samples.get(element)
      const parent = composedParentElement(element)
      const parentValues = parent ? samples.get(parent) : undefined
      if (!values) continue
      if (!parent || !parentValues || !("style" in parent)) {
        const synthetic = opaqueOwnedDeclarations.get(element.style)?.declarations
        for (const source of legacySources) {
          if (!values.get(source)) continue
          markLocal(element, source)
          for (const target of migrations[source] ?? []) {
            if (knownOpaqueStandardTargets.get(element)?.has(target)
              || (!synthetic?.has(target)
                && stableThemeValues.get(element)?.has(target)
                && stableThemeValues.get(element)?.get(target) !== values.get(target))) {
              markLocal(element, target)
            }
          }
        }
        continue
      }
      for (const source of legacySources) {
        const value = values.get(source)
        if (value && value !== parentValues.get(source)) markLocal(element, source)
      }
    }

    for (const [element, local] of localProperties) {
      const themeElement = element as ThemeElement
      const values = samples.get(element)
      const parent = composedParentElement(element)
      const parentValues = parent ? samples.get(parent) : undefined
      if (!values || !parent || !parentValues || !("style" in parent)) continue
      const synthetic = opaqueOwnedDeclarations.get(themeElement.style)?.declarations
      const targets = new Set(Array.from(local).flatMap((source) => migrations[source] ?? []))
      for (const property of targets) {
        if (synthetic?.has(property)) continue
        if (values.get(property) !== parentValues.get(property)) {
          markLocal(element, property)
          continue
        }
        let byProperty = inheritedCandidates.get(parent as ThemeElement)
        if (!byProperty) {
          byProperty = new Map()
          inheritedCandidates.set(parent as ThemeElement, byProperty)
        }
        const candidates = byProperty.get(property) ?? []
        candidates.push(themeElement)
        byProperty.set(property, candidates)
      }
    }

    const wasMutatingOpaqueBridge = mutatingOpaqueBridge
    mutatingOpaqueBridge = true
    try {
      let probeIndex = 0
      for (const [parent, byProperty] of inheritedCandidates) {
        for (const [property, candidates] of byProperty) {
          const declared = declaredProperties(parent.style).has(property)
          const value = parent.style.getPropertyValue(property)
          const priority = parent.style.getPropertyPriority(property)
          probeIndex += 1
          const probe = property.endsWith("radius")
            ? `${2000 + probeIndex / 1000}px`
            : property.startsWith("--avs-")
              ? `${probeIndex % 359} 71% 43%`
              : `rgb(${probeIndex % 251} ${(probeIndex * 5) % 251} ${(probeIndex * 11) % 251} / 0.913)`
          markOpaqueBridgeMutation(parent)
          if (nativeSetProperty) nativeSetProperty.call(parent.style, property, probe, "important")
          else parent.style.setProperty(property, probe, "important")
          const inheritedProbe = getComputedStyle(parent).getPropertyValue(property).trim()
          for (const element of candidates) {
            if (getComputedStyle(element).getPropertyValue(property).trim() !== inheritedProbe) {
              markLocal(element, property)
            }
          }
          markOpaqueBridgeMutation(parent)
          if (declared) {
            if (nativeSetProperty) nativeSetProperty.call(parent.style, property, value, priority)
            else parent.style.setProperty(property, value, priority)
          } else if (nativeRemoveProperty) nativeRemoveProperty.call(parent.style, property)
          else parent.style.removeProperty(property)
        }
      }
    } finally {
      mutatingOpaqueBridge = wasMutatingOpaqueBridge
      scheduleOpaqueMutationCleanup()
    }
    return localProperties
  }

  function sampleLocalThemeBoundaries(
    elements: ThemeElement[],
    baseline: Map<Element, Map<string, string>>,
    actual: Map<Element, Map<string, string>>
  ) {
    const localTargets = new Map<Element, Set<string>>()
    const inheritedCandidates = new Map<ThemeElement, Map<string, ThemeElement[]>>()
    const rootCandidates = new Map<ThemeElement, Set<string>>()
    const markLocal = (element: Element, target: string) => {
      let targets = localTargets.get(element)
      if (!targets) {
        targets = new Set()
        localTargets.set(element, targets)
      }
      targets.add(target)
    }

    for (const element of elements) {
      const before = baseline.get(element)
      const after = actual.get(element)
      const parent = composedParentElement(element)
      const parentBefore = parent ? baseline.get(parent) : undefined
      const parentAfter = parent ? actual.get(parent) : undefined
      if (!before || !after) continue
      const synthetic = opaqueOwnedDeclarations.get(element.style)?.declarations
      for (const [source, targets] of Object.entries(migrations)) {
        if (before.get(source) === after.get(source)) continue
        if (parentBefore?.get(source) === before.get(source)
          && parentAfter?.get(source) === after.get(source)) continue
        for (const target of targets) {
          if (synthetic?.has(target) || before.get(target) !== after.get(target)) continue
          if (!parent || !parentBefore || !parentAfter || !("style" in parent)) {
            if (element === document.documentElement) {
              const candidates = rootCandidates.get(element) ?? new Set<string>()
              candidates.add(target)
              rootCandidates.set(element, candidates)
            }
            continue
          }
          if (parentBefore.get(target) !== before.get(target)
            || parentAfter.get(target) !== after.get(target)) {
            markLocal(element, target)
            continue
          }
          let byTarget = inheritedCandidates.get(parent as ThemeElement)
          if (!byTarget) {
            byTarget = new Map()
            inheritedCandidates.set(parent as ThemeElement, byTarget)
          }
          const candidates = byTarget.get(target) ?? []
          candidates.push(element)
          byTarget.set(target, candidates)
        }
      }
    }

    // Equal computed values do not prove inheritance. Perturb the immediate parent
    // briefly so local declarations, including opaque ones, remain authoritative.
    const wasMutatingOpaqueBridge = mutatingOpaqueBridge
    mutatingOpaqueBridge = true
    try {
      let probeIndex = 0
      for (const [parent, byTarget] of inheritedCandidates) {
        for (const [target, candidates] of byTarget) {
          const declared = declaredProperties(parent.style).has(target)
          const value = parent.style.getPropertyValue(target)
          const priority = parent.style.getPropertyPriority(target)
          probeIndex += 1
          const probe = target === "--radius"
            ? `${1000 + probeIndex / 1000}px`
            : `rgb(${probeIndex % 251} ${(probeIndex * 3) % 251} ${(probeIndex * 7) % 251} / 0.937)`
          markOpaqueBridgeMutation(parent)
          if (nativeSetProperty) nativeSetProperty.call(parent.style, target, probe, "important")
          else parent.style.setProperty(target, probe, "important")
          const inheritedProbe = getComputedStyle(parent).getPropertyValue(target).trim()
          for (const element of candidates) {
            if (getComputedStyle(element).getPropertyValue(target).trim() !== inheritedProbe) {
              markLocal(element, target)
            }
          }
          markOpaqueBridgeMutation(parent)
          if (declared) {
            if (nativeSetProperty) nativeSetProperty.call(parent.style, target, value, priority)
            else parent.style.setProperty(target, value, priority)
          } else if (nativeRemoveProperty) nativeRemoveProperty.call(parent.style, target)
          else parent.style.removeProperty(target)
        }
      }
    } finally {
      mutatingOpaqueBridge = wasMutatingOpaqueBridge
      scheduleOpaqueMutationCleanup()
    }

    if (rootCandidates.size) {
      const readableSheets: Array<{ sheet: CSSStyleSheet; disabled: boolean }> = []
      const opaqueImportAncestors = new Set<CSSStyleSheet>()
      for (const opaqueSheet of opaqueStyleSheets) {
        let ownerSheet = opaqueSheet.ownerRule?.parentStyleSheet
        while (ownerSheet && !opaqueImportAncestors.has(ownerSheet)) {
          opaqueImportAncestors.add(ownerSheet)
          ownerSheet = ownerSheet.ownerRule?.parentStyleSheet
        }
      }
      const candidates = new Set<CSSStyleSheet>([
        ...Array.from(document.styleSheets),
        ...Array.from(document.adoptedStyleSheets ?? [])
      ])
      for (const sheet of candidates) {
        if (opaqueStyleSheets.has(sheet) || opaqueImportAncestors.has(sheet)) continue
        try {
          void sheet.cssRules
          if (!sheet.disabled) readableSheets.push({ sheet, disabled: sheet.disabled })
        } catch {
          // Opaque sheets are sampled by leaving them active.
        }
      }
      if (readableSheets.length) {
        const wasMutatingSheetState = mutatingOpaqueSheetState
        mutatingOpaqueSheetState = true
        try {
          for (const { sheet } of readableSheets) sheet.disabled = true
          for (const [root, targets] of rootCandidates) {
            const computed = getComputedStyle(root)
            const after = actual.get(root)
            for (const target of targets) {
              const opaqueValue = computed.getPropertyValue(target).trim()
              if (opaqueValue && opaqueValue === after?.get(target)) markLocal(root, target)
            }
          }
        } finally {
          try {
            for (const { sheet, disabled } of readableSheets) sheet.disabled = disabled
          } finally {
            mutatingOpaqueSheetState = wasMutatingSheetState
          }
        }
      }
    }
    return localTargets
  }

  function rememberStableOpaqueThemeState(
    elements: ThemeElement[],
    baseline: Map<Element, Map<string, string>>,
    actual: Map<Element, Map<string, string>>,
    localTargets: Map<Element, Set<string>>
  ) {
    for (const element of elements) {
      const before = baseline.get(element)
      const after = actual.get(element)
      if (!before || !after) {
        knownOpaqueStandardTargets.delete(element)
        stableThemeValues.delete(element)
        continue
      }
      stableThemeValues.set(element, new Map(after))
      const authoritative = new Set<string>()
      for (const target of migratedTargets) {
        if (before.get(target) !== after.get(target) || localTargets.get(element)?.has(target)) {
          authoritative.add(target)
        }
      }
      if (authoritative.size) knownOpaqueStandardTargets.set(element, authoritative)
      else knownOpaqueStandardTargets.delete(element)
    }
  }

  function composedParentElement(element: Element): Element | null {
    if (element.assignedSlot) return element.assignedSlot
    if (element.parentElement) return element.parentElement
    const root = element.getRootNode()
    return typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot ? root.host : null
  }

  function disableOpaqueStyleSheet(state: OpaqueStyleSheetState) {
    if (state.importMedia) state.importMedia.mediaText = "not all"
    else state.sheet.disabled = true
  }

  function restoreOpaqueStyleSheet(state: OpaqueStyleSheetState) {
    if (state.importMedia) state.importMedia.mediaText = state.importMediaText ?? ""
    else state.sheet.disabled = state.disabled
  }

  function hasActiveCssMotion(scope?: Document | ShadowRoot) {
    const root = scope ?? document
    const animations: Animation[] = []
    if ("getAnimations" in root && typeof root.getAnimations === "function") {
      animations.push(...root.getAnimations())
    } else {
      const container = root === document ? document.documentElement : root
      if (container) {
        const elements = container instanceof Element
          ? [container, ...container.querySelectorAll("*")]
          : Array.from(container.querySelectorAll("*"))
        for (const element of elements) animations.push(...element.getAnimations?.() ?? [])
      }
    }
    return animations.some((animation) => {
      const cssAnimation = (typeof CSSAnimation !== "undefined" && animation instanceof CSSAnimation)
        || (typeof CSSTransition !== "undefined" && animation instanceof CSSTransition)
        || animation.constructor?.name === "CSSAnimation"
        || animation.constructor?.name === "CSSTransition"
      return cssAnimation && (animation.playState === "running" || animation.pending)
    })
  }

  function reconcileOpaqueBridgeDeclarations(
    affected: ThemeElement[],
    baseline: Map<Element, Map<string, string>>,
    actual: Map<Element, Map<string, string>>,
    localTargets: Map<Element, Set<string>>,
    sourceIsRelevant?: (element: ThemeElement, source: string) => boolean
  ) {
    let changed = false
    mutatingOpaqueBridge = true
    try {
      for (const element of affected) {
        const before = baseline.get(element)
        const after = actual.get(element)
        if (!before || !after) continue
        const parent = composedParentElement(element)
        const parentBefore = parent ? baseline.get(parent) : undefined
        const parentAfter = parent ? actual.get(parent) : undefined
        const previous = opaqueOwnedDeclarations.get(element.style)?.declarations
        const owned = new Map<string, OwnedDeclaration>()
        for (const [target, declaration] of previous ?? []) {
          if (element.style.getPropertyValue(target).trim() === declaration.value
            && element.style.getPropertyPriority(target) === declaration.priority) {
            owned.set(target, declaration)
          }
        }
        const inlineDeclarations = declaredProperties(element.style)
        for (const target of owned.keys()) inlineDeclarations.delete(target)
        const required = new Set<string>()
        for (const [source, targets] of Object.entries(migrations)) {
          const relevant = sourceIsRelevant
            ? sourceIsRelevant(element, source)
              || (Boolean(after.get(source)) && targets.some((target) => owned.has(target)))
            : before.get(source) !== after.get(source)
              && !(parentBefore?.get(source) === before.get(source)
                && parentAfter?.get(source) === after.get(source))
          if (!relevant) continue
          for (const target of targets) {
            if (inlineDeclarations.has(target)) continue
            if (localTargets.get(element)?.has(target)) continue
            if (!owned.has(target) && parentBefore && parentBefore.get(target) !== before.get(target)) continue
            if (!owned.has(target) && before.get(target) !== after.get(target)) continue
            required.add(target)
            if (owned.has(target)) continue
            const value = migratedValue(source, target)
            markOpaqueBridgeMutation(element)
            if (nativeSetProperty) nativeSetProperty.call(element.style, target, value, "important")
            else element.style.setProperty(target, value, "important")
            owned.set(target, { value, priority: "important" })
            changed = true
          }
        }
        for (const [target, declaration] of owned) {
          if (required.has(target)) continue
          if (element.style.getPropertyValue(target).trim() === declaration.value
            && element.style.getPropertyPriority(target) === declaration.priority) {
            markOpaqueBridgeMutation(element)
            if (nativeRemoveProperty) nativeRemoveProperty.call(element.style, target)
            else element.style.removeProperty(target)
          }
          owned.delete(target)
          changed = true
        }
        if (owned.size) {
          opaqueOwnedDeclarations.set(element.style, { element, declarations: owned })
          opaqueBridgeSignatures.set(element.style, element.style.cssText)
        } else {
          opaqueOwnedDeclarations.delete(element.style)
          opaqueBridgeSignatures.delete(element.style)
        }
      }
    } finally {
      mutatingOpaqueBridge = false
      scheduleOpaqueMutationCleanup()
    }
    return changed
  }

  // Cross-origin rules are opaque to CSSOM. Compare their computed effect with the
  // sheets disabled, then bridge only legacy deltas that did not also set a standard token.
  function syncOpaqueLegacyThemes() {
    const continuing = opaqueContinuationPending
    opaqueContinuationPending = false
    const disconnectedStyles = new Set(
      Array.from(opaqueOwnedDeclarations)
        .filter(([, ownership]) => !ownership.element.isConnected)
        .map(([style]) => style)
    )
    clearOpaqueOwnedDeclarations(disconnectedStyles)
    const roots = new Set<Node>(opaqueScanRoots)
    if (opaqueFullScanPending) roots.add(document)
    opaqueFullScanPending = false
    opaqueScanRoots.clear()
    const { affected, elements } = compatibilityElements(roots)

    const activeSheets: OpaqueStyleSheetState[] = []
    for (const sheet of opaqueStyleSheets) {
      try {
        const scope = opaqueStyleSheetScopes.get(sheet)
        const ownerRule = sheet.ownerRule
        const importMedia = typeof CSSImportRule !== "undefined" && ownerRule instanceof CSSImportRule
          ? ownerRule.media
          : undefined
        if ((sheet.ownerNode && !sheet.ownerNode.isConnected)
          || (importMedia && !ownerRule?.parentStyleSheet)
          || (typeof ShadowRoot !== "undefined" && scope instanceof ShadowRoot && !scope.host.isConnected)) {
          if (typeof ShadowRoot !== "undefined" && scope instanceof ShadowRoot) {
            activeShadowRoots.delete(scope)
            inactiveShadowRoots.add(scope)
          }
          opaqueStyleSheets.delete(sheet)
          opaqueStyleSheetScopes.delete(sheet)
          continue
        }
        if (sheet.disabled && !importMedia) continue
        activeSheets.push({
          sheet,
          disabled: sheet.disabled,
          scope,
          importMedia,
          importMediaText: importMedia?.mediaText
        })
      } catch {
        // A stylesheet that cannot be toggled cannot be compared without changing page semantics.
        opaqueStyleSheets.delete(sheet)
        opaqueStyleSheetScopes.delete(sheet)
      }
    }
    if (!activeSheets.length) {
      clearOpaqueOwnedDeclarations(new Set(affected.map((element) => element.style)))
      return
    }
    if (activeSheets.some((state) => hasActiveCssMotion(state.scope))) {
      const actual = sampleThemeValues(elements)
      const localProperties = sampleLocalThemeProperties(elements, actual)
      const changed = reconcileOpaqueBridgeDeclarations(
        affected,
        actual,
        actual,
        localProperties,
        (element, source) => Boolean(actual.get(element)?.get(source))
          && Boolean(localProperties.get(element)?.has(source))
      )
      for (const root of roots) {
        if (root === document) opaqueFullScanPending = true
        else opaqueScanRoots.add(root)
      }
      if (changed) {
        opaqueContinuationPending = true
        scheduleAllOpaqueLegacyScans()
      }
      return
    }
    if (!continuing) clearOpaqueOwnedDeclarations(new Set(affected.map((element) => element.style)))

    let needsContinuation = false
    for (let pass = 0; pass <= migratedTargets.size; pass += 1) {
      let baseline: Map<Element, Map<string, string>>
      mutatingOpaqueSheetState = true
      try {
        for (const state of activeSheets) disableOpaqueStyleSheet(state)
        baseline = sampleThemeValues(elements)
      } finally {
        try {
          for (const state of activeSheets) restoreOpaqueStyleSheet(state)
        } finally {
          mutatingOpaqueSheetState = false
        }
      }
      const actual = sampleThemeValues(elements)
      const localTargets = sampleLocalThemeBoundaries(elements, baseline, actual)
      if (pass === 0) {
        rememberStableOpaqueThemeState(elements, baseline, actual, localTargets)
      }
      const changed = reconcileOpaqueBridgeDeclarations(affected, baseline, actual, localTargets)
      if (!changed) break
      if (pass === migratedTargets.size) needsContinuation = true
    }
    if (needsContinuation) {
      opaqueContinuationPending = true
      scheduleAllOpaqueLegacyScans()
    }
  }

  function opaqueBridgeIsCurrent(style: CSSStyleDeclaration) {
    const ownership = opaqueOwnedDeclarations.get(style)
    if (!ownership || opaqueBridgeSignatures.get(style) !== style.cssText) return false
    for (const [target, previous] of ownership.declarations) {
      if (style.getPropertyValue(target).trim() !== previous.value
        || style.getPropertyPriority(target) !== previous.priority) return false
    }
    return true
  }

  function relinquishOpaqueOwnership(style: CSSStyleDeclaration, target?: string) {
    const ownership = opaqueOwnedDeclarations.get(style)
    if (!ownership) return
    if (target) ownership.declarations.delete(target)
    else ownership.declarations.clear()
    opaqueBridgeSignatures.delete(style)
    if (!ownership.declarations.size) opaqueOwnedDeclarations.delete(style)
  }

  function removeOpaqueOwnedFromStyle(style: CSSStyleDeclaration) {
    const ownership = opaqueOwnedDeclarations.get(style)
    if (!ownership) return
    for (const [target, previous] of ownership.declarations) {
      if (style.getPropertyValue(target).trim() === previous.value
        && style.getPropertyPriority(target) === previous.priority) {
        if (nativeRemoveProperty) nativeRemoveProperty.call(style, target)
        else style.removeProperty(target)
      }
    }
    opaqueBridgeSignatures.delete(style)
    opaqueOwnedDeclarations.delete(style)
  }

  function resolveStyleSheetScope(
    sheet: CSSStyleSheet,
    fallback?: Document | ShadowRoot
  ): Document | ShadowRoot | undefined {
    const ownerRoot = sheet.ownerNode?.getRootNode()
    if (ownerRoot === document
      || (typeof ShadowRoot !== "undefined" && ownerRoot instanceof ShadowRoot)) {
      return ownerRoot as Document | ShadowRoot
    }
    return fallback ?? styleSheetScopes.get(sheet)
  }

  function syncLegacyStyleSheet(sheet: CSSStyleSheet | null | undefined, scope?: Document | ShadowRoot) {
    if (sheet) {
      const knownScope = resolveStyleSheetScope(sheet, scope)
      styleSheetScopes.set(sheet, knownScope)
      scope = knownScope
    }
    try {
      if (sheet?.cssRules) syncLegacyRuleList(sheet.cssRules, scope)
    } catch (error) {
      if (sheet && typeof error === "object" && error && "name" in error && error.name === "SecurityError") {
        registerOpaqueStyleSheet(sheet, scope)
        return
      }
      throw error
    }
  }

  function scanLegacyStyleSheets(root: Node & ParentNode) {
    const scope = root === document
      || (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot)
      ? root as Document | ShadowRoot
      : undefined
    if (root instanceof Element && root.matches("style, link[rel~=stylesheet]")) {
      const ownerRoot = root.getRootNode()
      syncLegacyStyleSheet(
        (root as HTMLStyleElement | HTMLLinkElement).sheet,
        ownerRoot === document || (typeof ShadowRoot !== "undefined" && ownerRoot instanceof ShadowRoot)
          ? ownerRoot as Document | ShadowRoot
          : scope
      )
    }
    for (const element of root.querySelectorAll<HTMLStyleElement | HTMLLinkElement>("style, link[rel~=stylesheet]")) {
      const ownerRoot = element.getRootNode()
      syncLegacyStyleSheet(
        element.sheet,
        ownerRoot === document || (typeof ShadowRoot !== "undefined" && ownerRoot instanceof ShadowRoot)
          ? ownerRoot as Document | ShadowRoot
          : scope
      )
    }
  }

  function syncInsertedRule(rule: CSSRule, scope?: Document | ShadowRoot) {
    syncLegacyRuleList([rule], scope)
    const candidate = rule as CSSRule & { styleSheet?: CSSStyleSheet | null }
    if (!("styleSheet" in candidate) || !globalThis.setTimeout) return
    // Dynamically inserted imports expose their child sheet only after loading.
    let attempts = 0
    const poll = () => {
      if (candidate.parentStyleSheet) {
        try {
          if (!Array.from(candidate.parentStyleSheet.cssRules).includes(candidate)) return
        } catch {
          return
        }
      }
      const sheet = candidate.styleSheet
      if (sheet) {
        syncLegacyStyleSheet(sheet, scope)
        if (opaqueStyleSheets.has(sheet)) scheduleOpaqueLegacyScan(scope)
        return
      }
      attempts += 1
      if (attempts < 600) globalThis.setTimeout(poll, 50)
    }
    globalThis.setTimeout(poll, 0)
  }

  function patchRuleContainer(input: object | undefined) {
    if (!input) return
    const prototype = input as RuleContainer
    const insertRule = prototype.insertRule
    if (typeof insertRule === "function") {
      prototype.insertRule = function(this: RuleContainer, rule: string, index?: number) {
        const insertedIndex = insertRule.call(this, rule, index)
        const insertedRule = this.cssRules[insertedIndex]
        const sheet = this instanceof CSSStyleSheet ? this : this.parentStyleSheet
        if (insertedRule) syncInsertedRule(insertedRule, sheet ? resolveStyleSheetScope(sheet) : undefined)
        scheduleAllOpaqueLegacyScans()
        return insertedIndex
      }
    }
    const addRule = prototype.addRule
    if (typeof addRule === "function") {
      prototype.addRule = function(this: RuleContainer, selector?: string, style?: string, index?: number) {
        const result = addRule.call(this, selector, style, index)
        const sheet = this instanceof CSSStyleSheet ? this : this.parentStyleSheet
        syncLegacyRuleList(this.cssRules, sheet ? resolveStyleSheetScope(sheet) : undefined)
        scheduleAllOpaqueLegacyScans()
        return result
      }
    }
    for (const name of ["deleteRule", "removeRule"] as const) {
      const remove = prototype[name]
      if (typeof remove !== "function") continue
      prototype[name] = function(this: RuleContainer, index: number) {
        remove.call(this, index)
        scheduleAllOpaqueLegacyScans()
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
        scheduleAllOpaqueLegacyScans()
      }
    }
    const deleteRule = prototype.deleteRule
    if (typeof deleteRule === "function") {
      prototype.deleteRule = function(this: CSSKeyframesRule, rule: string) {
        deleteRule.call(this, rule)
        scheduleAllOpaqueLegacyScans()
      }
    }
  }

  function patchMediaList(input: object | undefined) {
    if (!input) return
    const prototype = input as MediaList
    const mediaText = Object.getOwnPropertyDescriptor(input, "mediaText")
    if (mediaText?.get && mediaText.set) {
      Object.defineProperty(input, "mediaText", {
        ...mediaText,
        set(value: string) {
          const before = mediaText.get?.call(this)
          mediaText.set?.call(this, value)
          if (!mutatingOpaqueSheetState && before !== mediaText.get?.call(this)) {
            scheduleAllOpaqueLegacyScans()
          }
        }
      })
    }
    for (const name of ["appendMedium", "deleteMedium"] as const) {
      const mutate = prototype[name]
      if (typeof mutate !== "function") continue
      prototype[name] = function(this: MediaList, medium: string) {
        const before = this.mediaText
        mutate.call(this, medium)
        if (!mutatingOpaqueSheetState && before !== this.mediaText) scheduleAllOpaqueLegacyScans()
      }
    }
  }

  function patchStateProperty(input: object | undefined, name: string) {
    if (!input) return
    const descriptor = Object.getOwnPropertyDescriptor(input, name)
    if (!descriptor?.get || !descriptor.set) return
    Object.defineProperty(input, name, {
      ...descriptor,
      set(value: unknown) {
        const before = descriptor.get?.call(this)
        descriptor.set?.call(this, value)
        if (!Object.is(before, descriptor.get?.call(this))) scheduleAllOpaqueLegacyScans()
      }
    })
  }

  function patchCustomStateSet(input: object | undefined) {
    if (!input || patchedCustomStateSets.has(input)) return
    patchedCustomStateSets.add(input)
    const prototype = input as Record<string, (...args: string[]) => unknown> & { size: number }
    for (const name of ["add", "delete", "clear"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name)
      if (descriptor?.configurable === false) continue
      const mutate = prototype[name]
      if (typeof mutate !== "function") continue
      Object.defineProperty(input, name, {
        ...descriptor,
        configurable: true,
        writable: true,
        value(this: typeof prototype, ...args: string[]) {
          const before = this.size
          const result = mutate.apply(this, args)
          if (before !== this.size) scheduleAllOpaqueLegacyScans()
          return result
        }
      })
    }
  }

  function patchCustomStateSetOwner(input: object | undefined) {
    if (!input) return
    const descriptor = Object.getOwnPropertyDescriptor(input, "states")
    if (!descriptor?.get || descriptor.configurable === false) return
    Object.defineProperty(input, "states", {
      ...descriptor,
      get() {
        const states = descriptor.get?.call(this)
        if (states) patchCustomStateSet(Object.getPrototypeOf(states))
        return states
      }
    })
  }

  function patchSelectValue(input: object | undefined) {
    if (!input) return
    const descriptor = Object.getOwnPropertyDescriptor(input, "value")
    if (!descriptor?.get || !descriptor.set) return
    Object.defineProperty(input, "value", {
      ...descriptor,
      set(value: string) {
        const select = this as HTMLSelectElement
        const beforeValue = descriptor.get?.call(select)
        const beforeIndex = select.selectedIndex
        descriptor.set?.call(select, value)
        if (!Object.is(beforeValue, descriptor.get?.call(select))
          || beforeIndex !== select.selectedIndex) {
          scheduleAllOpaqueLegacyScans()
        }
      }
    })
  }

  function patchValidityMethod(input: object | undefined) {
    if (!input) return
    const prototype = input as { setCustomValidity?: (message: string) => void }
    const setCustomValidity = prototype.setCustomValidity
    if (typeof setCustomValidity !== "function") return
    prototype.setCustomValidity = function(this: Element & { validity?: ValidityState }, message: string) {
      const before = this.validity?.valid
      setCustomValidity.call(this, message)
      if (before !== this.validity?.valid) scheduleAllOpaqueLegacyScans()
    }
  }

  function patchInputStepMethod(input: object | undefined, name: "stepUp" | "stepDown") {
    if (!input) return
    const prototype = input as HTMLInputElement
    const step = prototype[name]
    if (typeof step !== "function") return
    prototype[name] = function(this: HTMLInputElement, amount?: number) {
      const before = [this.value, this.valueAsNumber, this.validity.valid]
      step.call(this, amount)
      if (before[0] !== this.value
        || !Object.is(before[1], this.valueAsNumber)
        || before[2] !== this.validity.valid) {
        scheduleAllOpaqueLegacyScans()
      }
    }
  }

  function patchRangeTextMethod(input: object | undefined) {
    if (!input) return
    const prototype = input as HTMLInputElement | HTMLTextAreaElement
    const setRangeText = prototype.setRangeText
    if (typeof setRangeText !== "function") return
    prototype.setRangeText = function(
      this: HTMLInputElement | HTMLTextAreaElement,
      ...args: [replacement: string, start?: number, end?: number, selectionMode?: SelectionMode]
    ) {
      const before = [this.value, this.validity.valid]
      const result = (setRangeText as (...values: unknown[]) => void).apply(this, args)
      if (before[0] !== this.value || before[1] !== this.validity.valid) scheduleAllOpaqueLegacyScans()
      return result
    }
  }

  function patchHistoryMethod(input: object | undefined, name: "pushState" | "replaceState") {
    if (!input) return
    const prototype = input as History
    const update = prototype[name]
    if (typeof update !== "function") return
    prototype[name] = function(
      this: History,
      ...args: [data: unknown, unused: string, url?: string | URL | null]
    ) {
      const result = (update as (...values: unknown[]) => void).apply(this, args)
      scheduleAllOpaqueLegacyScans()
      return result
    }
  }

  function patchStylePropertyMap(input: object | undefined) {
    if (!input) return
    const prototype = input as Record<string, (...args: unknown[]) => unknown>
    for (const name of ["set", "append", "delete", "clear"] as const) {
      const mutate = prototype[name]
      if (typeof mutate !== "function") continue
      prototype[name] = function(this: unknown, ...args: unknown[]) {
        const result = mutate.apply(this, args)
        const style = typeof this === "object" && this ? stylePropertyMapOwners.get(this) : undefined
        if (style) syncLegacyDeclaration(style)
        scheduleAllOpaqueLegacyScans()
        return result
      }
    }
  }

  function patchStylePropertyMapOwner(input: object | undefined, property: string) {
    for (let prototype = input; prototype; prototype = Object.getPrototypeOf(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
      if (!descriptor?.get) continue
      Object.defineProperty(prototype, property, {
        ...descriptor,
        get() {
          const map = descriptor.get?.call(this)
          const style = (this as { style?: CSSStyleDeclaration }).style
          if (map && style) stylePropertyMapOwners.set(map, style)
          return map
        }
      })
      return
    }
  }

  function patchCustomElementRegistry(input: object | undefined) {
    if (!input) return
    const prototype = input as CustomElementRegistry
    const define = prototype.define
    if (typeof define !== "function") return
    prototype.define = function(
      name: string,
      constructor: CustomElementConstructor,
      options?: ElementDefinitionOptions
    ) {
      define.call(this, name, constructor, options)
      scheduleAllOpaqueLegacyScans()
    }
  }

  function syncObservedAdoptedList(list: CSSStyleSheet[], scope?: Document | ShadowRoot) {
    const sheets = Array.from(list)
    const record = observedAdoptedLists.get(list)
    if (record) {
      record.scope = scope ?? record.scope
      record.snapshot = sheets
    } else {
      observedAdoptedLists.set(list, { scope, snapshot: sheets })
    }
    for (const sheet of sheets) syncLegacyStyleSheet(sheet, scope)
    scheduleAllOpaqueLegacyScans()
  }

  function scheduleAdoptedListPoll() {
    if (adoptedListPollTimer || !globalThis.setTimeout) return
    adoptedListPollTimer = globalThis.setTimeout(() => {
      adoptedListPollTimer = 0
      for (const [list, record] of observedAdoptedLists) {
        if (typeof ShadowRoot !== "undefined"
          && record.scope instanceof ShadowRoot
          && !record.scope.host?.isConnected) {
          observedAdoptedLists.delete(list)
          continue
        }
        const sheets = Array.from(list)
        if (sheets.length === record.snapshot.length
          && sheets.every((sheet, index) => sheet === record.snapshot[index])) continue
        syncObservedAdoptedList(list, record.scope)
      }
      if (observedAdoptedLists.size) scheduleAdoptedListPoll()
    }, 250) as unknown as number
  }

  function observeAdoptedStyleSheetList(list: CSSStyleSheet[], scope?: Document | ShadowRoot) {
    const existing = adoptedListProxies.get(list)
    if (existing) {
      if (!observedAdoptedLists.has(list)) {
        observedAdoptedLists.set(list, { scope, snapshot: Array.from(list) })
        scheduleAdoptedListPoll()
      }
      return existing
    }
    observedAdoptedLists.set(list, { scope, snapshot: Array.from(list) })
    scheduleAdoptedListPoll()
    const syncList = () => {
      if (!observedAdoptedLists.has(list)) return
      syncObservedAdoptedList(list, scope)
    }
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
            syncList()
            return result
          }
        })
      } catch {
        // Older FrozenArray implementations cannot be mutated in place.
      }
    }
    if (typeof Proxy === "undefined") return list
    const indexedProperty = (property: PropertyKey) => typeof property === "string"
      && (property === "length" || /^(0|[1-9]\d*)$/.test(property))
    const proxy = new Proxy(list, {
      set(target, property, value) {
        const result = Reflect.set(target, property, value, target)
        if (result && indexedProperty(property)) syncList()
        return result
      },
      defineProperty(target, property, descriptor) {
        const result = Reflect.defineProperty(target, property, descriptor)
        if (result && indexedProperty(property)) syncList()
        return result
      },
      deleteProperty(target, property) {
        const result = Reflect.deleteProperty(target, property)
        if (result && indexedProperty(property)) syncList()
        return result
      }
    })
    adoptedListProxies.set(list, proxy)
    adoptedListProxies.set(proxy, proxy)
    return proxy
  }

  function patchAdoptedStyleSheets(input: object | undefined) {
    if (!input) return
    const descriptor = Object.getOwnPropertyDescriptor(input, "adoptedStyleSheets")
    if (!descriptor?.get || !descriptor.set) return
    Object.defineProperty(input, "adoptedStyleSheets", {
      ...descriptor,
      get() {
        const list = descriptor.get?.call(this) ?? []
        const scope = this instanceof Document || this instanceof ShadowRoot ? this : undefined
        return observeAdoptedStyleSheetList(list, scope)
      },
      set(value: CSSStyleSheet[]) {
        const previousList = descriptor.get?.call(this)
        descriptor.set?.call(this, value)
        const list = descriptor.get?.call(this) ?? []
        const scope = this instanceof Document || this instanceof ShadowRoot ? this : undefined
        if (previousList && previousList !== list) observedAdoptedLists.delete(previousList)
        observeAdoptedStyleSheetList(list, scope)
        syncObservedAdoptedList(list, scope)
      }
    })
  }

  function patchStyleSheetDisabled(input: object | undefined) {
    for (let prototype = input; prototype; prototype = Object.getPrototypeOf(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "disabled")
      if (!descriptor?.get || !descriptor.set) continue
      Object.defineProperty(prototype, "disabled", {
        ...descriptor,
        get() {
          return descriptor.get?.call(this)
        },
        set(value: boolean) {
          const before = descriptor.get?.call(this)
          descriptor.set?.call(this, value)
          const after = descriptor.get?.call(this)
          if (!mutatingOpaqueSheetState && before !== after) {
            const sheet = this as CSSStyleSheet
            if (opaqueStyleSheets.has(sheet)) scheduleOpaqueLegacyScan(opaqueStyleSheetScopes.get(sheet))
            else scheduleAllOpaqueLegacyScans()
          }
        }
      })
      return
    }
  }

  function namedStyleProperty(cssProperty: string) {
    return cssProperty.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase())
  }

  function cssPropertyForNamedStyle(property: string) {
    if (property === "cssFloat") return "float"
    const cssProperty = property.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)
    return /^(webkit|moz|ms|o)-/.test(cssProperty) ? `-${cssProperty}` : cssProperty
  }

  function patchNamedRuleStyleProperties(style: CSSStyleDeclaration) {
    if (!nativeSetProperty || patchedRuleStyleDeclarations.has(style)) return
    const descriptors = new Map<string, PropertyDescriptor>()
    for (const property of Object.getOwnPropertyNames(style)) {
      if (property === "cssText" || !/^[A-Za-z][A-Za-z0-9]*$/.test(property)) continue
      const descriptor = Object.getOwnPropertyDescriptor(style, property)
      if (descriptor?.configurable !== false && descriptor?.writable && typeof descriptor.value === "string") {
        descriptors.set(property, descriptor)
      }
    }
    for (let prototype = Object.getPrototypeOf(style);
      prototype && prototype !== Object.prototype;
      prototype = Object.getPrototypeOf(prototype)) {
      for (const property of Object.getOwnPropertyNames(prototype)) {
        if (descriptors.has(property) || property === "cssText") continue
        const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
        if (descriptor?.get && descriptor.set && descriptor.configurable !== false) {
          descriptors.set(property, descriptor)
        }
      }
    }
    for (const cssProperty of portalThemeProperties.filter((property) => !property.startsWith("--"))) {
      const property = namedStyleProperty(cssProperty)
      if (!descriptors.has(property)) descriptors.set(property, { configurable: true, enumerable: true })
    }
    for (const [property, descriptor] of descriptors) {
      const cssProperty = cssPropertyForNamedStyle(property)
      Object.defineProperty(style, property, {
        configurable: true,
        enumerable: descriptor.enumerable ?? true,
        get() {
          return descriptor.get?.call(this) ?? this.getPropertyValue(cssProperty)
        },
        set(value: string | null) {
          const before = this.getPropertyValue(cssProperty)
          if (descriptor.set) descriptor.set.call(this, value)
          else nativeSetProperty.call(this, cssProperty, value)
          if (!mutatingOpaqueBridge && before !== this.getPropertyValue(cssProperty)) {
            scheduleAllOpaqueLegacyScans()
          }
        }
      })
    }
    patchedRuleStyleDeclarations.add(style)
  }

  function patchRuleStyleOwner(input: object | undefined) {
    for (let prototype = input; prototype; prototype = Object.getPrototypeOf(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "style")
      if (!descriptor?.get || descriptor.configurable === false) continue
      Object.defineProperty(prototype, "style", {
        ...descriptor,
        get() {
          const style = descriptor.get?.call(this)
          if (style) {
            ruleStyleDeclarations.add(style)
            if (!inspectingRuleStyles) patchNamedRuleStyleProperties(style)
          }
          return style
        }
      })
      return
    }
  }

  function canonicalCssPropertyName(name: unknown) {
    const propertyName = String(name)
    return propertyName.startsWith("--") ? propertyName : propertyName.toLowerCase()
  }

  if (stylePrototype && nativeSetProperty && nativeRemoveProperty) {
    const cssText = Object.getOwnPropertyDescriptor(stylePrototype, "cssText")
    stylePrototype.setProperty = function(name: string, value: string | null, priority?: string) {
      const propertyName = canonicalCssPropertyName(name)
      const tracksOpaqueTarget = !mutatingOpaqueBridge && migratedTargets.has(propertyName)
      const tracksPortalTheme = !mutatingOpaqueBridge && portalThemeMutationPropertySet.has(propertyName)
      const tracksRuleStyle = !mutatingOpaqueBridge
        && opaqueStyleSheets.size > 0
        && ruleStyleDeclarations.has(this)
      const tracksChange = tracksOpaqueTarget || tracksPortalTheme || tracksRuleStyle
      const ownedOpaqueTarget = tracksOpaqueTarget
        && Boolean(opaqueOwnedDeclarations.get(this)?.declarations.has(propertyName))
      const declaredBefore = tracksChange ? declaredProperties(this).has(propertyName) : false
      const valueBefore = tracksChange ? this.getPropertyValue(propertyName) : ""
      const priorityBefore = tracksChange ? this.getPropertyPriority(propertyName) : ""
      nativeSetProperty.call(this, name, value, priority)
      const changed = tracksChange
        && (declaredBefore !== declaredProperties(this).has(propertyName)
          || valueBefore !== this.getPropertyValue(propertyName)
          || priorityBefore !== this.getPropertyPriority(propertyName))
      const priorityValue = priority == null ? "" : String(priority)
      const acceptedPriority = value == null
        || String(value) === ""
        || priorityValue === ""
        || priorityValue.toLowerCase() === "important"
      if (tracksOpaqueTarget && acceptedPriority && (changed || ownedOpaqueTarget)) {
        relinquishOpaqueOwnership(this, propertyName)
        scheduleAllOpaqueLegacyScans()
      } else if (changed && tracksRuleStyle) {
        scheduleAllOpaqueLegacyScans()
      } else if (changed) {
        notifyThemeChange()
      }
      if (legacySources.includes(propertyName) || (migratedTargets.has(propertyName) && (ownedDeclarations.has(this) || hasLegacyDeclaration(this)))) {
        syncLegacyDeclaration(this)
      }
    }
    stylePrototype.removeProperty = function(name: string) {
      const propertyName = canonicalCssPropertyName(name)
      const tracksOpaqueTarget = !mutatingOpaqueBridge && migratedTargets.has(propertyName)
      const tracksPortalTheme = !mutatingOpaqueBridge && portalThemeMutationPropertySet.has(propertyName)
      const tracksRuleStyle = !mutatingOpaqueBridge
        && opaqueStyleSheets.size > 0
        && ruleStyleDeclarations.has(this)
      const tracksChange = tracksOpaqueTarget || tracksPortalTheme || tracksRuleStyle
      const declaredBefore = tracksChange ? declaredProperties(this).has(propertyName) : false
      const valueBefore = tracksChange ? this.getPropertyValue(propertyName) : ""
      const priorityBefore = tracksChange ? this.getPropertyPriority(propertyName) : ""
      const value = nativeRemoveProperty.call(this, name)
      const changed = tracksChange
        && (declaredBefore !== declaredProperties(this).has(propertyName)
          || valueBefore !== this.getPropertyValue(propertyName)
          || priorityBefore !== this.getPropertyPriority(propertyName))
      if (changed && tracksOpaqueTarget) {
        relinquishOpaqueOwnership(this, propertyName)
        scheduleAllOpaqueLegacyScans()
      } else if (changed && tracksRuleStyle) {
        scheduleAllOpaqueLegacyScans()
      } else if (changed) {
        notifyThemeChange()
      }
      if (legacySources.includes(propertyName) || (migratedTargets.has(propertyName) && (ownedDeclarations.has(this) || hasLegacyDeclaration(this)))) {
        syncLegacyDeclaration(this)
      }
      return value
    }
    if (cssText?.get && cssText.set) {
      Object.defineProperty(stylePrototype, "cssText", {
        ...cssText,
        set(value: string | null) {
          const wasOwned = ownedDeclarations.has(this)
          const before = cssText.get?.call(this) ?? ""
          const carriesOpaqueBridge = typeof value === "string"
            && value.length > before.length
            && value.startsWith(before)
          cssText.set?.call(this, value)
          if (!mutatingOpaqueBridge) {
            if (carriesOpaqueBridge) removeOpaqueOwnedFromStyle(this)
            else relinquishOpaqueOwnership(this)
          }
          const current = cssText.get?.call(this) ?? ""
          if (wasOwned || current.includes("--avs-")) syncLegacyDeclaration(this, current.includes("--avs-"))
          if (!mutatingOpaqueBridge && before !== current) scheduleAllOpaqueLegacyScans()
        }
      })
    }
  }

  const sheetPrototype = globalThis.CSSStyleSheet?.prototype
  patchRuleStyleOwner(globalThis.CSSStyleRule?.prototype)
  const stylePropertyMap = (globalThis as typeof globalThis & {
    StylePropertyMap?: { prototype: object }
  }).StylePropertyMap
  patchStylePropertyMapOwner(globalThis.CSSStyleRule?.prototype, "styleMap")
  patchStylePropertyMapOwner(globalThis.Element?.prototype, "attributeStyleMap")
  patchStylePropertyMap(stylePropertyMap?.prototype)
  patchStyleSheetDisabled(sheetPrototype)
  patchRuleContainer(sheetPrototype)
  patchRuleContainer(globalThis.CSSGroupingRule?.prototype)
  patchKeyframesRule(globalThis.CSSKeyframesRule?.prototype)
  patchMediaList(globalThis.MediaList?.prototype)
  for (const [prototype, properties] of [
    [globalThis.HTMLInputElement?.prototype, ["checked", "indeterminate", "value", "valueAsDate", "valueAsNumber"]],
    [globalThis.HTMLTextAreaElement?.prototype, ["value"]],
    [globalThis.HTMLSelectElement?.prototype, ["selectedIndex"]],
    [globalThis.HTMLOptionElement?.prototype, ["selected"]]
  ] as const) {
    for (const property of properties) patchStateProperty(prototype, property)
  }
  patchSelectValue(globalThis.HTMLSelectElement?.prototype)
  for (const prototype of [
    globalThis.HTMLButtonElement?.prototype,
    globalThis.HTMLFieldSetElement?.prototype,
    globalThis.HTMLInputElement?.prototype,
    globalThis.HTMLObjectElement?.prototype,
    globalThis.HTMLOutputElement?.prototype,
    globalThis.HTMLSelectElement?.prototype,
    globalThis.HTMLTextAreaElement?.prototype
  ]) {
    patchValidityMethod(prototype)
  }
  patchInputStepMethod(globalThis.HTMLInputElement?.prototype, "stepUp")
  patchInputStepMethod(globalThis.HTMLInputElement?.prototype, "stepDown")
  patchRangeTextMethod(globalThis.HTMLInputElement?.prototype)
  patchRangeTextMethod(globalThis.HTMLTextAreaElement?.prototype)
  patchHistoryMethod(globalThis.History?.prototype, "pushState")
  patchHistoryMethod(globalThis.History?.prototype, "replaceState")
  patchCustomElementRegistry(globalThis.CustomElementRegistry?.prototype)
  const customStateSet = (globalThis as typeof globalThis & {
    CustomStateSet?: { prototype: object }
  }).CustomStateSet
  patchCustomStateSet(customStateSet?.prototype)
  patchCustomStateSetOwner(globalThis.ElementInternals?.prototype)
  const styleRulePrototype = globalThis.CSSStyleRule?.prototype
  const selectorText = styleRulePrototype && Object.getOwnPropertyDescriptor(styleRulePrototype, "selectorText")
  if (styleRulePrototype && selectorText?.get && selectorText.set) {
    Object.defineProperty(styleRulePrototype, "selectorText", {
      ...selectorText,
      set(value: string) {
        const before = selectorText.get?.call(this)
        selectorText.set?.call(this, value)
        if (before !== selectorText.get?.call(this)) scheduleAllOpaqueLegacyScans()
      }
    })
  }
  if (sheetPrototype?.replaceSync) {
    const replaceSync = sheetPrototype.replaceSync
    sheetPrototype.replaceSync = function(text: string) {
      replaceSync.call(this, text)
      syncLegacyStyleSheet(this)
      scheduleAllOpaqueLegacyScans()
    }
  }
  if (sheetPrototype?.replace) {
    const replace = sheetPrototype.replace
    sheetPrototype.replace = async function(text: string) {
      const result = await replace.call(this, text)
      syncLegacyStyleSheet(this)
      scheduleAllOpaqueLegacyScans()
      return result
    }
  }

  patchAdoptedStyleSheets(globalThis.Document?.prototype)
  patchAdoptedStyleSheets(globalThis.ShadowRoot?.prototype)
  const observedRoots = new WeakSet<Document | ShadowRoot>()
  const stylesheetLoad = (event: Event) => {
    const target = event.target
    if (target instanceof HTMLLinkElement && target.relList.contains("stylesheet")) {
      const ownerRoot = target.getRootNode()
      syncLegacyStyleSheet(
        target.sheet,
        ownerRoot === document || (typeof ShadowRoot !== "undefined" && ownerRoot instanceof ShadowRoot)
          ? ownerRoot as Document | ShadowRoot
          : undefined
      )
      scheduleAllOpaqueLegacyScans()
      return
    }
    scheduleAllOpaqueLegacyScans()
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
          if (!pendingOpaqueBridgeMutations.has(record.target)
            && !opaqueBridgeIsCurrent(target.style)) notifyThemeChange()
        } else {
          scanLegacyStyleSheets(record.target)
        }
      } else {
        const owner = record.target.parentElement?.closest("style")
          ?? (record.target instanceof Element ? record.target.closest("style") : null)
        if (owner instanceof HTMLStyleElement) {
          const ownerRoot = owner.getRootNode()
          syncLegacyStyleSheet(
            owner.sheet,
            ownerRoot === document || (typeof ShadowRoot !== "undefined" && ownerRoot instanceof ShadowRoot)
              ? ownerRoot as Document | ShadowRoot
              : undefined
          )
          notifyThemeChange()
        }
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
        && (pendingOpaqueBridgeMutations.has(record.target)
          || opaqueBridgeIsCurrent((record.target as HTMLElement).style))) continue
      const stylesheetTreeChanged = record.type === "childList"
        && [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element
          && (node.matches("style, link[rel~=stylesheet]") || node.querySelector("style, link[rel~=stylesheet]")))
      if (stylesheetTreeChanged || record.target instanceof HTMLLinkElement || record.target instanceof HTMLStyleElement) {
        const ownerRoot = record.target.getRootNode()
        scheduleOpaqueLegacyScan(
          typeof ShadowRoot !== "undefined" && ownerRoot instanceof ShadowRoot ? ownerRoot : undefined
        )
      } else {
        const mutationRoot = record.target.getRootNode()
        if (typeof ShadowRoot !== "undefined" && mutationRoot instanceof ShadowRoot) {
          scheduleOpaqueLegacyScan(mutationRoot)
          if (record.type === "attributes") scheduleOpaqueLegacyRelationalScan()
          continue
        }
        const root = record.target instanceof Element
          ? record.target.parentElement ?? record.target
          : record.target.parentElement ?? record.target
        scheduleOpaqueLegacyScan(root)
        if (record.type === "attributes") scheduleOpaqueLegacyRelationalScan()
        for (const scope of new Set(opaqueStyleSheetScopes.values())) {
          if (typeof ShadowRoot === "undefined" || !(scope instanceof ShadowRoot)) continue
          const host = scope.host
          if (record.target === host
            || (record.target instanceof Element
              && (record.target.contains(host) || host.contains(record.target)))) {
            scheduleOpaqueLegacyScan(scope)
          }
        }
      }
    }
  })

  function scanShadowRoots(root: Node & ParentNode) {
    const hosts = root instanceof Element ? [root, ...root.querySelectorAll("*")] : Array.from(root.querySelectorAll("*"))
    for (const host of hosts) {
      const shadowRoot = host.shadowRoot ?? knownShadowRoots.get(host)
      if (shadowRoot) observeCompatibilityRoot(shadowRoot, inactiveShadowRoots.has(shadowRoot))
    }
  }

  function observeCompatibilityRoot(root: Document | ShadowRoot, rescan = false) {
    const container = root === document ? document.documentElement : root
    if (!container) return
    if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) {
      knownShadowRoots.set(root.host, root)
      snapshotShadowHostTheme(root)
    }
    if (observedRoots.has(root) && !rescan) {
      scanShadowRoots(container)
      return
    }
    inactiveShadowRoots.delete(root as ShadowRoot)
    scanLegacyThemes(container)
    scanLegacyStyleSheets(container)
    const styleSheets = root === document ? document.styleSheets : []
    for (const sheet of Array.from(styleSheets)) syncLegacyStyleSheet(sheet, root)
    const adoptedStyleSheets = root.adoptedStyleSheets ?? []
    observeAdoptedStyleSheetList(adoptedStyleSheets, root)
    for (const sheet of Array.from(adoptedStyleSheets)) syncLegacyStyleSheet(sheet, root)
    scanShadowRoots(container)
    if (observedRoots.has(root)) return
    observedRoots.add(root)
    observer.observe(container, {
      attributes: true,
      attributeFilter: ["style", "href", "rel", "media", "disabled"],
      characterData: true,
      childList: true,
      subtree: true
    })
    opaqueObserver.observe(container, {
      attributes: true,
      childList: true,
      subtree: true
    })
    root.addEventListener("load", stylesheetLoad, true)
  }

  function syncAllOpaqueLegacyThemesNow() {
    if (!opaqueStyleSheets.size) return
    opaqueFullScanPending = true
    for (const scope of opaqueStyleSheetScopes.values()) {
      if (typeof ShadowRoot !== "undefined" && scope instanceof ShadowRoot) opaqueScanRoots.add(scope)
    }
    syncOpaqueLegacyThemes()
    if (typeof Event !== "undefined") globalThis.dispatchEvent?.(new Event(themeChangeEvent))
  }

  globalThis.addEventListener?.("beforeprint", syncAllOpaqueLegacyThemesNow, true)
  globalThis.addEventListener?.(themeChangeEvent, refreshShadowHostThemes, true)
  document.fonts?.addEventListener?.("loadingdone", scheduleAllOpaqueLegacyScans)
  document.fonts?.addEventListener?.("loadingerror", scheduleAllOpaqueLegacyScans)
  for (const event of [
    "resize", "orientationchange", "pageshow", "hashchange", "popstate", "fullscreenchange", "afterprint"
  ]) {
    globalThis.addEventListener?.(event, scheduleAllOpaqueLegacyScans, true)
  }
  for (const event of [
    "focus", "pointerover", "pointerout", "pointerdown", "pointerup", "pointercancel",
    "mousedown", "mouseup", "touchstart", "touchend", "touchcancel", "keydown", "keyup",
    "focusin", "focusout", "input", "change", "invalid", "reset", "beforetoggle", "toggle"
  ]) {
    globalThis.addEventListener?.(event, scheduleOpaqueLegacyRelationalEventScan, true)
  }
  for (const event of [
    "play", "playing", "pause", "ended", "seeking", "seeked", "waiting", "stalled",
    "suspend", "progress", "emptied", "abort", "error", "loadstart", "loadedmetadata",
    "loadeddata", "durationchange", "canplay", "canplaythrough", "volumechange", "ratechange"
  ]) {
    globalThis.addEventListener?.(event, scheduleMediaStateEventScan, true)
  }
  for (const event of [
    "animationstart", "animationiteration", "animationend", "animationcancel",
    "transitionrun", "transitionend", "transitioncancel"
  ]) {
    globalThis.addEventListener?.(event, scheduleOpaqueLegacyEventScan, true)
  }
  for (const query of [
    "(prefers-color-scheme: dark)",
    "(prefers-contrast: more)", "(prefers-contrast: less)", "(prefers-contrast: custom)",
    "(prefers-reduced-motion: reduce)", "(prefers-reduced-transparency: reduce)",
    "(forced-colors: active)", "(inverted-colors: inverted)",
    "(hover: hover)", "(hover: none)",
    "(pointer: fine)", "(pointer: coarse)", "(pointer: none)",
    "(any-hover: hover)", "(any-hover: none)",
    "(any-pointer: fine)", "(any-pointer: coarse)", "(any-pointer: none)",
    "(dynamic-range: high)", "(video-dynamic-range: high)"
  ]) {
    globalThis.matchMedia?.(query).addEventListener("change", scheduleAllOpaqueLegacyScans)
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
  installLegacyThemeCompatibilityWithMigrations(
    LEGACY_THEME_MIGRATIONS,
    LEGACY_THEME_OWNERSHIP_PREFIX,
    SHOW_THEME_CHANGE_EVENT,
    SHOW_PORTAL_THEME_PROPERTIES
  )
}

export function themeCompatibilityClientScript(): string {
  return `(${installLegacyThemeCompatibilityWithMigrations.toString()})(${JSON.stringify(LEGACY_THEME_MIGRATIONS)},${JSON.stringify(LEGACY_THEME_OWNERSHIP_PREFIX)},${JSON.stringify(SHOW_THEME_CHANGE_EVENT)},${JSON.stringify(SHOW_PORTAL_THEME_PROPERTIES)});`
}

installLegacyThemeCompatibility()
