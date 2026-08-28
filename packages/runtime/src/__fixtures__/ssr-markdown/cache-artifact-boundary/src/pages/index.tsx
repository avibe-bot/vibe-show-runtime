import { artifactSecret } from "__CACHE_ARTIFACT_IMPORT__"

export default function CacheArtifactBoundaryPage() {
  return (
    <main>
      <h1>Cache artifact boundary</h1>
      <p>{artifactSecret}</p>
    </main>
  )
}
