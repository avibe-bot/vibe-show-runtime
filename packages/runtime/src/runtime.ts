import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { createServer as createViteServer } from "vite"
import type { InlineConfig, Plugin, ViteDevServer } from "vite"
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
import { createDependencyResolver, type DependencyResolver } from "./vendor.js"

const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_IDLE_PRUNE_INTERVAL_MS = 5 * 60 * 1000
const SLOW_TIMING_MS = Number(process.env.VIBE_SHOW_RUNTIME_SLOW_TIMING_MS ?? "1000")
const viteCacheWarmLocks = new Map<string, Promise<void>>()
// One shared-install resolver per `node_modules` dir, built lazily on the first extras
// session that needs the fallback and reused across sessions. Anchored at the shared
// install so it resolves `import`-only packages (e.g. `@avibe/show-sdk/*`) that CJS
// `createRequire` cannot. Disposed in `close()`; a disposed entry is rebuilt on demand.
const sharedInstallResolvers = new Map<string, Promise<DependencyResolver>>()

function sharedInstallResolver(sharedNodeModules: string): Promise<DependencyResolver> {
  const existing = sharedInstallResolvers.get(sharedNodeModules)
  if (existing) return existing
  const built = createDependencyResolver(dirname(sharedNodeModules)).catch((error) => {
    if (sharedInstallResolvers.get(sharedNodeModules) === built) sharedInstallResolvers.delete(sharedNodeModules)
    throw error
  })
  sharedInstallResolvers.set(sharedNodeModules, built)
  return built
}

async function disposeSharedInstallResolvers() {
  const resolvers = [...sharedInstallResolvers.values()]
  sharedInstallResolvers.clear()
  await Promise.all(resolvers.map(async (resolver) => {
    await resolver.then((value) => value.cleanup()).catch(() => undefined)
  }))
}

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
    await disposeSharedInstallResolvers()
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
    const uiPackageName = options.uiPackageName ?? "@avibe/show-ui"
    await ensureSessionTemplate(session.workspace, uiPackageName)
    logTiming("warmSession.template", session.id, templateStarted)
    const dependencyRoot = await resolveDependencyRoot(options.dependencyRoot, uiPackageName)
    const vendorStarted = performance.now()
    const bundle = await ensureVendorBundle({
      dependencyRoot,
      vendorCacheRoot: defaultVendorCacheRoot(dependencyRoot, options.cacheRoot),
      uiPackageName
    })
    vendorBundle = bundle
    // The bundle's manifest IS the authoritative provided set (exactly what the
    // bundle + import map cover). Externalize + optimize filtering key off it so the
    // browser never sees a bare specifier the import map can't resolve.
    const providedSpecifiers = bundle.result.manifest.specifiers
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
          allow: [session.workspace, sharedDependencies.nodeModules, sharedDependencies.sharedNodeModules, ...sharedDependencies.packageRoots],
          deny: []
        }
      },
      plugins: [
        vendorImportMapPlugin(bundle),
        ...createVendorExternalizePlugins(providedSpecifiers),
        // Extras sessions resolve their own declared extras from workspace/node_modules;
        // any other non-provided shared dep falls back to the shared install here (no
        // parent symlink). Skipped when node_modules already IS the shared install.
        ...(sharedDependencies.nodeModules === sharedDependencies.sharedNodeModules
          ? []
          : [sharedResolveFallbackPlugin(sharedDependencies.sharedNodeModules, providedSpecifiers)]),
        showHmrTransitionPlugin({ fallbackDelaySeconds: options.fallbackDelaySeconds }),
        // Tailwind v4 is a built-in runtime capability: `src/styles.css` opts in with
        // `@import "tailwindcss";` (see templates.ensureSessionTemplate), and the plugin
        // scans the workspace `src/**` for utility classes. It only transforms CSS, so it
        // composes with the vendor import-map/externalize plugins (which own JS specifiers)
        // and never sees a bare module they resolve.
        tailwindcss(),
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
        //
        // For extras sessions, a non-provided bare import that does NOT resolve from
        // the session's own node_modules (it lives only in the shared install) is left
        // OUT of `include`: Vite's optimizer can't pre-bundle it from the session root,
        // and the shared resolve fallback serves it on demand instead. Keeping it in
        // `include` would only emit a misleading "Failed to resolve dependency" warning.
        include: await optimizableBareImports(
          sourceDependencies.extraBareImports.filter((specifier) => !isProvidedVendorSpecifier(specifier, providedSpecifiers)),
          sharedDependencies.nodeModules,
          sharedDependencies.sharedNodeModules
        )
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
  /** The shared, pinned install dir (`<dependencyRoot>/node_modules`). */
  sharedNodeModules: string
  /** Extra dirs to add to `server.fs.allow` beyond the shared install + package roots. */
  packageRoots: string[]
  /** Signature of the declared extras the workspace was installed against. */
  extrasSignature: string
}

