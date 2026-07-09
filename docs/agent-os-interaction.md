# Agent OS Interaction Design

## Status

Draft for implementation planning. This document fixes the product and
package-level direction for Show Runtime as Vibe Remote's primary Web UI
interaction surface. It does not replace `docs/plan.md`; that document remains
the runtime execution plan. This document defines the human-agent interaction
model that sits on top of that runtime.

## Product Goal

Vibe Remote is expanding from an IM-centered agent bridge into an Agent OS.
The main interaction surface should no longer be a chat box with optional page
attachments. The primary surface should be a session-scoped HTML workspace
served by Show Runtime and owned by Vibe Remote.

Users and agents collaborate through that workspace:

- Agents create and update the page.
- Users interact with controls on the page.
- Users point at page regions, elements, and text when feedback is local.
- Agents can respond by editing the page, creating agent-visible marks, or
  asking structured questions.
- Every meaningful interaction becomes a session event that Vibe Remote can
  dispatch to the active agent session and record in the session transcript.

IM platforms remain important notification and lightweight response surfaces,
but they are no longer the only product center.

## Core Model

The model has three layers.

```text
Show Page
  Shared work object: UI, document, dashboard, report, diagram, controls.

Interaction Layer
  Intent inputs over the page: forms, choices, buttons, annotations, marks.

Agent Session
  Event and decision center: persistence, transcript, agent dispatch, audit.
```

### Show Page

Show Page is the shared work object. It is the concrete artifact that both the
human and the agent can inspect and change.

Use Show Page-native controls when the agent already knows the question or
workflow and the answer can be structured:

- choose one option from A/B/C/D
- approve, reject, or request revision
- edit a field
- fill a form
- rank candidates
- tune parameters
- trigger a page action
- upload or paste a known input type

These interactions should not be forced into selection-and-comment flows. A
structured form is faster, more accessible, easier to validate, and easier for
the agent to consume.

### Interaction Layer

The interaction layer turns page activity into session events. It is broader
than annotation.

It includes:

- structured intents from forms and controls
- anchored intents from comments, selections, and area marks
- agent marks that point back to the page
- mark lifecycle changes such as acknowledge, resolve, dismiss, or reopen
- user comments in a mark thread
- runtime status events that should be visible in the workspace

Annotation is one input mode inside the interaction layer. It is appropriate
when the user or agent needs to say "this exact thing here".

Use annotation or marks when the interaction is local, spatial, textual, or
hard to model ahead of time:

- "this paragraph is too strong"
- "the left node, not the right node"
- "why did this metric jump?"
- "change this chart label"
- "I updated this block; please confirm"
- "this area still needs a decision"

## Annotation Interaction Model

The product surface should expose annotation as a small number of natural user
actions, not as a dense toolbar of annotation types.

The default shell should provide two explicit modes:

```text
Smart annotation mode
  Point, click, select text, or drag a region. The system infers the anchor
  type and opens a comment popover.

Screenshot annotation mode
  Select one visual region, add one or more numbered comments on that image,
  then submit the image and comments together.
```

### Smart Annotation Mode

Smart annotation mode handles element, text, and region feedback through one
mode.

Interaction rules:

- Hovering outlines the element under the cursor.
- Clicking an element opens a comment popover near the click point.
- Dragging on text preserves normal browser text selection and creates a
  `text-range` annotation.
- Dragging in a non-text area creates a rectangle selection.
- The popover is anchored near the click, selection, or drag end point, not in
  a detached side panel.
- Submitting leaves a numbered annotation marker on the page. Clicking the
  marker opens the prior comment and any agent response/status.

Non-text drag selection should be classified after mouse-up:

```text
Clear element cluster
  -> primary anchor is element-group
  -> preserve individual element anchors and the overall rectangle

Blank/spacing/layout region
  -> primary anchor is area
  -> preserve the rectangle, viewport, scroll, and nearby elements

Ambiguous
  -> default to the higher-confidence choice
  -> show a small popover toggle:
     "按 3 个元素标注" / "按区域标注"
```

