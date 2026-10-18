Decision: Every page request and every tool call is timed at the one place each passes through, against the limit of its class (read, history, write, and a tighter one for the owner's mark-read), the served routes are one list that the router consults so that no route lacks a class, and a slow operation is logged and told to the architect once an hour, because a timer inside each tool or route would miss the next one someone adds ([Time limits](../../docs/design.md#4-architecture)), instead of logging alone, which leaves the architect to read the log, or a timed probe of the health route from outside, which cannot say which operation was slow; the limits themselves (1 second to read, 10 seconds for history, 2 seconds to write) are starting values that no measurement chose and are reopened after a day on the live board, when the log shows which ordinary operations exceed them.

Rejected:
- A timer inside each tool or route: rejected because it would miss the next route or tool someone adds.
- Logging alone: rejected because it leaves the architect to read the log.
- A timed probe of the health route from outside: rejected because it cannot say which operation was slow.
