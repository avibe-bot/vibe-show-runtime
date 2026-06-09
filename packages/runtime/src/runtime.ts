import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, extname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
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
import { createVendorExternalizePlugins, isProvidedVendorSpecifier } from "./vendor-externalize-plugin.js"
import {
  defaultVendorCacheRoot,
  ensureVendorBundle,
  vendorImportMapPlugin,
  type VendorBundle
} from "./vendor-runtime.js"

const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_IDLE_PRUNE_INTERVAL_MS = 5 * 60 * 1000
const SLOW_TIMING_MS = Number(process.env.VIBE_SHOW_RUNTIME_SLOW_TIMING_MS ?? "1000")
const viteCacheWarmLocks = new Map<string, Promise<void>>()

export function createShowRuntime(options: ShowRuntimeOptions): ShowRuntime {
  const sessions = new Map<string, ShowSession>()
  // The most recently warmed shared vendor bundle. The server serves its assets at a
  // session-independent path; it's set the first time any session warms (the build is
  // cached per dependency root in `ensureVendorBundle`).
  let vendorBundle: VendorBundle | undefined
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
  const idlePruneIntervalMs = options.idlePruneIntervalMs ?? DEFAULT_IDLE_PRUNE_INTERVAL_MS
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
    const existing = getOrCreateSession(sessionId)
    existing.lastAccessedAt = new Date()
    if (existing.closing) {
      await existing.closing
      existing.lastAccessedAt = new Date()
    }
    const normalizedBasePath = normalizeBasePath(basePath, sessionId)
    const dependencySignature = existing.state === "active" ? await sourceDependencySignature(existing.workspace, options.uiPackageName ?? "@avibe/show-ui") : undefined
    if (existing.state === "active" && existing.basePath === normalizedBasePath && existing.dependencySignature === dependencySignature) {
      existing.updatedAt = new Date()
      logTiming("ensureSession", sessionId, started, { state: "active", reused: true })
      return toStatus(existing)
    }
    if (existing.state === "active" && (existing.basePath !== normalizedBasePath || existing.dependencySignature !== dependencySignature)) {
      const closeStarted = performance.now()
      await closeSession(existing)
      logTiming("closeSessionForWarmChange", sessionId, closeStarted, { from: existing.basePath, to: normalizedBasePath })
    }
    if (!existing.warming) {
      if (existing.vite) {
        const closeStarted = performance.now()
        await closeSession(existing, existing.state === "closing" ? "suspended" : existing.state)
        logTiming("closeStaleSessionBeforeWarm", sessionId, closeStarted, { state: existing.state })
      }
      existing.state = "warming"
      existing.updatedAt = new Date()
      existing.warming = warmSession(existing, normalizedBasePath).catch(async (error) => {
        await closeSession(existing)
        throw error
      })
    }
    const warmed = await existing.warming
    warmed.lastAccessedAt = new Date()
    logTiming("ensureSession", sessionId, started, { state: warmed.state, reused: false, basePath: warmed.basePath })
    return toStatus(warmed)
  }

  async function getSessionStatus(sessionId: string): Promise<ShowSessionStatus> {
    const session = getOrCreateSession(sessionId)
    await pruneSessionIfIdle(session)
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
    const pruned: ShowSessionStatus[] = []
    for (const session of sessions.values()) {
      const status = await pruneSessionIfIdle(session, now)
      if (status) pruned.push(status)
    }
    return pruned
  }

  async function pruneSessionIfIdle(session: ShowSession, now = Date.now()): Promise<ShowSessionStatus | undefined> {
    if (session.state !== "active" || !session.lastAccessedAt) return undefined
    if (now - session.lastAccessedAt.getTime() <= idleTtlMs) return undefined
    const started = performance.now()
    await closeSession(session, "idle")
    logTiming("pruneIdleSession", session.id, started, { idleTtlMs, state: session.state })
    return toStatus(session)
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
    const templateStarted = performance.now()
    await ensureSessionTemplate(session.workspace)
    logTiming("warmSession.template", session.id, templateStarted)
    const uiPackageName = options.uiPackageName ?? "@avibe/show-ui"
    const dependencyRoot = await resolveDependencyRoot(options.dependencyRoot)
    const vendorStarted = performance.now()
    const bundle = await ensureVendorBundle({
      dependencyRoot,
      vendorCacheRoot: defaultVendorCacheRoot(dependencyRoot, options.cacheRoot),
      uiPackageName
    })
    vendorBundle = bundle
    logTiming("warmSession.vendorBundle", session.id, vendorStarted, { hash: bundle.result.manifest.hash, baseUrl: bundle.baseUrl })
    const dependencyStarted = performance.now()
    const sourceDependencies = await sourceDependenciesForWorkspace(session.workspace, uiPackageName)
    logTiming("warmSession.sourceDependencies", session.id, dependencyStarted, { signature: sourceDependencies.signature, extraBareImports: sourceDependencies.extraBareImports.length, declaredExtras: sourceDependencies.declaredExtras.entries.length })
    const linkStarted = performance.now()
    const sharedDependencies = await ensureSessionDependencies(session.workspace, sourceDependencies.declaredExtras, dependencyRoot, uiPackageName)
    logTiming("warmSession.dependencyLink", session.id, linkStarted, { nodeModules: sharedDependencies.nodeModules, extrasSignature: sharedDependencies.extrasSignature })
    const cacheStarted = performance.now()
    const cacheDir = await viteCacheDir(sharedDependencies.nodeModules, options.cacheRoot, sourceDependencies.signature)
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
          allow: [session.workspace, sharedDependencies.nodeModules, ...sharedDependencies.packageRoots],
          deny: []
        }
      },
      plugins: [
        vendorImportMapPlugin(bundle),
        ...createVendorExternalizePlugins(uiPackageName),
        showHmrTransitionPlugin({ fallbackDelaySeconds: options.fallbackDelaySeconds }),
        react()
      ] as InlineConfig["plugins"],
      resolve: {
        alias: createShadcnAlias(uiPackageName) as InlineConfig["resolve"] extends { alias?: infer Alias } ? Alias : never,
        // Singleton guard: even though React is served bare via the import map,
        // dedupe keeps any stray local resolution collapsed to one copy.
        dedupe: ["react", "react-dom"]
      },
      optimizeDeps: {
        noDiscovery: true,
        // The provided vendor set is externalized (left bare for the import map),
        // so the optimizer only handles the app's OWN non-provided bare imports.
        // `exclude` for the provided set is added by the externalize plugin's
        // `config` hook (single source of truth in vendor-externalize-plugin).
        include: sourceDependencies.extraBareImports.filter((specifier) => !isProvidedVendorSpecifier(specifier, uiPackageName))
      }
    } satisfies InlineConfig
    await withViteCacheWarmLock(cacheDir, async () => {
      const viteStarted = performance.now()
      session.vite = await createViteServer(viteConfig)
      logTiming("warmSession.createViteServer", session.id, viteStarted, { cacheDir, basePath })
      const entryStarted = performance.now()
      await warmEntryModuleGraph(session.vite, sourceDependencies.entryRequests)
      logTiming("warmSession.warmEntryModuleGraph", session.id, entryStarted, { entries: sourceDependencies.entryRequests.length })
    })
    session.state = "active"
    session.basePath = basePath
    session.dependencySignature = sourceDependencies.signature
    session.updatedAt = new Date()
    session.warming = undefined
    logTiming("warmSession.total", session.id, started, { cacheDir, basePath })
    return session
  }

  async function warmEntryModuleGraph(vite: ViteDevServer, entryRequests: string[]) {
    for (const entryRequest of entryRequests) {
      await vite.warmupRequest(entryRequest)
    }
    await vite.waitForRequestsIdle()
  }

  async function closeSession(session: ShowSession, nextState: ShowSession["state"] = "suspended") {
    if (session.closing) {
      await session.closing
      return
    }
    const vite = session.vite
    if (!vite) {
      session.state = nextState
      session.updatedAt = new Date()
      session.warming = undefined
      return
    }
    session.state = "closing"
    session.updatedAt = new Date()
    session.warming = undefined
    session.closing = (async () => {
      try {
        await vite.waitForRequestsIdle()
        await vite.close()
      } finally {
        if (session.vite === vite) {
          session.vite = undefined
        }
        session.closing = undefined
        session.state = nextState
        session.updatedAt = new Date()
      }
    })()
    await session.closing
  }

  return {
    ensureSession,
    getSessionStatus,
    pruneIdleSessions,
    getSession: (sessionId: string) => sessions.get(sessionId),
    getVendorBundle: () => vendorBundle,
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
  /** node_modules Vite resolves from (the shared symlink, or the session extras dir). */
  nodeModules: string
  /** Extra dirs to add to `server.fs.allow` beyond the shared install + package roots. */
  packageRoots: string[]
  /** Signature of the declared extras the workspace was installed against. */
  extrasSignature: string
}

