import type { Plugin } from "vite"

export const SSR_MARKDOWN_ENTRY_ID = "virtual:avibe-show-ssr-markdown-entry"
export const SSR_MARKDOWN_ENVIRONMENT = "avibe_show_markdown"

const RESOLVED_SSR_MARKDOWN_ENTRY_ID = `\0${SSR_MARKDOWN_ENTRY_ID}`
const SSR_MARKDOWN_ENTRY_SOURCE = `
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server.browser"
import App from "/src/App.tsx"
import { SsrRouterProvider } from "/src/router.tsx"

export function render(location) {
  return renderToStaticMarkup(
    createElement(SsrRouterProvider, { location }, createElement(App))
  )
}
`

export function ssrMarkdownEntryPlugin(): Plugin {
  return {
    name: "avibe-show-ssr-markdown-entry",
    resolveId(source, _importer, options) {
      if (!options.ssr) return null
      if (source === SSR_MARKDOWN_ENTRY_ID) return RESOLVED_SSR_MARKDOWN_ENTRY_ID
      return null
    },
    load(id, options) {
      if (!options?.ssr || id !== RESOLVED_SSR_MARKDOWN_ENTRY_ID) return null
      return SSR_MARKDOWN_ENTRY_SOURCE
    }
  }
}
