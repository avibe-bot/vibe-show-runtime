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
  it("orders an existing theme import after Tailwind", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "show-theme-import-order-"))
    workspaces.push(workspace)
    await mkdir(join(workspace, "src"), { recursive: true })
    await writeFile(join(workspace, "src", "App.tsx"), "export default function App() { return null }\n")
    await writeFile(join(workspace, "src", "styles.css"), `@import "@avibe/show-ui/theme.css";
/* keep this comment */
@import "tailwindcss";
.page { color: var(--foreground); }
`)

    await ensureSessionTemplate(workspace)
    const migrated = await readFile(join(workspace, "src", "styles.css"), "utf8")
    expect(migrated.indexOf('@import "tailwindcss";')).toBeLessThan(
      migrated.indexOf('@import "@avibe/show-ui/theme.css";')
    )
    expect(migrated).toContain("/* keep this comment */")

    await ensureSessionTemplate(workspace)
    expect(await readFile(join(workspace, "src", "styles.css"), "utf8")).toBe(migrated)
  })

  it("ignores import-shaped strings when locating the theme import", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "show-theme-import-string-"))
    workspaces.push(workspace)
    await mkdir(join(workspace, "src"), { recursive: true })
    await writeFile(join(workspace, "src", "App.tsx"), "export default function App() { return null }\n")
    await writeFile(join(workspace, "src", "styles.css"), `.label {
  content: '@import "@avibe/show-ui/theme.css";';
}
@import "tailwindcss";
`)

    await ensureSessionTemplate(workspace)
    const migrated = await readFile(join(workspace, "src", "styles.css"), "utf8")
    expect(migrated).toContain(`content: '@import "@avibe/show-ui/theme.css";';`)
    expect(migrated.indexOf('@import "tailwindcss";')).toBeLessThan(
      migrated.lastIndexOf('@import "@avibe/show-ui/theme.css";')
    )

    await ensureSessionTemplate(workspace)
    expect(await readFile(join(workspace, "src", "styles.css"), "utf8")).toBe(migrated)
  })

  it("adds standard tokens in each legacy declaration scope and is idempotent", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "show-theme-migration-"))
    workspaces.push(workspace)
    await mkdir(join(workspace, "src"), { recursive: true })
    await writeFile(join(workspace, "src", "App.tsx"), "export default function App() { return null }\n")
    await writeFile(join(workspace, "src", "styles.css"), `@import "tailwindcss";
@import "@avibe/show-ui/theme.css";
.brand { --avs-primary: 221, 83%, 53%; --avs-border: 214 32% 91%; }
.modern { --avs-primary: 221 83% 53%; --primary: oklch(0.62 0.19 255); }
.authored { --primary: hsl(var(--avs-primary)); }
.prior { --avs-ring: 199 89% 48%; /* avibe-generated-theme --avs-ring --ring */ --ring: hsl(var(--avs-ring)); }
.duplicate { --avs-primary: 221 83% 53%; --primary: oklch(0.62 0.19 255); /* avibe-generated-theme --avs-primary --primary */ --primary: hsl(var(--avs-primary)); --avibe-show-theme-owner-primary: --avs-primary; }
`)
    await mkdir(join(workspace, "src", "features"), { recursive: true })
    await writeFile(join(workspace, "src", "theme.css"), `.tenant { --avs-ring: 199 89% 48%; }\n`)
    await writeFile(join(workspace, "src", "features", "panel.module.css"), `.panel { --avs-muted: 210 40% 96%; }\n`)

    await ensureSessionTemplate(workspace)
    const migrated = await readFile(join(workspace, "src", "styles.css"), "utf8")
    expect(migrated).toMatch(/\.brand\s*\{[^}]*--primary:\s*hsl\(var\(--avs-primary\)\)/)
    expect(migrated).toMatch(/\.brand\s*\{[^}]*--avibe-show-theme-owner-primary:\s*--avs-primary/)
    expect(migrated).toMatch(/\.brand\s*\{[^}]*--input:\s*hsl\(var\(--avs-border\)\)/)
    expect(migrated).toMatch(/\.modern\s*\{[^}]*--primary:\s*oklch\(0\.62 0\.19 255\)/)
    expect(migrated).toMatch(/\.authored\s*\{[^}]*--primary:\s*hsl\(var\(--avs-primary\)\)/)
    expect(migrated).toMatch(/\.prior\s*\{[^}]*--avibe-show-theme-owner-ring:\s*--avs-ring/)
    const duplicate = migrated.match(/\.duplicate\s*\{([^}]*)\}/)?.[1] ?? ""
    expect(duplicate.match(/--primary:/g)).toHaveLength(1)
    expect(duplicate).toContain("--primary: oklch(0.62 0.19 255)")
    expect(duplicate).not.toContain("avibe-generated-theme")
    expect(duplicate).not.toContain("--avibe-show-theme-owner-primary")
    const theme = await readFile(join(workspace, "src", "theme.css"), "utf8")
    const module = await readFile(join(workspace, "src", "features", "panel.module.css"), "utf8")
    expect(theme).toMatch(/\.tenant\s*\{[^}]*--ring:\s*hsl\(var\(--avs-ring\)\)/)
    expect(module).toMatch(/\.panel\s*\{[^}]*--muted:\s*hsl\(var\(--avs-muted\)\)/)

    await ensureSessionTemplate(workspace)
    expect(await readFile(join(workspace, "src", "styles.css"), "utf8")).toBe(migrated)
    expect(await readFile(join(workspace, "src", "theme.css"), "utf8")).toBe(theme)
    expect(await readFile(join(workspace, "src", "features", "panel.module.css"), "utf8")).toBe(module)

    await writeFile(
      join(workspace, "src", "styles.css"),
      migrated.replace("--avs-primary: 221, 83%, 53%;", "--avs-primary: 221, 83%, 53% !important;")
    )
    await ensureSessionTemplate(workspace)
    const prioritized = await readFile(join(workspace, "src", "styles.css"), "utf8")
    const prioritizedBrand = prioritized.match(/\.brand\s*\{([^}]*)\}/)?.[1] ?? ""
    expect(prioritizedBrand).toMatch(/--primary:\s*hsl\(var\(--avs-primary\)\)\s*!important/)

    await writeFile(
      join(workspace, "src", "styles.css"),
      prioritized.replace("--avs-primary: 221, 83%, 53% !important;", "--avs-primary: 221, 83%, 53%;")
    )
    await ensureSessionTemplate(workspace)
    const reprioritized = await readFile(join(workspace, "src", "styles.css"), "utf8")
    const reprioritizedBrand = reprioritized.match(/\.brand\s*\{([^}]*)\}/)?.[1] ?? ""
    expect(reprioritizedBrand).toMatch(/--primary:\s*hsl\(var\(--avs-primary\)\)(?!\s*!important)/)

    await writeFile(
      join(workspace, "src", "styles.css"),
      reprioritized.replace("--avs-primary: 221, 83%, 53%;", "")
    )
    await ensureSessionTemplate(workspace)
    const cleaned = await readFile(join(workspace, "src", "styles.css"), "utf8")
    const brand = cleaned.match(/\.brand\s*\{([^}]*)\}/)?.[1] ?? ""
    expect(brand).not.toContain("--primary:")
    expect(brand).not.toContain("--avibe-show-theme-owner-primary:")
    expect(brand).toContain("--input: hsl(var(--avs-border))")
    expect(cleaned).toMatch(/\.authored\s*\{[^}]*--primary:\s*hsl\(var\(--avs-primary\)\)/)
    expect(cleaned).not.toMatch(/\.authored\s*\{[^}]*--avibe-show-theme-owner-primary/)
  })
})
