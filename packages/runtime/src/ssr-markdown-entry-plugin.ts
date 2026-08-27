import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"

export const SSR_MARKDOWN_ENTRY_ID = "virtual:avibe-show-ssr-markdown-entry"
export const SSR_MARKDOWN_CONVERSION_ID = "virtual:avibe-show-ssr-markdown-conversion"

const RESOLVED_SSR_MARKDOWN_ENTRY_ID = `\0${SSR_MARKDOWN_ENTRY_ID}`
const SSR_MARKDOWN_ENTRY_SOURCE = `
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import App from "/src/App.tsx"
import { SsrRouterProvider } from "/src/router.tsx"
import { convertSsrRenderedHtmlToMarkdown } from "${SSR_MARKDOWN_CONVERSION_ID}"

export function render(location) {
  return renderToStaticMarkup(
    createElement(SsrRouterProvider, { location }, createElement(App))
  )
}

export function convert(html, options) {
  return convertSsrRenderedHtmlToMarkdown(html, options)
}
`

function runtimeModulePath(compiledName: string): string {
  const compiled = fileURLToPath(new URL(`./${compiledName}`, import.meta.url))
  return existsSync(compiled) ? compiled : compiled.replace(/\.js$/, ".ts")
}

export function ssrMarkdownRuntimeModulePaths(): string[] {
  return [
    runtimeModulePath("ssr-markdown-conversion.js"),
    runtimeModulePath("markdown-core.js")
  ]
}

export function ssrMarkdownEntryPlugin(): Plugin {
  return {
    name: "avibe-show-ssr-markdown-entry",
    resolveId(source, _importer, options) {
      if (!options.ssr) return null
      if (source === SSR_MARKDOWN_ENTRY_ID) return RESOLVED_SSR_MARKDOWN_ENTRY_ID
      if (source === SSR_MARKDOWN_CONVERSION_ID) return ssrMarkdownRuntimeModulePaths()[0]
      return null
    },
    load(id, options) {
      if (!options?.ssr || id !== RESOLVED_SSR_MARKDOWN_ENTRY_ID) return null
      return SSR_MARKDOWN_ENTRY_SOURCE
    }
  }
}
