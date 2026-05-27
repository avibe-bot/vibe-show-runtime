import * as React from "react"

export type ThemePreset = "zinc" | "slate" | "green" | "blue"

export type ShowTheme = {
  radius?: string
  colors?: Partial<Record<"background" | "foreground" | "muted" | "mutedForeground" | "border" | "primary" | "primaryForeground" | "ring" | "success" | "warning" | "destructive", string>>
}

const presets: Record<ThemePreset, ShowTheme> = {
  zinc: {
    colors: {
      primary: "240 5% 10%",
      ring: "240 5% 64%"
    }
  },
  slate: {
    colors: {
      primary: "222 47% 11%",
      ring: "215 20% 65%"
    }
  },
  green: {
    colors: {
      primary: "158 64% 24%",
      ring: "158 64% 40%"
    }
  },
  blue: {
    colors: {
      primary: "221 83% 53%",
      ring: "221 83% 63%"
    }
  }
}

const colorVars: Record<keyof NonNullable<ShowTheme["colors"]>, string> = {
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

function toStyle(theme?: ShowTheme): React.CSSProperties {
  const style: React.CSSProperties = {}
  if (!theme) return style
  if (theme.radius) {
    ;(style as Record<string, string>)["--avs-radius"] = theme.radius
  }
  for (const [key, value] of Object.entries(theme.colors ?? {})) {
    if (value) {
      ;(style as Record<string, string>)[colorVars[key as keyof typeof colorVars]] = value
    }
  }
  return style
}

export function ThemeProvider({
  preset = "zinc",
  theme,
  children
}: {
  preset?: ThemePreset
  theme?: ShowTheme
  children: React.ReactNode
}) {
  return <div className="avs-theme" style={{ ...toStyle(presets[preset]), ...toStyle(theme) }}>{children}</div>
}
