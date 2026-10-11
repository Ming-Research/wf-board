# wf-board

The shared status board of the Whitefoot projects, run locally: one daemon on
`127.0.0.1` serves the owner's page, an MCP endpoint every agent session on
the Mac connects to, and a wake stream for "发给 Claude". The board's data is
a separate git repository (`Ming-Research/wf-board-data`) that only the
daemon writes.

Status: under construction. The design is `docs/design.md`.
