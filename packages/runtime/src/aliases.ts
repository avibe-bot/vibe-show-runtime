import type { AliasOptions } from "vite"

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
