const fileContents = "RENDER_FAILURE_FILE_CONTENT_MUST_NOT_LEAK"

export default function RenderFailureLogFixture() {
  throw new Error(`Fixture render failed: ${fileContents}`)
}
