// The server's instructions: a short pointer, never the rules. How to use the board and write on it lives in the
// shared rules (the board's rule blocks shared-rules and item-writing), which every agent's rule file carries. Claude Code cuts a server's instructions at 2048 characters, so full rules here would reach
// no agent. docs/design.md (MCP tools, Server instructions) is the owner of this decision and gives the measurement.

export const INSTRUCTIONS = [
  `wf-board is the status board all wf projects share.`,
  ``,
  `How to use it is in the shared rules, section "The board", and how to write items, cards, plans and logs on it is in "Item writing". Every agent's rule file carries both (assembled in $WF_HOME/agents_config). If yours does not, read the board's rule blocks shared-rules and item-writing with context (section "all") before you write. These instructions hold no rules of their own.`,
  ``,
  `To start:`,
  `1. Call projects and pick the project whose repo matches your repository's GitHub remote.`,
  `2. Call brief with that project's name.`,
  `3. In every write, pass that project's name as author and your own session's name as session.`,
].join("\n");
