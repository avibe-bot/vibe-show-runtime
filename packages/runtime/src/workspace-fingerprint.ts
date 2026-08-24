import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, readFile, readdir, readlink, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

const WORKSPACE_FINGERPRINT_EXCLUDED_ENTRIES = new Set(["node_modules", ".git", "dist", "build"])
const DEFAULT_CONTENT_HASH_ENTRIES_PER_SESSION = 4_096
const DEFAULT_CONTENT_HASH_ENTRIES_GLOBAL = 16_384

export type WorkspaceFingerprinter = {
  fingerprint(sessionId: string, workspace: string): Promise<string>
  invalidateSession(sessionId: string): void
  clear(): void
}

export type WorkspaceFingerprinterOptions = {
  entriesPerSession?: number
  entriesGlobal?: number
  readFile?: (path: string) => Promise<Uint8Array>
}

type ContentHashMemoEntry = {
  sessionId: string
  localKey: string
  signature: string
  contentHash: string
}

export function createWorkspaceFingerprinter(
  options: WorkspaceFingerprinterOptions = {}
): WorkspaceFingerprinter {
  const entriesPerSession = positiveInteger(
    options.entriesPerSession,
    DEFAULT_CONTENT_HASH_ENTRIES_PER_SESSION
  )
  const entriesGlobal = positiveInteger(
    options.entriesGlobal,
    DEFAULT_CONTENT_HASH_ENTRIES_GLOBAL
  )
  const readWorkspaceFile = options.readFile ?? (async (path: string) => await readFile(path))
  const entries = new Map<string, ContentHashMemoEntry>()
  const sessionEntries = new Map<string, Map<string, string>>()

  function removeEntry(globalKey: string, entry: ContentHashMemoEntry): void {
    entries.delete(globalKey)
    const perSession = sessionEntries.get(entry.sessionId)
    perSession?.delete(entry.localKey)
    if (perSession?.size === 0) sessionEntries.delete(entry.sessionId)
  }

  function touchEntry(globalKey: string, entry: ContentHashMemoEntry): void {
    entries.delete(globalKey)
    entries.set(globalKey, entry)
    const perSession = sessionEntries.get(entry.sessionId)
    perSession?.delete(entry.localKey)
    perSession?.set(entry.localKey, globalKey)
  }

  function rememberEntry(globalKey: string, entry: ContentHashMemoEntry): void {
    const existing = entries.get(globalKey)
    if (existing) removeEntry(globalKey, existing)

    entries.set(globalKey, entry)
    let perSession = sessionEntries.get(entry.sessionId)
    if (!perSession) {
      perSession = new Map()
      sessionEntries.set(entry.sessionId, perSession)
    }
    perSession.set(entry.localKey, globalKey)

    while (perSession.size > entriesPerSession) {
      const oldest = perSession.entries().next()
      if (oldest.done) break
      const [localKey, oldestGlobalKey] = oldest.value
      perSession.delete(localKey)
      entries.delete(oldestGlobalKey)
    }
    if (perSession.size === 0) sessionEntries.delete(entry.sessionId)

    while (entries.size > entriesGlobal) {
      const oldest = entries.entries().next()
      if (oldest.done) break
      removeEntry(oldest.value[0], oldest.value[1])
    }
  }

  async function contentHash(
    sessionId: string,
    workspace: string,
    relativePath: string,
    path: string,
    info: BigIntStats
  ): Promise<string> {
    const normalizedPath = relativePath.replaceAll("\\", "/")
    const localKey = `${workspace}\0${normalizedPath}`
    const globalKey = `${sessionId}\0${localKey}`
    const signature = [
      info.size,
      info.mtimeNs,
      info.ctimeNs,
      info.dev,
      info.ino
    ].join(":")
    const existing = entries.get(globalKey)
    if (existing?.signature === signature) {
      touchEntry(globalKey, existing)
      return existing.contentHash
    }

    const digest = createHash("sha256")
      .update(await readWorkspaceFile(path))
      .digest("hex")
    rememberEntry(globalKey, {
      sessionId,
      localKey,
      signature,
      contentHash: digest
    })
    return digest
  }

  return {
    async fingerprint(sessionId, workspace) {
      const absoluteWorkspace = resolve(workspace)
      const hash = createHash("sha256")
      await fingerprintDirectory(
        absoluteWorkspace,
        "",
        hash,
        (relativePath, path, info) => contentHash(
          sessionId,
          absoluteWorkspace,
          relativePath,
          path,
          info
        )
      )
      return hash.digest("hex")
    },
    invalidateSession(sessionId) {
      const perSession = sessionEntries.get(sessionId)
      if (!perSession) return
      for (const globalKey of perSession.values()) entries.delete(globalKey)
      sessionEntries.delete(sessionId)
    },
    clear() {
      entries.clear()
      sessionEntries.clear()
    }
  }
}

export async function workspaceFingerprint(workspace: string): Promise<string> {
  const fingerprinter = createWorkspaceFingerprinter()
  return await fingerprinter.fingerprint(resolve(workspace), workspace)
}

async function fingerprintDirectory(
  workspace: string,
  relativeDirectory: string,
  hash: ReturnType<typeof createHash>,
  contentHash: (relativePath: string, path: string, info: BigIntStats) => Promise<string>
): Promise<void> {
  const directory = relativeDirectory ? join(workspace, relativeDirectory) : workspace
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    if (!relativeDirectory && WORKSPACE_FINGERPRINT_EXCLUDED_ENTRIES.has(entry.name)) continue
    const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name
    const path = join(workspace, relativePath)
    const info = await lstat(path, { bigint: true })
    hash.update(relativePath.replaceAll("\\", "/"))
    hash.update("\0")
    hash.update(info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "file")
    hash.update("\0")
    hash.update(info.size.toString())
    hash.update("\0")
    hash.update(info.mtimeNs.toString())
    hash.update("\0")

    if (info.isFile()) {
      hash.update(await contentHash(relativePath, path, info))
      hash.update("\0")
    } else if (info.isSymbolicLink()) {
      hash.update(await readlink(path))
      hash.update("\0")
      const target = await stat(path, { bigint: true }).catch(() => undefined)
      if (target) {
        hash.update(target.size.toString())
        hash.update("\0")
        hash.update(target.mtimeNs.toString())
        hash.update("\0")
      }
    }

    if (info.isDirectory()) {
      await fingerprintDirectory(workspace, relativePath, hash, contentHash)
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback
}
