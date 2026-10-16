// The server's instructions: a short pointer, never the rules. How to use the board and write on it lives in the
// shared AGENTS.md (~/dev/wf/AGENTS.md, section "Board"), which every session started under ~/dev/wf loads and keeps
// through compaction. Claude Code cuts a server's instructions at 2048 characters, so full rules here would reach
// no agent. docs/design.md (MCP tools, Server instructions) is the owner of this decision and gives the measurement.

export const INSTRUCTIONS = [
  `wf-board is the status board all wf projects share.`,
  ``,
  `How to use it, and how to write items, cards, plans, logs and messages on it, is in ~/dev/wf/AGENTS.md, section "Board". Every session started under ~/dev/wf loads that file. If yours was not, read the section before you write. These instructions hold no rules of their own.`,
  ``,
  `To start:`,
  `1. Call projects and pick the project whose repo matches your repository's GitHub remote.`,
  `2. Call brief with that project's name.`,
  `3. In every write, pass that project's name as author and your own session's name as session.`,
].join("\n");