/**
 * Resolve a session's dependency layering and (re)install per-session extras.
 *
 * Layering (Node walk-up resolution does the work; no per-package aliasing):
 *  - **No declared extras** (today's behavior, unchanged): `workspace/node_modules`
 *    is a symlink to the shared, pinned install — that single dir resolves every
 *    non-provided dep the app uses, and the session shares the global optimize cache.
 *  - **Declared extras**: install ONLY the declared extras (+ their transitive,
 *    non-provided deps) into `workspace/node_modules` as a real, session-private dir,
 *    and symlink the shared install one level up at `workspaceRoot/node_modules`.
 *    Walk-up from the session sources hits the extras dir first, then the shared
 *    install as a fallback for non-provided shared deps. The provided vendor set
 *    (react, `@avibe/show-ui/*`, ...) is never installed per session — it stays
 *    externalized to the shared bundle (Stage R-B), so a session can't fork React.
 */
async function ensureSessionDependencies(
  workspace: string,
  declaredExtras: DeclaredExtras,
  dependencyRoot: string,
  uiPackageName = "@avibe/show-ui"
): Promise<SharedDependencies> {
  const root = dependencyRoot
  const sharedNodeModules = join(root, "node_modules")
  await access(sharedNodeModules)
  const packageRoots = await resolveAllowedPackageRoots(sharedNodeModules, [uiPackageName, "@avibe/show-sdk"])

  if (declaredExtras.entries.length === 0) {
    // Shared-only: workspace/node_modules -> shared install. Drop any stale extras
    // real dir from a previous warm so reverting to no-extras restores the symlink.
    await ensureSharedSymlink(join(workspace, "node_modules"), sharedNodeModules)
    return { nodeModules: sharedNodeModules, packageRoots, extrasSignature: "shared" }
  }

  // Extras: shared stays reachable as the walk-up fallback one level up; the session
  // node_modules becomes the private extras install.
  await ensureSharedSymlink(join(dirname(workspace), "node_modules"), sharedNodeModules)
  const extrasDir = await ensureSessionExtrasInstall(workspace, declaredExtras)
  return {
    nodeModules: extrasDir,
    packageRoots: [...packageRoots, extrasDir, sharedNodeModules],
    extrasSignature: declaredExtras.signature
  }
}