The user should never have to choose between "multi-select" and "area" before
dragging. The system makes the first call, and the popover lets the user
correct it only when the distinction matters.

Classification hints:

- Candidate elements must ignore the Avibe overlay itself, annotation markers,
  popovers, and toolbar controls.
- Prefer `element-group` when the rectangle tightly covers meaningful page
  elements such as cards, buttons, table rows, chart sections, or list items.
- Prefer `area` when the rectangle mainly describes spacing, alignment, empty
  space, visual relationship, or a layout defect that is not owned by one DOM
  node.
- Avoid selecting full-page containers unless the user clearly dragged a large
  page region.
- Always preserve both the user-drawn region and the matched element list in
  the event payload, even when one is marked as primary. This gives the agent
  both code-facing and visual-facing context.

### Screenshot Annotation Mode

Screenshot mode should be separate from smart annotation mode because it has a
different cost model and a different user goal.

Interaction flow:

1. User switches to screenshot mode.
2. Cursor becomes a screenshot crosshair and the page shows a lightweight
   "框选截图区域" hint.
3. User drags one screenshot region.
4. The selected region is captured as one screenshot draft.
5. The draft displays an obvious border and a visible label such as
   `截图 1`.
6. User adds comments inside that captured image:
   - click to place a numbered point comment
   - drag inside the screenshot to place a numbered sub-region comment
7. The draft shows numbered markers `1`, `2`, `3`, and a compact comment list.
8. User submits once: one screenshot image plus all numbered comments are sent
   to the agent.

This mode should default to batching. Images are token-expensive, so sending
one image with several numbered comments is better than sending several images
with one comment each.

Recommended screenshot draft behavior:

- Keep only one active screenshot draft by default.
- Let the user add, edit, delete, and reorder numbered comments before
  sending.
- "Add another comment" should not create another screenshot.
- "Retake screenshot" replaces the draft region after confirmation.
- Submit should create one `human.annotation.created` event whose annotation
  kind is `screenshot` and whose payload contains the screenshot attachment and
  an ordered `items[]` list of comments.

### Sending Strategy

Use different defaults for the two modes:

- Smart annotation: default to immediate send after each comment. The agent can
  start working quickly, and each marker becomes a durable page thread.
- Screenshot annotation: default to batch send. The user is likely describing
  multiple visible issues on one image, and one image with numbered comments is
  cheaper and clearer for the agent.

Future "collect mode" can be added if users frequently want to mark many
non-screenshot annotations before dispatch. It should be an optional workflow,
not the MVP default.

### Annotation Event Shape

The interaction layer should keep the protocol explicit about the user's
primary intent while still preserving fallback context.

Target shape:

```ts
type AnnotationPrimaryAnchor =
  | "mark"
  | "element"
  | "text-range"
  | "element-group"
  | "area"
  | "screenshot"

type AnnotationPayload = {
  id: string
  intent?: "fix" | "change" | "question" | "approve"
  comment?: string
  primaryAnchor: AnnotationPrimaryAnchor
  anchor?: Anchor
  anchors?: Anchor[]
  userRegion?: { x: number; y: number; width: number; height: number }
  viewport?: { width: number; height: number; scrollX: number; scrollY: number }
  matchedElements?: Anchor[]
  screenshot?: {
    attachmentId: string
    mimeType: "image/png" | "image/webp"
    width: number
    height: number
    capturedRegion: { x: number; y: number; width: number; height: number }
    viewport: { width: number; height: number; scrollX: number; scrollY: number }
    items: Array<{
      id: string
      label: number
      comment: string
      point?: { x: number; y: number }
      rect?: { x: number; y: number; width: number; height: number }
    }>
  }
}
```

For smart area selection, `primaryAnchor` may be `element-group` or `area`, but
`userRegion`, `viewport`, and `matchedElements` should all be retained. For
screenshot mode, the screenshot is the primary artifact, the viewport preserves
where it came from, and the numbered items are local coordinates inside that
screenshot.