/**
 * Resolve a session's dependency layering and (re)install per-session extras.
 *
 * The shared install is reached two different ways depending on the layer, but the
 * runtime NEVER mutates anything outside the session's own `workspace/node_modules`
 * (a host app could be configured with `workspaceRoot` pointing at its own root):
 *  - **No declared extras** (today's behavior, unchanged): `workspace/node_modules`
 *    is a symlink to the shared, pinned install — that single dir resolves every
 *    non-provided dep the app uses, and the session shares the global optimize cache.
 *  - **Declared extras**: install ONLY the declared extras (+ their transitive,
 *    non-provided deps) into `workspace/node_modules` as a real, session-private dir.
 *    Vite resolves the extras from there first; any OTHER non-provided shared dep the
 *    app imports is served by the shared-install resolve fallback (`sharedResolveFallbackPlugin`,
 *    wired in `warmSession`), NOT by a symlink into a parent dir. The provided vendor
 *    set (react, `@avibe/show-ui/*`, ...) is never installed per session — it stays
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
    return { nodeModules: sharedNodeModules, sharedNodeModules, packageRoots, extrasSignature: "shared" }
  }

  // Extras: the session node_modules becomes the private extras install. Non-provided
  // shared deps stay reachable via the resolve fallback (see warmSession), so we never
  // touch a parent/shared `node_modules` that may be a real host directory.
  const extrasDir = await ensureSessionExtrasInstall(workspace, declaredExtras)
  // `@tailwindcss/vite` resolves `@import "tailwindcss";` from the workspace by filesystem
  // walk-up (its own resolver, NOT Vite's JS resolve pipeline — so `sharedResolveFallbackPlugin`
  // can't reach it). An extras session's node_modules holds only the declared extras, so link
  // the runtime-owned `tailwindcss` package in from the shared install. Shared-only sessions
  // already resolve it through the whole-node_modules symlink above.
  await ensureSharedPackageLink(extrasDir, sharedNodeModules, "tailwindcss")
  // The workspace Tailwind entry also `@import`s the UI theme (`@avibe/show-ui/theme.css`),
  // resolved by the same filesystem walk-up. Link the runtime-owned UI package in so extras
  // sessions can resolve the theme + its `@source`d components. (JS imports of the package
  // stay externalized to the shared vendor bundle; this symlink only serves CSS resolution.)
  await ensureSharedPackageLink(extrasDir, sharedNodeModules, uiPackageName)
  return {
    nodeModules: extrasDir,
    sharedNodeModules,
    packageRoots: [...packageRoots, extrasDir, sharedNodeModules],
    extrasSignature: declaredExtras.signature
  }
}

/**
 * Symlink one runtime-owned package from the shared install into a session's private
 * (extras) `node_modules`, so a tool that resolves it by filesystem walk-up from the
 * workspace (e.g. `@tailwindcss/vite` resolving `@import "tailwindcss";`) finds it without
 * forking it per session. Idempotent and confined to the session's own node_modules.
 *
 * Replaces any NON-shared occupant: a directly-declared `tailwindcss` extra is dropped by
 * `isRuntimeOwnedDependency`, but an extra can still pull `tailwindcss` in as a peer/
 * transitive dep, leaving a real (possibly version-mismatched, or even v3) copy here.
 * `@tailwindcss/vite` resolves the workspace copy first, so that drifted copy must be
 * swapped for the runtime-owned one or the page can render unstyled. No-ops when the
 * shared install doesn't provide the package.
 */
