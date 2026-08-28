export default function IpcErrorBoundaryFixture() {
  throw new Error("oversized-render-error-".repeat(16 * 1024))
}
