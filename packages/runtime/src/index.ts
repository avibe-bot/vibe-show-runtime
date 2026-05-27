import type { AliasOptions } from "vite"

export type ShowRuntimeOptions = {
  workspaceRoot: string
  uiPackageName?: string
}

export type ShowSessionState = "created" | "warming" | "active" | "idle" | "suspended"

export type ShowSessionStatus = {
  sessionId: string
  state: ShowSessionState
  workspace: string
  updatedAt: string
}

export function createShadcnAlias(uiPackageName = "@avibe/show-ui"): AliasOptions {
  return [
    {
      find: /^@\/components\/ui\/(.+)$/,
      replacement: `${uiPackageName}/$1`
    },
    {
      find: "@/lib/utils",
      replacement: `${uiPackageName}/utils`
    }
  ]
}

export function createShowRuntime(options: ShowRuntimeOptions) {
  return {
    options,
    getViteResolveAlias(): AliasOptions {
      return createShadcnAlias(options.uiPackageName)
    }
  }
}
