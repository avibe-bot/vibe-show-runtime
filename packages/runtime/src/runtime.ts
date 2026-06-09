import { access, lstat, mkdir, readFile, readlink, realpath, rm, symlink } from "node:fs/promises"
import { dirname, extname, join, resolve } from "node:path"
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

function defaultOptimizeDepsInclude(uiPackageName: string) {
  return [
    "react",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "react-dom/client",
    `${uiPackageName}/animated-text > motion/react`,
    `${uiPackageName}/card > motion/react`,
    `${uiPackageName}/button`,
    `${uiPackageName}/card`,
    `${uiPackageName}/badge`,
    `${uiPackageName}/dialog`,
    `${uiPackageName}/input`,
    `${uiPackageName}/metric-card`,
    `${uiPackageName}/progress`,
    `${uiPackageName}/switch`,
    `${uiPackageName}/theme`
  ]
}

export function createShowRuntime(options: ShowRuntimeOptions): ShowRuntime {
  const sessions = new Map<string, ShowSession>()
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS

  async function ensureSession(sessionId: string, basePath?: string): Promise<ShowSessionStatus> {
    const existing = getOrCreateSession(sessionId)
    existing.lastAccessedAt = new Date()
    const normalizedBasePath = normalizeBasePath(basePath, sessionId)
    const dependencySignature = existing.state === "active" ? await sourceDependencySignature(existing.workspace, options.uiPackageName ?? "@avibe/show-ui") : undefined
    if (existing.state === "active" && existing.basePath === normalizedBasePath && existing.dependencySignature === dependencySignature) {
      existing.updatedAt = new Date()
      return toStatus(existing)
    }
    if (existing.state === "active" && (existing.basePath !== normalizedBasePath || existing.dependencySignature !== dependencySignature)) {
      await closeSession(existing)
    }
    if (!existing.warming) {
      existing.state = "warming"
      existing.updatedAt = new Date()
      existing.warming = warmSession(existing, normalizedBasePath).catch(async (error) => {
        await closeSession(existing)
        throw error
      })
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
    await ensureSessionTemplate(session.workspace)
    const uiPackageName = options.uiPackageName ?? "@avibe/show-ui"
    const sharedDependencies = await ensureSharedDependencyLink(session.workspace, options.dependencyRoot, uiPackageName)
    const sourceDependencies = await sourceDependenciesForWorkspace(session.workspace, uiPackageName)
    const cacheDir = await viteCacheDir(sharedDependencies.nodeModules, options.cacheRoot, sourceDependencies.signature)
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
        noDiscovery: true,
        include: [...defaultOptimizeDepsInclude(uiPackageName), ...sourceDependencies.extraBareImports]
      }
    } satisfies InlineConfig
    await withViteCacheWarmLock(cacheDir, async () => {
      session.vite = await createViteServer(viteConfig)
      await warmEntryModuleGraph(session.vite)
    })
    session.state = "active"
    session.basePath = basePath
    session.dependencySignature = sourceDependencies.signature
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

type SourceDependencies = {
  extraBareImports: string[]
  signature: string
}

const SOURCE_DEPENDENCY_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts"])
const IMPORT_RE = /\bimport\s+([^'"]*?\s+from\s+)?["']([^"']+)["']|\bexport\s+([^'"]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g

async function sourceDependenciesForWorkspace(workspace: string, uiPackageName: string): Promise<SourceDependencies> {
  const extraBareImports = new Set<string>()
  for (const sourceFile of await reachableSourceFiles(join(workspace, "src", "main.tsx"))) {
    const source = await readFile(sourceFile, "utf8")
    for (const { specifier } of importSpecifiers(source)) {
      if (isRuntimeManagedImport(specifier, uiPackageName)) {
        continue
      }
      if (isBareImport(specifier)) {
        extraBareImports.add(specifier)
      }
    }
  }
  const sorted = [...extraBareImports].sort()
  return {
    extraBareImports: sorted,
    signature: sorted.length ? createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16) : "shared"
  }
}

async function sourceDependencySignature(workspace: string, uiPackageName: string) {
  return (await sourceDependenciesForWorkspace(workspace, uiPackageName)).signature
}

async function reachableSourceFiles(entry: string): Promise<string[]> {
  const seen = new Set<string>()
  const queue = [entry]
  for (let index = 0; index < queue.length; index += 1) {
    const file = await resolveSourceFile(queue[index])
    if (!file || seen.has(file)) {
      continue
    }
    seen.add(file)
    let source = ""
    try {
      source = await readFile(file, "utf8")
    } catch {
      continue
    }
    for (const { specifier } of importSpecifiers(source)) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        queue.push(resolve(dirname(file), stripViteImportSuffix(specifier)))
      }
    }
  }
  return [...seen]
}

async function resolveSourceFile(path: string): Promise<string | undefined> {
  if (SOURCE_DEPENDENCY_EXTENSIONS.has(extname(path)) && await isFile(path)) {
    return path
  }
  for (const extension of SOURCE_DEPENDENCY_EXTENSIONS) {
    const candidate = `${path}${extension}`
    if (await isFile(candidate)) {
      return candidate
    }
  }
  for (const extension of SOURCE_DEPENDENCY_EXTENSIONS) {
    const candidate = join(path, `index${extension}`)
    if (await isFile(candidate)) {
      return candidate
    }
  }
  return undefined
}

async function isFile(path: string) {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

function importSpecifiers(source: string) {
  const specifiers: Array<{ specifier: string }> = []
  for (const match of stripJavaScriptComments(source).matchAll(IMPORT_RE)) {
    const staticImportClause = match[1]?.trim()
    const staticImportSpecifier = match[2]
    const staticExportClause = match[3]?.trim()
    const staticExportSpecifier = match[4]
    const specifier = staticImportSpecifier ?? staticExportSpecifier ?? match[5] ?? match[6]
    if (specifier) {
      if (staticImportSpecifier && (staticImportClause === "type" || staticImportClause?.startsWith("type "))) {
        continue
      }
      if (staticExportSpecifier && (staticExportClause === undefined || staticExportClause === "type from" || staticExportClause?.startsWith("type "))) {
        continue
      }
      specifiers.push({ specifier })
    }
  }
  return specifiers
}

function stripJavaScriptComments(source: string) {
  let output = ""
  let index = 0
  let quote: "\"" | "'" | "`" | undefined
  let escaped = false
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (quote) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = undefined
      }
      index += 1
      continue
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      output += char
      index += 1
      continue
    }

    if (char === "/" && next === "/") {
      output += "  "
      index += 2
      while (index < source.length && source[index] !== "\n") {
        output += " "
        index += 1
      }
      continue
    }

    if (char === "/" && next === "*") {
      output += "  "
      index += 2
      while (index < source.length) {
        const current = source[index]
        const following = source[index + 1]
        if (current === "*" && following === "/") {
          output += "  "
          index += 2
          break
        }
        output += current === "\n" ? "\n" : " "
        index += 1
      }
      continue
    }

    output += char
    index += 1
  }
  return output
}

function stripViteImportSuffix(specifier: string) {
  const queryIndex = specifier.search(/[?#]/)
  return queryIndex === -1 ? specifier : specifier.slice(0, queryIndex)
}

function isRuntimeManagedImport(specifier: string, uiPackageName: string) {
  return specifier === "react" ||
    specifier === "react-dom/client" ||
    specifier.startsWith("react/") ||
    specifier === uiPackageName ||
    specifier.startsWith(`${uiPackageName}/`) ||
    specifier === "@avibe/show-sdk" ||
    specifier.startsWith("@avibe/show-sdk/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("virtual:") ||
    specifier.startsWith("\0")
}

function isBareImport(specifier: string) {
  return !specifier.startsWith("./") &&
    !specifier.startsWith("../") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("virtual:") &&
    !specifier.startsWith("\0")
}

async function viteCacheDir(dependencyRoot: string, cacheRoot?: string, dependencySignature = "shared") {
  const root = resolve(cacheRoot ?? join(dirname(dependencyRoot), ".vite-cache"))
  const digest = createHash("sha256").update(`${dependencyRoot}\0${dependencySignature}`).digest("hex").slice(0, 16)
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