### Agent Session

Agent Session is the durable event and decision center. It owns:

- event persistence
- message transcript projection
- dispatch to the selected agent backend
- session-scoped permissions and identity
- SSE fan-out to connected Web UI clients
- audit and recovery

Show Runtime may provide a local sidecar transport for development and first
integration, but Vibe Remote owns the durable session semantics.

## Package Responsibilities

Keep the existing three-package architecture. Do not add a fourth core package
for interaction unless a future package boundary becomes unavoidable.

```text
@avibe/show-runtime
  Local Node/Vite sidecar. Owns execution, Vite contexts, HMR, handler loading,
  session workspace templates, runtime-local event ingress, and runtime status.

@avibe/show-ui
  Visual primitives. Owns shadcn-style components, tokens, layout primitives,
  and presentational shells. It must not know about agent sessions or transport.

@avibe/show-sdk
  Interaction contract. Owns event types, anchor types, browser client helpers,
  React providers/hooks/headless components, handler types, and agent-facing
  helpers for marks/intents.
```

`@avibe/show-sdk` is the right home for the interaction model. It should grow
from today's handler helper into the protocol and client layer.

Recommended subpath exports:

```text
@avibe/show-sdk          event schemas, clients, builders, shared utilities
@avibe/show-sdk/react    providers, hooks, headless interaction components
@avibe/show-sdk/handler  VibeContext, VibeHandler, handler utilities
```

The root export should stay usable outside React. React-specific code belongs
under `@avibe/show-sdk/react`.

### Agent-Facing Authoring Model

Agents should not be asked to manually assemble the live collaboration layer on
every page. The default authoring model is:

- build a normal Show Page with HTML, React, and `@avibe/show-ui` primitives
- add stable `mark-*` anchors to content that may need feedback or reverse
  marks
- use ordinary page controls for structured questions, choices, forms, and
  actions
- let the Vibe Remote Web UI shell around Show Runtime mount the interaction
  layer that captures annotations, submits intents, listens to SSE, and renders
  assistant marks

The React exports under `@avibe/show-sdk/react` are product primitives and
escape hatches. They are useful for building the injected interaction layer,
custom host shells, tests, and unusual pages, but they should not be presented
as the recommended baseline for agent-authored Show Pages.

## Event Pipeline

The unifying abstraction is a session event, not a chat message and not an
annotation object.

```text
Browser control / annotation / mark
  -> @avibe/show-sdk client
  -> Vibe Remote Web UI API
  -> session event store
  -> optional transcript projection
  -> agent dispatch
  -> SSE fan-out back to Show Page
```

For private live Show Pages, the browser should send events through Vibe Remote
under the authenticated `/show/<session-id>/...` route. The runtime sidecar may
expose local endpoints behind that proxy, but the public entry remains Vibe
Remote.

Protocol direction:

- Browser to backend: POST events.
- Backend to browser: SSE event stream.
- Agent to backend: CLI and SDK commands that create events or page patches.
- Backend to agent: dispatch selected session events as agent input.

This gives product-level bidirectional collaboration without requiring
WebSocket as the first transport. SSE also aligns with Vibe Remote's current
workbench direction and is easier to replay and audit.

## Event Taxonomy

Initial event families:

```text
human.intent.submitted
human.annotation.created
human.annotation.updated
human.annotation.resolved
human.annotation.dismissed

assistant.mark.created
assistant.mark.updated
assistant.mark.resolved
assistant.page.updated

system.runtime.status
system.runtime.error
```

The event name should describe the actor and action. The payload should carry
the UI modality separately.

Examples:

```json
{
  "type": "human.intent.submitted",
  "sessionId": "ses_123",
  "source": "show-page",
  "component": {
    "id": "decision.pricing",
    "kind": "choice"
  },
  "intent": {
    "kind": "answer",
    "value": "b",
    "comment": "This is closest, but reduce budget by 20%."
  }
}
```

