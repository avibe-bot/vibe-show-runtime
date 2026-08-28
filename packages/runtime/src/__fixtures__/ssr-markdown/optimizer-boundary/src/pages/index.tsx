import { secret } from "show-optimizer-boundary-extra"

export default function OptimizerBoundaryPage() {
  return (
    <main>
      <h1>Optimizer boundary</h1>
      <p>{secret}</p>
    </main>
  )
}
