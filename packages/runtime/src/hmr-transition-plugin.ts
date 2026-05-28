import type { Plugin } from "vite"

export function showHmrTransitionPlugin(): Plugin {
  return {
    name: "avibe-show-hmr-transition",
    apply: "serve",
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { type: "module" },
          children: `import { installShowHmrTransitions } from "@avibe/show-ui/hmr-transition"; installShowHmrTransitions();`,
          injectTo: "head"
        }
      ]
    }
  }
}