```json
{
  "type": "human.annotation.created",
  "sessionId": "ses_123",
  "source": "annotation-overlay",
  "annotation": {
    "id": "ann_123",
    "intent": "change",
    "comment": "This conclusion is too strong.",
    "anchor": {
      "kind": "text-range",
      "mark": "mark-default-summary-conclusion",
      "selector": "[mark-default='summary.conclusion']",
      "textQuote": "therefore we can conclude",
      "textRange": { "start": 0, "end": 24 },
      "rect": { "x": 420, "y": 312, "width": 360, "height": 42 },
      "componentPath": ["App", "SummaryPanel", "ConclusionBlock"]
    }
  }
}
```

```json
{
  "type": "assistant.mark.created",
  "sessionId": "ses_123",
  "mark": {
    "id": "mark_123",
    "scope": "default",
    "target": "summary.conclusion",
    "body": "I rewrote this block. Please confirm the softer claim."
  }
}
```

## Transcript Projection

Not every event must be shown as a chat-like message, but every user-meaningful
decision should be recoverable in the session history.

Projection rules:

- Human intents and annotations should have a human-readable transcript form.
- Assistant marks should be recorded as assistant messages.
- Low-level cursor, hover, draft text, and geometry recalculation events should
  not enter the transcript.
- The transcript projection should include enough anchor context to be useful
  after the page changes.

Assistant mark text format:

```text
[agent-mark:<scope>] <target>

<body>

Anchor: <selector or mark id>
Text: <optional selected text>
```

This projection is intentionally plain text so older transcript readers, IM
bridges, exports, and audits can display it without understanding the full
event schema.

## Anchor And Mark Model

Anchors are the hardest part of the system. CSS selectors and screen
coordinates are useful hints, not stable identity.

The priority order should be:

1. Explicit mark attribute emitted by agent-authored code.
2. Registered SDK anchor from a component or hook.
3. Text range with quote and surrounding text.
4. DOM selector/path.
5. Bounding box and viewport state.
6. React component path and source location as diagnostics.

### Mark Attribute

Use the short `mark-` naming.

```tsx
<section mark-default="summary.conclusion">...</section>
<div mark-risk="market-risk-chart">...</div>
```

Rules:

- default scope is `"default"`
- no `title` field is required
- mark id should be stable across page re-renders
- scope namespaces related groups without introducing a heavy hierarchy
- generated helpers may normalize ids but must preserve the author-facing
  short form

`ShowAgentMark` / `MarkBoundary` should be a convenience wrapper, not the only
way to mark an element.

Fallback behavior:

- If the child is a native DOM element, clone it with the mark attribute.
- If the child is text, multiple nodes, or a custom component, wrap with
  `display: contents`.
- Avoid passing unknown props into custom React components by default.
- Do not add visual layout unless the caller opts into a visible marker.

This keeps layout side effects small while still enabling automatic marking.

### Anchor Object

Target shape:

```ts
type Anchor = {
  kind: "mark" | "element" | "text-range" | "area" | "element-group" | "screenshot"
  scope: string
  mark?: string
  selector?: string
  domPath?: string
  textQuote?: string
  textBefore?: string
  textAfter?: string
  textRange?: { start: number; end: number }
  rect?: { x: number; y: number; width: number; height: number }
  viewport?: { width: number; height: number; scrollX: number; scrollY: number }
  componentPath?: string[]
  source?: { file?: string; line?: number; column?: number }
}
```

Anchor resolution should be probabilistic and layered. If the exact mark no
longer exists, the resolver can try text quote, nearby text, component path,
then geometry. Resolution confidence should be explicit.

```ts
type AnchorResolution = {
  status: "resolved" | "ambiguous" | "missing"
  confidence: number
  element?: Element
  reason?: string
}
```

## SDK Components

The SDK should provide headless interaction primitives for the product runtime
and advanced integrations. Visual styling should come from `@avibe/show-ui`.
These primitives are not the primary user-facing authoring contract for agents;
the primary contract is stable page markup, `mark-*` anchors, structured
controls, and the session event pipeline.

