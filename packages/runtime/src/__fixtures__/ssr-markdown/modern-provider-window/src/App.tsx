export default function ModernProviderWindow() {
  let accessError = "none"
  try {
    void window.location.href
  } catch (error) {
    accessError = error instanceof Error ? error.name : "unknown"
  }

  return (
    <main>
      <h1>Modern provider window policy</h1>
      <p>Window present: {String("window" in globalThis)}</p>
      <p>Window access: {accessError}</p>
    </main>
  )
}