/** Point `linkPath` at the shared install, replacing any stale symlink target or real dir. */
async function ensureSharedSymlink(linkPath: string, sharedNodeModules: string) {
  try {
    const stats = await lstat(linkPath)
    if (stats.isSymbolicLink()) {
      const currentTarget = resolve(dirname(linkPath), await readlink(linkPath))
      if (currentTarget === sharedNodeModules) return
      await rm(linkPath)
    } else {
      // A previous extras warm left a real node_modules here; clear it before linking.
      await rm(linkPath, { recursive: true, force: true })
    }
  } catch {
    // Nothing to replace; create the link below.
  }
  await symlink(sharedNodeModules, linkPath, "junction")
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

const execFileAsync = promisify(execFile)
const SESSION_EXTRAS_LOCKFILE = ".show-extras.json"

type DeclaredExtras = {
  /** Declared extra packages as `name@range`, sorted for a stable signature. */
  entries: string[]
  /** Stable digest of the declared extras (`"none"` when nothing is declared). */
  signature: string
}

/**
 * Read the OPTIONAL per-session `package.json` and return its declared extra deps.
 *
 * Only `dependencies` are honored (the install surface). The provided vendor set is
 * never installed per session, so any provided specifier a session lists is dropped
 * here — it's served by the shared bundle regardless and must not fork React.
 * Sessions that ship no `package.json` (or an empty `dependencies`) report no extras
 * and keep the shared-install fast path untouched.
 */
async function readDeclaredExtras(workspace: string, uiPackageName: string): Promise<DeclaredExtras> {
  let manifest: { dependencies?: Record<string, string> }
  try {
    manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"))
  } catch {
    return { entries: [], signature: "none" }
  }
  const dependencies = manifest.dependencies
  if (!dependencies || typeof dependencies !== "object") {
    return { entries: [], signature: "none" }
  }
  const entries = Object.entries(dependencies)
    .filter(([name]) => !isProvidedVendorSpecifier(name, uiPackageName))
    .map(([name, range]) => `${name}@${range}`)
    .sort()
  return {
    entries,
    signature: entries.length ? createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16) : "none"
  }
}

