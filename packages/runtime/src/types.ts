import type { Server } from "node:http"
import type { ViteDevServer } from "vite"
import type { AgentMark, MarkAnchor, ShowEvent, ShowEventInput } from "@avibe/show-sdk"

export type ShowRuntimeOptions = {
  workspaceRoot: string
  server?: Server
  dependencyRoot?: string
  cacheRoot?: string
  host?: string
  port?: number
  idleTtlMs?: number
  idlePruneIntervalMs?: number
  uiPackageName?: string
  fallbackDelaySeconds?: number
}

export type ShowSessionState = "created" | "warming" | "active" | "closing" | "idle" | "suspended"

export type ShowSessionStatus = {
  sessionId: string
  state: ShowSessionState
  workspace: string
  updatedAt: string
  lastAccessedAt?: string
  eventCount: number
  messageCount: number
}

export type ShowSession = {
  id: string
  workspace: string
  basePath?: string
  state: ShowSessionState
  updatedAt: Date
  lastAccessedAt?: Date
  vite?: ViteDevServer
  warming?: Promise<ShowSession>
  closing?: Promise<void>
  events: ShowEvent[]
  messages: ShowMessage[]
}

export type ShowRuntime = {
  ensureSession(sessionId: string, basePath?: string): Promise<ShowSessionStatus>
  getSessionStatus(sessionId: string): Promise<ShowSessionStatus>
  pruneIdleSessions(): Promise<ShowSessionStatus[]>
  getSession(sessionId: string): ShowSession | undefined
  suspendSession(sessionId: string): Promise<ShowSessionStatus>
  recordAgentMark(sessionId: string, mark: AgentMark, anchor?: MarkAnchor): ShowEvent
  recordShowEvent(sessionId: string, payload: ShowEventInput | ShowEvent): ShowEvent
  listSessionEvents(sessionId: string): ShowEvent[]
  listSessionMessages(sessionId: string): ShowMessage[]
  close(): Promise<void>
}

export type ShowMessage = {
  id: string
  role: "assistant" | "user" | "system"
  content: string
  createdAt: string
  eventId: string
}
