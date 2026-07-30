import { describe, expect, it } from "vitest"
import { showThemeCompatibilityPlugin } from "./theme-compat-plugin.js"

class TestStyle {
  private declarations = new Map<string, { value: string; priority: string }>()

  getPropertyPriority(name: string) {
    return this.declarations.get(name)?.priority ?? ""
  }

  getPropertyValue(name: string) {
    return this.declarations.get(name)?.value ?? ""
  }

  removeProperty(name: string) {
    const value = this.getPropertyValue(name)
    this.declarations.delete(name)
    return value
  }

  setProperty(name: string, value: string, priority = "") {
    this.declarations.set(name, { value, priority })
  }
}

function loadSyncLegacyTheme() {
  const plugin = showThemeCompatibilityPlugin()
  const load = plugin.load as ((id: string) => unknown) | undefined
  const code = load?.("\0virtual:avibe-show-theme-compat-client")
  expect(typeof code).toBe("string")
  return Function(`${code}\nreturn syncLegacyTheme;`)() as (element: { style: TestStyle }) => void
}

describe("dynamic legacy theme compatibility", () => {
  it("migrates inline legacy tokens one way without replacing authored standard tokens", () => {
    const sync = loadSyncLegacyTheme()
    const legacy = { style: new TestStyle() }
    legacy.style.setProperty("--avs-primary", "221 83% 53%", "important")
    legacy.style.setProperty("--avs-radius", "0.75rem")

    sync(legacy)
    expect(legacy.style.getPropertyValue("--primary")).toBe("hsl(var(--avs-primary))")
    expect(legacy.style.getPropertyPriority("--primary")).toBe("important")
    expect(legacy.style.getPropertyValue("--radius")).toBe("var(--avs-radius)")

    legacy.style.removeProperty("--avs-primary")
    sync(legacy)
    expect(legacy.style.getPropertyValue("--primary")).toBe("")

    const standard = { style: new TestStyle() }
    standard.style.setProperty("--avs-primary", "221 83% 53%")
    standard.style.setProperty("--primary", "oklch(0.62 0.19 255)")
    sync(standard)
    expect(standard.style.getPropertyValue("--primary")).toBe("oklch(0.62 0.19 255)")
  })
})
