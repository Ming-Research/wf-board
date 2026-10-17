Decision: The agent list is built only from the board's own records, the per-session index of the last items each session wrote and the dispatch records on items, and never from the host machine, because the owner required that the board can run on another machine and keep the list, and a dispatch record gives a session's level and start time before it has written anything, instead of asking the host for its session list, reading its state files, running a reporter process or hooks, or taking the last writer of an item alone ([Agent list](../../docs/design.md#agent-list)).

Decision: A session other than the PM and the architect is listed for six hours after its last write or dispatch start, its state word comes from the steps in progress on its two items (a wait text, working within 30 minutes of its last activity, may have stopped after that, and none for a review), and a row is expanded only when its session has an unfinished dispatch that is alive within the same six-hour window the item status uses, because alive is then defined once, and a session that waits for CI or the architect writes nothing for an hour; the 30 minutes are provisional and reopen if a working session is seen silent for longer, instead of hiding the rows that are not running or telling running by the time since the last write alone.

Rejected:
- Asking the host for its session list or reading its state files: rejected because it ties the board to the machine.
- A reporter process or hooks: rejected because they add a process or a Claude Code format to keep alive.
- Taking the last writer of an item alone: rejected because it loses a session's earlier items when another session writes the same item, and it needs the step in progress to know whose item it is.
- Hiding the rows that are not running: rejected because an unclosed finished session could then not be found.
- Telling running by the time since the last write alone: rejected because a session that waits for CI or the architect writes nothing for an hour.
- Inferring running from a step in progress on its items: rejected because the board cannot tell whose step it is.
