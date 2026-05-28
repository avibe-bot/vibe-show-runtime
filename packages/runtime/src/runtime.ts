import { access, mkdir, symlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { createServer as createViteServer } from "vite"
import type { InlineConfig } from "vite"
import type { ShowRuntime, ShowRuntimeOptions, ShowSession, ShowSessionStatus } from "./types.js"
import { createShadcnAlias } from "./aliases.js"
import { ensureSessionTemplate } from "./templates.js"

export function createShowRuntime(options: ShowRuntimeOptions): ShowRuntime {
  const sessions = new Map<string, ShowSession>()
  const idleTtlMs = options.idleTtlMs ?? 15 * 60 * 1000

  async function ensureSession(sessionId: string, basePath?: string): Promise<ShowSessionStatus> {
    const existing = getOrCreateSession(sessionId)
    existing.lastAccessedAt = new Date()
    const normalizedBasePath = normalizeBasePath(basePath, sessionId)
    if (existing.state === "active" && existing.basePath === normalizedBasePath) {
      existing.updatedAt = new Date()
      return toStatus(existing)
    }
    if (existing.state === "active" && existing.basePath !== normalizedBasePath) {
      await closeSession(existing)
    }
    if (!existing.warming) {
      existing.state = "warming"
      existing.updatedAt = new Date()
      existing.warming = warmSession(existing, normalizedBasePath)
    }
    const warmed = await existing.warming
    return toStatus(warmed)
  }

  function getSessionStatus(sessionId: string): ShowSessionStatus {
    const session = getOrCreateSession(sessionId)
    if (session.state === "active" && session.lastAccessedAt && Date.now() - session.lastAccessedAt.getTime() > idleTtlMs) {
      session.state = "idle"
    }
    return toStatus(session)
  }

  async function suspendSession(sessionId: string): Promise<ShowSessionStatus> {
    const session = getOrCreateSession(sessionId)
    await closeSession(session)
    return toStatus(session)
  }

  async function close() {
    await Promise.all([...sessions.values()].map((session) => closeSession(session)))
  }

  function getOrCreateSession(sessionId: string): ShowSession {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const session: ShowSession = {
      id: sessionId,
      workspace: join(options.workspaceRoot, sessionId),
      state: "created",
      updatedAt: new Date()
    }
    sessions.set(sessionId, session)
    return session
  }

  async function warmSession(session: ShowSession, basePath: string): Promise<ShowSession> {
    await mkdir(session.workspace, { recursive: true })
    await ensureSharedDependencyLink(session.workspace, options.dependencyRoot)
    await ensureSessionTemplate(session.workspace)
    const viteConfig = {
      base: basePath,
      root: session.workspace,
      server: {
        middlewareMode: options.server ? { server: options.server } : true,
        hmr: {
          server: options.server,
          path: `__vite_hmr`
        },
        fs: {
          strict: true,
          allow: [session.workspace],
          deny: []
        }
      },
      plugins: [react()] as InlineConfig["plugins"],
      resolve: {
        alias: createShadcnAlias(options.uiPackageName) as InlineConfig["resolve"] extends { alias?: infer Alias } ? Alias : never
      }
    } satisfies InlineConfig
    session.vite = await createViteServer(viteConfig)
    session.state = "active"
    session.basePath = basePath
    session.updatedAt = new Date()
    session.warming = undefined
    return session
  }

  async function closeSession(session: ShowSession) {
    if (session.vite) {
      await session.vite.waitForRequestsIdle()
      await session.vite.close()
      session.vite = undefined
    }
    session.state = "suspended"
    session.updatedAt = new Date()
    session.warming = undefined
  }

  return {
    ensureSession,
    getSessionStatus,
    getSession: (sessionId: string) => sessions.get(sessionId),
    suspendSession,
    close
  }
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
    return
  } catch {
    // create link below
  }
  await symlink(nodeModules, linkPath, "junction")
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
    lastAccessedAt: session.lastAccessedAt?.toISOString()
  }
}
