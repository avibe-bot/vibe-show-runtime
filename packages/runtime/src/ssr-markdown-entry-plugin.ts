import { access } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "vite"

export const SSR_MARKDOWN_ENTRY_ID = "virtual:avibe-show-ssr-markdown-entry"
export const SSR_MARKDOWN_ENVIRONMENT = "avibe_show_markdown"

const RESOLVED_SSR_MARKDOWN_ENTRY_ID = `\0${SSR_MARKDOWN_ENTRY_ID}`
const ROUTED_SSR_MARKDOWN_ENTRY_SOURCE = `
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server.browser"
import { MotionConfig } from "motion/react"
import App from "/src/App.tsx"
import * as RouterModule from "/src/router.tsx"

const REACT_MEMO_TYPE = Symbol.for("react.memo")
const REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref")

function isRenderableComponent(value, seen = new Set()) {
  if (typeof value === "function") return true
  if (typeof value !== "object" || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)
  if (value.$$typeof === REACT_MEMO_TYPE) return isRenderableComponent(value.type, seen)
  if (value.$$typeof === REACT_FORWARD_REF_TYPE) return typeof value.render === "function"
  return false
}

export const hasSsrRouterProvider = isRenderableComponent(RouterModule.SsrRouterProvider)

export function render(location) {
  const app = createElement(App)
  return renderToStaticMarkup(hasSsrRouterProvider
    ? createElement(RouterModule.SsrRouterProvider, { location }, app)
    : createElement(MotionConfig, { isStatic: true }, app))
}
`

const ROUTERLESS_SSR_MARKDOWN_ENTRY_SOURCE = `
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server.browser"
import { MotionConfig } from "motion/react"
import App from "/src/App.tsx"

export const hasSsrRouterProvider = false

export function render() {
  return renderToStaticMarkup(createElement(
    MotionConfig,
    { isStatic: true },
    createElement(App)
  ))
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
