import * as React from "react"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Dialog, DialogContent, DialogTrigger } from "./dialog"

describe("Dialog", () => {
  it("captures its source scope without inserting a marker element", () => {
    const markup = renderToStaticMarkup(
      <ul>
        <Dialog>
          <DialogTrigger asChild><li>Open</li></DialogTrigger>
          <DialogContent>Content</DialogContent>
        </Dialog>
      </ul>
    )
    expect(markup).toMatch(/^<ul><li[^>]*>Open<\/li><\/ul>$/)
    expect(markup).not.toContain("<span")
  })

  it("keeps portal snapshots authoritative across slots and important theme rules", () => {
    const source = readFileSync(new URL("./dialog.tsx", import.meta.url), "utf8")
    expect(source.indexOf("node.assignedSlot")).toBeLessThan(source.indexOf("node.parentElement"))
    expect(source).toContain('bridge.style.setProperty(property, value, "important")')
    expect(source).toContain("scope.openingTheme.current = readPortalTheme")
    expect(source).toContain("if (!active?.isConnected && triggerScope?.openingTheme.current) return null")
    expect(source).toContain("if (!nextOpen && open === undefined) clearOpeningTheme()")
    expect(source).toContain("if (controlledOpen.current === false) clearOpeningTheme()")
    expect(source).toContain('["color-scheme", computed.colorScheme]')
    expect(source).toContain('["direction", context.direction]')
    expect(source).toContain('node.hasAttribute("lang")')
    expect(source).toContain('bridge.setAttribute("lang", theme.language)')
    expect(source).toContain('node.classList.contains("avs-dark")')
    expect(source).toContain("window.addEventListener(SHOW_THEME_CHANGE_EVENT, schedule)")
    expect(source).toContain('window.addEventListener("beforeprint", updateBeforePrint)')
    expect(source).toContain("if (bridge) copiedProperties.current = applyPortalTheme(bridge, next")
    expect(source).toContain('window.addEventListener("animationstart", schedule, true)')
    expect(source).toContain("hasActivePortalThemeMotion(getThemeSource())")
    expect(source.match(/requestAnimationFrame\(update\)/g)).toHaveLength(1)
  })
})
