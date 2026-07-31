import type { Plugin } from "vite"
import {
  LEGACY_THEME_MIGRATIONS,
  LEGACY_THEME_OWNERSHIP_PREFIX,
  legacyThemeOwnershipMarker,
  themeCompatibilityClientScript
} from "@avibe/show-ui/theme-compat"

export {
  LEGACY_THEME_MIGRATIONS,
  LEGACY_THEME_OWNERSHIP_PREFIX,
  legacyThemeOwnershipMarker
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
      if (id === resolvedClientModuleId) return themeCompatibilityClientScript()
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
