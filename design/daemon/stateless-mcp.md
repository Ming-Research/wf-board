Decision: The MCP endpoint answers POST only with JSON, gives every request its own transport and tool server, issues no session id, and takes the writer's identity from the request's credential, because a session lived in the process that made it, so every restart invalidated it, and a client that was caught by a restart longer than it keeps retrying (about 16 seconds) gave up its board tools for good ([MCP without a session](../../docs/design.md#4-architecture)), instead of a table of MCP sessions.

Rejected:
- A table of MCP sessions (the earlier design): rejected because a restart or a deploy invalidated every session, and a client that outwaited its retries lost its board tools for the rest of its own session.
