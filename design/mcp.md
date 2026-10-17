Decision: Every tool returns compact text, and the two reads that returned the most, `context` and `overview`, answer with a summary by default (a head section's first paragraph cut at a limit, finished rows folded, option grounds left out, handled notes and long logs cut) where every cut says how much it left out and which parameter returns the rest, because a reply stays in the caller's context until it is compacted (433 `context` calls returned 1.59 million characters, and one `overview` answer cost 24 thousand characters) ([Lean replies](../docs/design.md#lean-replies)), instead of the whole answer by default. This is a temporary trim, reopened when the planned redesign of the tools is made.

Decision: A write refuses a head that holds the exact marker line of a cut answer and says to read the whole head first, because a head copied from a cut answer would silently drop the text the answer left out.

Decision: The MCP server's instructions are a short pointer, of at most 2048 characters, to the board section of the shared agent rules, with three first steps and no rule of their own, because Claude Code cuts longer instructions at 2048 characters (observed) and the owner decided that the rules for using the board must stay in the agent's context for the whole session, which the shared rules do, and a rule the server enforces is defined once in the model or rules module ([Server instructions](../docs/design.md#server-instructions)), instead of the full rules in the server's instructions or a guide tool.

Rejected:
- The whole answer by default (the previous behavior): rejected because of its measured cost in the caller's context.
- Accepting a head written back from a cut answer: rejected because it would drop the text that the cut left out.
- The full rules in the server's instructions: rejected because they would be cut at 2048 characters and reach no agent.
- A guide tool or resource for the rules: rejected because it adds a call the agent must make and does not keep the rules in its context.
