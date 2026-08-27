import type { Plugin } from "vite"

export const SSR_MARKDOWN_ENTRY_ID = "virtual:avibe-show-ssr-markdown-entry"

const RESOLVED_SSR_MARKDOWN_ENTRY_ID = `\0${SSR_MARKDOWN_ENTRY_ID}`
const SSR_MARKDOWN_ENTRY_SOURCE = `
export { default as App } from "/src/App.tsx"
export { SsrRouterProvider as RouterProvider } from "/src/router.tsx"
`

export function ssrMarkdownEntryPlugin(): Plugin {
  return {
    name: "avibe-show-ssr-markdown-entry",
    resolveId(source, _importer, options) {
      if (!options.ssr || source !== SSR_MARKDOWN_ENTRY_ID) return null
      return RESOLVED_SSR_MARKDOWN_ENTRY_ID
    },
    load(id, options) {
      if (!options?.ssr || id !== RESOLVED_SSR_MARKDOWN_ENTRY_ID) return null
      return SSR_MARKDOWN_ENTRY_SOURCE
    }
  }
}
