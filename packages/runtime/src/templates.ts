import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function ensureSessionTemplate(workspace: string) {
  await mkdir(join(workspace, "src"), { recursive: true })
  await mkdir(join(workspace, "api"), { recursive: true })
  await writeIfMissing(join(workspace, "index.html"), indexHtml())
  await writeIfMissing(join(workspace, "src", "main.tsx"), mainTsx())
  await writeIfMissing(join(workspace, "src", "App.tsx"), appTsx())
  await writeIfMissing(join(workspace, "src", "styles.css"), stylesCss())
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
    <main class="avs-fallback">
      <div class="avs-fallback-eyebrow">Vibe Show Runtime</div>
      <h1>Ready to visualize</h1>
      <p>This session's React workspace is ready. Replace <code>src/App.tsx</code> with a focused visual explanation, report, dashboard, or prototype.</p>
    </main>
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
import App from "./App"

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
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
  return `body {
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

#root:not(:empty) + .avs-fallback {
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
