import { createHash } from "node:crypto"
import { access, lstat, realpath } from "node:fs/promises"
import { join } from "node:path"
import { normalizePath, type Plugin } from "vite"
import { routerTsx } from "./templates.js"

export const SSR_MARKDOWN_ENTRY_ID = "virtual:avibe-show-ssr-markdown-entry"
export const SSR_MARKDOWN_ENVIRONMENT = "avibe_show_markdown"

const RESOLVED_SSR_MARKDOWN_ENTRY_ID = `\0${SSR_MARKDOWN_ENTRY_ID}`
// Released Python History-router source, LF and CRLF respectively. Custom and
// older hash routers are intentionally not eligible for this compatibility.
const LEGACY_HISTORY_ROUTER_HASHES = new Set([
  "1154739b3e21e2f1c7f45e3d0b7454dc5541fdf15e2c79bbc2f96f766338706e",
  "ed7cbd0aa11a491ac8b7621b8a7ea64d7c83c0b53ec46e950cca95b7f4d0079e"
])
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
    enforce: "pre",
    async configResolved(config) {
      workspace = await realpath(config.root)
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
    },
    async transform(source, id, options) {
      const routerPath = join(workspace, "src", "router.tsx")
      if (
        this.environment.name !== SSR_MARKDOWN_ENVIRONMENT ||
        !options?.ssr ||
        id !== normalizePath(routerPath)
      ) return null
      // Match the exact snapshot Vite loaded, before TS/React transforms. Never
      // reread the source from disk: an editor may have saved a newer snapshot.
      if (!LEGACY_HISTORY_ROUTER_HASHES.has(createHash("sha256").update(source).digest("hex"))) {
        return null
      }
      try {
        if (!(await lstat(routerPath)).isFile()) return null
        if (!(await lstat(join(workspace, "src"))).isDirectory()) return null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      }
      // Keep the original module identity and its existing invalidation path.
      return { code: routerTsx(), map: null }
    }
  }
}
