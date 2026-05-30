import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startShowRuntimeServer } from "../packages/runtime/dist/server.js"

const root = await mkdtemp(join(tmpdir(), "avibe-show-runtime-"))
const runtime = await startShowRuntimeServer({ workspaceRoot: root })

try {
  const apiDir = join(root, "smoke", "api")
  await mkdir(apiDir, { recursive: true })
  await writeFile(join(apiDir, "health.ts"), `export function GET(_request, context) {
  return Response.json({ ok: true, sessionId: context.session.id })
}
`)

  const ensure = await fetch(`${runtime.url}/sessions/smoke/ensure`, { method: "POST" }).then((res) => res.json())
  if (ensure.state !== "active") {
    throw new Error(`Expected active session, got ${ensure.state}`)
  }

  const handler = await fetch(`${runtime.url}/sessions/smoke/app/api/health`).then((res) => res.json())
  if (!handler.ok || handler.sessionId !== "smoke") {
    throw new Error(`Unexpected handler response: ${JSON.stringify(handler)}`)
  }

  const app = await fetch(`${runtime.url}/sessions/smoke/app/`).then((res) => res.text())
  if (!app.includes("Vibe Show")) {
    throw new Error("Expected app HTML to include Vibe Show")
  }
  if (!app.includes('/show/smoke/@vite/client') || !app.includes('/show/smoke/src/main.tsx')) {
    throw new Error("Expected app HTML asset URLs to stay under /show/<session>/")
  }

  const eventResponse = await fetch(`${runtime.url}/sessions/smoke/app/__show/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "assistant.mark.created",
      mark: {
        target: "mark-default-summary",
        body: "Please review the summary again."
      }
    })
  }).then((res) => res.json())
  const event = eventResponse.event ?? eventResponse
  if (event.type !== "assistant.mark.created" || !event.message?.content.includes("[agent-mark:default] mark-default-summary")) {
    throw new Error(`Unexpected mark event: ${JSON.stringify(event)}`)
  }

  const messages = await fetch(`${runtime.url}/sessions/smoke/messages`).then((res) => res.json())
  if (!messages.messages?.[0]?.content.includes("Please review the summary again.")) {
    throw new Error(`Expected assistant mark message to be recorded: ${JSON.stringify(messages)}`)
  }

  const status = await fetch(`${runtime.url}/sessions/smoke/status`).then((res) => res.json())
  if (status.messageCount !== 1 || status.eventCount !== 1) {
    throw new Error(`Expected mark counters in status: ${JSON.stringify(status)}`)
  }

  console.log("smoke runtime ok")
} finally {
  await runtime.close()
  await rm(root, { recursive: true, force: true })
}
