import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startShowRuntimeServer } from "../packages/runtime/dist/server.js"
import { showEventsStreamUrl } from "../packages/sdk/dist/index.js"

globalThis.__AVIBE_SHOW__ = {
  basePath: "/show/smoke/",
  eventsPath: "__show/events",
  streamPath: "__show/events?stream=1"
}

const configuredStreamPath = showEventsStreamUrl()
if (configuredStreamPath !== "/show/smoke/__show/events?stream=1") {
  throw new Error(`Expected configured stream path, got ${configuredStreamPath}`)
}

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
  const generatedMain = await readFile(join(root, "smoke", "src", "main.tsx"), "utf8")
  if (!generatedMain.includes('import "./show-runtime-config"') || generatedMain.indexOf('import "./show-runtime-config"') > generatedMain.indexOf('import App from "./App"')) {
    throw new Error("Expected generated client shell to initialize runtime config before importing App")
  }
  const generatedConfig = await readFile(join(root, "smoke", "src", "show-runtime-config.ts"), "utf8")
  if (!generatedConfig.includes("basePath: injected.basePath ?? showBasePath()")) {
    throw new Error("Expected generated client shell to preserve injected runtime config")
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

  const streamController = new AbortController()
  const stream = await fetch(`${runtime.url}/sessions/smoke/app/__show/events?stream=1`, {
    signal: streamController.signal
  })
  if (!stream.ok || !stream.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error(`Expected SSE stream response, got ${stream.status} ${stream.headers.get("content-type")}`)
  }
  const reader = stream.body.getReader()
  try {
    const firstFrame = await readUntil(reader, "event: show.event")
    if (!firstFrame.includes(`id: ${event.id}`)) {
      throw new Error(`Expected SSE event id for replayed mark: ${firstFrame}`)
    }
    if (!firstFrame.includes("Please review the summary again.")) {
      throw new Error(`Expected replayed mark event in SSE stream: ${firstFrame}`)
    }

    await fetch(`${runtime.url}/sessions/smoke/app/__show/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "assistant.mark.created",
        mark: {
          target: "mark-default-live",
          body: "Live event should reach the stream."
        }
      })
    })
    const liveFrame = await readUntil(reader, "mark-default-live")
    const liveEvent = JSON.parse(liveFrame.split("data: ")[1].split("\n\n")[0])
    if (!liveFrame.includes(`id: ${liveEvent.id}`)) {
      throw new Error(`Expected SSE event id for live mark: ${liveFrame}`)
    }
    if (!liveFrame.includes("Live event should reach the stream.")) {
      throw new Error(`Expected live mark event in SSE stream: ${liveFrame}`)
    }
  } finally {
    streamController.abort()
    try {
      await reader.cancel()
    } catch {
      // the abort above may already close the reader
    }
  }

  const resumeController = new AbortController()
  const resumedStream = await fetch(`${runtime.url}/sessions/smoke/app/__show/events?stream=1`, {
    headers: { "Last-Event-ID": event.id },
    signal: resumeController.signal
  })
  const resumedReader = resumedStream.body.getReader()
  try {
    const resumedFrame = await readUntil(resumedReader, "mark-default-live")
    if (resumedFrame.includes("Please review the summary again.")) {
      throw new Error(`Expected resumed stream to skip prior event: ${resumedFrame}`)
    }
  } finally {
    resumeController.abort()
    try {
      await resumedReader.cancel()
    } catch {
      // the abort above may already close the reader
    }
  }

  const queryResumeController = new AbortController()
  const queryResumedStream = await fetch(`${runtime.url}/sessions/smoke/app/__show/events?stream=1&after_id=${encodeURIComponent(event.id)}`, {
    signal: queryResumeController.signal
  })
  const queryResumedReader = queryResumedStream.body.getReader()
  try {
    const queryResumedFrame = await readUntil(queryResumedReader, "mark-default-live")
    if (queryResumedFrame.includes("Please review the summary again.")) {
      throw new Error(`Expected after_id stream to skip prior event: ${queryResumedFrame}`)
    }
  } finally {
    queryResumeController.abort()
    try {
      await queryResumedReader.cancel()
    } catch {
      // the abort above may already close the reader
    }
  }

  console.log("smoke runtime ok")
} finally {
  await runtime.close()
  await rm(root, { recursive: true, force: true })
}

async function readUntil(reader, needle) {
  const decoder = new TextDecoder()
  let body = ""
  const deadline = Date.now() + 5000
  while (!body.includes(needle)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${needle}; body so far: ${body}`)
    }
    const { done, value } = await reader.read()
    if (done) {
      throw new Error(`Stream ended before ${needle}; body so far: ${body}`)
    }
    body += decoder.decode(value, { stream: true })
  }
  return body
}