async function ensureSharedPackageLink(nodeModules: string, sharedNodeModules: string, packageName: string) {
  const target = join(sharedNodeModules, packageName)
  try {
    await access(target)
  } catch {
    return
  }
  const linkPath = join(nodeModules, packageName)
  try {
    const stats = await lstat(linkPath)
    if (stats.isSymbolicLink()) {
      const currentTarget = resolve(dirname(linkPath), await readlink(linkPath))
      if (currentTarget === resolve(target)) return
      await rm(linkPath)
    } else {
      // A per-session or transitively-installed copy — replace it with the runtime-owned
      // package so `@import "tailwindcss";` can't resolve a drifted/incompatible version.
      // (Guarded: linkPath is always inside the session's own extras node_modules.)
      await rm(linkPath, { recursive: true, force: true })
    }
  } catch {
    // Nothing at the link path yet; create it below.
  }
  // Ensure the scope dir exists for a scoped package (e.g. `@avibe/show-ui` → `@avibe/`).
  await mkdir(dirname(linkPath), { recursive: true })
  await symlink(target, linkPath, "junction")
}

/**
 * Point the session-owned `linkPath` (`workspace/node_modules`) at the shared install,
 * replacing any stale symlink target or a session-private extras dir from a prior warm.
 *
 * Only ever called for the session's OWN `workspace/node_modules` — never a parent or
 * shared dir — so removing a real directory here is safe (it can only be this session's
 * earlier extras install). It refuses to delete anything else as a guardrail.
 */
async function ensureSharedSymlink(linkPath: string, sharedNodeModules: string) {
  try {
    const stats = await lstat(linkPath)
    if (stats.isSymbolicLink()) {
      const currentTarget = resolve(dirname(linkPath), await readlink(linkPath))
      if (currentTarget === sharedNodeModules) return
      await rm(linkPath)
    } else {
      // A previous extras warm left this session's real node_modules here; clear it
      // before linking. (Guarded: `linkPath` is always the session-owned dir.)
      await rm(linkPath, { recursive: true, force: true })
    }
  } catch {
    // Nothing to replace; create the link below.
  }
  await symlink(sharedNodeModules, linkPath, "junction")
}

/**
 * A Vite resolve FALLBACK that serves a session's non-provided bare imports from the
 * shared, pinned install when the session's own `node_modules` can't resolve them.
 *
 * Used only for declared-extras sessions, whose `workspace/node_modules` holds ONLY the
 * declared extras (so a bare import of any other shared dep would otherwise fail). This
 * replaces the old parent symlink at `workspaceRoot/node_modules`, which could clobber a
 * host app's real `node_modules`.
 *
 * It deliberately serves `@avibe/show-sdk` (+ subpaths): the SDK ships its values from
 * the shared install but is NOT part of the vendor bundle/import map (it's filtered out
 * of the per-session extras install as runtime-owned), so without this fallback a page
 * importing an SDK value in an extras session would have no resolver. The skip-set is
 * aligned with what is ACTUALLY externalized — the React family + the EXACT members of
 * the vendor manifest's provided set (`isProvidedVendorSpecifier`, the same source of
 * truth `createVendorExternalizePlugins` uses). A `@avibe/show-ui` subpath NOT in the
 * manifest (e.g. a custom UI package whose wildcard `exports` couldn't be enumerated)
 * is therefore neither externalized here nor skipped — it falls through to the shared
 * resolver below, matching the shared-only session (where the symlink would resolve it).
 * Local/virtual ids are left to Vite.
 *
 * Resolution goes through an `import.meta.resolve` resolver anchored at the shared
 * install (not CJS `createRequire`, which throws `ERR_PACKAGE_PATH_NOT_EXPORTED` on the
 * `import`-only `@avibe/show-sdk/*` subpaths).
 */
function sharedResolveFallbackPlugin(sharedNodeModules: string, providedSpecifiers: string[]): Plugin {
  return {
    name: "avibe-show-shared-resolve-fallback",
    enforce: "post",
    apply: "serve",
    async resolveId(source, importer, options) {
      if (!isBareImport(source) || isExternalizedImport(source, providedSpecifiers)) {
        return null
      }
      // Only act as a fallback: defer to the session's own resolution first.
      const own = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (own) return null
      try {
        return (await sharedInstallResolver(sharedNodeModules)).resolveToPath(source)
      } catch {
        return null
      }
    }
  }
}

