import type { Plugin } from "vite"
import { fallbackRecoveryCss, injectFallbackRecovery } from "./fallback-recovery.js"

const clientModuleId = "virtual:avibe-show-hmr-transition-client"
const resolvedClientModuleId = `\0${clientModuleId}`

export function showHmrTransitionPlugin(): Plugin {
  return {
    name: "avibe-show-hmr-transition",
    apply: "serve",
    resolveId(id) {
      if (id === clientModuleId) return resolvedClientModuleId
      return null
    },
    load(id) {
      if (id === resolvedClientModuleId) return hmrTransitionScript()
      return null
    },
    transformIndexHtml(html) {
      return {
        html: injectFallbackRecovery(html),
        tags: [
        {
          tag: "style",
          children: `${fallbackRecoveryCss()}\n${hmrTransitionCss()}`,
          injectTo: "head"
        },
        {
          tag: "script",
          attrs: {
            type: "module",
            src: `./@id/__x00__${clientModuleId}`
          },
          injectTo: "head"
        }
        ]
      }
    }
  }
}

function hmrTransitionCss() {
  return `
html.avs-hmr-debug.avs-hmr-updating body {
  opacity: 0.9;
  transform: translateY(3px);
  transition: opacity 0.16s ease, filter 0.16s ease, transform 0.16s ease;
}

html.avs-hmr-debug.avs-hmr-updated body {
  animation: avs-runtime-hmr-updated 0.28s cubic-bezier(.2,.8,.2,1) both;
}

@keyframes avs-runtime-hmr-updated {
  from {
    opacity: 0.9;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  html.avs-hmr-updating body,
  html.avs-hmr-updated body {
    opacity: 1;
    filter: none;
    transform: none;
    transition: none;
    animation: none;
  }
}
`
}

function hmrTransitionScript() {
  return `
const hot = import.meta.hot;
let overlayTimer;
const debugEnabled =
  typeof window !== "undefined" &&
  (new URLSearchParams(window.location.search).has("avibe_hmr_debug") ||
    window.localStorage.getItem("avibe:hmr-debug") === "1");

if (hot && typeof window !== "undefined" && typeof document !== "undefined" && !window.__avibeShowHmrTransitionsInstalled) {
  window.__avibeShowHmrTransitionsInstalled = true;
  let beforeTimer;
  let afterTimer;
  if (debugEnabled) document.documentElement.classList.add("avs-hmr-debug");

  showDebug("HMR ready");

  hot.on("vite:beforeUpdate", () => {
    if (!debugEnabled) return;
    clearTimeout(beforeTimer);
    clearTimeout(afterTimer);
    showDebug("beforeUpdate");
    document.documentElement.classList.remove("avs-hmr-updated");
    document.documentElement.classList.add("avs-hmr-updating");
    beforeTimer = setTimeout(() => {
      document.documentElement.classList.remove("avs-hmr-updating");
    }, 180);
  });

  hot.on("vite:afterUpdate", () => {
    if (!debugEnabled) return;
    clearTimeout(beforeTimer);
    clearTimeout(afterTimer);
    document.documentElement.classList.remove("avs-hmr-updating");
    document.documentElement.classList.add("avs-hmr-updated");
    showDebug("afterUpdate");
    afterTimer = setTimeout(() => {
      document.documentElement.classList.remove("avs-hmr-updated");
    }, 1100);
  });
}

function showDebug(message) {
  if (!debugEnabled) return;
  clearTimeout(overlayTimer);
  let overlay = document.getElementById("avs-hmr-debug-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "avs-hmr-debug-overlay";
    overlay.style.cssText = [
      "position:fixed",
      "right:16px",
      "top:16px",
      "z-index:2147483647",
      "padding:12px 14px",
      "border-radius:12px",
      "background:#0f172a",
      "color:white",
      "font:700 13px/1.35 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "box-shadow:0 18px 50px rgba(15,23,42,.28)",
      "max-width:min(360px,calc(100vw - 32px))"
    ].join(";");
    document.body.appendChild(overlay);
  }
  overlay.textContent = "AVIBE " + message;
  overlayTimer = setTimeout(() => {
    overlay?.remove();
  }, 2400);
}

`
}
