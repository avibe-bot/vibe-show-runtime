const loadError = new Error("Workspace load phase spoof") as Error & { phase: string }
loadError.phase = "conversion"
throw loadError

export default function App() {
  return <h1>Unreachable load phase fixture</h1>
}
