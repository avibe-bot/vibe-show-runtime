import * as React from "react"
import { markAttributes, type AgentMark, type AgentMarkSubmitOptions, submitAgentMark } from "./index.js"

export type AgentMarkSubmitResult = Awaited<ReturnType<typeof submitAgentMark>>

export type ShowAgentMarkProps = {
  id: string
  scope?: string
  children: React.ReactNode
}

export type AgentMarkFormProps = AgentMarkSubmitOptions & {
  target: string
  scope?: string
  placeholder?: string
  onSubmitted?: (mark: AgentMark, result: AgentMarkSubmitResult) => void
}

export function ShowAgentMark({ id, scope, children }: ShowAgentMarkProps) {
  const attrs = markAttributes(id, scope)
  if (React.isValidElement(children) && typeof children.type === "string") {
    return React.cloneElement(children, attrs)
  }
  return (
    <span {...attrs} style={{ display: "contents" }}>
      {children}
    </span>
  )
}

export function AgentMarkForm({ target, scope, placeholder = "Write a mark...", onSubmitted, ...options }: AgentMarkFormProps) {
  const [body, setBody] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextMark = { target, scope, body }
    setSubmitting(true)
    setError(null)
    try {
      const response = await submitAgentMark(nextMark, options)
      setBody("")
      onSubmitted?.(nextMark, response)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to submit mark")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form data-mark-form="" onSubmit={onSubmit}>
      <textarea value={body} placeholder={placeholder} onChange={(event) => setBody(event.target.value)} />
      <button type="submit" disabled={submitting || !body.trim()}>
        {submitting ? "Sending..." : "Send"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  )
}
