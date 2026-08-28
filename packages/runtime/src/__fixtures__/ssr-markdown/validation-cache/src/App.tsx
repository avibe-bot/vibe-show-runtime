import { reportTitle } from "./content"

export default function App() {
  return (
    <main>
      <h1>{reportTitle}</h1>
      <p>The second uncached render reuses the live session's validated module graph.</p>
    </main>
  )
}
