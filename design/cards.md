Decision: A decision card is one line of question and options, each with a short name and a detail (what it does, its cost, its risks, why it is or is not recommended), at most one of them recommended, and a confidence (its reason and an optional score from 1 to 5), and it holds no background: the head of its item gives the reasoning and places the card with a line that holds only its reference, a convention of the head's text and not a stored field, because the owner decides where the head gives the reasoning, and the head already says where each question belongs, so a stored index could disagree with it ([Decision cards](../docs/design.md#decision-cards)), instead of a long background on the card with only names in the options.

Decision: A card is stored once, with its item, and only a card that names the work it blocks is also a row of that item's plan, written by the card tool in the same commit and cleared when the card stops blocking, while the plan tools refuse card rows, so that the work goes on without a card that blocks nothing, instead of a row in the plan of every item that waits on the card or in the plan for every card.

Decision: Sending the owner's choice on a card records the ruling on the card in the same commit, a decision made in chat is recorded by a separate tool, and nothing deletes a card, an open card being retired only by withdrawing it, because no session should have to rule a card afterwards and a pick must not sit sent but unrecorded, and a closed card keeps its plan row as resolved, instead of a session ruling the card after the owner's pick or a card that can be deleted.

Rejected:
- A long background on the card with only names in the options: rejected because the owner decides where the head gives the reasoning and each option's cost belongs beside its name.
- A stored placement field or an index of cards: rejected because the head already places each card and an index could disagree with it.
- A separate decisions section on the page: rejected because a card outside its item is read without the text that asks it.
- A row in the plan of every item that waits on the card: rejected because a card of another item is a shared dependency of the item that owns it.
- A plan row for every card: rejected because a card that blocks nothing would hold an item's status for a question the work does not wait on.
- A session ruling the card after the owner's pick: rejected because a pick could sit sent but unrecorded.
- Deleting a card: rejected because withdrawing is the one way to retire a card and nothing deletes one, so an open card stays in the history.
