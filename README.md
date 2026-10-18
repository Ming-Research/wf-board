# wf-board

The shared status board of the Whitefoot projects, run locally: one daemon on
`127.0.0.1` serves the owner's page, an MCP endpoint every agent session on
the Mac connects to, and a wake stream per session that pushes it what
needs it. The board's data is
a separate git repository (`Ming-Research/wf-board-data`) that only the
daemon writes.

Sessions reach the MCP endpoint through a user-scope registration on the
Mac, made once:

    claude mcp add --transport http --scope user wf-board http://127.0.0.1:7417/mcp

Project repositories commit no `.mcp.json`: the server exists only on this
Mac, and a committed file would point every other checkout at nothing.

Status: under construction. The design is `docs/design.md`.

## License

wf-board is available under the [MIT License](LICENSE).
