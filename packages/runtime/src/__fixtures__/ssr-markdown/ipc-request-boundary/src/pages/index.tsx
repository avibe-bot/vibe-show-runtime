const oversizedSpecifier = `virtual:${"x".repeat(70 * 1024)}`

await import(/* @vite-ignore */ oversizedSpecifier)

export default function IpcRequestBoundaryFixture() {
  return <h1>Oversized module request must not render</h1>
}
