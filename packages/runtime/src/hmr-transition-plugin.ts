import type { Plugin } from "vite"

export function showHmrTransitionPlugin(): Plugin {
  return {
    name: "avibe-show-hmr-transition",
    apply: "serve",
    transformIndexHtml() {
      return [
        {
          tag: "style",
          children: hmrTransitionCss(),
          injectTo: "head"
        },
        {
          tag: "script",
          attrs: { type: "module" },
          children: hmrTransitionScript(),
          injectTo: "head"
        }
      ]
    }
  }
}

function hmrTransitionCss() {
  return `
html.avs-hmr-updating body {
  opacity: 0.45;
  filter: blur(5px) saturate(1.2) brightness(1.05);
  transform: translateY(14px) scale(0.985);
  transition: opacity 0.16s ease, filter 0.16s ease, transform 0.16s ease;
}

html.avs-hmr-updated body {
  animation: avs-runtime-hmr-updated 1.1s cubic-bezier(.18,.9,.25,1) both;
}

@keyframes avs-runtime-hmr-updated {
  from {
    opacity: 0.42;
    filter: blur(10px) saturate(1.24) brightness(1.08);
    transform: translateY(24px) scale(0.975);
  }
  45% {
    opacity: 1;
    filter: blur(0) saturate(1.08) brightness(1.02);
    transform: translateY(-4px) scale(1.004);
  }
  to {
    opacity: 1;
    filter: blur(0) saturate(1) brightness(1);
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

  hot.on("vite:beforeUpdate", () => {
    clearTimeout(beforeTimer);
    clearTimeout(afterTimer);
    textSnapshot = snapshotTextNodes();
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
    requestAnimationFrame(() => {
      requestAnimationFrame(() => animateChangedText(textSnapshot));
    });
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

function animateChangedText(before) {
  for (const node of collectTextNodes()) {
    const key = textNodePath(node);
    const previous = before.get(key);
    const next = node.nodeValue || "";
    if (!shouldAnimateText(previous, next)) continue;
    typeTextNode(node, next);
  }
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
