import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import postcss from "postcss"
import {
  LEGACY_THEME_MIGRATIONS,
  legacyThemeOwnershipMarker
} from "./theme-compat-plugin.js"

const DEFAULT_UI_PACKAGE = "@avibe/show-ui"
const TAILWIND_IMPORT = `@import "tailwindcss";`
// The UI theme entry (`<uiPackageName>/theme.css`). It MUST be imported into this Tailwind
// entry (not merely as a main.tsx side effect) so its `@theme` tokens register in this
// compilation and its `@source` makes the shadcn component utility classes get generated. It
// goes right AFTER the tailwindcss import so it extends the default theme. Derived from the
// configured `uiPackageName` (the alias/vendor/extras paths use the same name), so a custom
// UI package resolves instead of a hardcoded `@avibe/show-ui`.
const themeImport = (uiPackageName: string) => `@import "${uiPackageName}/theme.css";`
// A leading `@charset "...";` is the only statement allowed before `@import`. Match only
// through the `;` (plus trailing spaces/one line ending) so rules sharing the line — e.g.
// minified `@charset "utf-8";body{...}` — are NOT swallowed, which would push the import
// after them and make it invalid.
const LEADING_CHARSET_PATTERN = /^@charset\s+["'][^"']*["'];[ \t]*\r?\n?/i
// UTF-8 byte order mark, preserved at position 0 when re-emitting an existing file.
const BOM = "\ufeff"
const THEME_MIGRATION_MARKER = /^avibe-generated-theme\s+(--[\w-]+)\s+(--[\w-]+)$/
const themeMigrationMarker = (source: string, target: string) => `avibe-generated-theme ${source} ${target}`
export async function ensureSessionTemplate(workspace: string, uiPackageName: string = DEFAULT_UI_PACKAGE) {
  await mkdir(join(workspace, "src"), { recursive: true })
  await mkdir(join(workspace, "api"), { recursive: true })
  const appPath = join(workspace, "src", "App.tsx")
  const freshWorkspace = !(await fileExists(appPath))
  await writeIfMissing(join(workspace, "index.html"), indexHtml())
  await writeIfMissing(join(workspace, "src", "show-runtime-config.ts"), showRuntimeConfigTs())
  await writeIfMissing(join(workspace, "src", "main.tsx"), mainTsx(freshWorkspace))
  if (freshWorkspace) {
    await mkdir(join(workspace, "src", "pages"), { recursive: true })
    // App imports the router, so publish it last. If scaffolding is interrupted,
    // App remains absent and the next warm still recognizes a fresh workspace;
    // once App exists, every generated dependency it references already exists.
    await writeIfMissing(join(workspace, "src", "router.tsx"), routerTsx())
    await writeIfMissing(join(workspace, "src", "pages", "index.tsx"), homePageTsx())
    await writeIfMissing(join(workspace, "src", "pages", "second.tsx"), secondPageTsx())
  }
  await writeIfMissing(appPath, appTsx())
  await writeIfMissing(join(workspace, "src", "styles.css"), stylesCss(uiPackageName))
  await ensureEntryImports(join(workspace, "src", "styles.css"), uiPackageName)
  await migrateWorkspaceThemeDeclarations(join(workspace, "src"))
}

