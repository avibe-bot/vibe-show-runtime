import * as React from "react"
import { CheckCircle2, Clipboard, Database, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ThemeProvider } from "@avibe/show-ui/theme"
import { createLocalDecisionStore, type LocalDecisionInput, type LocalDecisionSnapshot, type LocalDecisionValue } from "@avibe/show-sdk"
import { defaultDecisionInputs, formatDecisionValue, hasTemplateSeed, LOCAL_DECISION_TEMPLATE_STORAGE_KEY } from "./decision-template"

const store = createLocalDecisionStore({
  storageKey: LOCAL_DECISION_TEMPLATE_STORAGE_KEY
})

type FormState = {
  id: string
  label: string
  scope: string
  value: string
  note: string
}

const emptyForm: FormState = {
  id: "",
  label: "",
  scope: "brief",
  value: "",
  note: ""
}

export default function App() {
  const [snapshot, setSnapshot] = React.useState<LocalDecisionSnapshot>(() => store.loadSnapshot())
  const [form, setForm] = React.useState<FormState>(emptyForm)
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle")

  React.useEffect(() => {
    if (hasTemplateSeed(snapshot)) return
    let nextSnapshot = snapshot
    for (const decision of defaultDecisionInputs) {
      nextSnapshot = store.saveDecision(decision)
    }
    setSnapshot(nextSnapshot)
  }, [])

  const decisionCount = snapshot.decisions.length
  const jsonPreview = store.exportDecisionsJson()

  function updateForm(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function saveDecision(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = slugify(form.id || form.label)
    if (!id || !form.label.trim()) return
    const decision: LocalDecisionInput = {
      id,
      label: form.label.trim(),
      scope: form.scope.trim() || undefined,
      value: parseDecisionValue(form.value),
      note: form.note.trim() || undefined
    }
    setSnapshot(store.saveDecision(decision))
    setForm(emptyForm)
    setCopyState("idle")
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(store.exportDecisionsJson())
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
  }

  function removeDecision(id: string) {
    setSnapshot(store.removeDecision(id))
    setCopyState("idle")
  }

  function resetTemplate() {
    store.clearDecisions()
    let nextSnapshot = store.loadSnapshot()
    for (const decision of defaultDecisionInputs) {
      nextSnapshot = store.saveDecision(decision)
    }
    setSnapshot(nextSnapshot)
    setCopyState("idle")
  }

  return (
    <ThemeProvider preset="zinc">
      <main className="page">
        <section className="masthead">
          <div className="masthead-copy">
            <Badge variant="success">front end only</Badge>
            <h1>Local decisions template</h1>
            <p>
              A static Show Page starter that keeps decisions in browser localStorage and lets reviewers copy the complete JSON handoff.
            </p>
          </div>
          <div className="status-strip" aria-label="Template status">
            <span><Database size={16} /> localStorage</span>
            <span><CheckCircle2 size={16} /> no server submit</span>
            <span>{decisionCount} decisions</span>
          </div>
        </section>

        <section className="workspace">
          <Card className="editor-card">
            <CardHeader>
              <CardTitle>Add or update decision</CardTitle>
              <CardDescription>Use the same id to update a saved decision after refresh.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="decision-form" onSubmit={saveDecision}>
                <label>
                  <span>Decision id</span>
                  <Input value={form.id} placeholder="hero-copy" onChange={(event) => updateForm("id", event.target.value)} />
                </label>
                <label>
                  <span>Label</span>
                  <Input required value={form.label} placeholder="Hero copy" onChange={(event) => updateForm("label", event.target.value)} />
                </label>
                <label>
                  <span>Scope</span>
                  <Input value={form.scope} placeholder="brief" onChange={(event) => updateForm("scope", event.target.value)} />
                </label>
                <label className="wide">
                  <span>Value</span>
                  <textarea
                    required
                    value={form.value}
                    placeholder="Use a focused product headline."
                    onChange={(event) => updateForm("value", event.target.value)}
                  />
                </label>
                <label className="wide">
                  <span>Note</span>
                  <Input value={form.note} placeholder="Optional rationale or reviewer context" onChange={(event) => updateForm("note", event.target.value)} />
                </label>
                <div className="form-actions">
                  <Button type="submit"><Plus size={16} /> Save decision</Button>
                  <Button type="button" variant="outline" onClick={() => setForm(emptyForm)}>Clear</Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card className="handoff-card">
            <CardHeader>
              <CardTitle>JSON handoff</CardTitle>
              <CardDescription>Copy the full local decision snapshot without posting to a server.</CardDescription>
            </CardHeader>
            <CardContent className="handoff-content">
              <div className="handoff-actions">
                <Button type="button" onClick={() => void copyJson()}><Clipboard size={16} /> Copy JSON</Button>
                <Button type="button" variant="outline" onClick={resetTemplate}><RefreshCw size={16} /> Reset template</Button>
              </div>
              <p aria-live="polite" className={`copy-message copy-message-${copyState}`}>
                {copyState === "copied" ? "Copied all decisions to clipboard." : copyState === "failed" ? "Clipboard access failed. Select the JSON below instead." : "Ready to copy."}
              </p>
              <pre className="json-preview">{jsonPreview}</pre>
            </CardContent>
          </Card>
        </section>

        <section className="decision-list" aria-label="Saved decisions">
          {snapshot.decisions.map((decision) => (
            <Card key={decision.id}>
              <CardHeader>
                <div className="decision-heading">
                  <div>
                    <CardTitle>{decision.label}</CardTitle>
                    <CardDescription>{decision.scope || "default"} · {decision.id}</CardDescription>
                  </div>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${decision.label}`} onClick={() => removeDecision(decision.id)}>
                    <Trash2 size={16} />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="decision-card-content">
                <pre>{formatDecisionValue(decision.value)}</pre>
                {decision.note ? <p>{decision.note}</p> : null}
              </CardContent>
            </Card>
          ))}
        </section>
      </main>
    </ThemeProvider>
  )
}

function parseDecisionValue(value: string): LocalDecisionValue {
  const trimmed = value.trim()
  if (!trimmed) return ""
  try {
    return JSON.parse(trimmed) as LocalDecisionValue
  } catch {
    return trimmed
  }
}

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}
