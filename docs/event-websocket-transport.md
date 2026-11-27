# Show SDK event transport

## Change contract

The SDK consumes the frozen `websocket-sse-v1` contract approved on 2026-11-27.
Both `subscribeShowEvents` and `ShowSessionProvider` must select WebSocket only
when the target stream has that capability. An absent capability preserves
native EventSource behavior. A WebSocket failure never downgrades to HTTP SSE.

WebSocket messages carry the existing SSE text frames. Preserve event names,
payloads, IDs, URL paths and query parameters. The transport owns bounded
reconnection and resumes with `after_id`. Closing a source cancels reconnection
and prevents late deliveries. Provider source changes reset source-owned state.
An overridden stream on another origin cannot inherit the injected capability.

The Avibe companion change owns server admission, generators, capability
injection and joint browser acceptance. This repository owns SDK parsing,
subscription selection and React consumption. No archive packaging, release,
installation or production state changes are part of this work.

## Validation

- Unit tests exercise fragmented SSE frames, listener semantics, cursor replay,
  bounded reconnect, close cleanup, capability isolation and compatibility.
- React DOM tests mount the real Provider and exercise live delivery, reconnect,
  source changes and unmount cleanup.
- Build and typecheck the workspace; run focused SDK tests and workspace tests.
- Avibe integration tests cover Chromium/WebKit multi-document behavior and
  shared endpoint authorization, revocation and filtering.

## Artifact dependency

The private workspace SDK is version `0.0.0`. Avibe release automation resolves
Show `main` to a SHA and bundles the workspace, including the SDK. This PR must
merge before the intended Avibe release resolves that SHA. It requires no
separate npm publication or version bump.