/**
 * Whether the shared-install fallback must leave a bare specifier alone because it is
 * already externalized for the import map (resolved there, never forked here). This is
 * the EXACT externalized set, so the fallback's skip-list and the externalizer stay in
 * lockstep:
 *  - the React family (singletons that must collapse to the one shared copy), and
 *  - the exact members of the vendor manifest's provided specifiers
 *    (`isProvidedVendorSpecifier` — the same source of truth the externalize plugins
 *    use).
 *
 * Everything else falls through to `this.resolve` → the shared resolver, INCLUDING a
 * `@avibe/show-ui` subpath that is NOT in the manifest (e.g. a custom UI package whose
 * wildcard `exports` couldn't be enumerated): the externalizer leaves such a subpath
 * bare-unresolved, so the fallback must serve it from the shared install — exactly as
 * the symlink would in a shared-only session. `@avibe/show-sdk` (runtime-owned but NOT
 * in the bundle/import map) likewise falls through, so the fallback is its resolver.
 * Specifiers actually in the vendor import map (e.g. `motion/react`, `lucide-react`)
 * are short-circuited by the `enforce: "pre"` externalize plugin before this `post`
 * fallback runs; a non-provided bare dep like `motion` is still served from the shared
 * install, unchanged.
 */
function isExternalizedImport(specifier: string, providedSpecifiers: string[]): boolean {
  return isReactFamilyImport(specifier) || isProvidedVendorSpecifier(specifier, providedSpecifiers)
}

/** The React singletons that must always collapse to the one shared, externalized copy. */
function isReactFamilyImport(specifier: string): boolean {
  return specifier === "react" ||
    specifier === "react-dom" ||
    specifier === "react-dom/client" ||
    specifier.startsWith("react/")
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
 * Only `dependencies` are honored (the install surface). The runtime-owned deps (the
 * React family + the whole `@avibe/show-ui` / `@avibe/show-sdk` packages) are never
 * installed per session — any a session lists is dropped here; they're served by the
 * shared bundle / shared install regardless and must not fork React. Sessions that
 * ship no `package.json` (or an empty `dependencies`) report no extras and keep the
 * shared-install fast path untouched.
 *
 * This uses a build-independent ownership predicate (not the import-map externalize
 * set) so the declared-extras signature is stable on the hot reuse path, which has no
 * built bundle to read the manifest from.
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
    .filter(([name]) => !isRuntimeOwnedDependency(name, uiPackageName))
    .map(([name, range]) => `${name}@${anchorLocalRange(range, workspace)}`)
    .sort()
  return {
    entries,
    signature: entries.length ? createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16) : "none"
  }
}

/**
 * Rewrite a relative `file:`/`link:` dependency range so it is anchored at the session
 * `workspace`, not the throwaway staging dir the extras are installed from.
 *
 * The per-session extras install runs npm with cwd/`--prefix` = a staging dir (so the
 * workspace `package.json`'s provided/dev deps are never pulled in). A relative local
 * spec like `file:../local` (or `link:`) would therefore resolve against the staging dir,
 * not the workspace that declared it — pointing at the wrong directory (or nowhere). We
 * make it absolute up front. Absolute local specs and every registry/git/url range are
 * left untouched, and the absolute path is folded into the extras signature so a moved
 * target re-installs.
 */
function anchorLocalRange(range: string, workspace: string): string {
  const match = /^(file|link):(.*)$/.exec(range)
  if (!match) return range
  const [, scheme, target] = match
  if (isAbsolute(target)) return range
  return `${scheme}:${resolve(workspace, target)}`
}

/**
 * Whether a declared dependency NAME is owned by the runtime and must never be
 * installed per session. Prefix-matches the whole `@avibe/show-ui` / `@avibe/show-sdk`
 * packages (every subpath shares the shared install) plus the React family, `motion`,
 * and `lucide-react`. `tailwindcss` is owned too: its CSS engine version must match the
 * runtime's `@tailwindcss/vite`/oxide, so it is linked in from the shared install
 * (see ensureSharedPackageLink) rather than forked per session. Distinct from the
 * import-map externalize set (exact-match): ownership is broader than what the bundle
 * enumerates.
 */
