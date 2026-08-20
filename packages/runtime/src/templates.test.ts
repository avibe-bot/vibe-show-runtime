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
  it.each([
    ["both imports", `@import "./brand.css";\n@import "@avibe/show-ui/theme.css";\n@import "tailwindcss";\n`],
    ["only Tailwind", `@import "./brand.css";\n@import "tailwindcss";\n`],
    ["only the theme", `@import "./brand.css";\n@import "@avibe/show-ui/theme.css";\n`],
    ["neither import", `@import "./brand.css";\n`]
  ])("normalizes %s into one canonical prefix", async (_label, imports) => {
    const workspace = await workspaceWithStyles(`${imports}.page { color: var(--foreground); }\n`)

    await ensureSessionTemplate(workspace)
    const path = join(workspace, "src", "styles.css")
    const migrated = await readFile(path, "utf8")
    expect(migrated.startsWith('@import "tailwindcss";\n@import "@avibe/show-ui/theme.css";\n')).toBe(true)
    expect(migrated.indexOf('@import "@avibe/show-ui/theme.css";')).toBeLessThan(migrated.indexOf('@import "./brand.css";'))
    expect(migrated.match(/@import "tailwindcss";/g)).toHaveLength(1)
    expect(migrated.match(/@import "@avibe\/show-ui\/theme\.css";/g)).toHaveLength(1)

    await ensureSessionTemplate(workspace)
    expect(await readFile(path, "utf8")).toBe(migrated)
  })

  it("does not treat import-shaped comments or strings as real imports", async () => {
    const workspace = await workspaceWithStyles(`/* @import "@avibe/show-ui/theme.css"; */
.label { content: '@import "tailwindcss";'; }
`)

    await ensureSessionTemplate(workspace)
    const migrated = await readFile(join(workspace, "src", "styles.css"), "utf8")
    expect(migrated.indexOf("/* @import")).toBeLessThan(migrated.indexOf('@import "tailwindcss";'))
    expect(migrated).toContain('@import "tailwindcss";\n@import "@avibe/show-ui/theme.css";')
    expect(migrated).toContain(`content: '@import "tailwindcss";'`)
  })

  it("preserves leading layer order and replaces qualified duplicates with managed imports", async () => {
    const workspace = await workspaceWithStyles(`@charset "utf-8";
/* layer contract */
@layer theme, overrides;
@import "tailwindcss" print;
@import "./brand.css";
@import "@avibe/show-ui/theme.css" screen;
@import "tailwindcss";
@import "@avibe/show-ui/theme.css";
`)

    await ensureSessionTemplate(workspace)
    const path = join(workspace, "src", "styles.css")
    const migrated = await readFile(path, "utf8")
    expect(migrated.startsWith(`@charset "utf-8";
/* layer contract */
@layer theme, overrides;
@import "tailwindcss";
@import "@avibe/show-ui/theme.css";
@import "./brand.css";`)).toBe(true)
    expect(migrated.match(/@import "tailwindcss"/g)).toHaveLength(1)
    expect(migrated.match(/@import "@avibe\/show-ui\/theme\.css"/g)).toHaveLength(1)

    await ensureSessionTemplate(workspace)
    expect(await readFile(path, "utf8")).toBe(migrated)
  })
})
