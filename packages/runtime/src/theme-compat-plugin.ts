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
const ownedDeclarations = new WeakMap();

function migratedValue(source, target) {
  return target === "--radius" ? "var(" + source + ")" : "hsl(var(" + source + "))";
}

function syncLegacyTheme(element) {
  const style = element.style;
  let owned = ownedDeclarations.get(element);
  if (!owned) {
    owned = new Map();
    ownedDeclarations.set(element, owned);
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
        if (stillOwned) style.removeProperty(target);
        owned.delete(target);
        continue;
      }

      if (!currentValue || stillOwned) {
        const value = migratedValue(source, target);
        if (currentValue !== value || currentPriority !== sourcePriority) {
          style.setProperty(target, value, sourcePriority);
        }
        owned.set(target, { value, priority: sourcePriority });
      } else if (previous) {
        owned.delete(target);
      }
    }
  }
}

function scanLegacyThemes(root) {
  if (!(root instanceof Element)) return;
  if (root.hasAttribute("style")) syncLegacyTheme(root);
  for (const element of root.querySelectorAll("[style]")) syncLegacyTheme(element);
}

if (typeof document !== "undefined" && !globalThis.__avibeShowThemeCompatInstalled) {
  globalThis.__avibeShowThemeCompatInstalled = true;
  scanLegacyThemes(document.documentElement);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") syncLegacyTheme(record.target);
      else for (const node of record.addedNodes) scanLegacyThemes(node);
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
    childList: true,
    subtree: true
  });
}
`
}