function isRuntimeOwnedDependency(name: string, uiPackageName: string): boolean {
  return name === "react" ||
    name === "react-dom" ||
    name.startsWith("react/") ||
    name.startsWith("react-dom/") ||
    name === "motion" ||
    name.startsWith("motion/") ||
    name === "lucide-react" ||
    name === "tailwindcss" ||
    name === uiPackageName ||
    name.startsWith(`${uiPackageName}/`) ||
    name === "@avibe/show-sdk" ||
    name.startsWith("@avibe/show-sdk/")
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
 * Run `npm install <extra@range> ... --ignore-scripts` in a throwaway staging dir
 * whose manifest has no dependencies, and return the resulting `node_modules` path.
 * Isolating the install keeps npm from also resolving the session `package.json` deps
 * (which include the provided vendor set); `--ignore-scripts` keeps agent/user-authored
 * declared or transitive lifecycle scripts from running on the runtime host. The caller
 * moves the result into the session.
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
    // Session `package.json` deps are agent/user-authored, so a declared or transitive
    // package's lifecycle scripts (postinstall/prepare/...) would run arbitrary code on
    // the runtime host during warm. Never execute them for per-session extras.
    "--ignore-scripts",
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

/**
 * Filter `optimizeDeps.include` to specifiers Vite's dep optimizer can actually resolve
 * from the session's own `node_modules`.
 *
 * Shared-only sessions resolve everything from the single shared dir, so the list is
 * returned unchanged. For extras sessions, a specifier that resolves ONLY from the
 * shared install (not the session's extras-only dir) is dropped: the optimizer (rooted
 * at the session) can't pre-bundle it, and the shared resolve fallback serves it on
 * demand. Keeping it would just emit a misleading "Failed to resolve dependency" warning.
 */
async function optimizableBareImports(specifiers: string[], nodeModules: string, sharedNodeModules: string): Promise<string[]> {
  if (nodeModules === sharedNodeModules) return specifiers
  // Anchor a resolver at the session workspace (the parent of its extras node_modules).
  const sessionRequire = createRequire(join(dirname(nodeModules), "__avibe-show-session-resolver.js"))
  return specifiers.filter((specifier) => {
    try {
      sessionRequire.resolve(specifier)
      return true
    } catch {
      return false
    }
  })
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
async function resolveDependencyRoot(dependencyRoot?: string, uiPackageName = "@avibe/show-ui"): Promise<string> {
  if (!dependencyRoot) {
    return await findNearestDependencyRoot(uiPackageName)
  }
  const root = resolve(dependencyRoot)
  const missing = await missingDependencyRootPackages(root, uiPackageName)
  if (missing.length) {
    throw new Error(`Invalid Show Runtime dependency root ${root}: missing ${missing.join(", ")}`)
  }
  return root
}

async function findNearestDependencyRoot(uiPackageName = "@avibe/show-ui") {
  let current = dirname(fileURLToPath(import.meta.url))
  const skipped: string[] = []
  while (current !== dirname(current)) {
    const candidate = join(current, "node_modules")
    try {
      await access(candidate)
      const missing = await missingDependencyRootPackages(current, uiPackageName)
      if (missing.length === 0) {
        return current
      }
      skipped.push(`${candidate} (missing ${missing.join(", ")})`)
    } catch {
      // No node_modules at this level.
    }
    current = dirname(current)
  }
  const detail = skipped.length ? `; skipped incomplete candidates: ${skipped.join("; ")}` : ""
  throw new Error(`Unable to locate shared node_modules for Show Runtime${detail}`)
}

async function missingDependencyRootPackages(dependencyRoot: string, uiPackageName: string): Promise<string[]> {
  const required = ["react", "react-dom", uiPackageName, "@avibe/show-sdk"]
  const missing: string[] = []
  for (const packageName of required) {
    const packageJson = join(packageRoot(dependencyRoot, packageName), "package.json")
    try {
      await access(packageJson)
    } catch {
      missing.push(packageName)
    }
  }
  return missing
}

function packageRoot(dependencyRoot: string, packageName: string) {
  return packageName.split("/").reduce((current, part) => join(current, part), join(dependencyRoot, "node_modules"))
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
