export const DEFAULT_FALLBACK_DELAY_SECONDS = 5
const ROOT_ELEMENT_PATTERN = /(<div\b(?=[^>]*\bid\s*=\s*(["'])root\2)[^>]*>\s*<\/div>)/i
const AVS_FALLBACK_PATTERN = /\bclass\s*=\s*(["'])[^"']*\bavs-fallback(?=\s|["'])[^"']*\1/i

export function fallbackRecoveryCss(delaySeconds = DEFAULT_FALLBACK_DELAY_SECONDS) {
  return `
#root:not(:empty) + .avs-fallback-shell {
  display: none;
}

.avs-fallback-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px 18px;
  box-sizing: border-box;
  position: relative;
}

.avs-fallback-shell::before {
  content: "";
  position: fixed;
  left: 50%;
  top: calc(50% - 28px);
  width: 42px;
  height: 42px;
  margin: -21px 0 0 -21px;
  border-radius: 999px;
  border: 3px solid rgba(82, 96, 120, 0.18);
  border-top-color: #0f172a;
  box-sizing: border-box;
  animation:
    avs-show-fallback-spinner 0.8s linear infinite,
    avs-show-fallback-loading-out 0.18s ease ${delaySeconds}s forwards;
}

.avs-fallback-shell::after {
  content: "Loading Show Page";
  position: fixed;
  left: 50%;
  top: calc(50% + 28px);
  transform: translateX(-50%);
  color: #526078;
  font: 760 13px/1.2 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  animation: avs-show-fallback-loading-out 0.18s ease ${delaySeconds}s forwards;
}

.avs-fallback {
  width: min(860px, 100%);
  border: 1px solid rgba(23, 32, 51, 0.12);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.92);
  padding: clamp(24px, 5vw, 44px);
  box-shadow: 0 24px 80px rgba(23, 32, 51, 0.10);
  box-sizing: border-box;
  opacity: 0;
  visibility: hidden;
  transform: translateY(6px);
  animation: avs-show-fallback-recovery-in 0.22s ease ${delaySeconds}s forwards;
}

.avs-fallback-eyebrow {
  color: #526078;
  font-size: 13px;
  font-weight: 760;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.avs-fallback h1 {
  margin: 12px 0 0;
  font-size: clamp(32px, 7vw, 56px);
  line-height: 1;
  letter-spacing: 0;
}

.avs-fallback p {
  max-width: 720px;
  line-height: 1.65;
  margin: 12px 0 0;
  color: #526078;
}

.avs-fallback-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 0.8fr);
  gap: 18px;
  margin-top: 24px;
}

.avs-fallback-panel {
  border: 1px solid rgba(23, 32, 51, 0.10);
  border-radius: 14px;
  background: #fff;
  padding: 16px;
}

.avs-fallback-panel h2 {
  margin: 0 0 10px;
  font-size: 15px;
}

.avs-fallback-panel ul {
  margin: 0;
  padding-left: 18px;
  color: #526078;
  line-height: 1.7;
}

.avs-fallback textarea {
  width: 100%;
  min-height: 178px;
  resize: vertical;
  border: 1px solid rgba(23, 32, 51, 0.14);
  border-radius: 12px;
  padding: 12px;
  box-sizing: border-box;
  font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  color: #172033;
  background: #f8fafc;
}

.avs-copy-button {
  margin-top: 10px;
  height: 36px;
  border: 0;
  border-radius: 10px;
  padding: 0 14px;
  background: #0f172a;
  color: #fff;
  font: 700 14px/1 Inter, ui-sans-serif, system-ui;
  cursor: pointer;
}

.avs-fallback code {
  background: rgba(82, 96, 120, 0.12);
  border-radius: 6px;
  padding: 2px 6px;
}

@keyframes avs-show-fallback-spinner {
  to {
    transform: rotate(360deg);
  }
}

@keyframes avs-show-fallback-loading-out {
  to {
    opacity: 0;
    visibility: hidden;
  }
}

@keyframes avs-show-fallback-recovery-in {
  to {
    opacity: 1;
    visibility: visible;
    transform: translateY(0);
  }
}

@media (max-width: 760px) {
  .avs-fallback-grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .avs-fallback-shell::before {
    animation: avs-show-fallback-loading-out 0.18s ease ${delaySeconds}s forwards;
  }

  .avs-fallback {
    transform: none;
  }
}
`
}

export function fallbackRecoveryHtml() {
  return `<section class="avs-fallback-shell">
      <main class="avs-fallback">
        <div class="avs-fallback-eyebrow">Vibe Show recovery</div>
        <h1>Ready to visualize</h1>
        <p>The React app has not mounted yet. This can happen during first-load dependency optimization, before the agent writes the page, or when <code>src/App.tsx</code> has a compile/runtime error.</p>
        <div class="avs-fallback-grid">
          <div class="avs-fallback-panel">
            <h2>Ask your agent to fix the Show Page</h2>
            <textarea id="avs-agent-prompt" readonly>Please repair this Vibe Remote Show Page. Open the Show Page workspace, read the local Show Page/runtime instructions, then replace src/App.tsx with a polished React page. Use the shadcn-style components from @/components/ui and @avibe/show-ui. Do not edit index.html unless it is required. If the browser shows Ready to visualize, check src/App.tsx, src/main.tsx, src/styles.css, and the Vite/browser console for compile or runtime errors. Make the page responsive and verify it renders.</textarea>
            <button class="avs-copy-button" type="button" onclick="navigator.clipboard.writeText(document.getElementById('avs-agent-prompt').value).then(() => this.textContent = 'Copied')">Copy prompt</button>
          </div>
          <div class="avs-fallback-panel">
            <h2>What to check</h2>
            <ul>
              <li>Wait a moment and refresh if this is the first visit.</li>
              <li>Ask the agent to inspect Vite and browser console errors.</li>
              <li>The main file to edit is <code>src/App.tsx</code>.</li>
              <li>Use shared UI imports like <code>@/components/ui/card</code>.</li>
            </ul>
          </div>
        </div>
      </main>
    </section>`
}

export function injectFallbackRecovery(html: string) {
  if (html.includes("avs-fallback-shell") || AVS_FALLBACK_PATTERN.test(html)) return html
  return html.replace(ROOT_ELEMENT_PATTERN, `$1\n    ${fallbackRecoveryHtml()}`)
}
