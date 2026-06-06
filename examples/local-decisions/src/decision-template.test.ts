import { describe, expect, it } from "vitest"
import { formatDecisionValue, hasTemplateSeed, defaultDecisionInputs } from "./decision-template"
import type { LocalDecisionSnapshot } from "@avibe/show-sdk"

describe("local decisions template helpers", () => {
  it("detects when the default decision template has been seeded", () => {
    const snapshot: LocalDecisionSnapshot = {
      version: 1,
      decisions: defaultDecisionInputs.map((decision) => ({
        ...decision,
        createdAt: "2026-06-06T10:00:00.000Z",
        updatedAt: "2026-06-06T10:00:00.000Z"
      }))
    }

    expect(hasTemplateSeed(snapshot)).toBe(true)
  })

  it("formats object values as readable JSON for editing", () => {
    expect(formatDecisionValue({ format: "JSON", source: "localStorage" })).toBe(JSON.stringify({ format: "JSON", source: "localStorage" }, null, 2))
  })
})
