type ViteHotContext = {
  on: (event: string, callback: () => void) => void
}

type ImportMetaWithHot = ImportMeta & {
  hot?: ViteHotContext
}

export type ShowHmrTransitionOptions = {
  beforeMs?: number
  afterMs?: number
}

declare global {
  interface Window {
    __avibeShowHmrTransitionsInstalled?: boolean
  }
}

export function installShowHmrTransitions(options: ShowHmrTransitionOptions = {}) {
  if (typeof window === "undefined" || typeof document === "undefined") return
  if (window.__avibeShowHmrTransitionsInstalled) return
  const hot = (import.meta as ImportMetaWithHot).hot
  if (!hot) return

  window.__avibeShowHmrTransitionsInstalled = true
  const beforeMs = options.beforeMs ?? 180
  const afterMs = options.afterMs ?? 520
  let beforeTimer: number | undefined
  let afterTimer: number | undefined

  hot.on("vite:beforeUpdate", () => {
    window.clearTimeout(beforeTimer)
    window.clearTimeout(afterTimer)
    document.documentElement.classList.remove("avs-hmr-updated")
    document.documentElement.classList.add("avs-hmr-updating")
    beforeTimer = window.setTimeout(() => {
      document.documentElement.classList.remove("avs-hmr-updating")
    }, beforeMs)
  })

  hot.on("vite:afterUpdate", () => {
    window.clearTimeout(beforeTimer)
    window.clearTimeout(afterTimer)
    document.documentElement.classList.remove("avs-hmr-updating")
    document.documentElement.classList.add("avs-hmr-updated")
    afterTimer = window.setTimeout(() => {
      document.documentElement.classList.remove("avs-hmr-updated")
    }, afterMs)
  })
}