Core providers and hooks:

```text
ShowSessionProvider
useShowSession()
useShowEvents()
useSubmitIntent()
useAnchors()
useMarkRegistry()
```

Structured interaction components:

```text
IntentForm
DecisionRequest
ChoiceGroup
ApprovalRequest
ActionButton
```

Annotation components:

```text
AnnotationOverlay
TextSelectionAnnotator
AreaSelectionAnnotator
ElementPicker
CommentPopover
AnnotationMarker
AgentMarkLayer
```

Anchor helpers:

```text
ShowAgentMark / MarkBoundary
registerAnchor()
resolveAnchor()
collectElementContext()
```

The components should submit the same underlying session event shape. The UI
modality is a detail, not a separate backend model.

## Agent CLI

Agents need a CLI path for reverse marks and intent events. The CLI should not
ask agents to guess CSS selectors when a mark id is available.

Possible shape:

```bash
vibe show mark --session-id <id> --target summary.conclusion --message "Please confirm this wording."
vibe show mark --session-id <id> --scope risk --target market-risk-chart --message "I updated the assumptions."
vibe show event --session-id <id> --type assistant.mark.created --json @event.json
```

Rules:

- `--scope` defaults to `default`
- target resolves first against mark registry
- assistant marks are recorded as assistant transcript messages
- CLI should print the active Show Page URL after creating a mark
- later, CLI can support resolving, updating, or linking to mark threads

## Backend Boundaries

Vibe Remote owns durable state:

- session event store
- transcript projection
- agent dispatch
- user identity and auth
- public/private/offline visibility
- SSE fan-out to Web UI clients

Show Runtime owns local execution:

- Vite app serving
- HMR
- handler execution
- SDK runtime config injection
- local development event ingress as a proxy target

`@avibe/show-sdk` owns the contract:

- TypeScript event types
- browser client helpers
- React providers/hooks
- handler context types
- anchor collection helpers

Do not make Show Runtime into the durable business backend. It should be
replaceable, restartable, and versioned independently.

## Public Sharing Policy

Private `/show/<session-id>/...` may host live service pages and interaction
events after authentication.

Public `/p/<share-id>/...` should still host live frontend pages and HMR so
users can watch agent edits in real time. It must not expose write-capable
handlers, annotation event submission, or agent session actions by accident.

Initial policy:

- private pages: live runtime and interaction allowed
- public pages: live frontend runtime and HMR allowed
- public handlers: disabled by default unless a handler is explicitly declared
  read-only and share-safe; pages that depend on private handlers for rendering
  must use a materialized read-only data snapshot or a public-safe fallback
- public interaction: read-only by default; event submission, write-capable
  handlers, and agent actions require a separate permission and abuse-control
  design

## Agentation Findings

Agentation is a useful reference for product shape and implementation tactics,
but it should not be treated as a drop-in dependency or copied wholesale.
Its license is not a permissive MIT-style license, and its product scope is
different: it is primarily a visual feedback tool for coding agents.

Useful mechanisms to study and reimplement in our own architecture:

- element identification with human-readable labels
- shadow DOM traversal helpers
- nearby text and nearby element collection
- selected text capture
- bounding box capture
- multi-select and area selection
- fixed/sticky element detection for marker positioning
- React fiber component path detection
- development-only source location extraction from React debug metadata
- detail levels for generated output
- local storage fallback with optional server sync
- annotation status lifecycle
- animation freeze mode for capturing transient states
- portal-based toolbar and popup isolation
- event propagation guards so overlay clicks do not close page modals

Important differences from Vibe Remote:

- Agentation outputs markdown for agents; Vibe Remote should emit typed session
  events and only project selected events into markdown/text transcript form.
- Agentation can be local-only; Vibe Remote needs durable session state.
- Agentation is a page feedback tool; Vibe Remote needs a general Agent OS
  interaction SDK that includes forms, choices, buttons, annotations, marks,
  and agent-driven page updates.
