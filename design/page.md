Decision: The page is a client of the daemon: it loads a snapshot of the board, applies the live change stream and posts the owner's writes, loads the same rules module as the server, and the snapshot carries only the days of messages that hold the newest 200, because the board must work independently of any claude.ai account and the page must not grow with the board's history ([The page](../docs/design.md#7-the-page)), instead of the claude.ai artifact's own data layer and comment interface.

Rejected:
- The claude.ai artifact's data layer and comment interface: rejected because the board was tied to the account that published it and an account switch cut every session off from it.
- Sending the page the whole history of messages: rejected because the page would grow with the board's history.
