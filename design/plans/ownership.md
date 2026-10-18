Decision: An item's owner is the item whose plan holds an owned row for it and there is no parent field: a second owned row is refused, owned rows never cross projects (a need from another project is a shared row), an open top item that an open item of its own project waits on is refused, and item rows may not form a cycle, so owned rows form a forest, and each of these structural rules is refused at the write, because writes should be hard to get wrong and a violation that is only flagged afterward is one someone must find ([Ownership, the tree, roots and top items](../../docs/design.md#ownership-the-tree-roots-and-top-items)), instead of flagging violations after the fact, as the artifact board did.

Decision: A plan write adds an owned row only for an item that no row owns and refuses to remove an owned row while its target is open, and ownership moves only through the deliberate move call, which logs on both owners, because a transfer must be a deliberate act and not a side effect of editing two plans, instead of transferring ownership through plan writes.

Decision: Changing an item's project moves the item and everything it owns in one commit, an owner left behind keeps its row as a shared row, and the item arrives as a top item of the new project, because ownership never crosses projects and each project writes only its own items, instead of moving only the named item, which would leave owned rows across projects, or letting the call name the new owner, which would write another project's item.

Rejected:
- Flagging violations after the fact on the page: rejected because the board's goal is that a write is hard to get wrong, and the flag only reports it later.
- Transferring ownership through ordinary plan writes: rejected because a transfer must be deliberate and logged on both sides.
- Moving only the named item to another project: rejected because the rows it owns would then cross projects.
- A move call that names the new owner: rejected because the call would write an item of another project.