- Agentation server sync is optional; Vibe Remote backend integration is core.
- Agentation's toolbar owns much of the experience; Vibe Remote should provide
  headless SDK primitives plus product-specific UI shells.

### Reference Matrix

| Agentation capability | What it does | Vibe Remote direction |
| --- | --- | --- |
| Click-to-annotate | Captures the clicked element, label, path, rect, nearby text, classes, and comment. | Reimplement as `ElementPicker` + `CommentPopover`, emitting `human.annotation.created`. Prefer explicit `mark-*` anchors when present. |
| Text selection | Adds selected text to the annotation payload. | Reimplement as `TextSelectionAnnotator`, producing `text-range` anchors with quote, range, and surrounding context. |
| Drag / multi-select | Creates area or multi-element feedback with individual bounding boxes. | Implement after the basic overlay. Model as `area` or grouped anchors, not as one opaque annotation blob. |
| Shadow DOM traversal | Crosses shadow roots for element lookup and parent traversal. | Required for robustness, but keep it as a low-level anchor utility in SDK, not in the toolbar component. |
| React fiber detection | Reads React internal fiber metadata to derive component paths. | Use only as diagnostic metadata. Do not make fiber internals the primary anchor because React internals change. |
| Source location detection | Reads development-only `_debugSource` metadata. | Useful as diagnostic metadata only. Never require it for public rendering or durable anchors. |
| Computed style / forensic output | Adds detailed CSS and environment info for coding-agent debugging. | Keep as an opt-in diagnostic detail level. Default event payload should stay compact. |
| Animation freeze | Pauses CSS animations, WAAPI animations, videos, and patched timers. | Reimplement later as `freezePageState()` for annotation capture. Must exclude Avibe overlay elements. |
| Portal overlay isolation | Renders toolbar/popup through a portal and blocks propagation to page-level handlers. | Required. Overlay events must not close page dialogs, trigger page buttons, or interfere with form state. |
| localStorage fallback | Keeps annotations without a server endpoint and tracks sync markers. | Useful for development only. Production Vibe Remote must persist through session events. |
| Markdown output | Produces agent-readable markdown with detail levels. | Keep only as transcript/export projection. Primary system contract is typed events. |
| Design mode / rearrange | Lets users place/rearrange UI blocks and generate structured output. | Not MVP. Useful future direction for agent-directed page editing, but separate from annotation MVP. |

### Implementation Lessons

Agentation's code shows several practical risks that Vibe Remote should plan
for early:

- Overlay UI must aggressively isolate pointer, click, keyboard, and focus
  events. Otherwise annotation popovers will close host dialogs or trigger page
  shortcuts.
- Annotation capture needs both viewport-relative and page-absolute geometry.
  Fixed and sticky elements need special handling.
- Text selection and click annotation conflict with normal page interactions.
  The overlay must have explicit modes and clear escape behavior.
- React/source metadata is helpful but best-effort. It should improve agent
  context, not determine identity.
- Long annotation objects become hard to reason about. Vibe Remote should split
  event identity, anchor, display state, transcript projection, and diagnostic
  metadata.
- Freeze mode is powerful but invasive because it patches timing APIs. It
  should be opt-in and isolated, not always loaded.
- A single all-in-one toolbar grows quickly. Vibe Remote should keep the SDK
  decomposed into headless primitives and assemble product UI separately.

### Do Not Copy

Do not directly copy Agentation source into this repository. The license is
`PolyForm-Shield-1.0.0`, which restricts competing products and is not aligned
with this repository's intended package distribution.

Do not adopt these shapes directly:

- localStorage as the production source of truth
- markdown as the primary protocol
- one toolbar component owning sync, storage, capture, output, settings, and
  design mode
- React fiber/source metadata as required anchor identity
- automatic forensic CSS capture on every annotation
- public endpoint sync semantics independent of Vibe Remote auth

Use Agentation as a product and algorithmic reference, then implement a clean
Avibe-specific SDK around typed session events.

## Agentation-Inspired Component Breakdown