/**
 * Install the declared extras into `workspace/node_modules` (a real, session-private
 * dir) and return that dir. Idempotent: a sidecar lockfile records the signature the
 * dir was installed for, so the install only re-runs when the declared extras change.
 *
 * Installs EXACTLY the declared extras (+ their transitive, non-provided deps). npm
 * resolves into a temp staging dir whose manifest has no dependencies, so the
 * workspace `package.json` is never read during install — even when each extra is
 * named explicitly, an in-place `npm install <extra>` would still ALSO pull the
 * workspace manifest's (provided/dev) deps. The staged `node_modules` then replaces
 * the session one, so the provided vendor set is never installed per session and the
 * workspace `package.json` (the source of truth for declared extras) is untouched.
 */
async function ensureSessionExtrasInstall(workspace: string, declaredExtras: DeclaredExtras): Promise<string> {
  const extrasDir = join(workspace, "node_modules")
  const lockfile = join(workspace, SESSION_EXTRAS_LOCKFILE)
  const installed = await readInstalledExtrasSignature(lockfile)
  // The lock signature alone is not enough: if extras were added → removed (which
  // reverts node_modules to the shared symlink) → re-added the same, the signature
  // matches but node_modules is the symlink, so the extras aren't actually present.
  // Only trust the lock when node_modules is a real (non-symlink) extras dir.
  if (installed === declaredExtras.signature && await isRealDirectory(extrasDir)) {
    return extrasDir
  }
  const staged = await installExtrasToStagingDir(workspace, declaredExtras)
  try {
    // Swap the staged extras install in for the session node_modules (replacing the
    // shared symlink or a stale extras dir from a prior signature).
    await rm(extrasDir, { recursive: true, force: true })
    await rename(staged, extrasDir)
  } finally {
    await rm(dirname(staged), { recursive: true, force: true })
  }
  await writeFile(lockfile, `${JSON.stringify({ signature: declaredExtras.signature, entries: declaredExtras.entries }, null, 2)}\n`, "utf8")
  return extrasDir
}

/**
 * Run `npm install <extra@range> ...` in a throwaway staging dir whose manifest has
 * no dependencies, and return the resulting `node_modules` path. Isolating the
 * install keeps npm from also resolving the session `package.json` deps (which
 * include the provided vendor set). The caller moves the result into the session.
 *
 * Staged next to `workspace` (not in the OS temp dir) so the follow-up `rename` into
 * the session stays on the same filesystem (avoids cross-device `EXDEV`).
 */
