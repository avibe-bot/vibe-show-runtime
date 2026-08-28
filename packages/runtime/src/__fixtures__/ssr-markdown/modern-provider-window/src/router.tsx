import type { ReactNode } from "react"

export function SsrRouterProvider({ children }: { location: unknown; children: ReactNode }) {
  return children
}
