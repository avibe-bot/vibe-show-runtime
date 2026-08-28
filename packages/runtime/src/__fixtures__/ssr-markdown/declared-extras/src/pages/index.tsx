import { cjsExtra } from "show-extra-cjs"
import { esmExtra } from "show-extra-esm"

export default function DeclaredExtrasPage() {
  return (
    <main>
      <h1>Declared extras</h1>
      <p>ESM extra: {esmExtra}</p>
      <p>CommonJS extra: {cjsExtra}</p>
    </main>
  )
}