async function fileExists(path: string) {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

/**
 * Keep the workspace Tailwind entry importing BOTH `tailwindcss` and the `@avibe/show-ui`
 * theme, in that order. New workspaces already lead with both (see stylesCss); this is the
 * idempotent, HMR-safe migration for workspaces whose `src/styles.css` predates them — it
 * adds whichever import is missing and repairs a reversed existing pair. Runs on every warm
 * before the Vite server is created.
 *
 * Detection parses top-level CSS at-rules so comments and import-shaped strings never count.
 */
async function ensureEntryImports(path: string, uiPackageName: string = DEFAULT_UI_PACKAGE) {
  let contents: string
  try {
    contents = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  const theme = themeImport(uiPackageName)
  const imports = topLevelImports(contents)
  if (!imports) return
  const tailwind = imports.find((statement) => statement.specifier === "tailwindcss")
  const themeStatement = imports.find((statement) => statement.specifier === `${uiPackageName}/theme.css`)
  const hasTailwind = Boolean(tailwind)
  const hasTheme = Boolean(themeStatement)
  if (hasTailwind && hasTheme) {
    const ordered = orderThemeAfterTailwind(contents, uiPackageName)
    if (ordered !== contents) await writeFile(path, ordered, "utf8")
    return
  }
  if (!hasTailwind) {
    // No Tailwind entry yet: prepend it (plus the theme, unless the theme is already there)
    // as the leading statement(s), after any `@charset`/BOM.
    const block = hasTheme ? TAILWIND_IMPORT : `${TAILWIND_IMPORT}\n${theme}`
    contents = prependImports(contents, block)
  } else {
    // Tailwind entry present but the theme is missing: insert it right after the import.
    contents = insertAfterImport(contents, tailwind!, theme)
  }
  await writeFile(path, contents, "utf8")
}

function orderThemeAfterTailwind(contents: string, uiPackageName: string): string {
  const imports = topLevelImports(contents)
  if (!imports) return contents
  const tailwind = imports.find((statement) => statement.specifier === "tailwindcss")
  const theme = imports.find((statement) => statement.specifier === `${uiPackageName}/theme.css`)
  if (!tailwind || !theme || tailwind.start < theme.start) return contents
  const statement = contents.slice(theme.start, theme.end)
  const removedLength = theme.end - theme.start
  const withoutTheme = `${contents.slice(0, theme.start)}${contents.slice(theme.end)}`
  return insertAfterImport(withoutTheme, { ...tailwind, end: tailwind.end - removedLength }, statement)
}

type ImportStatement = { start: number; end: number; specifier: string }

function topLevelImports(contents: string): ImportStatement[] | null {
  let root: postcss.Root
  try {
    root = postcss.parse(contents)
  } catch {
    return null
  }
  const imports: ImportStatement[] = []
  for (const node of root.nodes) {
    if (node.type !== "atrule" || node.name.toLowerCase() !== "import") continue
    const specifier = importSpecifier(node.params)
    const start = node.source?.start?.offset
    const end = node.source?.end?.offset
    if (specifier == null || start == null || end == null) continue
    imports.push({ start, end, specifier })
  }
  return imports
}

function importSpecifier(params: string): string | null {
  const quoted = /^(["'])(.*?)\1(?:\s|$)/s.exec(params.trim())
  if (quoted) return quoted[2]
  const url = /^url\(\s*(["']?)(.*?)\1\s*\)(?:\s|$)/is.exec(params.trim())
  return url?.[2] ?? null
}

async function migrateWorkspaceThemeDeclarations(path: string): Promise<void> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }

  await Promise.all(entries.map(async (entry) => {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) {
      await migrateWorkspaceThemeDeclarations(entryPath)
      return
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".css")) return
    const contents = await readFile(entryPath, "utf8")
    const migrated = migrateLegacyThemeDeclarations(contents)
    if (migrated !== contents) await writeFile(entryPath, migrated, "utf8")
  }))
}

function migrateLegacyThemeDeclarations(contents: string): string {
  let root: postcss.Root
  try {
    root = postcss.parse(contents)
  } catch {
    // Leave invalid CSS untouched so Vite reports the original syntax error.
    return contents
  }

  let changed = false
  root.walkRules((rule) => {
    const legacyDeclarations = new Map<string, postcss.Declaration>()
    for (const node of rule.nodes) {
      if (node.type !== "decl" || !LEGACY_THEME_MIGRATIONS[node.prop]) continue
      const current = legacyDeclarations.get(node.prop)
      if (!current || (node.important && !current.important) || node.important === current.important) {
        legacyDeclarations.set(node.prop, node)
      }
    }
    for (const node of [...rule.nodes]) {
      if (node.type !== "comment") continue
      const marker = THEME_MIGRATION_MARKER.exec(node.text.trim())
      if (!marker) continue
      const [, source, target] = marker
      const declaration = node.next()
      const ownership = declaration?.next()
      const ownershipProperty = legacyThemeOwnershipMarker(target)
      const ownsMarker = ownership?.type === "decl"
        && ownership.prop === ownershipProperty
        && ownership.value.trim() === source
      const targets = LEGACY_THEME_MIGRATIONS[source]
      const generatedValue = target === "--radius" ? `var(${source})` : `hsl(var(${source}))`
      const ownsDeclaration = declaration?.type === "decl"
        && declaration.prop === target
        && declaration.value.trim() === generatedValue
        && targets?.includes(target)
      const hasOtherTarget = rule.nodes.some((candidate) => candidate.type === "decl"
        && candidate.prop === target
        && candidate !== declaration)
      if (!ownsDeclaration || hasOtherTarget) {
        if (ownsMarker) ownership.remove()
        if (ownsDeclaration && hasOtherTarget) declaration.remove()
        node.remove()
        changed = true
        continue
      }
      const sourceDeclaration = legacyDeclarations.get(source)
      if (!sourceDeclaration) {
        if (ownsMarker) ownership.remove()
        declaration.remove()
        node.remove()
        changed = true
      } else {
        if (!ownsMarker) {
          rule.insertAfter(declaration, postcss.decl({ prop: ownershipProperty, value: source }))
          changed = true
        }
        if (declaration.important !== sourceDeclaration.important) {
          declaration.important = sourceDeclaration.important
          changed = true
        }
      }
    }
    const existing = new Set(
      rule.nodes.filter((node): node is postcss.Declaration => node.type === "decl").map((declaration) => declaration.prop)
    )
    for (const node of legacyDeclarations.values()) {
      const targets = LEGACY_THEME_MIGRATIONS[node.prop]
      let anchor: postcss.ChildNode = node
      for (const target of targets) {
        if (existing.has(target)) continue
        const value = target === "--radius" ? `var(${node.prop})` : `hsl(var(${node.prop}))`
        const marker = postcss.comment({ text: themeMigrationMarker(node.prop, target) })
        const migrated = node.clone({ prop: target, value })
        const ownership = postcss.decl({ prop: legacyThemeOwnershipMarker(target), value: node.prop })
        rule.insertAfter(anchor, marker)
        rule.insertAfter(marker, migrated)
        rule.insertAfter(migrated, ownership)
        anchor = ownership
        existing.add(target)
        changed = true
      }
    }
  })
  return changed ? root.toString() : contents
}

function insertAfterImport(contents: string, target: ImportStatement, statement: string): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n"
  return `${contents.slice(0, target.end)}${newline}${statement}${contents.slice(target.end)}`
}

/**
 * Insert a leading `@import` block as the first CSS statement(s). `@import` must precede
 * every rule except a leading `@charset`, so when the file opens with one (after an optional
 * BOM) the block is placed right after it; otherwise it goes at the very top.
 */
function prependImports(contents: string, block: string): string {
  const bom = contents.startsWith(BOM) ? BOM : ""
  const body = bom ? contents.slice(1) : contents
  const charset = LEADING_CHARSET_PATTERN.exec(body)
  if (charset) {
    return `${bom}${charset[0]}${block}\n${body.slice(charset[0].length)}`
  }
  return `${bom}${block}\n${body}`
}

async function writeIfMissing(path: string, contents: string) {
  try {
    await writeFile(path, contents, { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error
    }
  }
}

function indexHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base href="%BASE_URL%" />
    <title>Vibe Show</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`
}

function mainTsx(includeLegacyHashRedirect: boolean) {
  const legacyHashRedirect = includeLegacyHashRedirect ? `
function redirectLegacyHashRoute() {
  if (!window.location.hash.startsWith("#/")) return
  const configuredBase = globalThis.__AVIBE_SHOW__?.basePath || "/"
  const basePathname = new URL(configuredBase, window.location.origin).pathname
  const baseParts = basePathname.split("/").filter(Boolean)
  const base = baseParts.length ? "/" + baseParts.join("/") + "/" : "/"
  const legacy = new URL(window.location.hash.slice(1), window.location.origin)
  const target = new URL(window.location.href)
  target.pathname = base + legacy.pathname.replace(/^\\/+/, "")
  for (const [key, value] of legacy.searchParams) target.searchParams.set(key, value)
  target.hash = legacy.hash
  window.history.replaceState(window.history.state, "", target)
}

redirectLegacyHashRoute()
` : ""

  return `import React from "react"
import { createRoot } from "react-dom/client"
import "@avibe/show-ui/styles.css"
import "./styles.css"
import "./show-runtime-config"
import App from "./App"
${legacyHashRedirect}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
`
}

function showRuntimeConfigTs() {
  return `import type { RuntimeConfig } from "@avibe/show-sdk"

function showBasePath() {
  return window.location.pathname.match(/^\\/(?:show|p)\\/[^/]+\\//)?.[0] || window.location.pathname.replace(/[^/]*$/, "")
}

function showSessionId() {
  const match = window.location.pathname.match(/\\/show\\/([^/]+)/)
  return match ? decodeURIComponent(match[1]) : undefined
}

const injected = globalThis.__AVIBE_SHOW__ ?? {}

globalThis.__AVIBE_SHOW__ = {
  // Preserve any other injected fields (e.g. the \`annotation\` block + its attached window API)
  // so normalizing the transport config never drops the annotation overlay's config/gating.
  ...injected,
  sessionId: injected.sessionId ?? showSessionId(),
  basePath: injected.basePath ?? showBasePath(),
  eventsPath: injected.eventsPath ?? "__show/events",
  streamPath: injected.streamPath ?? "__show/events?stream=1",
  writeToken: injected.writeToken
} satisfies RuntimeConfig
`
}

function appTsx() {
  return `import { RouterView } from "./router"

export default function App() {
  return (
    <main className="page bg-background text-foreground">
      <RouterView />
    </main>
  )
}
`
}

function routerTsx() {
  return `import type { ComponentType, MouseEvent, ReactNode } from "react"
import { useSyncExternalStore } from "react"

export type PageProps = {
  params: Record<string, string>
}

type PageModule = { default: ComponentType<PageProps> }
type Segment = { name: string; dynamic: boolean }
type Route = {
  path: string
  segments: Segment[]
  Component: ComponentType<PageProps>
}

const PAGES_PREFIX = "./pages/"
const PAGE_SUFFIX = ".tsx"
const modules = import.meta.glob<PageModule>("./pages/**/*.tsx", { eager: true })

function filePathToRoute(file: string): string | null {
  const relative = file.slice(PAGES_PREFIX.length, file.length - PAGE_SUFFIX.length)
  const parts = relative.split("/")
  if (parts[parts.length - 1] === "index") parts.pop()
  if (parts.some((part) => part.startsWith("_"))) return null
  const path = parts
    .map((part) => (part.startsWith("[") && part.endsWith("]") ? ":" + part.slice(1, -1) : part))
    .join("/")
  return path ? "/" + path : "/"
}

function toSegments(path: string): Segment[] {
  if (path === "/") return []
  return path.slice(1).split("/").map((part) =>
    part.startsWith(":")
      ? { name: part.slice(1), dynamic: true }
      : { name: part, dynamic: false }
  )
}

function routeSpecificity(segments: Segment[]): string {
  return segments.map((segment) => (segment.dynamic ? "1" : "0")).join("")
}

function isRenderablePage(value: unknown): value is ComponentType<PageProps> {
  return typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value)
}

export const routes: Route[] = Object.entries(modules)
  .map(([file, mod]): Route | null => {
    const path = filePathToRoute(file)
    if (!path || !isRenderablePage(mod.default)) return null
    return { path, segments: toSegments(path), Component: mod.default }
  })
  .filter((route): route is Route => route !== null)
  .sort((a, b) => {
    const specA = routeSpecificity(a.segments)
    const specB = routeSpecificity(b.segments)
    if (specA !== specB) return specA < specB ? -1 : 1
    return a.path.localeCompare(b.path)
  })

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function matchRoute(path: string): { route: Route | null; params: Record<string, string> } {
  const parts = path === "/" ? [] : path.slice(1).split("/")
  for (const route of routes) {
    if (route.segments.length !== parts.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let index = 0; index < parts.length; index++) {
      const segment = route.segments[index]
      if (segment.dynamic) params[segment.name] = safeDecode(parts[index])
      else if (segment.name !== safeDecode(parts[index])) {
        matched = false
        break
      }
    }
    if (matched) return { route, params }
  }
  return { route: null, params: {} }
}

function basePath(): string {
  const configured = globalThis.__AVIBE_SHOW__?.basePath
  const fallback = window.location.pathname.match(/^\\/(?:show|p)\\/[^/]+\\//)?.[0] || "/"
  const pathname = new URL(configured || fallback, window.location.origin).pathname
  const parts = pathname.split("/").filter(Boolean)
  return parts.length ? "/" + parts.join("/") + "/" : "/"
}

function normalizeRoutePath(path: string): string {
  const withLeadingSlash = path.startsWith("/") ? path : "/" + path
  return withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash
}

function readRoutePath(): string {
  const base = basePath()
  const pathname = window.location.pathname
  if (!pathname.startsWith(base)) return "/"
  const routePath = normalizeRoutePath("/" + pathname.slice(base.length))
  return routePath === "/index.html" ? "/" : routePath
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange)
  return () => window.removeEventListener("popstate", onChange)
}

export function useRoutePath(): string {
  return useSyncExternalStore(subscribe, readRoutePath, () => "/")
}

function routeUrl(to: string): URL {
  const normalizedTo = to.startsWith("/") ? to : "/" + to
  const route = new URL(normalizedTo, window.location.origin)
  const current = new URL(window.location.href)
  const target = new URL(basePath(), window.location.origin)
  const embed = current.searchParams.get("vibe-embed")
  target.pathname = basePath() + route.pathname.replace(/^\\/+/, "")
  target.search = route.search
  if (embed && !target.searchParams.has("vibe-embed")) target.searchParams.set("vibe-embed", embed)
  target.hash = route.hash
  return target
}

export function navigate(to: string): void {
  const target = routeUrl(to)
  window.history.pushState({}, "", target)
  window.dispatchEvent(new PopStateEvent("popstate"))
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to)
  }
  return <a href={routeUrl(to).toString()} className={className} onClick={onClick}>{children}</a>
}

export function RouterView() {
  const path = useRoutePath()
  const { route, params } = matchRoute(path)
  if (!route) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-card-foreground">
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">No route matches {path}.</p>
        <p className="mt-4 text-sm"><Link className="font-medium underline" to="/">Back to Home</Link></p>
      </div>
    )
  }
  const Page = route.Component
  return <Page params={params} />
}
`
}

function homePageTsx() {
  return `import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Link } from "../router"

