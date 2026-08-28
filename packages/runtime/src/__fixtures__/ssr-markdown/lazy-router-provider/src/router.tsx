import { lazy } from "react"

export const SsrRouterProvider = lazy(async () => ({
  default: function LazyRouterProvider() {
    return null
  }
}))
