Decision: The activity index (the times of content writes, each item's last change, the spans when work was paused, the last session to write each item and each session's last two items) is derived from the git history and no board data file stores it, and a start reads a disposable cache kept in git's own metadata directory only when it parses to exactly the current format, is of an ancestor of the head and, when it is of the head itself, agrees with the documents on whether a pause was ever set, and otherwise rescans the whole history and writes the cache at once, because the history already holds the evidence and a restart must give what live writes gave ([Data format](../../docs/design.md#5-data-format)), instead of a stored activity file or a derivation from the whole history at every start.

Rejected:
- A stored activity file: rejected because everything in it can be derived from the history.
- Deriving the index from the whole history at every start: rejected because the start would grow with the history instead of with the commits since the cache.
- Writing the cache at shutdown: rejected because shutdown must fit the time launchd gives.