function apiUrl(path: string) {
  const base = globalThis.__AVIBE_SHOW__?.basePath || "/"
  const baseUrl = new URL(base, window.location.origin)
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/"
  return new URL(path.replace(/^\\/+/, ""), baseUrl).toString()
}

export default function HomePage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Vibe Show Runtime</CardTitle>
        <CardDescription>This session is served by the managed service runtime.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <Button onClick={() => void fetch(apiUrl("api/health"))}>Call handler</Button>
        <Link className="text-sm underline" to="/second">Open second page</Link>
      </CardContent>
    </Card>
  )
}
`
}

function secondPageTsx() {
  return `import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Link } from "../router"

export default function SecondPage() {
  return (
    <Card>
      <CardHeader><CardTitle>A second page</CardTitle></CardHeader>
      <CardContent><Link className="text-sm underline" to="/">Back to Home</Link></CardContent>
    </Card>
  )
}
`
}

function stylesCss(uiPackageName: string = DEFAULT_UI_PACKAGE) {
  return `${TAILWIND_IMPORT}
${themeImport(uiPackageName)}

body {
  margin: 0;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--background);
  color: var(--foreground);
}

.page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

#root:not(:empty) + .avs-fallback-shell {
  display: none;
}

.avs-fallback {
  width: min(720px, calc(100% - 36px));
  margin: 32px auto;
  border: 1px solid rgba(23, 32, 51, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.86);
  padding: clamp(24px, 5vw, 48px);
  box-shadow: 0 24px 80px rgba(23, 32, 51, 0.10);
  box-sizing: border-box;
}

.avs-fallback p {
  line-height: 1.65;
  margin: 10px 0 0;
}

.avs-fallback h1 {
  margin: 12px 0 0;
  font-size: clamp(32px, 8vw, 56px);
  line-height: 1;
  letter-spacing: 0;
}

.avs-fallback code {
  background: rgba(82, 96, 120, 0.12);
  border-radius: 6px;
  padding: 2px 6px;
}

.avs-fallback-eyebrow {
  color: #526078;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
`
}
