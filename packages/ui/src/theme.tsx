import * as React from "react"
import { ThemeScopeContext } from "./theme-context"

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

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === "(") depth += 1
    else if (character === ")") depth = Math.max(0, depth - 1)
    else if (character === delimiter && depth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}

function splitSpaceChannels(value: string): string[] {
  const channels: string[] = []
  let depth = 0
  let current = ""
  const push = () => {
    if (current) channels.push(current)
    current = ""
  }
  for (const character of value.trim()) {
    if (character === "(") depth += 1
    else if (character === ")") depth = Math.max(0, depth - 1)
    if (depth === 0 && /\s/.test(character)) {
      push()
    } else if (depth === 0 && character === "/") {
      push()
      channels.push(character)
    } else {
      current += character
    }
  }
  push()
  return channels
}

function usesLegacyHslChannels(value: string): boolean {
  const commaChannels = splitTopLevel(value, ",")
  if (commaChannels.length === 3 || commaChannels.length === 4) return commaChannels.every(Boolean)
  const spaceChannels = splitSpaceChannels(value)
  if (spaceChannels.length === 3 || (spaceChannels.length === 5 && spaceChannels[3] === "/")) return true
  const variable = value.match(/^\s*var\(\s*(--[^,\s)]+)/i)?.[1]
  return Boolean(variable && /(?:^--avs-|(?:^|[-_])hsl(?:[-_]|$)|(?:^|[-_])channels?(?:[-_]|$))/i.test(variable))
}

function toStyle(theme?: ShowTheme): React.CSSProperties {
  const style = {} as React.CSSProperties & Record<string, string>
  if (!theme) return style
  if (theme.radius) {
    style["--radius"] = theme.radius
    style["--avs-radius"] = theme.radius
  }
  for (const [key, value] of Object.entries(theme.colors ?? {}) as [ThemeColor, string][]) {
    if (!value) continue
    const legacyChannels = usesLegacyHslChannels(value)
    style[colorVars[key]] = legacyChannels ? `hsl(${value})` : value
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
  const scopeRef = React.useRef<HTMLDivElement>(null)
  return (
    <ThemeScopeContext.Provider value={scopeRef}>
      <div ref={scopeRef} className="avs-theme" data-theme-preset={preset} style={toStyle(theme)}>{children}</div>
    </ThemeScopeContext.Provider>
  )
}
