export default function RenderAbortFixture() {
  throw new DOMException("Page-owned operation was aborted", "AbortError")
}
