type ViteHotContext = {
  on: (event: string, callback: () => void) => void
}

type ImportMetaWithHot = ImportMeta & {
  hot?: ViteHotContext
}

export type ShowHmrTransitionOptions = {
  beforeMs?: number
  afterMs?: number
  typewriter?: boolean
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
  const afterMs = options.afterMs ?? 820
  const typewriter = options.typewriter ?? true
  let beforeTimer: number | undefined
  let afterTimer: number | undefined
  let textSnapshot = new Map<string, string>()

  hot.on("vite:beforeUpdate", () => {
    window.clearTimeout(beforeTimer)
    window.clearTimeout(afterTimer)
    textSnapshot = snapshotTextNodes()
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
    if (typewriter) {
      window.requestAnimationFrame(() => animateChangedText(textSnapshot))
    }
    afterTimer = window.setTimeout(() => {
      document.documentElement.classList.remove("avs-hmr-updated")
    }, afterMs)
  })
}

function snapshotTextNodes() {
  const snapshot = new Map<string, string>()
  for (const node of collectTextNodes()) {
    snapshot.set(textNodePath(node), node.nodeValue || "")
  }
  return snapshot
}

function animateChangedText(before: Map<string, string>) {
  for (const node of collectTextNodes()) {
    const key = textNodePath(node)
    const previous = before.get(key)
    const next = node.nodeValue || ""
    if (!shouldAnimateText(previous, next)) continue
    typeTextNode(node, next)
  }
}

function collectTextNodes() {
  const root = document.getElementById("root") || document.body
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || !node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT
      if (isUnsafeTextContainer(parent)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  const nodes: Text[] = []
  let current = walker.nextNode()
  while (current) {
    nodes.push(current as Text)
    current = walker.nextNode()
  }
  return nodes
}

function isUnsafeTextContainer(element: Element) {
  return Boolean(
    element.closest(
      "script,style,noscript,textarea,input,select,option,button,pre,code,kbd,samp,svg,canvas,[contenteditable=true],[data-avs-no-typewriter]"
    )
  )
}

function shouldAnimateText(previous: string | undefined, next: string) {
  const trimmed = next.trim()
  if (!trimmed || previous === undefined || previous === next) return false
  if (trimmed.length < 3 || trimmed.length > 180) return false
  return /[A-Za-z0-9\u4e00-\u9fff]/.test(trimmed)
}

function typeTextNode(node: Text, text: string) {
  const leading = text.match(/^\s*/)?.[0] || ""
  const trailing = text.match(/\s*$/)?.[0] || ""
  const core = text.slice(leading.length, text.length - trailing.length)
  node.nodeValue = leading
  let index = 0
  const step = Math.max(1, Math.ceil(core.length / 42))
  const tick = () => {
    index = Math.min(core.length, index + step)
    node.nodeValue = `${leading}${core.slice(0, index)}${index >= core.length ? trailing : ""}`
    if (index < core.length) {
      window.setTimeout(tick, 16)
    }
  }
  tick()
}

function textNodePath(node: Text) {
  const parts: number[] = []
  let current: Node | null = node
  while (current && current.parentNode && current !== document.body) {
    const parent: Node = current.parentNode
    parts.push(Array.prototype.indexOf.call(parent.childNodes, current))
    current = parent
  }
  return parts.reverse().join(".")
}
