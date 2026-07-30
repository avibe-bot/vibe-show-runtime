import type { Plugin } from "vite"

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

const clientModuleId = "virtual:avibe-show-theme-compat-client"
const resolvedClientModuleId = `\0${clientModuleId}`

export function showThemeCompatibilityPlugin(): Plugin {
  let base = "/"
  return {
    name: "avibe-show-theme-compat",
    apply: "serve",
    configResolved(config) {
      base = config.base.endsWith("/") ? config.base : `${config.base}/`
    },
    resolveId(id) {
      if (id === clientModuleId) return resolvedClientModuleId
      return null
    },
    load(id) {
      if (id === resolvedClientModuleId) return themeCompatibilityScript()
      return null
    },
    transformIndexHtml() {
      return [{
        tag: "script",
        attrs: {
          type: "module",
          src: `${base}@id/__x00__${clientModuleId}`
        },
        injectTo: "head"
      }]
    }
  }
}

function themeCompatibilityScript(): string {
  return `
const migrations = ${JSON.stringify(LEGACY_THEME_MIGRATIONS)};
const legacySources = Object.keys(migrations);
const migratedTargets = new Set(Object.values(migrations).flat());
const ownedDeclarations = new WeakMap();
const nativeSetProperty = globalThis.CSSStyleDeclaration?.prototype.setProperty;
const nativeRemoveProperty = globalThis.CSSStyleDeclaration?.prototype.removeProperty;

function migratedValue(source, target) {
  return target === "--radius" ? "var(" + source + ")" : "hsl(var(" + source + "))";
}

function hasLegacyDeclaration(style) {
  return legacySources.some((source) => style.getPropertyValue(source).trim());
}

function syncLegacyDeclaration(style) {
  let owned = ownedDeclarations.get(style);
  if (!owned && !hasLegacyDeclaration(style)) return;
  if (!owned) {
    owned = new Map();
    ownedDeclarations.set(style, owned);
  }

  for (const [source, targets] of Object.entries(migrations)) {
    const sourceValue = style.getPropertyValue(source).trim();
    const sourcePriority = style.getPropertyPriority(source);
    for (const target of targets) {
      const currentValue = style.getPropertyValue(target).trim();
      const currentPriority = style.getPropertyPriority(target);
      const previous = owned.get(target);
      const stillOwned = previous && previous.value === currentValue && previous.priority === currentPriority;

      if (!sourceValue) {
        if (stillOwned) {
          if (nativeRemoveProperty) nativeRemoveProperty.call(style, target);
          else style.removeProperty(target);
        }
        owned.delete(target);
        continue;
      }

      if (!currentValue || stillOwned) {
        const value = migratedValue(source, target);
        if (currentValue !== value || currentPriority !== sourcePriority) {
          if (nativeSetProperty) nativeSetProperty.call(style, target, value, sourcePriority);
          else style.setProperty(target, value, sourcePriority);
        }
        owned.set(target, { value, priority: sourcePriority });
      } else if (previous) {
        owned.delete(target);
      }
    }
  }
  if (!owned.size) ownedDeclarations.delete(style);
}

function syncLegacyTheme(element) {
  syncLegacyDeclaration(element.style);
}

function scanLegacyThemes(root) {
  if (!(root instanceof Element)) return;
  if (root.getAttribute("style")?.includes("--avs-")) syncLegacyTheme(root);
  for (const element of root.querySelectorAll('[style*="--avs-"]')) syncLegacyTheme(element);
}

function syncLegacyRuleList(rules) {
  for (const rule of Array.from(rules)) {
    if (rule.style) syncLegacyDeclaration(rule.style);
    if (rule.cssRules) syncLegacyRuleList(rule.cssRules);
    if (rule.styleSheet) syncLegacyStyleSheet(rule.styleSheet);
  }
}

function syncLegacyStyleSheet(sheet) {
  try {
    if (sheet?.cssRules) syncLegacyRuleList(sheet.cssRules);
  } catch (error) {
    if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "SecurityError") return;
    throw error;
  }
}

function scanLegacyStyleSheets(root) {
  if (!(root instanceof Element)) return;
  if (root.matches("style, link[rel~=stylesheet]")) syncLegacyStyleSheet(root.sheet);
  for (const element of root.querySelectorAll("style, link[rel~=stylesheet]")) {
    syncLegacyStyleSheet(element.sheet);
  }
}

if (typeof document !== "undefined" && !globalThis.__avibeShowThemeCompatInstalled) {
  globalThis.__avibeShowThemeCompatInstalled = true;
  const stylePrototype = globalThis.CSSStyleDeclaration?.prototype;
  if (stylePrototype && nativeSetProperty && nativeRemoveProperty) {
    const cssText = Object.getOwnPropertyDescriptor(stylePrototype, "cssText");
    stylePrototype.setProperty = function(name, value, priority) {
      nativeSetProperty.call(this, name, value, priority);
      if (legacySources.includes(name) || (migratedTargets.has(name) && (ownedDeclarations.has(this) || hasLegacyDeclaration(this)))) {
        syncLegacyDeclaration(this);
      }
    };
    stylePrototype.removeProperty = function(name) {
      const value = nativeRemoveProperty.call(this, name);
      if (legacySources.includes(name) || (migratedTargets.has(name) && (ownedDeclarations.has(this) || hasLegacyDeclaration(this)))) {
        syncLegacyDeclaration(this);
      }
      return value;
    };
    if (cssText?.get && cssText.set) {
      Object.defineProperty(stylePrototype, "cssText", {
        ...cssText,
        set(value) {
          const needsSync = value.includes("--avs-") || ownedDeclarations.has(this);
          cssText.set.call(this, value);
          if (needsSync) syncLegacyDeclaration(this);
        }
      });
    }
  }

  const sheetPrototype = globalThis.CSSStyleSheet?.prototype;
  if (sheetPrototype) {
    const insertRule = sheetPrototype.insertRule;
    sheetPrototype.insertRule = function(...args) {
      const index = insertRule.apply(this, args);
      syncLegacyStyleSheet(this);
      return index;
    };
    if (sheetPrototype.replaceSync) {
      const replaceSync = sheetPrototype.replaceSync;
      sheetPrototype.replaceSync = function(...args) {
        const result = replaceSync.apply(this, args);
        syncLegacyStyleSheet(this);
        return result;
      };
    }
    if (sheetPrototype.replace) {
      const replace = sheetPrototype.replace;
      sheetPrototype.replace = async function(...args) {
        const result = await replace.apply(this, args);
        syncLegacyStyleSheet(this);
        return result;
      };
    }
  }

  scanLegacyThemes(document.documentElement);
  for (const sheet of Array.from(document.styleSheets)) syncLegacyStyleSheet(sheet);
  for (const sheet of Array.from(document.adoptedStyleSheets ?? [])) syncLegacyStyleSheet(sheet);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        const element = record.target;
        if (record.attributeName === "style") {
          if (element.getAttribute("style")?.includes("--avs-") || ownedDeclarations.has(element.style)) {
            syncLegacyTheme(element);
          }
        } else {
          scanLegacyStyleSheets(element);
        }
      } else {
        const owner = record.target.parentElement?.closest("style") ?? record.target.closest?.("style");
        if (owner) syncLegacyStyleSheet(owner.sheet);
        for (const node of record.addedNodes) {
          scanLegacyThemes(node);
          scanLegacyStyleSheets(node);
        }
      }
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "href", "rel", "media", "disabled"],
    characterData: true,
    childList: true,
    subtree: true
  });
  document.addEventListener("load", (event) => {
    const target = event.target;
    if (target instanceof HTMLLinkElement && target.relList.contains("stylesheet")) {
      syncLegacyStyleSheet(target.sheet);
    }
  }, true);
}
`
}
