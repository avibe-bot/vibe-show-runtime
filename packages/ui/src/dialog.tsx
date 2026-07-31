import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { useComposedRefs } from "@radix-ui/react-compose-refs"
import { X } from "lucide-react"
import { ThemeScopeContext } from "./theme-context"
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
  properties: Record<string, string>
}

type PortalThemeSource = {
  context: Element
  tokens: HTMLElement
}

function readPortalTheme(source: PortalThemeSource): PortalThemeSnapshot {
  const computed = getComputedStyle(source.tokens)
  const context = source.context === source.tokens ? computed : getComputedStyle(source.context)
  const properties: Record<string, string> = {}
  const values = PORTAL_THEME_TOKENS.map((token) => {
    const value = computed.getPropertyValue(token)
    properties[token] = value || " "
    return value
  })
  for (const [property, value] of [
    ["color-scheme", computed.colorScheme], ["color", context.color],
    ["font-family", context.fontFamily], ["font-size", context.fontSize],
    ["font-stretch", context.fontStretch], ["font-style", context.fontStyle],
    ["font-variant", context.fontVariant], ["font-weight", context.fontWeight],
    ["line-height", context.lineHeight]
  ]) {
    if (value) properties[property] = value
  }
  const dark = hasComposedDarkTheme(source.tokens)
  return {
    dark,
    signature: JSON.stringify([
      dark, computed.colorScheme, context.color, context.fontFamily, context.fontSize,
      context.fontStretch, context.fontStyle, context.fontVariant, context.fontWeight,
      context.lineHeight, ...values
    ]),
    properties
  }
}

function composedParentNode(node: Node): Node | null {
  if (node instanceof Element) {
    if (node.assignedSlot) return node.assignedSlot
    if (node.parentElement) return node.parentElement
    const root = node.getRootNode()
    if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) return root
  }
  return typeof ShadowRoot !== "undefined" && node instanceof ShadowRoot ? node.host : null
}

function composedParentElement(node: Node): Element | null {
  for (let parent = composedParentNode(node); parent; parent = composedParentNode(parent)) {
    if (parent instanceof Element) return parent
  }
  return null
}

function hasComposedDarkTheme(element: Element): boolean {
  for (let node: Node | null = element; node; node = composedParentNode(node)) {
    if (node instanceof Element
      && (node.classList.contains("dark")
        || node.classList.contains("avs-dark")
        || node.getAttribute("data-theme") === "dark")) {
      return true
    }
  }
  return false
}

function PortalThemeBridge({
  getTheme,
  children
}: {
  getTheme: () => PortalThemeSnapshot
  children: React.ReactNode
}) {
  const [theme, setTheme] = React.useState<PortalThemeSnapshot>()
  const bridgeRef = React.useRef<HTMLDivElement>(null)
  const copiedProperties = React.useRef<string[]>([])

  React.useLayoutEffect(() => {
    let frame = 0
    let signature = ""
    const update = () => {
      const next = getTheme()
      if (next.signature !== signature) {
        signature = next.signature
        setTheme(next)
      }
      frame = window.requestAnimationFrame(update)
    }
    update()
    return () => window.cancelAnimationFrame(frame)
  }, [getTheme])

  React.useLayoutEffect(() => {
    const bridge = bridgeRef.current
    if (!bridge) return
    for (const property of copiedProperties.current) bridge.style.removeProperty(property)
    copiedProperties.current = []
    if (!theme) return
    for (const [property, value] of Object.entries(theme.properties)) {
      bridge.style.setProperty(property, value, "important")
      copiedProperties.current.push(property)
    }
  }, [theme])

  return (
    <div
      ref={bridgeRef}
      data-theme={theme?.dark ? "dark" : undefined}
      style={{ display: "contents", visibility: theme ? undefined : "hidden" }}
    >
      {children}
    </div>
  )
}

type DialogScope = {
  activeTrigger: React.RefObject<HTMLElement | null>
  openingTheme: React.RefObject<PortalThemeSnapshot | null>
  triggers: Set<HTMLElement>
}

const DialogScopeContext = React.createContext<DialogScope | null>(null)

function activeDialogTrigger(scope: DialogScope | null): HTMLElement | null {
  const active = scope?.activeTrigger.current
  if (active?.isConnected) return active
  let only: HTMLElement | null = null
  for (const trigger of scope?.triggers ?? []) {
    if (!trigger.isConnected) continue
    if (only) return null
    only = trigger
  }
  return only
}

