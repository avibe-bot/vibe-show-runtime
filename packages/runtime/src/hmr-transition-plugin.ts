import type { Plugin } from "vite"

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
    transformIndexHtml() {
      return [
        {
          tag: "style",
          children: hmrTransitionCss(),
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
if (hot && typeof window !== "undefined" && typeof document !== "undefined" && !window.__avibeShowHmrTransitionsInstalled) {
  window.__avibeShowHmrTransitionsInstalled = true;
  let beforeTimer;
  let afterTimer;
  let textSnapshot = new Map();
  let overlayTimer;
  const debugEnabled = new URLSearchParams(window.location.search).has("avibe_hmr_debug") || window.localStorage.getItem("avibe:hmr-debug") === "1";
  if (debugEnabled) document.documentElement.classList.add("avs-hmr-debug");

  showDebug("HMR ready");

  hot.on("vite:beforeUpdate", () => {
    clearTimeout(beforeTimer);
    clearTimeout(afterTimer);
    textSnapshot = snapshotTextNodes();
    showDebug("beforeUpdate: " + textSnapshot.size + " text nodes");
    document.documentElement.classList.remove("avs-hmr-updated");
    document.documentElement.classList.add("avs-hmr-updating");
    beforeTimer = setTimeout(() => {
      document.documentElement.classList.remove("avs-hmr-updating");
    }, 180);
  });

  hot.on("vite:afterUpdate", () => {
    clearTimeout(beforeTimer);
    clearTimeout(afterTimer);
    document.documentElement.classList.remove("avs-hmr-updating");
    document.documentElement.classList.add("avs-hmr-updated");
    requestAnimationFrame(() => requestAnimationFrame(() => animateChangedText(textSnapshot, "afterUpdate")));
    setTimeout(() => animateChangedText(textSnapshot, "afterUpdate+80ms"), 80);
    setTimeout(() => animateChangedText(textSnapshot, "afterUpdate+220ms"), 220);
    afterTimer = setTimeout(() => {
      document.documentElement.classList.remove("avs-hmr-updated");
    }, 1100);
  });
}

function snapshotTextNodes() {
  const snapshot = new Map();
  for (const node of collectTextNodes()) {
    snapshot.set(textNodePath(node), node.nodeValue || "");
  }
  return snapshot;
}

function animateChangedText(before, label) {
  let animated = 0;
  for (const node of collectTextNodes()) {
    const key = textNodePath(node);
    const previous = before.get(key);
    const next = node.nodeValue || "";
    if (!shouldAnimateText(previous, next)) continue;
    animated += 1;
    typeTextNode(node, next);
  }
  showDebug(label + ": typed " + animated);
}

function collectTextNodes() {
  const root = document.getElementById("root") || document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (isUnsafeTextContainer(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current);
    current = walker.nextNode();
  }
  return nodes;
}

function isUnsafeTextContainer(element) {
  return Boolean(element.closest("script,style,noscript,textarea,input,select,option,button,pre,code,kbd,samp,svg,canvas,[contenteditable=true],[data-avs-no-typewriter]"));
}

function shouldAnimateText(previous, next) {
  const trimmed = next.trim();
  if (!trimmed || previous === undefined || previous === next) return false;
  if (trimmed.length < 3 || trimmed.length > 220) return false;
  return /[A-Za-z0-9\\u4e00-\\u9fff]/.test(trimmed);
}

function typeTextNode(node, text) {
  const leading = (text.match(/^\\s*/) || [""])[0];
  const trailing = (text.match(/\\s*$/) || [""])[0];
  const core = text.slice(leading.length, text.length - trailing.length);
  node.nodeValue = leading;
  let index = 0;
  const step = Math.max(1, Math.ceil(core.length / 56));
  const tick = () => {
    index = Math.min(core.length, index + step);
    node.nodeValue = leading + core.slice(0, index) + (index >= core.length ? trailing : "");
    if (index < core.length) setTimeout(tick, 18);
  };
  tick();
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

function textNodePath(node) {
  const parts = [];
  let current = node;
  while (current && current.parentNode && current !== document.body) {
    const parent = current.parentNode;
    parts.push(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  return parts.reverse().join(".");
}
`
}
