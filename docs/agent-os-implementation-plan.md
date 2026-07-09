# Agent OS Interaction Implementation Plan

## Status

Implementation plan derived from `docs/agent-os-interaction.md`.

This plan is intentionally split into small mergeable slices. The goal is to
land the durable protocol and session event pipeline first, then add UI
capabilities in layers. Do not begin with a large annotation toolbar, and do
not make every agent-authored page hand-wire the interaction layer.

## Repositories

Two repositories are involved.

```text
vibe-show-runtime
  Owns npm packages:
  - @avibe/show-sdk
  - @avibe/show-ui
  - @avibe/show-runtime

vibe-remote
  Owns product runtime:
  - Web UI routes
  - session event persistence
  - transcript projection
  - agent dispatch
  - CLI
  - auth / private / public visibility
```

Implementation should alternate between the repos only when the contract
requires it. Avoid landing runtime-only UI components before Vibe Remote has a
place to persist and deliver the events they emit.

## Milestone 0: Design Docs

Purpose: make the direction reviewable before implementation.

Changes:

- Add `docs/agent-os-interaction.md`.
- Add this implementation plan.
- Link both from `README.md`.

Validation:

- Markdown links resolve.
- No code changes.

Exit criteria:

- Product direction, package boundaries, event families, and MVP scope are
  accepted.

## Milestone 1: SDK Contract Skeleton

Repo: `vibe-show-runtime`

Purpose: define the event and anchor types without committing to UI behavior.

Package changes:

- In `@avibe/show-sdk`, split exports into:
  - root protocol exports
  - `@avibe/show-sdk/react`
  - `@avibe/show-sdk/handler`
- Move `VibeContext` / `VibeHandler` to the handler subpath and re-export for
  compatibility if needed.
- Add event types:
  - `human.intent.submitted`
  - `human.annotation.created`
  - `human.annotation.updated`
  - `human.annotation.resolved`
  - `human.annotation.dismissed`
  - `assistant.mark.created`
  - `assistant.mark.updated`
  - `assistant.mark.resolved`
  - `assistant.page.updated`
  - `system.runtime.status`
  - `system.runtime.error`
- Add anchor types:
  - `mark`
  - `element`
  - `text-range`
  - `area`
  - `element-group`
  - `screenshot`
- Add transcript projection helpers for human intents, human annotations, and
  assistant marks.

Non-goals:

- No overlay UI.
- No Vibe Remote persistence yet.
- No Agentation-inspired element capture.

Validation:

- `npm run check`
- Add unit tests for event builders and transcript projection.

Exit criteria:

- SDK can create typed events and format transcript-safe text.

## Milestone 2: Vibe Remote Event Persistence

Repo: `vibe-remote`

Purpose: make session events durable before browser UI starts emitting them.

Storage changes:

- Add a `show_session_events` table or equivalent session-event storage.
- Store:
  - event id
  - session id
  - actor role
  - event type
  - event JSON
  - transcript projection, if any
  - created timestamp
  - visibility / delivery metadata as needed
- Add migration and store/service helpers.

API changes:

- Add authenticated private Show Page event POST endpoint:

```text
POST /show/<session-id>/__events
GET  /show/<session-id>/__events
GET  /show/<session-id>/__events/stream
```

- Keep these endpoints private. Public `/p/<share-id>/...` must not expose
  event submission.

Transcript projection:

- Project selected events into the Web UI session transcript.
- Assistant marks become assistant messages in plain text format.
- Human form/annotation events become human messages only when useful for
  history review.

Non-goals:

- No annotation UI.
- No agent dispatch yet unless the event is explicitly marked dispatchable.
- No public sharing support.

Validation:

- Migration tests.
- API auth tests for private/public boundaries.
- Event persistence unit tests.
- Transcript projection tests.

Exit criteria:

- Events survive restart and can be listed by session.
- Public share URL cannot submit events.

## Milestone 3: Runtime Transport Wiring

Repo: `vibe-show-runtime`

Purpose: make pages know where to send events, while keeping durable semantics
in Vibe Remote.

Runtime changes:

- Inject runtime config into generated sessions:

```ts
globalThis.__AVIBE_SHOW__ = {
  sessionId,
  basePath,
  eventsPath,
  streamPath
}
```

- Add `@avibe/show-sdk` browser client helpers:
  - `submitShowEvent()`
  - `subscribeShowEvents()`
  - `submitIntent()`
  - `createAssistantMark()`

Boundary:

