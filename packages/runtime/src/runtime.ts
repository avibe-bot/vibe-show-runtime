import { access, lstat, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import react from "@vitejs/plugin-react"
import { createServer as createViteServer } from "vite"
import type { InlineConfig, ViteDevServer } from "vite"
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
const viteCacheWarmLocks = new Map<string, Promise<void>>()

export function createShowRuntime(options: ShowRuntimeOptions): ShowRuntime {
  const sessions = new Map<string, ShowSession>()
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS

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
      updatedAt: new Date(),
      events: [],
      messages: []
    }
    sessions.set(sessionId, session)
    return session
  }

  async function warmSession(session: ShowSession, basePath: string): Promise<ShowSession> {
    await mkdir(session.workspace, { recursive: true })
    const uiPackageName = options.uiPackageName ?? "@avibe/show-ui"
    const sharedDependencies = await ensureSharedDependencyLink(session.workspace, options.dependencyRoot, uiPackageName)
    await ensureSessionTemplate(session.workspace)
    const cacheDir = await viteCacheDir(sharedDependencies.nodeModules, options.cacheRoot)
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
          allow: [session.workspace, sharedDependencies.nodeModules, ...sharedDependencies.packageRoots],
          deny: []
        }
      },
      plugins: [showHmrTransitionPlugin({ fallbackDelaySeconds: options.fallbackDelaySeconds }), react()] as InlineConfig["plugins"],
      resolve: {
        alias: createShadcnAlias(uiPackageName) as InlineConfig["resolve"] extends { alias?: infer Alias } ? Alias : never
      },
      optimizeDeps: {
        include: [
          "react",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
          "react-dom/client",
          "motion/react",
          `${uiPackageName}/button`,
          `${uiPackageName}/card`,
          `${uiPackageName}/badge`,
          `${uiPackageName}/progress`,
          `${uiPackageName}/theme`
        ]
      }
    } satisfies InlineConfig
    await withViteCacheWarmLock(cacheDir, async () => {
      session.vite = await createViteServer(viteConfig)
      await warmEntryModuleGraph(session.vite)
    })
    session.state = "active"
    session.basePath = basePath
    session.updatedAt = new Date()
    session.warming = undefined
    return session
  }

  async function warmEntryModuleGraph(vite: ViteDevServer) {
    await vite.warmupRequest("/src/main.tsx")
    await vite.waitForRequestsIdle()
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

type SharedDependencies = {
  nodeModules: string
  packageRoots: string[]
}

async function ensureSharedDependencyLink(workspace: string, dependencyRoot?: string, uiPackageName = "@avibe/show-ui"): Promise<SharedDependencies> {
  const root = dependencyRoot ? resolve(dependencyRoot) : await findNearestDependencyRoot()
  const nodeModules = join(root, "node_modules")
  await access(nodeModules)
  const packageRoots = await resolveAllowedPackageRoots(nodeModules, [uiPackageName, "@avibe/show-sdk"])
  const linkPath = join(workspace, "node_modules")
  try {
    const stats = await lstat(linkPath)
    if (stats.isSymbolicLink()) {
      const currentTarget = resolve(dirname(linkPath), await readlink(linkPath))
      if (currentTarget !== nodeModules) {
        await rm(linkPath)
        await symlink(nodeModules, linkPath, "junction")
      }
    }
    return { nodeModules, packageRoots }
  } catch {
    // create link below
  }
  await symlink(nodeModules, linkPath, "junction")
  return { nodeModules, packageRoots }
}

async function resolveAllowedPackageRoots(nodeModules: string, packageNames: string[]) {
  const roots = new Set<string>()
  for (const packageName of packageNames) {
    const packageRoot = packageName.split("/").reduce((current, part) => join(current, part), nodeModules)
    try {
      roots.add(resolve(packageRoot))
      roots.add(await realpath(packageRoot))
    } catch {
      // Optional package aliases may not exist in every runtime install.
    }
  }
  return [...roots]
}

async function viteCacheDir(dependencyRoot: string, cacheRoot?: string) {
  const root = resolve(cacheRoot ?? join(dirname(dependencyRoot), ".vite-cache"))
  const digest = createHash("sha256").update(dependencyRoot).digest("hex").slice(0, 16)
  const cacheDir = join(root, digest)
  await mkdir(cacheDir, { recursive: true })
  return cacheDir
}

async function withViteCacheWarmLock<T>(cacheDir: string, callback: () => Promise<T>): Promise<T> {
  const previous = viteCacheWarmLocks.get(cacheDir) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  viteCacheWarmLocks.set(cacheDir, tail)
  await previous.catch(() => undefined)
  try {
    return await callback()
  } finally {
    release()
    if (viteCacheWarmLocks.get(cacheDir) === tail) {
      viteCacheWarmLocks.delete(cacheDir)
    }
  }
}

async function findNearestDependencyRoot() {
  let current = dirname(fileURLToPath(import.meta.url))
  while (current !== dirname(current)) {
    const candidate = join(current, "node_modules")
    try {
      await access(candidate)
      return current
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
