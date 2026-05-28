import * as React from "react"
import { AnimatedText } from "./animated-text"
import { cn } from "./utils"

export type BadgeVariant = "default" | "secondary" | "success" | "warning" | "destructive"

export function Badge({
  className,
  variant = "default",
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span className={cn("avs-badge", `avs-badge-${variant}`, className)} {...props}>
      <AnimatedText>{children}</AnimatedText>
    </span>
  )
}
