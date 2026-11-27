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

The 2026-11-27 security amendment makes an authoritative access denial terminal.
After WS failure on a same-origin `/show/{id}/__show/events` or
`/p/{id}/__show/events` URL, the SDK performs one ordinary JSON GET to the same
endpoint with `stream` removed, preserving the cursor and other query values.
These server-owned routes reuse admission and return a non-streaming list.
The SDK does not follow redirects or consume the response as events. A 4xx
response closes the source, except temporary 408/425/429 responses. Network
failures, the three-second probe deadline and 5xx responses retain bounded
backoff. A successful WS open resets the delay even for an idle stream.
Closing cancels the probe as well as the socket and reconnect timer.

The SDK never assumes that a custom endpoint, `/api/events`, or a foreign origin
has this non-streaming GET/credential policy. Their opaque failures retain
backoff; a received WS policy-violation close (1008) is terminal on every path.
No handshake failure selects EventSource or changes capability.

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
