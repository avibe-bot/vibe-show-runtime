import type { Server } from "node:http"
import type { ViteDevServer } from "vite"

export type ShowRuntimeOptions = {
  workspaceRoot: string
  server?: Server
  dependencyRoot?: string
  host?: string
  port?: number
  idleTtlMs?: number
  uiPackageName?: string
}

export type ShowSessionState = "created" | "warming" | "active" | "idle" | "suspended"

export type ShowSessionStatus = {
  sessionId: string
  state: ShowSessionState
  workspace: string
  updatedAt: string
  lastAccessedAt?: string
}

export type ShowSession = {
  id: string
  workspace: string
  state: ShowSessionState
  updatedAt: Date
  lastAccessedAt?: Date
  vite?: ViteDevServer
  warming?: Promise<ShowSession>
}

export type ShowRuntime = {
  ensureSession(sessionId: string): Promise<ShowSessionStatus>
  getSessionStatus(sessionId: string): ShowSessionStatus
  getSession(sessionId: string): ShowSession | undefined
  suspendSession(sessionId: string): Promise<ShowSessionStatus>
  close(): Promise<void>
}
