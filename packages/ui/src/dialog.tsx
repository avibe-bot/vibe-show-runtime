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
  style: React.CSSProperties & Record<string, string>
}

type PortalThemeSource = {
  context: HTMLElement
  tokens: HTMLElement
}

function readPortalTheme(source: PortalThemeSource): PortalThemeSnapshot {
  const computed = getComputedStyle(source.tokens)
  const context = source.context === source.tokens ? computed : getComputedStyle(source.context)
  const style = {} as React.CSSProperties & Record<string, string>
  const values = PORTAL_THEME_TOKENS.map((token) => {
    const value = computed.getPropertyValue(token).trim()
    if (value) style[token] = value
    return value
  })
  if (context.colorScheme) style.colorScheme = context.colorScheme
  if (context.color) style.color = context.color
  if (context.fontSize) style.fontSize = context.fontSize
  const dark = Boolean(source.tokens.closest('.dark, [data-theme="dark"]'))
  return {
    dark,
    signature: `${dark}|${context.colorScheme}|${context.color}|${context.fontSize}|${values.join("|")}`,
    style
  }
}

function collectMediaQueries(rules: CSSRuleList, queries: Set<string>) {
  for (const rule of Array.from(rules)) {
    if (rule.type === CSSRule.MEDIA_RULE) queries.add((rule as CSSMediaRule).conditionText)
    const nested = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules
    if (nested) collectMediaQueries(nested, queries)
  }
}

function subscribeToMediaChanges(update: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined
  const queries = new Set([
    "(prefers-color-scheme: dark)",
    "(prefers-contrast: more)",
    "(forced-colors: active)"
  ])
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collectMediaQueries(sheet.cssRules, queries)
    } catch {
      // Cross-origin stylesheets are opaque; their media attribute is observed separately.
    }
  }
  const media = Array.from(queries, (query) => window.matchMedia(query))
  for (const item of media) item.addEventListener("change", update)
  return () => {
    for (const item of media) item.removeEventListener("change", update)
  }
}

function PortalThemeBridge({
  getSource,
  children
}: {
  getSource: () => PortalThemeSource
  children: React.ReactNode
}) {
  const [theme, setTheme] = React.useState<PortalThemeSnapshot>()

  React.useLayoutEffect(() => {
    let source = getSource()
    const ancestorObserver = new MutationObserver(() => update())
    const observeSource = () => {
      ancestorObserver.disconnect()
      const observed = new Set<HTMLElement>()
      for (const origin of [source.tokens, source.context]) {
        for (let element: HTMLElement | null = origin; element; element = element.parentElement) {
          if (observed.has(element)) continue
          observed.add(element)
          ancestorObserver.observe(element, { attributes: true, childList: true })
        }
      }
    }
    const update = () => {
      const nextSource = getSource()
      if (nextSource.tokens !== source.tokens || nextSource.context !== source.context) {
        source = nextSource
        observeSource()
      }
      const next = readPortalTheme(source)
      setTheme((current) => current?.signature === next.signature ? current : next)
    }
    observeSource()
    update()

    let stopMediaChanges = subscribeToMediaChanges(update)
    const refreshStylesheets = () => {
      update()
      stopMediaChanges()
      stopMediaChanges = subscribeToMediaChanges(update)
    }
    const stylesheetObserver = new MutationObserver(refreshStylesheets)
    stylesheetObserver.observe(document.head, {
      attributes: true,
      attributeFilter: ["href", "media", "disabled"],
      characterData: true,
      childList: true,
      subtree: true
    })
    const handleLoad = (event: Event) => {
      const target = event.target
      if (target instanceof HTMLLinkElement && target.relList.contains("stylesheet")) refreshStylesheets()
    }
    document.addEventListener("load", handleLoad, true)
    const interactionEvents = ["pointerover", "pointerout", "pointerdown", "pointerup", "focusin", "focusout", "input", "change", "toggle"]
    for (const event of interactionEvents) document.addEventListener(event, update, true)
    window.addEventListener("hashchange", update)
    window.addEventListener("resize", update)

    return () => {
      ancestorObserver.disconnect()
      stylesheetObserver.disconnect()
      stopMediaChanges()
      document.removeEventListener("load", handleLoad, true)
      for (const event of interactionEvents) document.removeEventListener(event, update, true)
      window.removeEventListener("hashchange", update)
      window.removeEventListener("resize", update)
    }
  }, [getSource])

  return (
    <div
      data-theme={theme?.dark ? "dark" : undefined}
      style={{ display: "contents", visibility: theme ? undefined : "hidden", ...theme?.style }}
    >
      {children}
    </div>
  )
}

type DialogScope = {
  activeTrigger: React.RefObject<HTMLElement | null>
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

export function Dialog(props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  const activeTrigger = React.useRef<HTMLElement>(null)
  const triggers = React.useRef(new Set<HTMLElement>()).current
  const scope = React.useMemo(() => ({ activeTrigger, triggers }), [triggers])
  return (
    <DialogScopeContext.Provider value={scope}>
      <DialogPrimitive.Root {...props} />
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
    if (!event.defaultPrevented && localRef.current && scope) scope.activeTrigger.current = localRef.current
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
  const getSource = React.useCallback(
    (): PortalThemeSource => {
      const fallback = themeScope?.current ?? document.documentElement
      const trigger = activeDialogTrigger(triggerScope)
      return trigger
        ? { tokens: trigger, context: trigger.parentElement ?? fallback }
        : { tokens: fallback, context: fallback }
    },
    [themeScope, triggerScope]
  )

  return (
    <DialogPortal>
      <PortalThemeBridge getSource={getSource}>
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
