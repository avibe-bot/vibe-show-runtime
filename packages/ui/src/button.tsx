import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { AnimatedText } from "./animated-text"
import { cn } from "./utils"

// Real shadcn/ui (new-york) button, styled through the token utilities from theme.css.
// `size: "md"` is kept as an alias of shadcn's `default` so existing pages keep working;
// `link`/`lg` are additive extras. The subtle hover lift preserves the previous feel.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-all cursor-pointer outline-none disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-[3px] focus-visible:ring-ring/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:-translate-y-px hover:shadow-md",
        secondary: "bg-secondary text-secondary-foreground hover:-translate-y-px hover:shadow-md",
        outline: "border border-border bg-background text-foreground hover:-translate-y-px hover:shadow-md",
        ghost: "bg-transparent text-foreground hover:bg-muted",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:-translate-y-px hover:shadow-md",
        link: "text-primary underline-offset-4 hover:underline"
      },
      size: {
        default: "h-[2.375rem] px-3.5 py-2",
        md: "h-[2.375rem] px-3.5 py-2",
        sm: "h-8 gap-1.5 px-2.5 text-[0.8125rem]",
        lg: "h-11 px-6",
        icon: "size-9"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "md"
    }
  }
)

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, children, ...props }, ref) => {
    if (asChild) {
      return (
        <Slot className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props}>
          {children}
        </Slot>
      )
    }
    return (
      <button className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props}>
        <AnimatedText>{children}</AnimatedText>
      </button>
    )
  }
)

Button.displayName = "Button"
