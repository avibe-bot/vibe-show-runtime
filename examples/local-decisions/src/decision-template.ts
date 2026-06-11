import type { LocalDecisionInput, LocalDecisionSnapshot } from "@avibe/show-sdk"

export const LOCAL_DECISION_TEMPLATE_STORAGE_KEY = "avibe.show.local-decisions-template"

export const defaultDecisionInputs = [
  {
    id: "audience",
    label: "Audience",
    scope: "brief",
    value: "Product teams reviewing an agent-authored Show Page",
    note: "Who this front-end-only page is for."
  },
  {
    id: "deployment",
    label: "Deployment mode",
    scope: "runtime",
    value: "Static front end only; no Show Runtime server is required",
    note: "Keep this template safe for static hosts."
  },
  {
    id: "handoff",
    label: "Handoff format",
    scope: "workflow",
    value: {
      format: "JSON",
      source: "localStorage",
      action: "copy"
    },
    note: "The copied JSON is the portable decision artifact."
  }
] as const satisfies readonly LocalDecisionInput[]

export function hasTemplateSeed(snapshot: LocalDecisionSnapshot) {
  const ids = new Set(snapshot.decisions.map((decision) => decision.id))
  return defaultDecisionInputs.every((decision) => ids.has(decision.id))
}

export function formatDecisionValue(value: LocalDecisionInput["value"]) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}
