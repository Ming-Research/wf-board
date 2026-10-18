Decision: One local daemon, bound to the loopback address only, is the only writer of the board's data and serves the owner's page, the MCP tools and the push streams, because a single process serializes every write and can push each change to the page and to the waiting sessions ([architecture](../docs/design.md#4-architecture)), instead of one stdio MCP server process per session, where several processes write the same files and none can push to the page.

Decision: The board's derived rules (an item's status from its plan, checks, freshness) are defined once, in one module that both the server and the page bundle import, and the daemon is written in TypeScript because that module must run in the page and the MCP SDK is TypeScript, so that an agent sees exactly the flags the owner sees, instead of a separate implementation of the rules for the server and for the page.

Rejected:
- One MCP server process per session (the usual stdio setup): rejected because several processes writing the same files need cross-process locking and could not push a change to the page.
- Several stateless server processes behind a lock file, with a separate notifier process: rejected because it keeps the cross-process locking and adds a process only to tell the page and the sessions what the writer did.
- A separate implementation of the rules for the page and for the server: rejected because an agent would no longer see exactly the flags the owner sees.
