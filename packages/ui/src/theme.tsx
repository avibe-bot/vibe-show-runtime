import * as React from "react"

export type ThemePreset = "zinc" | "slate" | "green" | "blue"

type ThemeColor =
  | "background"
  | "foreground"
  | "card"
  | "cardForeground"
  | "popover"
  | "popoverForeground"
  | "primary"
  | "primaryForeground"
  | "secondary"
  | "secondaryForeground"
  | "muted"
  | "mutedForeground"
  | "accent"
  | "accentForeground"
  | "destructive"
  | "destructiveForeground"
  | "border"
  | "input"
  | "ring"
  | "chart1"
  | "chart2"
  | "chart3"
  | "chart4"
  | "chart5"
  | "sidebar"
  | "sidebarForeground"
  | "sidebarPrimary"
  | "sidebarPrimaryForeground"
  | "sidebarAccent"
  | "sidebarAccentForeground"
  | "sidebarBorder"
  | "sidebarRing"
  | "success"
  | "successForeground"
  | "warning"
  | "warningForeground"

export type ShowTheme = {
  radius?: string
  colors?: Partial<Record<ThemeColor, string>>
}

const colorVars: Record<ThemeColor, string> = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  cardForeground: "--card-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  destructive: "--destructive",
  destructiveForeground: "--destructive-foreground",
  border: "--border",
  input: "--input",
  ring: "--ring",
  chart1: "--chart-1",
  chart2: "--chart-2",
  chart3: "--chart-3",
  chart4: "--chart-4",
  chart5: "--chart-5",
  sidebar: "--sidebar",
  sidebarForeground: "--sidebar-foreground",
  sidebarPrimary: "--sidebar-primary",
  sidebarPrimaryForeground: "--sidebar-primary-foreground",
  sidebarAccent: "--sidebar-accent",
  sidebarAccentForeground: "--sidebar-accent-foreground",
  sidebarBorder: "--sidebar-border",
  sidebarRing: "--sidebar-ring",
  success: "--success",
  successForeground: "--success-foreground",
  warning: "--warning",
  warningForeground: "--warning-foreground"
}

const legacyColorVars: Partial<Record<ThemeColor, string>> = {
  background: "--avs-background",
  foreground: "--avs-foreground",
  muted: "--avs-muted",
  mutedForeground: "--avs-muted-foreground",
  border: "--avs-border",
  primary: "--avs-primary",
  primaryForeground: "--avs-primary-foreground",
  ring: "--avs-ring",
  success: "--avs-success",
  warning: "--avs-warning",
  destructive: "--avs-destructive"
}

const legacyColorFanout: Partial<Record<ThemeColor, readonly ThemeColor[]>> = {
  background: ["card", "popover"],
  foreground: ["cardForeground", "popoverForeground", "secondaryForeground", "accentForeground"],
  muted: ["secondary", "accent"],
  border: ["input"]
}

function isLegacyHslChannels(value: string): boolean {
  let components = 0
  let depth = 0
  let inComponent = false

  const finishComponent = () => {
    if (!inComponent) return
    components += 1
    inComponent = false
  }

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === "/" && value[index + 1] === "*") {
      if (depth === 0) finishComponent()
      const commentEnd = value.indexOf("*/", index + 2)
      index = commentEnd === -1 ? value.length : commentEnd + 1
      continue
    }
    if (character === '"' || character === "'") {
      const quote = character
      inComponent = true
      while (index + 1 < value.length) {
        index += 1
        if (value[index] === "\\") index += 1
        else if (value[index] === quote) break
      }
      continue
    }
    if (character === "(") {
      depth += 1
      inComponent = true
      continue
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && (character === "," || /\s/.test(character))) {
      finishComponent()
      continue
    }
    inComponent = true
  }
  finishComponent()

  return components >= 3
}

function normalizeColor(value: string): { standard: string; legacyChannels: boolean } {
  const legacyChannels = isLegacyHslChannels(value)
  return { standard: legacyChannels ? `hsl(${value})` : value, legacyChannels }
}

function toStyle(theme?: ShowTheme): React.CSSProperties {
  const style = {} as React.CSSProperties & Record<string, string>
  if (!theme) return style
  if (theme.radius) {
    style["--radius"] = theme.radius
    style["--avs-radius"] = theme.radius
  }

  for (const [key, aliases] of Object.entries(legacyColorFanout) as [ThemeColor, readonly ThemeColor[]][]) {
    const value = theme.colors?.[key]
    if (!value) continue
    const { standard } = normalizeColor(value)
    for (const alias of aliases) style[colorVars[alias]] = standard
  }

  for (const [key, value] of Object.entries(theme.colors ?? {}) as [ThemeColor, string][]) {
    if (!value) continue
    const { standard, legacyChannels } = normalizeColor(value)
    style[colorVars[key]] = standard
    const legacyVar = legacyColorVars[key]
    if (legacyChannels && legacyVar) style[legacyVar] = value
  }
  return style
}

export function ThemeProvider({
  preset,
  theme,
  children
}: {
  preset?: ThemePreset
  theme?: ShowTheme
  children: React.ReactNode
}) {
  return <div className="avs-theme" data-theme-preset={preset} style={toStyle(theme)}>{children}</div>
}