First annotation implementation should be decomposed rather than built as one
large toolbar.

```text
Element context collection
  - deep elementFromPoint
  - shadow DOM-aware parent traversal
  - readable label and DOM path
  - nearby text/elements
  - accessibility summary
  - computed style summary only for diagnostic/detail modes

Selection capture
  - text selection to text-range anchor
  - element click to mark/element anchor
  - drag rectangle to area anchor
  - multi-select to grouped anchors

Overlay shell
  - portal root
  - z-index and pointer-event isolation
  - toolbar state
  - marker rendering
  - comment popover

State and transport
  - optimistic local draft state
  - POST session event
  - SSE update subscription
  - transcript projection callback
  - offline/local fallback only as development mode

Agent response layer
  - assistant mark rendering
  - resolve/reopen controls
  - link mark to page patch or source edit when available
```

## MVP Scope

The first implementation should validate the full loop without trying to solve
every annotation edge case.

MVP:

- mark attributes and `ShowAgentMark` wrapper
- default scope `default`
- `human.intent.submitted` from a structured form
- `human.annotation.created` from click-to-comment on a marked element
- `assistant.mark.created` from CLI or SDK
- assistant mark transcript projection
- private page SSE updates
- runtime template injects session id and endpoints
- Vibe Remote persists events and messages

Not in MVP:

- public live write/action access
- arbitrary live public handlers
- multi-user conflict resolution
- visual diffing
- advanced source-map integration
- production-grade text anchor migration
- screenshot upload and visual matching
- permission prompts for external network or file access

## Implementation Phases

### Phase 1: Contract And Persistence

- Define event and anchor TypeScript types in `@avibe/show-sdk`.
- Add Vibe Remote persistence for session events.
- Add transcript projection for human intents, human annotations, and assistant
  marks.
- Add private Show Page POST event endpoint and SSE stream.

### Phase 2: Mark And Structured Intent MVP

- Add `mark-*` helpers and `ShowAgentMark`.
- Add `IntentForm`, `DecisionRequest`, and `ActionButton` headless components.
- Add `vibe show mark` CLI.
- Verify form events and assistant marks appear in Web UI history.

### Phase 3: Basic Annotation Overlay

- Add element click annotation for marked elements.
- Add text selection annotation.
- Add comment popover.
- Add assistant mark rendering.
- Add resolve/dismiss lifecycle.

### Phase 4: Agentation-Inspired Advanced Capture

- Add area selection and multi-select.
- Add shadow DOM traversal.
- Add nearby text/elements and accessibility summaries.
- Add React component path detection.
- Add dev-only source location extraction.
- Add animation freeze mode.

### Phase 5: Robust Anchors And Collaboration

- Add anchor resolution confidence.
- Add missing/ambiguous anchor UI.
- Add page-update to mark linkage.
- Add multi-client fan-out and conflict handling.
- Add explicit public read/write policy while preserving live public rendering
  and HMR.

## Open Decisions

These still need final product calls before broad implementation:

- Whether visible assistant marks should appear by default or only after the
  user opens a "marks" layer.
- Whether resolved marks remain visible in a collapsed history layer.
- How aggressive transcript projection should be for high-volume form events.
- Whether page-authored handlers can create user-visible assistant marks, or
  whether only the agent backend/CLI can create them.
- What permission boundary is required before handlers can submit events that
  dispatch a new agent turn.
- Whether Vibe Remote should expose one event stream per session or one global
  stream filtered by session.

## Non-Negotiable Design Rules

- Show Page is the main interface; annotation is one modality, not the whole
  system.
- Structured controls should be preferred when the answer space is known.
- Annotation should be preferred when the user needs to point at local context.
- All meaningful interactions become typed session events.
- Durable state belongs to Vibe Remote, not the runtime sidecar.
- `@avibe/show-sdk` owns protocol, client, and headless interaction APIs.
- `@avibe/show-ui` stays presentational.
- `@avibe/show-runtime` stays the execution/runtime layer.
- Public sharing must not expose live agent actions by default.
