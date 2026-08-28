import type { ReactNode } from "react"

const browserWidth = window.innerWidth

export function SsrRouterProvider({ children }: { children: ReactNode }) {
  return children
}

export function RouterView() {
  return <p>Browser width: {browserWidth}</p>
}
