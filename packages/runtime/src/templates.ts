import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import postcss from "postcss"

const DEFAULT_UI_PACKAGE = "@avibe/show-ui"
const TAILWIND_IMPORT = `@import "tailwindcss";`
// The UI theme entry (`<uiPackageName>/theme.css`). It MUST be imported into this Tailwind
// entry (not merely as a main.tsx side effect) so its `@theme` tokens register in this
// compilation and its `@source` makes the shadcn component utility classes get generated. It
// goes right AFTER the tailwindcss import so it extends the default theme. Derived from the
// configured `uiPackageName` (the alias/vendor/extras paths use the same name), so a custom
// UI package resolves instead of a hardcoded `@avibe/show-ui`.
const themeImport = (uiPackageName: string) => `@import "${uiPackageName}/theme.css";`
// UTF-8 byte order mark, preserved at position 0 when re-emitting an existing file.
const BOM = "\ufeff"

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
 * idempotent, HMR-safe migration for workspaces whose `src/styles.css` predates them. The two
 * Runtime-owned imports are unique and unconditional; BOM, charset, comments, and layer-order
 * statements remain ahead of them, while workspace imports follow so they can override theme
 * defaults. Runs on every warm before the Vite server is created.
 */
async function ensureEntryImports(path: string, uiPackageName: string = DEFAULT_UI_PACKAGE) {
  let contents: string
  try {
    contents = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  const normalized = normalizeEntryImports(contents, uiPackageName)
  if (normalized == null) return
  if (normalized !== contents) await writeFile(path, normalized, "utf8")
}

function normalizeEntryImports(
  contents: string,
  uiPackageName: string
): string | null {
  const bom = contents.startsWith(BOM) ? BOM : ""
  const body = bom ? contents.slice(1) : contents
  const imports = topLevelImports(body)
  if (!imports) return null
  const themeSpecifier = `${uiPackageName}/theme.css`
  const tailwindImports = imports.filter((statement) => statement.specifier === "tailwindcss")
  const themeImports = imports.filter((statement) => statement.specifier === themeSpecifier)
  const removed = [...tailwindImports, ...themeImports].sort((left, right) => right.start - left.start)
  const firstManagedImport = removed.length
    ? Math.min(...removed.map((statement) => statement.start))
    : Number.POSITIVE_INFINITY

  let originalRoot: postcss.Root
  try {
    originalRoot = postcss.parse(body)
  } catch {
    return null
  }
  let insertionOffset = 0
  for (const node of originalRoot.nodes) {
    const start = node.source?.start?.offset
    if (start != null && start >= firstManagedImport) break
    const leadingStatement =
      node.type === "comment" ||
      (node.type === "atrule" && node.name.toLowerCase() === "charset") ||
      (node.type === "atrule" && node.name.toLowerCase() === "layer" && node.nodes == null)
    if (!leadingStatement) break
    insertionOffset = node.source?.end?.offset ?? insertionOffset
  }

  let remainder = body
  for (const statement of removed) {
    remainder = `${remainder.slice(0, statement.start)}${remainder.slice(statement.endExclusive)}`
  }

  const prefix = remainder.slice(0, insertionOffset).replace(/[ \t\r\n]+$/, "")
  const rest = remainder.slice(insertionOffset).replace(/^[ \t\r\n]+/, "")
  const managedImports = `${TAILWIND_IMPORT}\n${themeImport(uiPackageName)}`
  return `${bom}${prefix}${prefix ? "\n" : ""}${managedImports}${rest ? `\n${rest}` : "\n"}`
}

type ImportStatement = { start: number; endExclusive: number; specifier: string }

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
    const endExclusive = node.source?.end?.offset
    if (specifier == null || start == null || endExclusive == null) continue
    imports.push({ start, endExclusive, specifier })
  }
  return imports
}

function importSpecifier(params: string): string | null {
  const quoted = /^(["'])(.*?)\1(?:\s|$)/s.exec(params.trim())
  if (quoted) return quoted[2]
  const url = /^url\(\s*(["']?)(.*?)\1\s*\)(?:\s|$)/is.exec(params.trim())
  return url?.[2] ?? null
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
import { createContext, useContext, useSyncExternalStore } from "react"

export type PageProps = {
  params: Record<string, string>
  query: URLSearchParams
}

export type SsrRouteLocation = {
  pathname: string
  search: string
  origin: string
  basePath: string
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
const SsrRouterContext = createContext<SsrRouteLocation | null>(null)

export function SsrRouterProvider({
  location,
  children
}: {
  location: SsrRouteLocation
  children: ReactNode
}) {
  return <SsrRouterContext.Provider value={location}>{children}</SsrRouterContext.Provider>
}

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

function basePath(location?: SsrRouteLocation | null): string {
  if (location) {
    const pathname = new URL(location.basePath, location.origin).pathname
    const parts = pathname.split("/").filter(Boolean)
    return parts.length ? "/" + parts.join("/") + "/" : "/"
  }
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

function readRoutePath(location?: SsrRouteLocation | null): string {
  if (location) return normalizeRoutePath(location.pathname)
  const base = basePath(location)
  const pathname = window.location.pathname
  if (!pathname.startsWith(base)) return "/"
  const routePath = normalizeRoutePath("/" + pathname.slice(base.length))
  return routePath === "/index.html" ? "/" : routePath
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange)
  return () => window.removeEventListener("popstate", onChange)
}

function noSubscribe(): () => void {
  return () => undefined
}

export function useRoutePath(): string {
  const location = useContext(SsrRouterContext)
  return useSyncExternalStore(
    location ? noSubscribe : subscribe,
    location ? () => readRoutePath(location) : readRoutePath,
    () => readRoutePath(location)
  )
}

export function useRouteQuery(): URLSearchParams {
  const location = useContext(SsrRouterContext)
  const search = useSyncExternalStore(
    location ? noSubscribe : subscribe,
    location ? () => location.search : () => window.location.search,
    () => location?.search ?? ""
  )
  return new URLSearchParams(search)
}

function routeUrl(to: string, location?: SsrRouteLocation | null): URL {
  const normalizedTo = to.startsWith("/") ? to : "/" + to
  const origin = location?.origin ?? window.location.origin
  const route = new URL(normalizedTo, origin)
  const currentSearch = location?.search ?? new URL(window.location.href).search
  const target = new URL(basePath(location), origin)
  const embed = new URLSearchParams(currentSearch).get("vibe-embed")
  target.pathname = basePath(location) + route.pathname.replace(/^\\/+/, "")
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
  const location = useContext(SsrRouterContext)
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to)
  }
  return <a href={routeUrl(to, location).toString()} className={className} onClick={onClick}>{children}</a>
}

export function RouterView() {
  const path = useRoutePath()
  const query = useRouteQuery()
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
  return <Page params={params} query={query} />
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
