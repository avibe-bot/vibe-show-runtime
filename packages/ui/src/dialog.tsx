import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { cn } from "./utils"

// Radix portals escape scoped inheritance; copy the source theme onto a contents-only bridge.
const PORTAL_THEME_TOKENS = [
  "--radius", "--background", "--foreground", "--card", "--card-foreground",
  "--popover", "--popover-foreground", "--primary", "--primary-foreground",
  "--secondary", "--secondary-foreground", "--muted", "--muted-foreground",
  "--accent", "--accent-foreground", "--destructive", "--destructive-foreground",
  "--border", "--input", "--ring", "--chart-1", "--chart-2", "--chart-3",
  "--chart-4", "--chart-5", "--sidebar", "--sidebar-foreground",
  "--sidebar-primary", "--sidebar-primary-foreground", "--sidebar-accent",
  "--sidebar-accent-foreground", "--sidebar-border", "--sidebar-ring", "--success",
  "--success-foreground", "--warning", "--warning-foreground", "--avs-radius",
  "--avs-background", "--avs-foreground", "--avs-muted", "--avs-muted-foreground",
  "--avs-border", "--avs-primary", "--avs-primary-foreground", "--avs-ring",
  "--avs-success", "--avs-warning", "--avs-destructive"
] as const

type PortalThemeSnapshot = {
  dark: boolean
  signature: string
  style: React.CSSProperties & Record<string, string>
}

function readPortalTheme(source: HTMLElement): PortalThemeSnapshot {
  const computed = getComputedStyle(source)
  const style = {} as React.CSSProperties & Record<string, string>
  const values = PORTAL_THEME_TOKENS.map((token) => {
    const value = computed.getPropertyValue(token).trim()
    if (value) style[token] = value
    return value
  })
  if (computed.colorScheme) style.colorScheme = computed.colorScheme
  const dark = Boolean(source.closest('.dark, [data-theme="dark"]'))
  return { dark, signature: `${dark}|${computed.colorScheme}|${values.join("|")}`, style }
}

function PortalThemeBridge({
  source,
  children
}: {
  source: React.RefObject<HTMLSpanElement | null>
  children: React.ReactNode
}) {
  const [theme, setTheme] = React.useState<PortalThemeSnapshot>()

  React.useLayoutEffect(() => {
    const marker = source.current
    if (!marker) return
    const update = () => {
      const next = readPortalTheme(marker)
      setTheme((current) => current?.signature === next.signature ? current : next)
    }
    update()

    const ancestorObserver = new MutationObserver(update)
    for (let element = marker.parentElement; element; element = element.parentElement) {
      ancestorObserver.observe(element, { attributes: true })
    }

    const stylesheetObserver = new MutationObserver(update)
    stylesheetObserver.observe(document.head, {
      attributes: true,
      attributeFilter: ["href", "media", "disabled"],
      characterData: true,
      childList: true,
      subtree: true
    })
    document.addEventListener("load", update, true)

    return () => {
      ancestorObserver.disconnect()
      stylesheetObserver.disconnect()
      document.removeEventListener("load", update, true)
    }
  }, [source])

  return (
    <div
      data-theme={theme?.dark ? "dark" : undefined}
      style={{ display: "contents", visibility: theme ? undefined : "hidden", ...theme?.style }}
    >
      {children}
    </div>
  )
}

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogPortal = DialogPrimitive.Portal
export const DialogClose = DialogPrimitive.Close

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const markerRef = React.useRef<HTMLSpanElement>(null)

  return (
    <>
      <span ref={markerRef} aria-hidden="true" style={{ display: "none" }} />
      <DialogPortal>
        <PortalThemeBridge source={markerRef}>
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
        </PortalThemeBridge>
      </DialogPortal>
    </>
  )
})
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
