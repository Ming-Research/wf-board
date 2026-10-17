Decision: The architect's stream is an ordinary agent stream and every owner note that has been sent goes there and not to the PM, because one protocol and one set of state for each recipient follow the owner's rule that any agent is reached the same way, and judging which notes are about content is the architect's work ([The architect's stream](../../docs/design.md#the-wake-streams)), instead of a second stream of the PM's kind for the architect, a note pushed to both streams, the PM forwarding notes, or the PM receiving them.

Decision: The architect's calls also count as receipts on the PM's stream; this is provisional, because no PM ran yet and the architect handles what is pushed to it, and it is reopened once a PM runs, when only the PM's calls should answer the PM's stream, because the architect's work would otherwise hide the PM's silence from the owner.

Rejected:
- A second stream of the PM's kind for the architect: rejected because it is a second protocol and a second set of state for one recipient, and the architect's calls would answer notes that it was never shown.
- Pushing each note to both streams: rejected because two receipts for one note leave it unclear who handled it.
- The PM forwarding the notes: rejected because the PM would have to judge which are about content, and that judgment is the architect's.
- The PM receiving the notes: rejected because most ask about an item's content, which takes reading the item, while the PM does the process.
