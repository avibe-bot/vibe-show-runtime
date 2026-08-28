import { createContext, forwardRef, useContext, type ReactNode } from "react"

export type SsrRouteLocation = {
  pathname: string
  search: string
  origin: string
  basePath: string
}

const SsrRouterContext = createContext<SsrRouteLocation | null>(null)

export const SsrRouterProvider = forwardRef(function SsrRouterProvider({
  location,
  children
}: {
  location: SsrRouteLocation
  children: ReactNode
}, _ref) {
  return <SsrRouterContext.Provider value={location}>{children}</SsrRouterContext.Provider>
})

export function useSsrRouteLocation(): SsrRouteLocation {
  const location = useContext(SsrRouterContext)
  if (!location) throw new Error("Missing SSR route location")
  return location
}
