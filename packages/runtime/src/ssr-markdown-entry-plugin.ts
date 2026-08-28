import { access } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "vite"

export const SSR_MARKDOWN_ENTRY_ID = "virtual:avibe-show-ssr-markdown-entry"
export const SSR_MARKDOWN_ENVIRONMENT = "avibe_show_markdown"

const RESOLVED_SSR_MARKDOWN_ENTRY_ID = `\0${SSR_MARKDOWN_ENTRY_ID}`
const ROUTED_SSR_MARKDOWN_ENTRY_SOURCE = `
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server.browser"
import App from "/src/App.tsx"
import * as RouterModule from "/src/router.tsx"

function isRenderableComponent(value) {
  return typeof value === "function" || (
    typeof value === "object" &&
    value !== null &&
    "$$typeof" in value
  )
}

export const hasSsrRouterProvider = isRenderableComponent(RouterModule.SsrRouterProvider)

export function render(location) {
  const app = createElement(App)
  return renderToStaticMarkup(hasSsrRouterProvider
    ? createElement(RouterModule.SsrRouterProvider, { location }, app)
    : app)
}
`

const ROUTERLESS_SSR_MARKDOWN_ENTRY_SOURCE = `
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server.browser"
import App from "/src/App.tsx"

export const hasSsrRouterProvider = false

export function render() {
  return renderToStaticMarkup(createElement(App))
}
`

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

export function ssrMarkdownEntryPlugin(): Plugin {
  let workspace = ""
  return {
    name: "avibe-show-ssr-markdown-entry",
    configResolved(config) {
      workspace = config.root
    },
    resolveId(source, _importer, options) {
      if (!options.ssr) return null
      if (source === SSR_MARKDOWN_ENTRY_ID) return RESOLVED_SSR_MARKDOWN_ENTRY_ID
      return null
    },
    async load(id, options) {
      if (!options?.ssr || id !== RESOLVED_SSR_MARKDOWN_ENTRY_ID) return null
      return await fileExists(join(workspace, "src", "router.tsx"))
        ? ROUTED_SSR_MARKDOWN_ENTRY_SOURCE
        : ROUTERLESS_SSR_MARKDOWN_ENTRY_SOURCE
    }
  }
}
