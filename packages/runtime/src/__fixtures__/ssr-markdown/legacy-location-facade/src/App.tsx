export default function LegacyLocationFacade() {
  const originalPathname = window.location.pathname
  let mutationError = "none"
  try {
    window.location.pathname = "/mutated"
  } catch (error) {
    mutationError = error instanceof Error ? error.name : "unknown"
  }

  const report = {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    href: window.location.href,
    origin: window.location.origin,
    windowKeys: Reflect.ownKeys(window).map(String).sort(),
    locationKeys: Reflect.ownKeys(window.location).map(String).sort(),
    windowPrototypeNull: Object.getPrototypeOf(window) === null,
    locationPrototypeNull: Object.getPrototypeOf(window.location) === null,
    windowFrozen: Object.isFrozen(window),
    locationFrozen: Object.isFrozen(window.location),
    documentPresent: "document" in globalThis,
    historyPresent: "history" in window,
    eventLifecyclePresent: "addEventListener" in window,
    mutationError,
    pathnameUnchanged: window.location.pathname === originalPathname
  }

  return (
    <main>
      <h1>Legacy location facade</h1>
      <code>LegacyLocationReport:{JSON.stringify(report)}</code>
    </main>
  )
}