export function Dialog({
  onOpenChange,
  open,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  const activeTrigger = React.useRef<HTMLElement>(null)
  const openingTheme = React.useRef<PortalThemeSnapshot>(null)
  const triggers = React.useRef(new Set<HTMLElement>()).current
  const controlledOpen = React.useRef(open)
  controlledOpen.current = open
  const scope = React.useMemo(() => ({ activeTrigger, openingTheme, triggers }), [triggers])
  const clearOpeningTheme = React.useCallback(() => {
    activeTrigger.current = null
    openingTheme.current = null
  }, [])
  React.useEffect(() => {
    if (open === false) clearOpeningTheme()
  }, [clearOpeningTheme, open])
  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (!nextOpen && open === undefined) clearOpeningTheme()
    onOpenChange?.(nextOpen)
    if (nextOpen && open === false) {
      queueMicrotask(() => {
        if (controlledOpen.current === false) clearOpeningTheme()
      })
    }
  }, [clearOpeningTheme, onOpenChange, open])
  return (
    <DialogScopeContext.Provider value={scope}>
      <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange} {...props} />
    </DialogScopeContext.Provider>
  )
}

export const DialogTrigger = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>(({ onClick, ...props }, forwardedRef) => {
  const scope = React.useContext(DialogScopeContext)
  const localRef = React.useRef<HTMLElement>(null)
  const setLocalRef = React.useCallback((node: HTMLElement | null) => {
    const previous = localRef.current
    const wasActive = scope?.activeTrigger.current === previous
    if (previous) scope?.triggers.delete(previous)
    localRef.current = node
    if (node) scope?.triggers.add(node)
    if (wasActive && scope) scope.activeTrigger.current = node
  }, [scope])
  const ref = useComposedRefs(forwardedRef, setLocalRef)
  const handleClick: NonNullable<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>["onClick"]> = (event) => {
    onClick?.(event)
    if (!event.defaultPrevented && localRef.current && scope) {
      const trigger = localRef.current
      const fallback = document.documentElement
      scope.activeTrigger.current = trigger
      scope.openingTheme.current = readPortalTheme({
        tokens: trigger,
        context: composedParentElement(trigger) ?? fallback
      })
    }
  }
  return <DialogPrimitive.Trigger ref={ref} onClick={handleClick} {...props} />
})
DialogTrigger.displayName = "DialogTrigger"

export const DialogPortal = DialogPrimitive.Portal
export const DialogClose = DialogPrimitive.Close

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const themeScope = React.useContext(ThemeScopeContext)
  const triggerScope = React.useContext(DialogScopeContext)
  const getTheme = React.useCallback(
    (): PortalThemeSnapshot => {
      const fallback = themeScope?.current ?? document.documentElement
      const active = triggerScope?.activeTrigger.current
      const opening = triggerScope?.openingTheme.current
      if (!active?.isConnected && opening) return opening
      const trigger = activeDialogTrigger(triggerScope)
      const source = trigger
        ? { tokens: trigger, context: composedParentElement(trigger) ?? fallback }
        : { tokens: fallback, context: fallback }
      const theme = readPortalTheme(source)
      if (trigger && triggerScope) triggerScope.openingTheme.current = theme
      return theme
    },
    [themeScope, triggerScope]
  )

  return (
    <DialogPortal>
      <PortalThemeBridge getTheme={getTheme}>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgb(17_24_39/45%)] animate-[avs-fade-in_0.16s_ease_both] motion-reduce:animate-none" />
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            "fixed left-1/2 top-1/2 z-[41] w-[min(32.5rem,calc(100%-1.75rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-[1.125rem] text-foreground shadow-[0_24px_80px_rgb(17_24_39/22%)] outline-none animate-[avs-dialog-in_0.2s_cubic-bezier(0.2,0.8,0.2,1)_both] motion-reduce:animate-none max-[540px]:inset-x-0 max-[540px]:bottom-0 max-[540px]:top-auto max-[540px]:w-full max-[540px]:translate-x-0 max-[540px]:translate-y-0 max-[540px]:rounded-b-none max-[540px]:rounded-t-[1.125rem] max-[540px]:animate-[avs-dialog-in-sheet_0.24s_ease_both]",
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
