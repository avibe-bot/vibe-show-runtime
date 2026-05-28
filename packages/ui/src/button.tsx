import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { AnimatedText } from "./animated-text"
import { cn } from "./utils"

const buttonVariants = cva("avs-button", {
  variants: {
    variant: {
      default: "avs-button-default",
      secondary: "avs-button-secondary",
      outline: "avs-button-outline",
      ghost: "avs-button-ghost",
      destructive: "avs-button-destructive"
    },
    size: {
      sm: "avs-button-sm",
      md: "avs-button-md",
      icon: "avs-button-icon"
    }
  },
  defaultVariants: {
    variant: "default",
    size: "md"
  }
})

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
    return <button className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props}><AnimatedText>{children}</AnimatedText></button>
  }
)

Button.displayName = "Button"
