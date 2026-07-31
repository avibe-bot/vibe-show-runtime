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

export const SHOW_PORTAL_MOTION_PROPERTIES = [
  ...SHOW_PORTAL_THEME_PROPERTIES,
  "all", "font",
  "width", "min-width", "max-width", "height", "min-height", "max-height",
  "inline-size", "min-inline-size", "max-inline-size",
  "block-size", "min-block-size", "max-block-size",
  "aspect-ratio", "box-sizing", "contain", "container-type", "display",
  "align-content", "align-items", "align-self", "justify-content", "justify-items", "justify-self",
  "place-content", "place-items", "place-self", "order",
  "flex", "flex-basis", "flex-direction", "flex-flow", "flex-grow", "flex-shrink", "flex-wrap",
  "grid", "grid-area", "grid-auto-columns", "grid-auto-flow", "grid-auto-rows",
  "grid-column", "grid-column-end", "grid-column-start", "grid-row", "grid-row-end", "grid-row-start",
  "grid-template", "grid-template-areas", "grid-template-columns", "grid-template-rows",
  "gap", "column-gap", "row-gap", "columns", "column-count", "column-width",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "padding-block", "padding-block-end", "padding-block-start",
  "padding-inline", "padding-inline-end", "padding-inline-start",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "margin-block", "margin-block-end", "margin-block-start",
  "margin-inline", "margin-inline-end", "margin-inline-start",
  "border-width", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-block-width", "border-block-end-width", "border-block-start-width",
  "border-inline-width", "border-inline-end-width", "border-inline-start-width",
  "overflow", "overflow-x", "overflow-y", "overflow-block", "overflow-inline",
  "position", "top", "right", "bottom", "left", "inset",
  "inset-block", "inset-block-end", "inset-block-start",
  "inset-inline", "inset-inline-end", "inset-inline-start"
] as const

const showPortalMotionPropertySet = new Set<string>(SHOW_PORTAL_MOTION_PROPERTIES)

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
      return name.startsWith("--") || showPortalMotionPropertySet.has(name)
    }))
  } catch {
    return false
  }
}
