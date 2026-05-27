# Security

Vibe Show Runtime is designed to run as a local sidecar behind Vibe Remote.

Security expectations for the runtime:

- bind only to loopback
- do not expose the sidecar directly to public networks
- do not allow session code to call `server.listen()`
- scope file access to the active session workspace
- keep public sharing separate from live service handlers until explicit policy
  exists

Please report security issues privately to the maintainers instead of opening
public issues.
