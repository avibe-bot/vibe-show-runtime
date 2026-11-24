import { lstat, readdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import type { ViteDevServer } from "vite"

const POLL_MS = 1_000
const excluded = new Set(["node_modules", ".git", "dist", "build", ".vite-cache", ".show-vendor"])
type FileStamp = { identity: string; mtime: bigint; link: boolean }
type Snapshot = Map<string, FileStamp>

// Metadata only. Follow the workspace root (it can itself be a symlink),
// never directory entries that point elsewhere. A symlink's own identity is
// part of the snapshot; authorized targets in the workspace are scanned once.
export async function workspaceSnapshot(workspace: string, excludeDir?: string): Promise<Snapshot> {
  const files: Snapshot = new Map()
  async function visit(dir: string) {
    // Dirent is a hint from the parent listing. Recheck before and after the
    // listing so a replaced directory cannot admit its target's children.
    if (await realpath(dir) !== dir) return
    const entries = await readdir(dir, { withFileTypes: true })
    if (await realpath(dir) !== dir) return
    for (const entry of entries) {
      const file = join(dir, entry.name)
      if (excluded.has(entry.name) || file === excludeDir) continue
      try {
        if (entry.isDirectory()) await visit(file)
        else {
          const s = await lstat(file, { bigint: true })
          files.set(file, { identity: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`, mtime: s.mtimeMs, link: s.isSymbolicLink() })
        }
      } catch (error) {
        // A save/rename overlapped the scan. Never follow a vanished entry.
        if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
      }
    }
  }
  await visit(await realpath(workspace))
  return files
}

// The request preflight and the timer consume ONE ordered history. A request
// arriving during a scan gets the following pass, never a sample started
// before that request. Concurrent waiters for that following pass share it.
export function observeWorkspace(
  workspace: string, sessionId: string, vite: ViteDevServer, initial: Snapshot, excludeDir?: string
) {
  let previous = initial
  let requiresWarm = false
  let closed = false
  let running: Promise<void> | undefined
  let queued: Promise<void> | undefined
  async function scan() {
    if (closed || requiresWarm) return
    const current = await workspaceSnapshot(workspace, excludeDir)
    if (closed) return
    const changed: string[] = []
    for (const [file, signature] of current) {
      const old = previous.get(file)
      if (old?.identity === signature.identity) continue
      // Fast path only for ordinary source edits with the runtime-owned plugin
      // stack. Config, resolution and compiler inputs have caches outside the
      // graph; a non-increasing mtime can fool Tailwind's internal scanner.
      if (!old || old.link || signature.link || signature.mtime <= old.mtime || vite.config.configFile ||
          !/\.[cm]?[jt]sx?$/i.test(file) || /(?:^|[\\/])[^\\/]*config\.[^\\/]+$/i.test(file)) requiresWarm = true
      changed.push(file)
    }
    if (previous.size !== current.size) requiresWarm = true
    previous = current
    if (requiresWarm) {
      // Module resolution (not just transforms) and public-file/glob indexes
      // depend on tree membership. Reuse the runtime's normal warm path on the
      // next request, including the reload requested by an already-open page.
      vite.ws.send({ type: "full-reload" })
    } else if (changed.length) {
      // A cached module may inline other inputs (e.g. CSS @import), or have
      // multiple URL/query variants. Invalidate before ANY conditional GET;
      // then let Vite deliver its normal plugin hooks and React HMR messages.
      for (const env of Object.values(vite.environments)) env.moduleGraph.invalidateAll()
      for (const file of changed) vite.watcher.emit("change", file)
    }
  }
  function startScan() {
    running = scan().finally(() => { running = undefined })
    return running
  }
  async function check() {
    if (!running) await startScan()
    else {
      queued ??= running.catch(() => {}).then(() => { queued = undefined; return startScan() })
      await queued
    }
    return !requiresWarm
  }
  const timer = setInterval(() => {
    if (!running && !closed && !requiresWarm) void check().catch((error) => {
      console.error(JSON.stringify({ level: "warn", source: "show-runtime", event: "workspace-poll-error", sessionId, message: String(error) }))
    })
  }, POLL_MS)
  timer.unref()
  console.error(JSON.stringify({ level: "info", source: "show-runtime", event: "workspace-watch", sessionId, mode: "polling", intervalMs: POLL_MS }))
  return { check, close() { closed = true; clearInterval(timer) } }
}
