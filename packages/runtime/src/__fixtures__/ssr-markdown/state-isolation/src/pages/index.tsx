import type { PageProps } from "../../router"

let renderCount = 0
let initializedOwner: string | undefined

export default function StateIsolationFixture({ query }: PageProps) {
  renderCount += 1
  initializedOwner ??= query.get("owner") ?? "missing"
  return (
    <main>
      <h1>State isolation fixture</h1>
      <p>Render count: {renderCount}</p>
      <p>Initialized owner: {initializedOwner}</p>
    </main>
  )
}