async function installExtrasToStagingDir(workspace: string, declaredExtras: DeclaredExtras): Promise<string> {
  const stagingDir = await mkdtemp(join(dirname(workspace), ".avibe-show-extras-"))
  await writeFile(
    join(stagingDir, "package.json"),
    `${JSON.stringify({ name: "avibe-show-session-extras", private: true }, null, 2)}\n`,
    "utf8"
  )
  await execFileAsync(npmExecutable(), [
    "install",
    ...declaredExtras.entries,
    "--no-save",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    "--prefix",
    stagingDir
  ], { cwd: stagingDir, env: process.env })
  return join(stagingDir, "node_modules")
}

/** Whether `path` is a real directory on disk (a symlink, file, or missing entry is not). */
async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    return stats.isDirectory()
  } catch {
    return false
  }
}

async function readInstalledExtrasSignature(lockfile: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockfile, "utf8")) as { signature?: string }
    return typeof parsed.signature === "string" ? parsed.signature : undefined
  } catch {
    return undefined
  }
}

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

type SourceDependencies = {
  entryRequests: string[]
  extraBareImports: string[]
  /** Per-session extras declared in the workspace `package.json` (`name@range`, sorted). */
  declaredExtras: DeclaredExtras
  signature: string
}

const SOURCE_DEPENDENCY_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts"])
const HTML_MODULE_SCRIPT_RE = /<script\b(?=[^>]*\btype\s*=\s*["']module["'])(?=[^>]*\bsrc\s*=\s*["']([^"']+)["'])[^>]*>/gi

async function sourceDependenciesForWorkspace(workspace: string, uiPackageName: string): Promise<SourceDependencies> {
  const extraBareImports = new Set<string>()
  const entries = await workspaceEntryFiles(workspace)
  for (const sourceFile of await reachableSourceFiles(entries.map((entry) => entry.file), workspace)) {
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
  const declaredExtras = await readDeclaredExtras(workspace, uiPackageName)
  // The signature keys both warm-change detection and the Vite optimize cache, so
  // it must move when EITHER the scanned bare imports OR the declared extras change
  // (a `package.json` version bump alone must still re-install + re-optimize).
  const signatureSource = `${sorted.join("\n")}\0${declaredExtras.signature}`
  return {
    entryRequests: entries.map((entry) => entry.request),
    extraBareImports: sorted,
    declaredExtras,
    signature: sorted.length || declaredExtras.entries.length
      ? createHash("sha256").update(signatureSource).digest("hex").slice(0, 16)
      : "shared"
  }
}

async function sourceDependencySignature(workspace: string, uiPackageName: string) {
  return (await sourceDependenciesForWorkspace(workspace, uiPackageName)).signature
}

async function workspaceEntryFiles(workspace: string): Promise<Array<{ file: string; request: string }>> {
  const entries = new Map<string, { file: string; request: string }>()
  try {
    const html = stripHtmlComments(await readFile(join(workspace, "index.html"), "utf8"))
    for (const match of html.matchAll(HTML_MODULE_SCRIPT_RE)) {
      const sourcePath = workspaceLocalImportPath(workspace, workspace, match[1])
      if (sourcePath) {
        entries.set(sourcePath, { file: sourcePath, request: normalizeViteRequestPath(match[1]) })
      }
    }
  } catch {
    // Fall back to the runtime-owned client shell when index.html is absent.
  }
  if (!entries.size) {
    const fallback = join(workspace, "src", "main.tsx")
    entries.set(fallback, { file: fallback, request: "/src/main.tsx" })
  }
  return [...entries.values()]
}

async function reachableSourceFiles(entries: string[], workspace: string): Promise<string[]> {
  const seen = new Set<string>()
  const queue = [...entries]
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
      const localPath = workspaceLocalImportPath(workspace, dirname(file), specifier)
      if (localPath) {
        queue.push(localPath)
      }
    }
    for (const localPath of await globSourceFiles(workspace, dirname(file), importGlobSpecifiers(source))) {
      queue.push(localPath)
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
  const tokens = javascriptTokens(source)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.value === "import") {
      const nextToken = tokens[index + 1]
      if (nextToken?.value === "(") {
        const specifierToken = tokens[index + 2]
        if (specifierToken?.kind === "string") {
          specifiers.push({ specifier: specifierToken.value })
        }
        continue
      }
      if (nextToken?.kind === "string") {
        specifiers.push({ specifier: nextToken.value })
        continue
      }
      const fromIndex = findNextKeyword(tokens, index + 1, "from")
      const specifierToken = fromIndex === undefined ? undefined : tokens[fromIndex + 1]
      if (specifierToken?.kind === "string" && !isTypeOnlyImportClause(tokens.slice(index + 1, fromIndex))) {
        specifiers.push({ specifier: specifierToken.value })
      }
      continue
    }
    if (token.value === "export") {
      const fromIndex = findNextKeyword(tokens, index + 1, "from")
      const specifierToken = fromIndex === undefined ? undefined : tokens[fromIndex + 1]
      if (specifierToken?.kind === "string" && !isTypeOnlyImportClause(tokens.slice(index + 1, fromIndex))) {
        specifiers.push({ specifier: specifierToken.value })
      }
      continue
    }
    if (token.value === "require" && tokens[index + 1]?.value === "(") {
      const specifierToken = tokens[index + 2]
      if (specifierToken?.kind === "string") {
        specifiers.push({ specifier: specifierToken.value })
      }
    }
  }
  return specifiers
}

function importGlobSpecifiers(source: string) {
  const specifiers: string[] = []
  const tokens = javascriptTokens(source)
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      tokens[index].value === "import" &&
      tokens[index + 1]?.value === "." &&
      tokens[index + 2]?.value === "meta" &&
      tokens[index + 3]?.value === "." &&
      tokens[index + 4]?.value === "glob" &&
      tokens[index + 5]?.value === "(" &&
      tokens[index + 6]?.kind === "string"
    ) {
      specifiers.push(tokens[index + 6].value)
    }
  }
  return specifiers
}

