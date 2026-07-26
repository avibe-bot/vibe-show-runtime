export const DEFAULT_LOCAL_DECISIONS_STORAGE_KEY = "avibe.show.decisions"

export type LocalDecisionValue = string | number | boolean | null | LocalDecisionValue[] | { [key: string]: LocalDecisionValue }

export type LocalDecision = {
  id: string
  label: string
  value: LocalDecisionValue
  scope?: string
  note?: string
  createdAt: string
  updatedAt: string
  [key: string]: unknown
}

export type LocalDecisionInput = {
  id: string
  label: string
  value: LocalDecisionValue
  scope?: string
  note?: string
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

export type LocalDecisionSnapshot = {
  version: 1
  updatedAt?: string
  decisions: LocalDecision[]
}

export type LocalDecisionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export type LocalDecisionStoreOptions = {
  storage?: LocalDecisionStorage
  storageKey?: string
  now?: () => Date | string
}

export type LocalDecisionStore = {
  loadSnapshot(): LocalDecisionSnapshot
  saveDecision(decision: LocalDecisionInput): LocalDecisionSnapshot
  removeDecision(id: string): LocalDecisionSnapshot
  clearDecisions(): LocalDecisionSnapshot
  exportDecisionsJson(): string
}

export function createLocalDecisionStore(options: LocalDecisionStoreOptions = {}): LocalDecisionStore {
  const storage = options.storage ?? defaultDecisionStorage()
  const storageKey = options.storageKey ?? DEFAULT_LOCAL_DECISIONS_STORAGE_KEY
  const now = options.now ?? (() => new Date())

  function readTimestamp() {
    const value = now()
    return typeof value === "string" ? value : value.toISOString()
  }

  function writeSnapshot(snapshot: LocalDecisionSnapshot) {
    storage.setItem(storageKey, JSON.stringify(snapshot))
    return snapshot
  }

  return {
    loadSnapshot() {
      return normalizeLocalDecisionSnapshot(readSnapshot(storage, storageKey))
    },
    saveDecision(decision) {
      const timestamp = readTimestamp()
      const snapshot = normalizeLocalDecisionSnapshot(readSnapshot(storage, storageKey))
      const existing = snapshot.decisions.find((item) => item.id === decision.id)
      const nextDecision: LocalDecision = {
        ...existing,
        ...decision,
        id: decision.id,
        label: decision.label,
        value: decision.value,
        createdAt: decision.createdAt ?? existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      const decisions = existing
        ? snapshot.decisions.map((item) => (item.id === decision.id ? nextDecision : item))
        : [...snapshot.decisions, nextDecision]
      return writeSnapshot({ version: 1, updatedAt: timestamp, decisions })
    },
    removeDecision(id) {
      const timestamp = readTimestamp()
      const snapshot = normalizeLocalDecisionSnapshot(readSnapshot(storage, storageKey))
      return writeSnapshot({
        version: 1,
        updatedAt: timestamp,
        decisions: snapshot.decisions.filter((decision) => decision.id !== id)
      })
    },
    clearDecisions() {
      storage.removeItem(storageKey)
      return { version: 1, decisions: [] }
    },
    exportDecisionsJson() {
      return JSON.stringify(normalizeLocalDecisionSnapshot(readSnapshot(storage, storageKey)), null, 2)
    }
  }
}

export function normalizeLocalDecisionSnapshot(value: unknown): LocalDecisionSnapshot {
  if (!value || typeof value !== "object") {
    return { version: 1, decisions: [] }
  }
  const snapshot = value as Partial<LocalDecisionSnapshot>
  const decisions = Array.isArray(snapshot.decisions) ? snapshot.decisions.filter(isLocalDecision) : []
  return {
    version: 1,
    updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : decisions.at(-1)?.updatedAt,
    decisions
  }
}

function readSnapshot(storage: LocalDecisionStorage, storageKey: string) {
  const raw = storage.getItem(storageKey)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function isLocalDecision(value: unknown): value is LocalDecision {
  if (!value || typeof value !== "object") return false
  const decision = value as Partial<LocalDecision>
  return (
    typeof decision.id === "string" &&
    decision.id.length > 0 &&
    typeof decision.label === "string" &&
    "value" in decision &&
    typeof decision.createdAt === "string" &&
    typeof decision.updatedAt === "string"
  )
}

function defaultDecisionStorage(): LocalDecisionStorage {
  if (typeof localStorage !== "undefined") {
    return localStorage
  }
  const items = new Map<string, string>()
  return {
    getItem(key) {
      return items.get(key) ?? null
    },
    setItem(key, value) {
      items.set(key, value)
    },
    removeItem(key) {
      items.delete(key)
    }
  }
}
