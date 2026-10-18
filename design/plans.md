Decision: Every item has one ordered plan of rows (steps, owned items, shared items, cards and acceptance steps) from which the item tree, status and blocking are derived; item and card rows are named by their target's key so that a plan names each target once, rows carry no separate reason, and a row may come only after earlier rows, so that order cannot form a cycle, because the earlier model spread an item's work over a head section read by pattern, dependency lists, a parent repeated in the parent's dependencies (174 children missing) and sub-items invented only to derive a status (58), instead of separate steps, dependencies, a parent field and a completion-condition section ([Item plans](../docs/design.md#item-plans)).

Decision: A work item has at least one acceptance step and is done only when every row is resolved, acceptance and delivery rows included, and a parent is not done merely because its children are, because the owner ruled that an item is complete when its own plan is, instead of a parent that is done when its children are.

Decision: An item's status is derived from its plan as the first that holds of: cancelled (stored), done, paused, in progress because a row is in progress, blocked because everything that could move next waits on another item, another project or the owner (or the row that owns the item comes after an unresolved row of its owner), in progress because an unfinished dispatch started or wrote within six hours, part done, not started; only cancellation and the pause marker are stored, because a status set by hand needs checks that only exist for it, and an item is blocked exactly when nothing it holds can move ([Status](../docs/design.md#status)), instead of a status set by hand or a parent that is blocked as soon as one child is blocked while another may be ready.

Decision: A row's level is zero when it comes after nothing and otherwise one more than the highest level of the rows it comes after, a run of adjacent rows of one level is a parallel group, and rows are shown in the order they were stored while a read warns when rows of one level are not adjacent, because sorting a plan by level would reorder what a session wrote, instead of the server keeping every plan sorted by level.

Decision: A shared row that points at a cancelled item stays unresolved and is flagged, and cancelling an item is refused while a row it owns is still open, naming those rows, because a result that will never come is for the waiting project to settle and each open part deserves its own reason, instead of counting such a shared row as resolved or cancelling every open owned item with one reason.

Rejected:
- Separate steps, dependency lists, a parent field and a completion-condition section in the head: rejected because the copies disagreed and status could only be read from the text by pattern.
- A reason on every item and card row: rejected because the owner ruled that a row's place in the plan and the titles say what it is for.
- A parent that is done when its children are: rejected because the owner ruled that an item is complete when its own plan is.
- A status set by hand: rejected because the checks that existed only to catch hand-set status go away when it is derived.
- A parent that is blocked as soon as one child is blocked while none is in progress: rejected because another child may be ready, so work can proceed.
- The server keeping every plan sorted by level: rejected because it reorders what a session wrote.
- Counting a shared row to a cancelled item as resolved: rejected because a result that will never come is for the waiting project to settle.
- Cancelling every open owned descendant with one reason: rejected because each part gets its own reason.