- The sidecar may expose local development endpoints, but production pages
  should post through Vibe Remote's `/show/<session-id>/__events`.

Validation:

- `npm run check`
- Smoke test that generated app can read runtime config.
- Browser-client unit tests with mocked fetch/EventSource.

Exit criteria:

- Agent-authored React code can submit a typed event without hardcoding the
  endpoint.

## Milestone 4: Mark Helpers And Agent CLI

Repos: `vibe-show-runtime`, `vibe-remote`

Purpose: support agent-created reverse marks and stable mark anchors.

SDK changes:

- Add `mark-*` helpers:
  - `markId()`
  - `markAttributes()`
  - `ShowAgentMark` / `MarkBoundary`
  - `useMarkRegistry()`
- Defaults:
  - `scope = "default"`
  - no `title`
  - automatic layout by default
  - fallback wrapper uses `display: contents`
  - native DOM child gets cloned; custom components get wrapped

Vibe Remote CLI:

```bash
vibe show mark --session-id <id> --target <mark-id> --message <text>
vibe show mark --session-id <id> --scope <scope> --target <mark-id> --message <text>
```

Behavior:

- CLI creates `assistant.mark.created`.
- Event is persisted.
- Event projects to assistant transcript message.
- CLI returns active Show Page URL.

Non-goals:

- No visible overlay yet.
- No anchor resolution UI yet.

Validation:

- SDK unit tests for mark attributes and wrapper fallback.
- CLI tests for default scope and message projection.
- API tests for assistant mark persistence.

Exit criteria:

- Agent can create a mark by session id and target id.
- User can find the assistant mark in session history.

## Milestone 5: Structured Intent Components

Repo: `vibe-show-runtime`, plus Vibe Remote integration tests

Purpose: validate the non-annotation interaction path first.

SDK React components:

- `ShowSessionProvider`
- `IntentForm`
- `DecisionRequest`
- `ChoiceGroup`
- `ApprovalRequest`
- `ActionButton`

Behavior:

- Components submit `human.intent.submitted`.
- Successful submission clears local input where applicable.
- Components are headless or minimally styled; visual primitives come from
  `@avibe/show-ui`.
- Agent-authored pages can choose their layout.

Vibe Remote behavior:

- Persist events.
- Optionally dispatch selected intent events to the agent.
- Show history projection for meaningful form submissions.

Boundary:

- These React components are SDK primitives, not the default Agent-facing
  authoring style.
- The recommended Agent-facing style is ordinary Show Page UI plus a stable
  session-event convention for forms and controls.
- A later Vibe Remote Web UI shell around Show Runtime should be able to
  recognize or wrap common controls so agents are not required to import SDK
  components for simple choices, approvals, and forms.

Validation:

- SDK component tests.
- Browser smoke page for choice + free text.
- Vibe Remote API tests for persisted form event.

Exit criteria:

- A Show Page can ask a structured question and deliver the answer to the
  session event stream without annotation UI.

## Milestone 6: Basic Annotation Overlay

Repo: `vibe-show-runtime`, with Vibe Remote endpoint already available

Purpose: implement the smallest useful annotation loop.

Components:

- `AnnotationOverlay`
- `ElementPicker`
- `TextSelectionAnnotator`
- `CommentPopover`
- `AnnotationMarker`
- `AgentMarkLayer`

Capabilities:

- click a marked/native element and comment
- select text and comment
- show pending annotation marker
- submit `human.annotation.created`
- render assistant marks from SSE events
- resolve/dismiss annotations
- escape/cancel mode reliably

Interaction rules:

- Normal page controls remain usable when annotation mode is off.
- Annotation mode has a visible on/off state.
- Overlay clicks must not trigger page controls underneath.
- Popover focus must not be stolen by host page focus traps.
- The overlay is mounted by the Vibe Remote Web UI shell around Show Runtime by
  default. Agent-authored pages should only need stable `mark-*` anchors unless
  they are intentionally building a custom interaction host.

Validation:

- Component tests with jsdom where possible.
- Browser smoke test for click annotation and text selection.
- Regression test that page buttons do not fire while picking an annotation
  target.

Exit criteria:

- User can create a basic anchored annotation and see it persisted.
- Agent-created marks render back on the page.

## Milestone 7: Agentation-Inspired Capture Utilities

Repo: `vibe-show-runtime`

Purpose: harden the annotation system with context capture. Implement as
separate utilities, not inside one large toolbar component.

Utilities:

- `deepElementFromPoint()`
- shadow DOM-aware parent traversal
- readable element label
- DOM path and fallback selector
- nearby text and nearby elements
- accessibility summary
- fixed/sticky detection
- viewport/page-absolute rect conversion
- grouped anchors for multi-select

Diagnostics:

- optional computed style summary
- optional React component path detection
- optional development-only source location extraction

Non-goals:

- No automatic forensic payload on every event.
- No source location requirement in production.
- No screenshot/visual matching yet.

Validation:

- Unit tests for selector/path generation.
- Browser tests for fixed/sticky geometry.
- Shadow DOM fixture test.

Exit criteria:

- Annotation payloads contain enough context for agents without becoming
  huge by default.

## Milestone 8: Area Selection And Multi-Select

Repo: `vibe-show-runtime`

Purpose: support spatial feedback beyond single elements.

Capabilities:

- drag rectangle to create area anchor
- multi-select elements into grouped anchors
- classify non-text drag selection after mouse-up:
  - `element-group` when the rectangle clearly captures meaningful elements
  - `area` when the rectangle mainly expresses spacing, layout, or empty visual
    space
  - ambiguous state with a popover toggle between the two interpretations
- show individual bounding boxes on hover
- preserve page scroll and viewport context
- preserve both the user-drawn region and matched elements in the payload

Agentation reference:

- Use Agentation's area/multi-select behavior as a product reference.
- Reimplement with Avibe event schema and anchor model.
- Do not require the user to preselect "multi-select" versus "area". The drag
  gesture is one gesture; the system infers the primary anchor and exposes a
  correction toggle only when needed.

Event data:

```ts
type AreaSelectionPayload = {
  primaryAnchor: "element-group" | "area"
  userRegion: { x: number; y: number; width: number; height: number }
  matchedElements: Anchor[]
  classification: {
    confidence: number
    reason: string
    ambiguous: boolean
  }
}
```

Validation:

- Browser smoke tests for area and multi-select.
- Browser smoke test for ambiguous drag selection and popover toggle.
- Payload size and transcript projection tests.

Exit criteria:

- User can say "this region" or "these items" with structured anchors.

## Milestone 8.5: Screenshot Annotation Drafts

Repo: `vibe-show-runtime`, with Vibe Remote attachment support available or
stubbed in tests

Purpose: support screenshot feedback without multiplying image payloads.

Product behavior:

- Screenshot mode is separate from smart annotation mode.
- User selects one screenshot region.
- The selected screenshot region receives an obvious border and label, for
  example `截图 1`.
- User can place multiple numbered comments on that one screenshot:
  - point comments
  - optional sub-region comments
- A compact list lets the user edit, delete, and reorder comments before
  sending.
- Submit sends one image plus all numbered comments as one event.
- Retake replaces the screenshot draft after confirmation.

Technical approach:

- Capture should be implemented behind an SDK utility so the UI can swap
  strategies:
  - browser-native capture where available and permission-appropriate
  - DOM-to-image rendering for same-origin Show Page content
  - Vibe Remote/runtime server-side screenshot fallback for cases where client
    capture is blocked or incomplete
- Store screenshot comments in local draft state until submit.
- Convert marker coordinates to screenshot-local coordinates, not page-global
  coordinates.
- Keep image format configurable, with PNG as the safe default and WebP as a
  possible size optimization.
- Attach the image through Vibe Remote attachment/event storage before or as
  part of event submission.

Event data:

