export default function App() {
  const renderError = new Error("Workspace render phase spoof") as Error & { phase: string }
  renderError.phase = "cleanup"
  throw renderError
}
