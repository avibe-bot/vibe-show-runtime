import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ensureSessionTemplate } from "./templates.js"

const workspaces: string[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { force: true, recursive: true })))
})

describe("legacy theme migration", () => {
  it("adds standard tokens in each legacy declaration scope and is idempotent", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "show-theme-migration-"))
    workspaces.push(workspace)
    await mkdir(join(workspace, "src"), { recursive: true })
    await writeFile(join(workspace, "src", "App.tsx"), "export default function App() { return null }\n")
    await writeFile(join(workspace, "src", "styles.css"), `@import "tailwindcss";
@import "@avibe/show-ui/theme.css";
.brand { --avs-primary: 221, 83%, 53%; --avs-border: 214 32% 91%; }
.modern { --avs-primary: 221 83% 53%; --primary: oklch(0.62 0.19 255); }
`)

    await ensureSessionTemplate(workspace)
    const migrated = await readFile(join(workspace, "src", "styles.css"), "utf8")
    expect(migrated).toMatch(/\.brand\s*\{[^}]*--primary:\s*hsl\(var\(--avs-primary\)\)/)
    expect(migrated).toMatch(/\.brand\s*\{[^}]*--input:\s*hsl\(var\(--avs-border\)\)/)
    expect(migrated).toMatch(/\.modern\s*\{[^}]*--primary:\s*oklch\(0\.62 0\.19 255\)/)

    await ensureSessionTemplate(workspace)
    expect(await readFile(join(workspace, "src", "styles.css"), "utf8")).toBe(migrated)
  })
})
