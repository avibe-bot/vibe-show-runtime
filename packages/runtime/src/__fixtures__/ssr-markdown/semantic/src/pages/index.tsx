import { useEffect, useState } from "react"
import { Badge } from "@avibe/show-ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@avibe/show-ui/card"
import fixtureImage from "./fixture.svg"
import fixtureAssetUrl from "./fixture.svg?no-inline"
import "./fixture.css"

export default function SemanticFixture() {
  const [effectState, setEffectState] = useState("Loading...")

  useEffect(() => {
    window.__SSR_FIXTURE_EFFECT_RAN__ = true
    void fetch("/api/fixture").then(() => setEffectState("Loaded in a browser"))
  }, [])

  return (
    <main>
      <h1>SSR fixture report</h1>
      <p>The initial React tree is semantic.</p>
      <Card>
        <CardHeader>
          <CardTitle>Built-in Show UI</CardTitle>
        </CardHeader>
        <CardContent>
          <Badge>SSR safe</Badge>
          <p>{effectState}</p>
          <img src={fixtureImage} alt="Fixture chart" />
          <img src={fixtureAssetUrl} alt="Fixture asset URL" />
        </CardContent>
      </Card>
      <p data-agent-hidden>Private visual-only detail</p>
      <section {...{ "agent-note": "Verify the audited total" }}>
        <p>Visible audited total</p>
      </section>
      <script>{"window.__SSR_SCRIPT_RAN__ = true"}</script>
      <style>{".fixture-only { color: red; }"}</style>
    </main>
  )
}

declare global {
  interface Window {
    __SSR_FIXTURE_EFFECT_RAN__?: boolean
  }
}
