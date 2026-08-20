import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { cn } from "./utils"

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogPortal = DialogPrimitive.Portal
export const DialogClose = DialogPrimitive.Close

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgb(17_24_39/45%)] animate-[avs-fade-in_0.16s_ease_both] motion-reduce:animate-none" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-[41] w-[min(32.5rem,calc(100%-1.75rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-[1.125rem] shadow-[0_24px_80px_rgb(17_24_39/22%)] outline-none animate-[avs-dialog-in_0.2s_cubic-bezier(0.2,0.8,0.2,1)_both] motion-reduce:animate-none max-[540px]:inset-x-0 max-[540px]:bottom-0 max-[540px]:top-auto max-[540px]:w-full max-[540px]:translate-x-0 max-[540px]:translate-y-0 max-[540px]:rounded-b-none max-[540px]:rounded-t-[1.125rem] max-[540px]:animate-[avs-dialog-in-sheet_0.24s_ease_both]",
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-3 top-3 grid size-8 cursor-pointer place-items-center rounded-md border border-border bg-background text-foreground">
        <X size={16} />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = "DialogContent"

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("pr-9", className)} {...props} />
)

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("m-0 text-lg text-foreground", className)} {...props} />
))
DialogTitle.displayName = "DialogTitle"

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("mt-2 leading-relaxed text-muted-foreground", className)} {...props} />
))
DialogDescription.displayName = "DialogDescription"
