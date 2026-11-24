import { stat } from "node:fs/promises"
import { isAbsolute, relative, sep } from "node:path"
import { isCSSRequest, normalizePath, type Plugin, type WatchOptions } from "vite"

const POLL_MS = 1_000
const ignored = new Set(["node_modules", "dist", "build", ".git"])

function authored(roots: string[], file: string): boolean {
  return roots.some((root) => {
    const path = relative(root, file)
    return !isAbsolute(path) && !path.split(sep).some((part) => part === ".." || ignored.has(part))
  })
}

export function workspaceWatchOptions(roots: string[]): WatchOptions {
  return {
    usePolling: true,
    interval: POLL_MS,
    binaryInterval: POLL_MS,
    followSymlinks: false,
    ignored: (file) => !authored(roots, file)
  }
}

async function signature(file: string) {
  try {
    const s = await stat(file, { bigint: true })
    return `${s.dev}:${s.ino}:${s.ctimeNs}:${s.mtimeNs}:${s.size}`
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined
    throw error
  }
}

// Chokidar drives normal Vite HMR (including plugin hooks and glob membership).
// HTTP requests need a separate guarantee: even a conditional GET between the
// write and the next poll must not hit Vite's pre-transform ETag shortcut.
export function workspaceFreshnessPlugin(roots: string[], sessionId: string): Plugin {
  // Keep each transform variant's own baseline: loading ?raw must not certify
  // an older transform of the same file. Sample BEFORE Vite reads its bytes.
  const loaded = new Map<string, string | undefined>()
  const globs = new Set<string>()
  return {
    name: "avibe-show-workspace-freshness",
    enforce: "pre",
    apply: "serve",
    async load(id) {
      if (this.environment.name !== "client") return
      const file = id.split("?", 1)[0]
      if (isAbsolute(file) && authored(roots, file)) loaded.set(id, await signature(file))
    },
    transform(code, id) {
      if (this.environment.name !== "client" || !loaded.has(id)) return
      // The router is a transform of directory membership, not just its own
      // bytes. Let Vite re-expand actual glob imports on request; don't mirror
      // Vite's glob language or recursively stat the tree on ordinary GETs.
      if (code.includes("import.meta.glob")) globs.add(id)
      else globs.delete(id)
    },
    configureServer(server) {
      if (server.watcher.options.usePolling) {
        console.error(JSON.stringify({ level: "info", source: "show-runtime", event: "workspace-watch", sessionId, mode: "polling", intervalMs: server.watcher.options.interval }))
      }
      server.middlewares.use((req, _res, next) => {
        const check = async () => {
          const url = decodeURI(req.url ?? "/")
          const graph = server.environments.client.moduleGraph
          let path = url.startsWith(server.config.base) ? `/${url.slice(server.config.base.length)}` : url
          // Match Vite's stylesheet negotiation; a browser's <link> uses a
          // different transform from the JS/CSS module imported by a script.
          if (isCSSRequest(path) && req.headers.accept?.includes("text/css") && !/[?&]direct(?:&|$)/.test(path)) {
            path = path.replace(/\?|$/, (separator) => separator ? "?direct&" : "?direct")
          }
          const mod = await graph.getModuleByUrl(path)
          if (!mod?.file || !mod.id || !authored(roots, mod.file)) return
          if (globs.has(mod.id) || !loaded.has(mod.id) || loaded.get(mod.id) !== await signature(mod.file)) {
            graph.onFileChange(normalizePath(mod.file))
          }
        }
        void check().then(() => next(), next)
      })
    }
  }
}
