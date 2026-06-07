import { access, mkdir, symlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import react from "@vitejs/plugin-react"
import { createServer as createViteServer } from "vite"
import type { InlineConfig } from "vite"
import {
  formatShowEventMessage,
  normalizeShowEvent,
  type AgentMark,
  type MarkAnchor,
  type ShowEvent,
  type ShowEventInput
} from "@avibe/show-sdk"
import type { ShowRuntime, ShowRuntimeOptions, ShowSession, ShowSessionStatus } from "./types.js"
import { createShadcnAlias } from "./aliases.js"
import { showHmrTransitionPlugin } from "./hmr-transition-plugin.js"
import { ensureSessionTemplate } from "./templates.js"

const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_IDLE_PRUNE_INTERVAL_MS = 5 * 60 * 1000
const SLOW_TIMING_MS = Number(process.env.VIBE_SHOW_RUNTIME_SLOW_TIMING_MS ?? "1000")

export function createShowRuntime(options: ShowRuntimeOptions): ShowRuntime {
  const sessions = new Map<string, ShowSession>()
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
  const idlePruneIntervalMs = options.idlePruneIntervalMs ?? DEFAULT_IDLE_PRUNE_INTERVAL_MS
  let lastIdlePruneAt = 0
  const idlePruneTimer = idlePruneIntervalMs > 0
    ? setInterval(() => {
      void pruneIdleSessions().catch((error) => {
        console.error(JSON.stringify({
          level: "warn",
          source: "show-runtime",
          event: "idle-prune-error",
          message: error instanceof Error ? error.message : String(error)
        }))
      })
    }, idlePruneIntervalMs)
    : undefined
  idlePruneTimer?.unref?.()

  async function ensureSession(sessionId: string, basePath?: string): Promise<ShowSessionStatus> {
    const started = performance.now()
    await pruneIdleSessionsIfDue()
    const existing = getOrCreateSession(sessionId)
    existing.lastAccessedAt = new Date()
    const normalizedBasePath = normalizeBasePath(basePath, sessionId)
    if (existing.state === "active" && existing.basePath === normalizedBasePath) {
      existing.updatedAt = new Date()
      logTiming("ensureSession", sessionId, started, { state: "active", reused: true })
      return toStatus(existing)
    }
    if (existing.state === "active" && existing.basePath !== normalizedBasePath) {
      const closeStarted = performance.now()
      await closeSession(existing)
      logTiming("closeSessionForBasePathChange", sessionId, closeStarted, { from: existing.basePath, to: normalizedBasePath })
    }
    if (!existing.warming) {
      if (existing.vite) {
        const closeStarted = performance.now()
        await closeSession(existing, existing.state)
        logTiming("closeStaleSessionBeforeWarm", sessionId, closeStarted, { state: existing.state })
      }
      existing.state = "warming"
      existing.updatedAt = new Date()
      existing.warming = warmSession(existing, normalizedBasePath)
    }
    const warmed = await existing.warming
    warmed.lastAccessedAt = new Date()
    logTiming("ensureSession", sessionId, started, { state: warmed.state, reused: false, basePath: warmed.basePath })
    return toStatus(warmed)
  }

  async function getSessionStatus(sessionId: string): Promise<ShowSessionStatus> {
    await pruneIdleSessions()
    const session = getOrCreateSession(sessionId)
    return toStatus(session)
  }

  async function suspendSession(sessionId: string): Promise<ShowSessionStatus> {
    const session = getOrCreateSession(sessionId)
    await closeSession(session)
    return toStatus(session)
  }

  async function close() {
    if (idlePruneTimer) clearInterval(idlePruneTimer)
    await Promise.all([...sessions.values()].map((session) => closeSession(session)))
  }

  async function pruneIdleSessions(): Promise<ShowSessionStatus[]> {
    const now = Date.now()
    lastIdlePruneAt = now
    const pruned: ShowSessionStatus[] = []
    for (const session of sessions.values()) {
      if (session.state !== "active" || !session.lastAccessedAt) continue
      if (now - session.lastAccessedAt.getTime() <= idleTtlMs) continue
      const started = performance.now()
      await closeSession(session, "idle")
      logTiming("pruneIdleSession", session.id, started, { idleTtlMs })
      pruned.push(toStatus(session))
    }
    return pruned
  }

  async function pruneIdleSessionsIfDue(): Promise<ShowSessionStatus[]> {
    if (idlePruneIntervalMs <= 0) return []
    if (Date.now() - lastIdlePruneAt < idlePruneIntervalMs) return []
    return pruneIdleSessions()
  }

  function getOrCreateSession(sessionId: string): ShowSession {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const session: ShowSession = {
      id: sessionId,
      workspace: join(options.workspaceRoot, sessionId),
      state: "created",
      updatedAt: new Date(),
      events: [],
      messages: []
    }
    sessions.set(sessionId, session)
    return session
  }

  async function warmSession(session: ShowSession, basePath: string): Promise<ShowSession> {
    const started = performance.now()
    const mkdirStarted = performance.now()
    await mkdir(session.workspace, { recursive: true })
    logTiming("warmSession.mkdir", session.id, mkdirStarted)
    const linkStarted = performance.now()
    const dependencyRoot = await ensureSharedDependencyLink(session.workspace, options.dependencyRoot)
    logTiming("warmSession.dependencyLink", session.id, linkStarted, { dependencyRoot })
    const templateStarted = performance.now()
    await ensureSessionTemplate(session.workspace)
    logTiming("warmSession.template", session.id, templateStarted)
    const cacheStarted = performance.now()
    const cacheDir = await viteCacheDir(dependencyRoot, session.id, options.cacheRoot)
    logTiming("warmSession.cacheDir", session.id, cacheStarted, { cacheDir })
    const viteConfig = {
      base: basePath,
      root: session.workspace,
      cacheDir,
      server: {
        middlewareMode: options.server ? { server: options.server } : true,
        hmr: {
          server: options.server,
          path: `__vite_hmr`
        },
        fs: {
          strict: true,
          allow: [session.workspace, dependencyRoot],
          deny: []
        }
      },
      plugins: [showHmrTransitionPlugin({ fallbackDelaySeconds: options.fallbackDelaySeconds }), react()] as InlineConfig["plugins"],
      resolve: {
        alias: createShadcnAlias(options.uiPackageName) as InlineConfig["resolve"] extends { alias?: infer Alias } ? Alias : never
      }
    } satisfies InlineConfig
    const viteStarted = performance.now()
    session.vite = await createViteServer(viteConfig)
    logTiming("warmSession.createViteServer", session.id, viteStarted, { cacheDir, basePath })
    session.state = "active"
    session.basePath = basePath
    session.updatedAt = new Date()
    session.warming = undefined
    logTiming("warmSession.total", session.id, started, { cacheDir, basePath })
    return session
  }

  async function closeSession(session: ShowSession, nextState: ShowSession["state"] = "suspended") {
    if (session.vite) {
      await session.vite.waitForRequestsIdle()
      await session.vite.close()
      session.vite = undefined
    }
    session.state = nextState
    session.updatedAt = new Date()
    session.warming = undefined
  }

  return {
    ensureSession,
    getSessionStatus,
    pruneIdleSessions,
    getSession: (sessionId: string) => sessions.get(sessionId),
    suspendSession,
    recordAgentMark(sessionId: string, mark: AgentMark, anchor?: MarkAnchor) {
      return recordShowEvent(sessionId, { type: "assistant.mark.created", mark, anchor })
    },
    recordShowEvent,
    listSessionEvents(sessionId: string) {
      return [...getOrCreateSession(sessionId).events]
    },
    listSessionMessages(sessionId: string) {
      return [...getOrCreateSession(sessionId).messages]
    },
    close
  }

  function recordShowEvent(sessionId: string, payload: ShowEventInput | ShowEvent) {
    const session = getOrCreateSession(sessionId)
    const event = normalizeShowEvent(payload, sessionId)
    const content = formatShowEventMessage(event)
    session.events.push(event)
    if (content) {
      session.messages.push({
        id: `${event.id}:message`,
        role: messageRoleForEvent(event),
        content,
        createdAt: event.createdAt,
        eventId: event.id
      })
    }
    session.updatedAt = new Date()
    return event
  }
}

function messageRoleForEvent(event: ShowEvent): "assistant" | "user" | "system" {
  if (event.type.startsWith("assistant.")) return "assistant"
  if (event.type.startsWith("human.")) return "user"
  return "system"
}

function normalizeBasePath(basePath: string | undefined, sessionId: string) {
  const fallback = `/show/${encodeURIComponent(sessionId)}/`
  const raw = (basePath || fallback).trim()
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`
}

async function ensureSharedDependencyLink(workspace: string, dependencyRoot?: string) {
  const nodeModules = dependencyRoot ? join(dependencyRoot, "node_modules") : await findNearestNodeModules()
  const linkPath = join(workspace, "node_modules")
  try {
    await access(linkPath)
    return nodeModules
  } catch {
    // create link below
  }
  await symlink(nodeModules, linkPath, "junction")
  return nodeModules
}

async function viteCacheDir(dependencyRoot: string, sessionId: string, cacheRoot?: string) {
  const root = resolve(cacheRoot ?? join(dirname(dependencyRoot), ".vite-cache"))
  const digest = createHash("sha256").update(dependencyRoot).digest("hex").slice(0, 16)
  const cacheDir = join(root, digest, encodeURIComponent(sessionId))
  await mkdir(cacheDir, { recursive: true })
  return cacheDir
}

async function findNearestNodeModules() {
  let current = dirname(fileURLToPath(import.meta.url))
  while (current !== dirname(current)) {
    const candidate = join(current, "node_modules")
    try {
      await access(candidate)
      return candidate
    } catch {
      current = dirname(current)
    }
  }
  throw new Error("Unable to locate shared node_modules for Show Runtime")
}

export function toStatus(session: ShowSession): ShowSessionStatus {
  return {
    sessionId: session.id,
    state: session.state,
    workspace: session.workspace,
    updatedAt: session.updatedAt.toISOString(),
    lastAccessedAt: session.lastAccessedAt?.toISOString(),
    eventCount: session.events.length,
    messageCount: session.messages.length
  }
}

function logTiming(label: string, sessionId: string, started: number, extra: Record<string, unknown> = {}) {
  const durationMs = Math.round(performance.now() - started)
  if (durationMs < SLOW_TIMING_MS && process.env.VIBE_SHOW_RUNTIME_TIMING !== "1") return
  console.error(JSON.stringify({
    level: durationMs >= SLOW_TIMING_MS ? "warn" : "info",
    source: "show-runtime",
    event: "timing",
    label,
    sessionId,
    durationMs,
    ...extra
  }))
}
