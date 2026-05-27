import * as React from "react"
import { cn } from "./utils"

export type BadgeVariant = "default" | "secondary" | "success" | "warning" | "destructive"

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return <span className={cn("avs-badge", `avs-badge-${variant}`, className)} {...props} />
}
