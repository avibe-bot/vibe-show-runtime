import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const TAILWIND_IMPORT = `@import "tailwindcss";`
// Matches an existing Tailwind entry in any quote/spacing form so migration never double-imports.
const TAILWIND_IMPORT_PATTERN = /@import\s+["']tailwindcss["']/
// The @avibe/show-ui theme entry. It MUST be imported into this Tailwind entry (not merely
// as a main.tsx side effect) so its `@theme` tokens register in this compilation and its
// `@source` makes the shadcn component utility classes get generated. It goes right AFTER
// the tailwindcss import so it extends the default theme.
const THEME_IMPORT = `@import "@avibe/show-ui/theme.css";`
const THEME_IMPORT_PATTERN = /@import\s+["']@avibe\/show-ui\/theme\.css["']/
// A leading `@charset "...";` is the only statement allowed before `@import`. Match only
// through the `;` (plus trailing spaces/one line ending) so rules sharing the line — e.g.
// minified `@charset "utf-8";body{...}` — are NOT swallowed, which would push the import
// after them and make it invalid.
const LEADING_CHARSET_PATTERN = /^@charset\s+["'][^"']*["'];[ \t]*\r?\n?/i
// UTF-8 byte order mark, preserved at position 0 when re-emitting an existing file.
const BOM = "\ufeff"

export async function ensureSessionTemplate(workspace: string) {
  await mkdir(join(workspace, "src"), { recursive: true })
  await mkdir(join(workspace, "api"), { recursive: true })
  await writeIfMissing(join(workspace, "index.html"), indexHtml())
  await writeIfMissing(join(workspace, "src", "show-runtime-config.ts"), showRuntimeConfigTs())
  await writeIfMissing(join(workspace, "src", "main.tsx"), mainTsx())
  await writeIfMissing(join(workspace, "src", "App.tsx"), appTsx())
  await writeIfMissing(join(workspace, "src", "styles.css"), stylesCss())
  await ensureEntryImports(join(workspace, "src", "styles.css"))
}

/**
 * Keep the workspace Tailwind entry importing BOTH `tailwindcss` and the `@avibe/show-ui`
 * theme, in that order. New workspaces already lead with both (see stylesCss); this is the
 * idempotent, HMR-safe migration for workspaces whose `src/styles.css` predates them — it
 * adds whichever import is missing and skips (no write) when both are present. Runs on every
 * warm before the Vite server is created.
 *
 * Detection runs against a comment-stripped copy so a commented-out import is not mistaken
 * for a real one (which would skip migration and leave the page unstyled).
 */
async function ensureEntryImports(path: string) {
  let contents: string
  try {
    contents = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  const scanned = stripCssComments(contents)
  const hasTailwind = TAILWIND_IMPORT_PATTERN.test(scanned)
  const hasTheme = THEME_IMPORT_PATTERN.test(scanned)
  if (hasTailwind && hasTheme) return
  if (!hasTailwind) {
    // No Tailwind entry yet: prepend it (plus the theme, unless the theme is already there)
    // as the leading statement(s), after any `@charset`/BOM.
    const block = hasTheme ? TAILWIND_IMPORT : `${TAILWIND_IMPORT}\n${THEME_IMPORT}`
    contents = prependImports(contents, block)
  } else {
    // Tailwind entry present but the theme is missing: insert it right after the import.
    contents = insertThemeAfterTailwind(contents)
  }
  await writeFile(path, contents, "utf8")
}

/** Insert the theme import immediately after the existing `@import "tailwindcss";` statement. */
function insertThemeAfterTailwind(contents: string): string {
  const match = /@import\s+["']tailwindcss["'][^;]*;/.exec(contents)
  if (!match) return contents
  const end = match.index + match[0].length
  return `${contents.slice(0, end)}\n${THEME_IMPORT}${contents.slice(end)}`
}

/** Strip CSS block comments (used only for import detection, not for the emitted file). */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "")
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
    <title>Vibe Show</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`
}

function mainTsx() {
  return `import React from "react"
import { createRoot } from "react-dom/client"
import "@avibe/show-ui/styles.css"
import "./styles.css"
import "./show-runtime-config"
import App from "./App"

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
  sessionId: injected.sessionId ?? showSessionId(),
  basePath: injected.basePath ?? showBasePath(),
  eventsPath: injected.eventsPath ?? "__show/events",
  streamPath: injected.streamPath ?? "__show/events?stream=1",
  writeToken: injected.writeToken
} satisfies RuntimeConfig
`
}

function appTsx() {
  return `import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ThemeProvider } from "@avibe/show-ui/theme"

export default function App() {
  return (
    <ThemeProvider preset="zinc">
      <main className="page">
        <Card>
          <CardHeader>
            <CardTitle>Vibe Show Runtime</CardTitle>
            <CardDescription>This session is served by the managed service runtime.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void fetch("./api/health")}>Call handler</Button>
          </CardContent>
        </Card>
      </main>
    </ThemeProvider>
  )
}
`
}

function stylesCss() {
  return `@import "tailwindcss";
@import "@avibe/show-ui/theme.css";

body {
  margin: 0;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f6f7f9;
  color: hsl(var(--avs-foreground));
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
