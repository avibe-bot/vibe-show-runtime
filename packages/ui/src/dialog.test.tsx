import * as React from "react"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Dialog, DialogContent, DialogTrigger } from "./dialog"
import { animationAffectsShowPortalTheme } from "./theme-properties"

function animationWithKeyframes(keyframes: Array<Record<string, unknown>>): Animation {
  return {
    effect: { getKeyframes: () => keyframes }
  } as unknown as Animation
}

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
    expect(source).toContain("PORTAL_CONTEXT_PROPERTIES.map")
    expect(source).toContain("scope.openingTheme.current = readPortalTheme")
    expect(source).toContain("if (!active?.isConnected && triggerScope?.openingTheme.current) return null")
    expect(source).toContain("if (!nextOpen && open === undefined) clearOpeningTheme()")
    expect(source).toContain("if (controlledOpen.current === false) clearOpeningTheme()")
    expect(source).toContain('properties["color-scheme"] = computed.colorScheme')
    expect(source).toContain('node.hasAttribute("lang")')
    expect(source).toContain('bridge.setAttribute("lang", theme.language)')
    expect(source).toContain('node.classList.contains("avs-dark")')
    expect(source).toContain("window.addEventListener(SHOW_THEME_CHANGE_EVENT, schedule)")
    expect(source).toContain('window.addEventListener("beforeprint", updateBeforePrint)')
    expect(source).toContain("if (bridge) copiedProperties.current = applyPortalTheme(bridge, next")
    expect(source).toContain('window.addEventListener("animationstart", schedule, true)')
    expect(source).toContain("hasActivePortalThemeMotion(getThemeSource())")
    expect(source).toContain("animationAffectsShowPortalTheme(animation)")
    expect(source).toContain("new ResizeObserver(schedule)")
    expect(source).toContain("resizeObserver.observe(element)")
    expect(source).toContain("resizeObserver?.disconnect()")
    expect(source.match(/requestAnimationFrame\(update\)/g)).toHaveLength(1)
  })

  it("polls only animations that can change portal theme context", () => {
    expect(animationAffectsShowPortalTheme(animationWithKeyframes([
      { transform: "translateX(10px)", opacity: 0.5 }
    ]))).toBe(false)
    expect(animationAffectsShowPortalTheme(animationWithKeyframes([
      { fontSize: "20px" }
    ]))).toBe(true)
    expect(animationAffectsShowPortalTheme(animationWithKeyframes([
      { "--brand-primary": "red" }
    ]))).toBe(true)
    expect(animationAffectsShowPortalTheme(animationWithKeyframes([
      { inlineSize: "30rem" }
    ]))).toBe(true)
    expect(animationAffectsShowPortalTheme(animationWithKeyframes([
      { flexBasis: "30rem", gridTemplateColumns: "1fr 2fr" }
    ]))).toBe(true)
  })
})
