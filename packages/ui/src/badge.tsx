import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { AnimatedText } from "./animated-text"
import { cn } from "./utils"

// Real shadcn/ui badge shape, styled through the token utilities. `success`/`warning` are
// the existing Show UI extras; the union type is preserved for API compatibility.
const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-1 text-xs font-bold leading-none",
  {
    variants: {
      variant: {
        default: "border-primary bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        success: "border-success/30 bg-success/10 text-success",
        warning: "border-warning/30 bg-warning/10 text-warning",
        destructive: "border-destructive/30 bg-destructive/10 text-destructive"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
)

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>

export function Badge({
  className,
  variant = "default",
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      <AnimatedText>{children}</AnimatedText>
    </span>
  )
}