type JavaScriptToken = {
  kind: "identifier" | "string" | "punctuation"
  value: string
}

function javascriptTokens(source: string) {
  const tokens: JavaScriptToken[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (/\s/.test(char)) {
      index += 1
      continue
    }

    if (char === "/" && next === "/") {
      index += 2
      while (index < source.length && source[index] !== "\n") {
        index += 1
      }
      continue
    }

    if (char === "/" && next === "*") {
      index += 2
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1
      }
      index = Math.min(index + 2, source.length)
      continue
    }

    if (char === "\"" || char === "'") {
      const result = readQuotedString(source, index, char)
      tokens.push({ kind: "string", value: result.value })
      index = result.nextIndex
      continue
    }

    if (char === "`") {
      index = skipTemplateLiteral(source, index)
      continue
    }

    if (isIdentifierStart(char)) {
      const start = index
      index += 1
      while (index < source.length && isIdentifierPart(source[index])) {
        index += 1
      }
      tokens.push({ kind: "identifier", value: source.slice(start, index) })
      continue
    }

    tokens.push({ kind: "punctuation", value: char })
    index += 1
  }
  return tokens
}

function readQuotedString(source: string, start: number, quote: "\"" | "'") {
  let value = ""
  let index = start + 1
  let escaped = false
  while (index < source.length) {
    const char = source[index]
    if (escaped) {
      value += char
      escaped = false
    } else if (char === "\\") {
      escaped = true
    } else if (char === quote) {
      return { value, nextIndex: index + 1 }
    } else {
      value += char
    }
    index += 1
  }
  return { value, nextIndex: index }
}

function skipTemplateLiteral(source: string, start: number) {
  let index = start + 1
  let escaped = false
  while (index < source.length) {
    const char = source[index]
    if (escaped) {
      escaped = false
    } else if (char === "\\") {
      escaped = true
    } else if (char === "`") {
      return index + 1
    }
    index += 1
  }
  return index
}

function findNextKeyword(tokens: JavaScriptToken[], start: number, keyword: string) {
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === keyword) {
      return index
    }
    if (tokens[index].value === ";" || tokens[index].value === "\n") {
      return undefined
    }
  }
  return undefined
}