```ts
type ScreenshotAnnotationPayload = {
  primaryAnchor: "screenshot"
  screenshot: {
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

Batching rule:

- Screenshot comments default to batch dispatch because images are token-heavy.
- One screenshot event with numbered comments is the MVP default.
- Multiple screenshot drafts can be explored later, but they should not be the
  first implementation because they increase both UI complexity and agent token
  cost.

Validation:

- Browser smoke test for selecting a screenshot region.
- Browser smoke test for adding multiple numbered comments to one screenshot.
- Event payload test that marker coordinates are screenshot-local.
- Attachment upload/storage test in Vibe Remote once backend support exists.
- Payload-size guard test for image metadata and transcript projection.

Exit criteria:

- User can capture one page region, add multiple numbered comments, and submit
  one event containing one image and all comments.

## Milestone 9: Freeze Mode

Repo: `vibe-show-runtime`

Purpose: support annotating transient animated states.

Capabilities:

- pause CSS animations and transitions
- pause Web Animations API animations
- pause videos
- optionally gate timer/requestAnimationFrame patching behind explicit user
  action

Rules:

- Freeze is opt-in.
- Overlay elements are excluded from freeze.
- Timing patches must be reversible and survive HMR safely.
- Do not load freeze patching code until needed.

Validation:

- Browser smoke test with CSS animation and video fixture.
- Regression test that unfreeze restores page behavior.

Exit criteria:

- User can freeze a transient page state, annotate it, and unfreeze safely.

## Milestone 10: Robust Anchor Resolution

Repos: `vibe-show-runtime`, `vibe-remote`

Purpose: keep annotations useful after page edits.

Capabilities:

- resolve by exact `mark-*`
- fallback to registered anchor id
- fallback to text quote and surrounding text
- fallback to selector/path
- fallback to geometry
- explicit confidence score
- missing/ambiguous anchor UI

Data:

```ts
type AnchorResolution = {
  status: "resolved" | "ambiguous" | "missing"
  confidence: number
  reason?: string
}
```

Validation:

- Unit tests for fallback ordering.
- Fixture tests for page edits that move or rewrite content.

Exit criteria:

- Existing annotations degrade gracefully when the page changes.

## Milestone 11: Agent Dispatch Integration

Repo: `vibe-remote`

Purpose: decide which events trigger agent turns and how they are formatted.

Rules:

- Not every event dispatches an agent turn.
- Form submissions and user annotations can opt into dispatch.
- Resolve/dismiss may not dispatch by default.
- Assistant marks do not dispatch to the agent that created them.
- Dispatch payload includes both typed event JSON and transcript projection.

Validation:

- Dispatch service tests.
- Agent backend contract tests.
- SSE tests for browser receiving turn progress.

Exit criteria:

- A user annotation can trigger an agent turn and stream the response back to
  the same Show Page.

## Milestone 12: Public Live Story And Runtime Cache

Repos: both

Purpose: support public sharing and hot updates without exposing privileged
actions.

Capabilities:

- serve `/p/<share-id>/...` through the live runtime, including HMR
- keep event submission, live handlers, and agent actions behind explicit
  permission checks
- move immutable runtime/vendor assets to versioned, cacheable paths that can
  be reused across session and share URLs
- keep session source modules and HMR channels unshared and fresh

Validation:

- public/private auth boundary tests
- browser smoke tests that public and private pages both receive HMR updates
- cache-header tests for immutable runtime assets and no-store session HTML
- public permission tests for event POST, handlers, and agent actions

Exit criteria:

- A user can share a public page that updates live as the agent edits it, while
  privileged actions remain inaccessible unless explicitly allowed.

## PR Sequencing

Recommended PR order:

1. `docs: define agent os interaction model`
2. `feat(sdk): add session event and anchor contracts`
3. `feat(show): persist show session events`
4. `feat(runtime): inject show event client config`
5. `feat(show): add assistant mark cli and transcript projection`
6. `feat(sdk): add structured intent components`
7. `feat(sdk): add basic annotation overlay`
8. `feat(sdk): add element context capture utilities`
9. `feat(sdk): add area and multi-select annotations`
10. `feat(sdk): add screenshot annotation drafts`
11. `feat(sdk): add opt-in freeze mode`
12. `feat(show): dispatch show events to agent sessions`
13. `feat(show): add public live show policy`

Each PR should include the scenario it unlocks and the evidence layer it
updates: unit, contract, integration, browser smoke, or manual residual.

## First Implementation Slice

The first code PR after the docs should be `feat(sdk): add session event and
anchor contracts`.

Minimum scope:

- SDK event type definitions
- anchor type definitions
- event builder helpers
- transcript projection helpers
- compatibility re-export for existing handler types
- tests for projection and default mark scope

Do not include:

- React overlay
- Vibe Remote migrations
- CLI
- Agentation-style capture utilities

This keeps the contract reviewable and gives Vibe Remote a stable target for
the persistence PR.

## Acceptance Checklist

Before marking the interaction system MVP complete:

- A Show Page can submit a structured choice to the session event store.
- A user can annotate a marked element with a comment.
- An agent can create an assistant mark by CLI.
- Assistant marks appear in the session transcript as assistant messages.
- Browser clients receive event updates over SSE.
- Public share URLs cannot submit events or invoke live handlers.
- The implementation does not depend on Agentation code.
- Annotation capture works when the target element is fixed/sticky.
- Annotation mode does not break normal page controls when disabled.
- Non-text drag selection can submit either an element group or an area without
  requiring a separate toolbar mode.
- Screenshot annotation can batch multiple numbered comments into one image
  event.
- The SDK remains split from visual primitives.
