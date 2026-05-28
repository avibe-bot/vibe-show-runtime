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
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f7f9;
        color: #172033;
      }
      body {
        margin: 0;
        min-height: 100vh;
        box-sizing: border-box;
      }
      #root:not(:empty) + .avs-fallback-shell {
        display: none;
      }
      .avs-fallback-shell {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 32px 18px;
        box-sizing: border-box;
      }
      .avs-fallback {
        width: min(860px, 100%);
        border: 1px solid rgba(23, 32, 51, 0.12);
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.92);
        padding: clamp(24px, 5vw, 44px);
        box-shadow: 0 24px 80px rgba(23, 32, 51, 0.10);
        box-sizing: border-box;
      }
      .avs-fallback-eyebrow {
        color: #526078;
        font-size: 13px;
        font-weight: 760;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .avs-fallback h1 {
        margin: 12px 0 0;
        font-size: clamp(32px, 7vw, 56px);
        line-height: 1;
        letter-spacing: 0;
      }
      .avs-fallback p {
        max-width: 720px;
        line-height: 1.65;
        margin: 12px 0 0;
        color: #526078;
      }
      .avs-fallback-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(280px, 0.8fr);
        gap: 18px;
        margin-top: 24px;
      }
      .avs-fallback-panel {
        border: 1px solid rgba(23, 32, 51, 0.10);
        border-radius: 14px;
        background: #fff;
        padding: 16px;
      }
      .avs-fallback-panel h2 {
        margin: 0 0 10px;
        font-size: 15px;
      }
      .avs-fallback-panel ul {
        margin: 0;
        padding-left: 18px;
        color: #526078;
        line-height: 1.7;
      }
      .avs-fallback textarea {
        width: 100%;
        min-height: 178px;
        resize: vertical;
        border: 1px solid rgba(23, 32, 51, 0.14);
        border-radius: 12px;
        padding: 12px;
        box-sizing: border-box;
        font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        color: #172033;
        background: #f8fafc;
      }
      .avs-copy-button {
        margin-top: 10px;
        height: 36px;
        border: 0;
        border-radius: 10px;
        padding: 0 14px;
        background: #0f172a;
        color: #fff;
        font: 700 14px/1 Inter, ui-sans-serif, system-ui;
        cursor: pointer;
      }
      code {
        background: rgba(82, 96, 120, 0.12);
        border-radius: 6px;
        padding: 2px 6px;
      }
      @media (max-width: 760px) {
        .avs-fallback-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <section class="avs-fallback-shell">
      <main class="avs-fallback">
        <div class="avs-fallback-eyebrow">Vibe Show recovery</div>
        <h1>Ready to visualize</h1>
        <p>The React app has not mounted yet. This can happen during first-load dependency optimization, before the agent writes the page, or when <code>src/App.tsx</code> has a compile/runtime error.</p>
        <div class="avs-fallback-grid">
          <div class="avs-fallback-panel">
            <h2>Ask your agent to fix the Show Page</h2>
            <textarea id="avs-agent-prompt" readonly>Please repair this Vibe Remote Show Page. Open the Show Page workspace, read the local Show Page/runtime instructions, then replace src/App.tsx with a polished React page. Use the shadcn-style components from @/components/ui and @avibe/show-ui. Do not edit index.html unless it is required. If the browser shows Ready to visualize, check src/App.tsx, src/main.tsx, src/styles.css, and the Vite/browser console for compile or runtime errors. Make the page responsive and verify it renders.</textarea>
            <button class="avs-copy-button" type="button" onclick="navigator.clipboard.writeText(document.getElementById('avs-agent-prompt').value).then(() => this.textContent = 'Copied')">Copy prompt</button>
          </div>
          <div class="avs-fallback-panel">
            <h2>What to check</h2>
            <ul>
              <li>Wait a moment and refresh if this is the first visit.</li>
              <li>Ask the agent to inspect Vite and browser console errors.</li>
              <li>The main file to edit is <code>src/App.tsx</code>.</li>
              <li>Use shared UI imports like <code>@/components/ui/card</code>.</li>
            </ul>
          </div>
        </div>
      </main>
    </section>
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
