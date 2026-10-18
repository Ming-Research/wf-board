Decision: The owner's reading state is a cursor into the git log plus optional per-document marks, saved locally without a commit and joined to the next data commit, with a commit of its own only at an orderly shutdown, and logs, first ratings, numbers, glossaries and messages are never unread, because git history replaces the 478 per-item read records that each held a full snapshot (473 KB), and a commit id is enough to say what changed since the owner last read ([The read cursor](../../docs/design.md#5-data-format)), instead of per-item read records, a commit for every read, or a first rating that shows an item as unread.

Rejected:
- Per-item read records with full snapshots: rejected because with git history a read needs only a commit id.
- A commit for every read: rejected because ordinary reading would then make commit noise.
- Showing a first rating as unread: rejected because rating hundreds of items would mark each of them new for one added label.
