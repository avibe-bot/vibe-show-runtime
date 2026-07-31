export const SHOW_PORTAL_THEME_PROPERTIES = [
  "--radius", "--background", "--foreground", "--card", "--card-foreground",
  "--popover", "--popover-foreground", "--primary", "--primary-foreground",
  "--secondary", "--secondary-foreground", "--muted", "--muted-foreground",
  "--accent", "--accent-foreground", "--destructive", "--destructive-foreground",
  "--border", "--input", "--ring", "--chart-1", "--chart-2", "--chart-3",
  "--chart-4", "--chart-5", "--sidebar", "--sidebar-foreground",
  "--sidebar-primary", "--sidebar-primary-foreground", "--sidebar-accent",
  "--sidebar-accent-foreground", "--sidebar-border", "--sidebar-ring", "--success",
  "--success-foreground", "--warning", "--warning-foreground", "--avs-radius",
  "--avs-background", "--avs-foreground", "--avs-muted", "--avs-muted-foreground",
  "--avs-border", "--avs-primary", "--avs-primary-foreground", "--avs-ring",
  "--avs-success", "--avs-warning", "--avs-destructive", "color-scheme", "color", "direction",
  "font-family", "font-feature-settings", "font-kerning", "font-optical-sizing",
  "font-size", "font-stretch", "font-style", "font-synthesis", "font-variant",
  "font-variation-settings", "font-weight", "hyphens", "letter-spacing", "line-break",
  "line-height", "overflow-wrap", "tab-size", "text-align", "text-align-last",
  "text-indent", "text-justify", "text-orientation", "text-shadow", "text-transform",
  "white-space", "word-break", "word-spacing", "writing-mode"
] as const

const SHOW_PORTAL_MOTION_PROPERTIES = new Set([
  ...SHOW_PORTAL_THEME_PROPERTIES,
  "all", "font",
  "width", "min-width", "max-width", "height", "min-height", "max-height",
  "inline-size", "min-inline-size", "max-inline-size",
  "block-size", "min-block-size", "max-block-size",
  "contain", "container-type"
])

function cssPropertyName(property: string): string {
  if (property.startsWith("--")) return property
  return property.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)
}

export function animationAffectsShowPortalTheme(animation: Animation): boolean {
  const effect = animation.effect
  if (!effect || !("getKeyframes" in effect)) return false
  const getKeyframes = effect.getKeyframes
  if (typeof getKeyframes !== "function") return false
  try {
    return getKeyframes.call(effect).some((keyframe: ComputedKeyframe) => Object.keys(keyframe).some((property) => {
      const name = cssPropertyName(property)
      return name.startsWith("--") || SHOW_PORTAL_MOTION_PROPERTIES.has(name)
    }))
  } catch {
    return false
  }
}
