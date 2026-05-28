import * as React from "react"
import { motion, type HTMLMotionProps } from "motion/react"
import { AnimatedText } from "./animated-text"
import { cn } from "./utils"

type CardProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  | "onAnimationStart"
  | "onAnimationEnd"
  | "onAnimationIteration"
  | "onDrag"
  | "onDragStart"
  | "onDragEnd"
  | "onDragEnter"
  | "onDragExit"
  | "onDragLeave"
  | "onDragOver"
> & {
  className?: string
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, ...props }, ref) => (
    <motion.div
      layout
      ref={ref}
      className={cn("avs-card", className)}
      initial={{ opacity: 0, y: 12, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.985 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1], layout: { duration: 0.34 } }}
      {...(props as HTMLMotionProps<"div">)}
    />
  )
)
Card.displayName = "Card"

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("avs-card-header", className)} {...props} />
)
CardHeader.displayName = "CardHeader"

export const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, children, ...props }, ref) => (
    <h3 ref={ref} className={cn("avs-card-title", className)} {...props}>
      <AnimatedText>{children}</AnimatedText>
    </h3>
  )
)
CardTitle.displayName = "CardTitle"

export const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, children, ...props }, ref) => (
    <p ref={ref} className={cn("avs-card-description", className)} {...props}>
      <AnimatedText>{children}</AnimatedText>
    </p>
  )
)
CardDescription.displayName = "CardDescription"

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("avs-card-content", className)} {...props} />
)
CardContent.displayName = "CardContent"
