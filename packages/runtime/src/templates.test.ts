import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ensureSessionTemplate } from "./templates.js"

const workspaces: string[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { force: true, recursive: true })))
})

async function workspaceWithStyles(styles: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "show-theme-imports-"))
  workspaces.push(workspace)
  await mkdir(join(workspace, "src"), { recursive: true })
  await writeFile(join(workspace, "src", "App.tsx"), "export default function App() { return null }\n")
  await writeFile(join(workspace, "src", "styles.css"), styles)
  return workspace
}

describe("theme import ordering", () => {
  it("moves the theme directly after Tailwind and ahead of workspace overrides", async () => {
    const workspace = await workspaceWithStyles(`@import "tailwindcss";
@import "./brand.css";
@import "@avibe/show-ui/theme.css";
.page { color: var(--foreground); }
`)

    await ensureSessionTemplate(workspace)
    const path = join(workspace, "src", "styles.css")
    const migrated = await readFile(path, "utf8")
    expect(migrated.indexOf('@import "tailwindcss";')).toBeLessThan(migrated.indexOf('@import "@avibe/show-ui/theme.css";'))
    expect(migrated.indexOf('@import "@avibe/show-ui/theme.css";')).toBeLessThan(migrated.indexOf('@import "./brand.css";'))

    await ensureSessionTemplate(workspace)
    expect(await readFile(path, "utf8")).toBe(migrated)
  })

  it("does not treat import-shaped comments or strings as real imports", async () => {
    const workspace = await workspaceWithStyles(`/* @import "@avibe/show-ui/theme.css"; */
.label { content: '@import "tailwindcss";'; }
`)

    await ensureSessionTemplate(workspace)
    const migrated = await readFile(join(workspace, "src", "styles.css"), "utf8")
    expect(migrated.startsWith('@import "tailwindcss";\n@import "@avibe/show-ui/theme.css";')).toBe(true)
    expect(migrated).toContain(`content: '@import "tailwindcss";'`)
  })
})
