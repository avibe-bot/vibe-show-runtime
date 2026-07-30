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

const presets: Record<ThemePreset, ShowTheme> = {
  zinc: { colors: { primary: "240 5% 10%", ring: "240 5% 64%" } },
  slate: { colors: { primary: "222 47% 11%", ring: "215 20% 65%" } },
  green: { colors: { primary: "158 64% 24%", ring: "158 64% 40%" } },
  blue: { colors: { primary: "221 83% 53%", ring: "221 83% 63%" } }
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

const LEGACY_HSL_CHANNELS = /^\s*-?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|grad|rad|turn)?\s+-?(?:\d+(?:\.\d+)?|\.\d+)%\s+-?(?:\d+(?:\.\d+)?|\.\d+)%(?:\s*\/\s*(?:\d+(?:\.\d+)?|\.\d+)%?)?\s*$/

function toStyle(theme?: ShowTheme): React.CSSProperties {
  const style = {} as React.CSSProperties & Record<string, string>
  if (!theme) return style
  if (theme.radius) {
    style["--radius"] = theme.radius
    style["--avs-radius"] = theme.radius
  }
  for (const [key, value] of Object.entries(theme.colors ?? {}) as [ThemeColor, string][]) {
    if (!value) continue
    const legacyChannels = LEGACY_HSL_CHANNELS.test(value)
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
  return <div className="avs-theme" style={{ ...toStyle(preset ? presets[preset] : undefined), ...toStyle(theme) }}>{children}</div>
}
