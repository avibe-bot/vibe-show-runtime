import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MarkdownRenderError, workspaceFingerprint } from "./markdown-renderer.js"
import type { ShowRuntime } from "./types.js"

export type RenderSnapshot = {
  sessionId: string
  fingerprint: string
  outDir: string
}

export type RenderSnapshotManager = {
  prepare(sessionId: string, workspace: string, basePath: string): Promise<RenderSnapshot>
  get(sessionId: string): RenderSnapshot | undefined
  invalidateSession(sessionId: string): Promise<void>
  close(): Promise<void>
}

export function createRenderSnapshotManager(runtime: ShowRuntime): RenderSnapshotManager {
  const snapshots = new Map<string, RenderSnapshot>()
  const preparations = new Map<string, Promise<RenderSnapshot>>()
  const generations = new Map<string, number>()
  let rootPromise: Promise<string> | undefined
  let closed = false

  const snapshotRoot = (): Promise<string> => {
    rootPromise ??= mkdtemp(join(tmpdir(), "avibe-show-render-snapshots-"))
      .then((path) => realpath(path))
    return rootPromise
  }

  async function prepareSnapshot(
    sessionId: string,
    workspace: string,
    basePath: string,
    generation: number
  ): Promise<RenderSnapshot> {
    try {
      // This is the single dependency-preparation owner shared with live serving.
      // It awaits the session's existing warm state and never creates a parallel runtime.
      await runtime.prepareSessionSnapshot(sessionId)
      const fingerprint = await workspaceFingerprint(workspace)
      const existing = snapshots.get(sessionId)
      if (existing?.fingerprint === fingerprint && await snapshotExists(existing)) {
        return existing
      }

      const digest = createHash("sha256")
        .update(`${sessionId}\0${fingerprint}`)
        .digest("hex")
        .slice(0, 24)
      const outDir = join(await snapshotRoot(), digest)
      try {
        await runtime.buildSessionSnapshot(sessionId, { basePath, outDir })
      } catch (error) {
        await rm(outDir, { force: true, recursive: true }).catch(() => undefined)
        throw snapshotBuildFailed(error)
      }

      if (closed || (generations.get(sessionId) ?? 0) !== generation) {
        await rm(outDir, { force: true, recursive: true }).catch(() => undefined)
        throw snapshotBuildFailed(new Error("Snapshot build was invalidated"))
      }
      const snapshot = { sessionId, fingerprint, outDir }
      snapshots.set(sessionId, snapshot)
      if (existing && existing.outDir !== outDir) {
        await rm(existing.outDir, { force: true, recursive: true }).catch(() => undefined)
      }
      return snapshot
    } catch (error) {
      if (error instanceof MarkdownRenderError) throw error
      throw snapshotBuildFailed(error)
    }
  }

  return {
    async prepare(sessionId, workspace, basePath) {
      if (closed) throw snapshotBuildFailed(new Error("Snapshot manager is closed"))
      const pending = preparations.get(sessionId)
      if (pending) return await pending

      const generation = generations.get(sessionId) ?? 0
      const preparing = prepareSnapshot(sessionId, workspace, basePath, generation)
      preparations.set(sessionId, preparing)
      try {
        return await preparing
      } finally {
        if (preparations.get(sessionId) === preparing) preparations.delete(sessionId)
      }
    },
    get(sessionId) {
      return snapshots.get(sessionId)
    },
    async invalidateSession(sessionId) {
      generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1)
      await preparations.get(sessionId)?.catch(() => undefined)
      const snapshot = snapshots.get(sessionId)
      snapshots.delete(sessionId)
      if (snapshot) {
        await rm(snapshot.outDir, { force: true, recursive: true }).catch(() => undefined)
      }
    },
    async close() {
      if (closed) return
      closed = true
      for (const sessionId of new Set([...snapshots.keys(), ...preparations.keys()])) {
        generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1)
      }
      await Promise.allSettled(preparations.values())
      preparations.clear()
      snapshots.clear()
      if (rootPromise) {
        await rm(await rootPromise, { force: true, recursive: true }).catch(() => undefined)
      }
    }
  }
}

async function snapshotExists(snapshot: RenderSnapshot): Promise<boolean> {
  try {
    return (await stat(join(snapshot.outDir, "index.html"))).isFile()
  } catch {
    return false
  }
}

function snapshotBuildFailed(error: unknown): MarkdownRenderError {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown build error")
  const summary = raw
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "Unknown build error"
  const concise = summary.length > 300 ? `${summary.slice(0, 297)}...` : summary
  return new MarkdownRenderError(
    "render_failed",
    502,
    `Show Page build failed: ${concise}`,
    { cause: error }
  )
}
