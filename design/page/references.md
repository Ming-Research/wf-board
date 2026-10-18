Decision: A reference to an item is written as `[[it:key]]` and a reference to a card as `[[q:key]]`, a note keeps the token as typed, and the page shows the target's current title as a link, a missing target struck through, and leaves tokens in code untouched, because an item and a card may share a key, double square brackets begin no other markup in block text, and a session that reads through MCP sees the key ([Reference tokens](../../docs/design.md#7-the-page)), instead of a bare key without a prefix.

Rejected:
- A bare key without a prefix: rejected because an item and a card may share a key.