function isTypeOnlyImportClause(tokens: JavaScriptToken[]) {
  const meaningful = tokens.filter((token) => token.value !== "\n")
  if (!meaningful.length) {
    return false
  }
  if (meaningful[0].value === "type") {
    return true
  }
  if (meaningful[0].value !== "{" || meaningful[meaningful.length - 1].value !== "}") {
    return false
  }
  const body = meaningful.slice(1, -1)
  if (!body.length) {
    return false
  }
  let segment: JavaScriptToken[] = []
  for (const token of [...body, { kind: "punctuation" as const, value: "," }]) {
    if (token.value !== ",") {
      segment.push(token)
      continue
    }
    if (segment.length && (segment.length < 2 || segment[0].value !== "type")) {
      return false
    }
    segment = []
  }
  return true
}

function workspaceLocalImportPath(workspace: string, importerDir: string, specifier: string) {
  if (!isExecutableSourceSpecifier(specifier)) {
    return undefined
  }
  const path = stripViteImportSuffix(specifier)
  if (path.startsWith("./") || path.startsWith("../")) {
    return resolve(importerDir, path)
  }
  if (path.startsWith("/src/")) {
    return resolve(workspace, path.slice(1))
  }
  return undefined
}

async function globSourceFiles(workspace: string, importerDir: string, specifiers: string[]) {
  const files = new Set<string>()
  for (const specifier of specifiers) {
    const basePath = workspaceLocalImportPath(workspace, importerDir, specifier)
    if (!basePath) {
      continue
    }
    const pattern = normalizePath(relative(workspace, basePath))
    for (const file of await sourceFilesUnder(workspace)) {
      const relativeFile = normalizePath(relative(workspace, file))
      if (globMatches(pattern, relativeFile)) {
        files.add(file)
      }
    }
  }
  return [...files]
}

async function sourceFilesUnder(root: string) {
  const files: string[] = []
  async function visit(directory: string) {
    let entries = []
    try {
      entries = await readdir(directory, { encoding: "utf8", withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue
      }
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile() && SOURCE_DEPENDENCY_EXTENSIONS.has(extname(path))) {
        files.push(path)
      }
    }
  }
  await visit(root)
  return files
}

function globMatches(pattern: string, value: string) {
  const regex = new RegExp(`^${pattern.split(/(\*\*)|(\*)/g).filter(Boolean).map((part) => {
    if (part === "**") return ".*"
    if (part === "*") return "[^/]*"
    return escapeRegExp(part)
  }).join("")}$`)
  return regex.test(value)
}

function stripHtmlComments(source: string) {
  return source.replace(/<!--[\s\S]*?-->/g, "")
}

function stripViteImportSuffix(specifier: string) {
  const queryIndex = specifier.search(/[?#]/)
  return queryIndex === -1 ? specifier : specifier.slice(0, queryIndex)
}

function isExecutableSourceSpecifier(specifier: string) {
  const suffix = specifier.match(/[?#](.*)$/)?.[1]
  if (!suffix) {
    return true
  }
  const params = new URLSearchParams(suffix.replace(/^#/, ""))
  return params.has("worker") || params.has("sharedworker")
}

function normalizeViteRequestPath(path: string) {
  const normalized = stripViteImportSuffix(path)
  return normalized.startsWith("/") ? normalized : `/${normalized}`
}

function normalizePath(path: string) {
  return path.split(sep).join("/")
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function isIdentifierStart(char: string) {
  return /[A-Za-z_$]/.test(char)
}

function isIdentifierPart(char: string) {
  return /[A-Za-z0-9_$]/.test(char)
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

/** Resolve the dependency root whose `node_modules` is the shared, pinned install. */
async function resolveDependencyRoot(dependencyRoot?: string): Promise<string> {
  return dependencyRoot ? resolve(dependencyRoot) : await findNearestDependencyRoot()
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

function logTiming(event: string, sessionId: string, started: number, extra: Record<string, unknown> = {}) {
  const durationMs = Math.round(performance.now() - started)
  if (durationMs < SLOW_TIMING_MS) return
  console.error(JSON.stringify({
    level: "info",
    source: "show-runtime",
    event,
    sessionId,
    durationMs,
    ...extra
  }))
}
