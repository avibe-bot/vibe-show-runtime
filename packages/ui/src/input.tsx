import * as React from "react"
import { cn } from "./utils"

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-[2.375rem] w-full rounded-lg border border-border bg-background px-2.5 text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20",
        className
      )}
      {...props}
    />
  )
)
Input.displayName = "Input"
