# wf-board design

Item plans (section 5) and plan conversion (section 10) are the owner's
approved design of 2026-10-13. Project responsibility in sections 8–9
records the owner’s settled decisions and supersedes per-item `agent` ownership
and per-project lists of agent session names.

## 1. Problem

The status board that the owner and every agent session share was a claude.ai
artifact. Its data lived in
the artifact's database, read and written with the ArtifactData tool, and its
"发给 Claude" button woke the watching session through the artifact runtime's
comment API (`comments.sendToClaude`).

The board was tied to the account that published it: from another account,
Claude Code can read the page but not its data ("that organization doesn't let
invited editors use artifact data from Claude Code"), and the help center
documents no setting that lifts this for outside invitees. An account switch
therefore cuts every session off from it.

The board is more than a progress display. Its 835 items, 161 decision cards
and 374 owner notes are the shared context of all projects: what each line of
work is, why it was chosen, what it waits on and what the owner ruled. Agents
read and write it all day (from the session transcripts since 2026-10-06:
about 720 item reads, 800 item writes, 600 batches, 130 queries for sent
notes).

## 2. Goals

1. The board works independently of any claude.ai account.
2. Agents find context easily: search across everything, the history of an
   item, why it exists, what it depends on and what depends on it, what
   changed while they were away.
3. Writes are hard to get wrong: the server stamps times, checks the board's
   rules (every row's target exists, every item is owned by at most
   one plan row and never across projects, a work plan has at least one
   acceptance step, a cancelled item says why), and refuses a stale
   overwrite. Today these rules are prose in AGENTS.md that agents must
   remember, and the page only flags violations after the fact.
4. Every change is kept with who made it and when, and nothing is lost.
5. The owner keeps the page as it is today, opened in the desktop app's
   browser pane, including one-click "发给 Claude".

Non-goals for now: access from the owner's phone or other machines, cloud
sessions, multiple human users, authentication beyond binding to localhost.

## 3. What the data shows

From the export of 2026-10-11 07:17 UTC (`wf-board-data/import/`):

| Fact | Consequence for the design |
|---|---|
| Item bodies total about 900k characters; half the items have no log, the largest has 19k characters and 35 log entries | Nobody can read the board whole. Search first, then expand; context returns recent log entries by default and the rest on request |
| 23 areas (top-level items), depth at most 4, 126 parents, one with 77 children | Listings page and summarize |
| 649 deps, 631 with a why; 61 cross areas and 48 cross projects | The dependency graph must span projects and always carry the why; that is where context crosses sessions (since item plans, a row's place in its plan replaces the why; section 5) |
| 150 of 161 decision cards are ruled, each with background, options and ruling | Ruled cards are the main record of why; search covers cards and notes, not only items |
| 1536 bare `#NNN` references in 269 items, without the repository | Index PR references per repository; new text writes `Repo#N` |
| 478 read records holding a full snapshot each (473 KB) | With git history a read needs only a commit id; the snapshot goes |
| `agent` appears only on the 23 areas; no sub-item ever used the handover field | Responsibility is effectively per area plus prose in logs; see section 9 |
| Agents' own pattern: read an item, append a log entry, write the item back with its version (the majority of all writes); 5 version conflicts and several malformed calls in the transcripts | `append_log` becomes one call without a version; appends never conflict |

## 4. Architecture

One local daemon, `wf-board`, written in TypeScript on Node 24, bound to
`127.0.0.1` only. It serves three things from one process:

1. **The page** for the owner, at `http://127.0.0.1:7417/`, with live updates
   pushed over server-sent events.
2. **MCP** for agents, over Streamable HTTP at `/mcp`. Every Claude Code and
   Codex session on the Mac connects to the same process. It keeps no session:
   each request stands alone (see *MCP without a session*).
3. **The wake streams** (WebSocket): `/wake/<session name>` pushes an agent, the
   architect among them, what needs it (the architect: the owner's notes and its hourly wake; section 8). There is
   no stream for the PM, which is retired (section 8, The PM is retired).

**Why one daemon rather than an MCP subprocess per session.** The usual MCP
setup starts one server process per session (stdio). Several processes
writing the same files would need cross-process locking and could not push
changes to the page. A single process is the only writer, serializes all
writes, and pushes every change to the page and to waiting sessions.

**Why TypeScript.** The page's derived rules (an item's status from its
plan, the 需核对 flags, freshness) are JavaScript
today. One module, `src/rules.ts`, serves both the page and the server, so an
agent sees exactly the flags the owner sees. MCP has an official TypeScript
SDK.

**Storage.** The data is a git working tree, `wf-board-data` beside the wf-board checkout (`~/dev/wf/wf-board-data` with the checkout at `~/dev/wf/wf-board`; `WF_BOARD_DATA` overrides it), with the
private remote `Ming-Research/wf-board-data`. The server is the only writer:
each logical operation is one commit whose author is the writing project (or
`owner` for an owner operation) and whose message summarizes the operation. git's automatic maintenance is off (`gc.auto=0` and `maintenance.auto=false` on every git command that writes the repository, which all run through the store's `git()`; the read-only `cat-file` reader and the reads of a one-time conversion start no maintenance); the board maintains the repository itself, as a task of the write queue (Maintenance), so no git process writes the data repository outside the write queue. The server pushes to the remote when
it has new commits: first 60 seconds after it starts listening, then at most
every ten minutes. The 60 seconds date from when a push held the write queue and the agents
that reconnect after a restart catch up on writes in the first seconds; a push no longer
holds the queue, so that reason is gone and the value stays as a provisional choice,
since nothing measured favors another. It does not push on shutdown (see Stopping). Each push writes its duration to the service log. If the server
is down, agents can still read the files with Grep and Read; nothing is
hidden in a database.

**Pushing and the write queue.** Writes go through one queue, one task at a time, so
only one git change is in flight; its tasks are each write and the save of the
owner's reading state on shutdown. A push is not a task of the queue. It takes the
head commit as of its start and runs one `git push` of that commit beside the writes,
over one connection; git itself says whether it sent commits, found the remote
current, or was refused. Only a refusal is followed by one `fetch`, to tell a remote
that is ahead of this clone (no error: the next push has nothing to send) from one that
has diverged (an error). Commits written while a push runs go in the next one. One push
runs at a time, and a call made while one runs gets its result. A push beside a write
is safe because it reads objects and changes one remote-tracking reference, and its
git runs with automatic maintenance off, so it never starts a repack of its own. The
other direction is a maintenance step repacking while a push reads objects. Two
replays of the live board's busiest ten minutes (hosted runner, git 2.55.0, 1652 writes
each, a step after every 200 commits) ran a push every 3 seconds beside the writes and
the steps: 396 pushes in all, none failed, `git fsck` passed at the end, and the remote's
head was an ancestor of the local one (item `data-repo-gc-timing-study`). A push that
did fail would be tried again at the next round and, if it kept failing, told by the
lag push below.

A push takes 4.1 to 6.6 seconds (five pushes in the service log of 2026-10-16) and,
with the network down, never ends. In the queue, it held every write: in CI with a fake
ssh, a write made 300 ms into a push waited 3.4 s when each connection took 1.2 s,
8.8 s when each took 3 s, and did not finish within 20 s when a connection never
answered. Writes have a 2 s limit (Time limits), so the queue must not wait
for the network.

**The rule: no task of the write queue waits for the network.** Every git command that
reaches a remote runs through one function, `netGit` (`src/net-git.ts`): the store's push
and the deploy job's fetch, and nothing else. It starts git in a process group of its own,
with automatic maintenance off. ssh is git's child and a signal to git alone leaves it
running, so a command that outlives its cap (five minutes) or whose caller asks it to stop
is sent SIGTERM as a whole group and, two seconds later, SIGKILL. Five minutes is provisional:
shorter than the push interval, so a stuck push ends before the next is due, and longer than
a large catch-up needs (a week offline is about 20 MB, 20 s at 1 MB/s; deduced, the real
uplink is not measured). It is reopened when the service log shows a push killed by the cap
while it was still sending. The shutdown asks for the push's end the same way.

**A copy that falls behind is told.** A stuck push no longer slows a write, so its harm
is a remote copy that is out of date without anyone seeing it. When the copy has lacked
commits for an hour, the architect gets one `backup-behind` push (section 8) with the
number of commits left, the time of the last success (null if none since the start) and
the last failure's reason. The hour counts from the last time the copy was known current:
a push that sent or found nothing to send, or a round that found nothing to send; after a
start, from the start, since the state is in memory. A copy that is current again and falls
behind again is told again.

**Maintenance.** The data repository gains loose objects, about 4 for each commit (4.14 on the
live board), and someone has to pack them. git does it by itself after a commit, at a time and in a
size the board does not choose: the first such repack on the live repository (9,087 loose objects from
2,160 commits) held a write for 5,672 ms, over the 3 seconds a write may wait. In the background, the same
repack deleted an empty object directory while the next `git add` made a temporary file in it, which
failed 11 of 1,726,480 writes in a reproduction with git alone and none of 2,030,080 without the
repack (item `e2e-git-tmp-flake-study`). So git's own maintenance is off, and the board runs a step
itself as a task of the write queue, where it cannot overlap a write.

- **When.** After every `MAINTENANCE_EVERY` (100) commits, counted from the last step. `Store.open` estimates the
  commits waiting from the loose objects it finds (divided by 4), maintains a backlog of 100 or more before it returns,
  and so before the daemon listens. A commit queues no second step while one is queued. A step that fails is logged and
  tried again after 100 more commits. Rejected, with the measurements of item `data-repo-gc-timing-study`: waiting for
  idle time (the live board's busiest ten minutes of 596 seconds have 105 seconds without a commit and a commit in
  the others, so the cap on commits would decide anyway), maintaining only at start (the backlog has no bound: a week without a restart is about 20,000 commits and a
  step of about 60 s, estimated), maintaining at fixed times (a step follows the writes: the busiest ten minutes' 1,566
  commits would be one step of about 5 s, estimated), and git's own trigger with a lower threshold (it still
  rewrites the whole repository now and then, and its trigger is out of the board's hands: on the replica it started at 3,436 loose
  objects and on the live repository not yet at 5,154, for a cause that was not found).
- **How many.** 100. On a hosted runner, replaying the live board's busiest ten minutes against a copy of its shape
  (1652 writes each), a step of 100 commits took a median of 240 and 299 ms (two samples) and at most 753 and 734 ms, the slowest
  write was 631 and 771 ms, and none of the writes took 3 s. A step of 200 took at most 1,065 to 1,699 ms in three samples. In one reproduction of the 10-16
  repack the replica took 0.69 to 0.95 of the live repository's time, so the live Mac may be up to 1.45 times slower: a step of 100
  then takes about 1.1 to 1.3 s, under the 2 s line at which a slow write is told to the architect (Time limits), and a step of 200
  about 1.5 to 2.5 s, which reaches that line.
- **What a step does.** `git repack -d -l --write-midx` packs every loose object into one new pack;
  `git commit-graph write --split --reachable` writes the commit-graph (a history query is about 6 times
  faster with it); and, when the repository had more than 8 packs before the step, `git multi-pack-index expire` and
  `git multi-pack-index repack --batch-size=16m` merge the small packs in batches of about 16 MB. Over 12,000
  commits on a synthetic copy a step of 100 took a median of 601 ms and at most 906 ms, and there were at most 10 packs.
  Rejected: git's own geometric repack for each step (the smallest disk, but a repack of the whole repository every
  7,300 commits took 3.6 to 4.4 s and grows with the repository), packing without merging (the pack count has no bound: 63
  after 60 steps), and a `.keep` file on the large packs (every step took 2.2 to 2.6 s).

The cost is disk: the merge in batches finds deltas only inside a batch, so the synthetic copy grew to 134 MB over 12,000 commits
where git's own way gave 75 MB (from 54 MB), about 4 times per commit. On the live board that is an estimated 80 to 108 MB a
week more than git's own, not measured there. Each step writes a line to the service log,
`maintenance 100 commits 301 ms 6 packs 27.5 MB` (commits, time, packs and size after the step), and the start writes
`startup maintenance: ...` with what it found. The first start after this change has a backlog of about 1,600 commits and a
step of about 5 s (estimated). Reopen the choice when the service log shows a step over 1.5 s or a write over 2 s, when a week's
growth is over twice the estimate (then a full repack at start, before listening, once the disk passes a threshold), or when
the pack count passes 10.

**Running.** A launchd agent starts the daemon at login and restarts it on
exit, one second after the last start (`ThrottleInterval`; launchd's default of
ten seconds would hold up a redeploy that has to be rolled back). `GET /health`
reports its state; the page shows a banner when the server
does not answer, and every MCP tool error names the cause. Every line of the
service log carries its time, and a start logs how long each step took (reading
the documents, checking them against the repository, reading the startup cache
and the commits after it, replaying them) and the time from the start of the
process to listening.

**MCP without a session.** `/mcp` answers `POST` only, with JSON. Every request
gets its own transport and tool server, closed when it has answered, and no
session id is issued; `GET` and `DELETE` get 405, as there is no stream to open
and no session to close (the board pushes through the wake stream, not through
MCP). A restart of the board therefore invalidates nothing a client holds. This
replaced a session table: a session lived in the process that made it, so a
restart invalidated it, and a client caught in that gave up its tools for good
when the board stayed down longer than the client keeps trying (about 16
seconds; item `fast-restart-study`). A client that is not in a call knows
nothing of a stop; one that is retries when the board is back. Who is writing
comes from the request's `Authorization` header (section 9), not from a session.

A write that was committed when the board stopped but not answered is sent
again by the client. Four writes would silently add a line twice, and nothing
else stops the second: `append_log`, `close_note`, `set_status` and
`journal_entry`. Such a write is not made when the item's history holds a commit
of the same operation on the same target from the same session, made in the
last minute, that left the item holding the line this write adds (the last log
line of the same author with the same text; for `journal_entry`, the same text
at the end of the head; for `set_status`, also only while the item is in the state the
call asks for, so a cancel after a reopen is a new decision). The answer is that first
commit, marked `repeated`. The check reads history under the request's budget; when
the budget is spent the write is made, at worst once too often. It asks git for the
item's commits of the last minute (`git log --since`), not for its 20 newest: a log
limited to one file and asked for 20 commits looks through the whole history for them
when the file has fewer, which took 2 to 3 s on the live board's 27,666 commits, and the
write queue waited for it (Time limits, Where a write's time went). The
rule reads the commit's message and `Session:` trailer and the item as the
commit left it, so it holds across a restart with nothing kept in memory, and
one function serves the four writes. A caller that names no session is not
recognised and writes. The cost is that a second identical write within a
minute from one session is not made, which the answer says. The other writes
are refused or change nothing when repeated (a used key, a stale revision, an
unchanged plan, a note already replied, an ended dispatch).

**Stopping.** launchd sends SIGTERM and kills the process five seconds later (the job's exit
timeout: `launchctl print` on the job reports `exit timeout = 5`, and the plist sets none).
The daemon uses well under that:

1. From the signal on, the server accepts no new connection and answers every
   request that still arrives (page, MCP or wake stream) with 503, `Connection:
   close` and `Retry-After: 2`. A client that retries on its old connection
   therefore starts no work in a process that is about to exit.
2. The page's event streams and the wake connections end at once, so their
   clients start to reconnect and are refused. MCP has no stream.
3. A request already running, a tool call included, may finish. The connection
   it ran on closes with its response. After two seconds (`SHUTDOWN_GRACE_MS`)
   every connection that is left is closed.
4. A push that is running is ended (below). The owner's reading state is committed locally, and the process exits.

A push takes 4.1 to 6.6 seconds (Storage), more than the five seconds launchd allows, so
shutdown does not push. The data is already committed locally, so nothing is
lost: the remote copy is only a backup, and the first push after the next start
sends what this run left. A push still running when the signal arrives is ended
at once, its group killed as in Storage, so it neither delays the local commit of
the reading state nor keeps the process alive.

A maintenance step that is running when the signal arrives is not stopped: the commit of the
reading state waits for it in the write queue, and the shutdown queues no step after the signal
(`Store.stopMaintenance`). In the replays of Maintenance a step of 100 commits took 753 ms at most
on a hosted runner. Not measured: a step that runs at the moment of a shutdown on the live Mac, and
the first step after a long backlog.

**Time limits.** Every page request and every MCP tool call is timed at the one
place each passes through: the request handler in `src/http.ts`, and `register` in
`src/mcp.ts`, which every tool goes through. One line of the service log says what
ran, how it ended and for how many milliseconds: `GET /api/snapshot 200 62 ms`,
`tool context ok 12 ms` (`error` for a tool that failed). A request whose
connection closed before the answer went out ends as `closed`, with the time it
had run, so a page that gave up waiting is timed too. `SlowOps`
(`src/slow-ops.ts`) does the timing, the logging and the telling.

An operation has a class, and is slow when it takes more than its class's limit:

| Class | Limit | Operations |
|---|---|---|
| read | 1 s | `GET /`, `/app.js`, `/mermaid.js`, `/health`, `/api/snapshot`; every tool that reads the board except those of the next row |
| history | 10 s | `GET /api/unread`, `GET /api/step`; the tools `changes`, `history` and `diff`, which read the git history |
| write | 2 s | `POST /api/notes`, `/api/draft`, `/api/send`, `/api/read`, `/api/wake`; `DELETE /api/notes/<id>`; every tool that changes the board |

`POST /api/read`, the owner's mark-read key, has a limit of its own, 0.3 s, since
the owner waits on it. The key that jumps to the next unread change sends no
request, so it has none here. The event stream (`GET /api/events`) and the
requests of the MCP transport (`/mcp`) last as long as their client does, and a
tool call is timed as its tool: they are logged with their time and never held
to a limit. The wake socket (an upgrade, not a request) is not timed. The log
line of a request carries its path without the query, and the operation's name
(what the one-hour rule and the push go by) drops ids: a path the board does not
serve is counted under one name, `<method> (unknown route)`, and
`DELETE /api/notes/<id>` under `DELETE /api/notes/:id`, so the names stay a small
fixed set. The routes the board serves are that one list (`PAGE_ROUTES` in
`src/slow-ops.ts`, the table above with its streams): the router answers 404 to a
request that matches no row of it, so a route cannot be served without a class,
and the classes are never out of step with the routes.

An operation over its limit is logged on a `slow` warning line with a summary of
its parameters, and told to the architect as a `slow-op` push (section 8): its
name, its time, its limit and the summary. One operation is told once an hour;
its later slow calls are only logged, so one slow stretch does not become a string
of pushes. The hour is counted from the pushes the board keeps, so a restart does
not tell again. The summary holds no body text: numbers and the names of things
(an id, a project, a kind, a filter, a search query cut at 60 characters) are
written out, any other string shows only as its length (`head(2100 chars)`), and
a list as its count.

The 1, 2 and 10 seconds are starting values, not measurements. After a day on the
live board, the times in the log show which ordinary operations exceed them; each
is then looked at to see whether it is slow, and the number changed or the
slowness fixed. No write waits for a push to the remote: the push runs beside the
write queue (Storage).

**Where a write's time went.** The line of an operation says how long it took, which for a
write that waits in two queues and runs a handful of git commands is not enough to tell
what was slow. A write call (a tool that changes the board, a page request of the write
class) carries a `WriteTrace` (`src/write-trace.ts`) in its async context, and the places
it waits or works end a step in it: the wait in the operations' own queue (`ops queue`,
`src/ops.ts`) and the checks before the commit (`check`); the wait in the store's write
queue (`store queue`, with how many tasks were ahead and the kind of the one it joined
behind: `write`, `owner state` or `maintenance`); the code before the first git command
(`validate`), the writing of the files (`files`), each git command by its name (`git diff`,
`git add`, `git commit`, `git show`), the update of the board in memory (`publish`), the
observers of the change (`listeners`) and the rest of the call. The steps are consecutive:
each is the time since the one before ended, so they add up to the call. When the call took
500 ms or more (`STEPS_FROM_MS`, a quarter of the write limit, a starting value like the
limits), its ordinary log line carries them after a semicolon:
`tool append_log ok 2659 ms; ops queue 165 ms, check 12 ms, git diff 8 ms, git add 14 ms, git commit 2400 ms, ...`.
A line under 500 ms stays as it was, and the push to the architect (`slow-op`) is unchanged.
The maintenance step, which a commit queues from inside its own call, belongs to no call and
adds nothing to any trace. A second line says when the event loop itself was held: a timer
due every 100 ms that comes 500 ms or more late (`src/loop-watch.ts`) logs
`event loop held for 621 ms (a timer due every 100 ms came that late); cpu 612 ms, gc 3 ms, load 1.82`,
because a git command's time that is the time of a held loop is not git's. The three
readings say why it was held, each over the stretch between the timer's last two firings
(the held time and the 100 ms before it): `cpu` is the CPU the process used
(`process.cpuUsage`, user and system, all its threads), `gc` the time its garbage
collections took (the `gc` entries of a `PerformanceObserver`) and `load` the machine's load
average over the last minute (`os.loadavg`). `cpu` about the held time with little `gc` is
code that did not return; `gc` about the held time is the collector; `cpu` far under the
held time is a process that was not given the CPU, and `load` tells whether the machine was
busy. The collector's helper threads count in `cpu`, so a collection can put it over the
held time. The readings are taken in the check phase of the loop's next turn, not in the
timer's callback: the entry of a collection that ran in a callback of that phase reaches the
observer only there (measured on Node 24 with a collection forced inside a `setImmediate`
callback: the timer's callback after it saw no entry). The two lines make the slow tail of
the writes readable as one of: waiting in a queue, a slow git command, work in the process,
or a held loop, which its readings tell further as code, collection or a process without CPU.

The tail they were made for had a cause that the service log of 10-16 to 10-18 and the data
repository showed before they were deployed. The log of 10-18 holds 90 writes of 5360 over
2 s, most between 2.1 and 2.6 s, and nearly every group of them began with an `append_log`
(the others queued behind it, finishing about 100 ms apart, the time of an ordinary write).
Not the cause, measured in that log: a push (the 3 percent of slow writes that overlapped
one against 0.3 percent of the others) and a held event loop (40 of the last 60 slow writes
answered another request meanwhile). The cause is the retry check above: for a session that
appends to an item written in the last minute it ran `git log --max-count=20 -- items/<id>.yaml`
inside the operations' queue. On the live repository (27,666 commits, measured with that
command) it took 2.06 s for an item with 104 commits, most of them old, 2.43 s for one with 19 and
3.02 s for one with 11, against 0.14 s for an item whose 20 newest commits are recent; the
slow lines of the service log for the first two items read 2116 and 2584 ms. With `--since` of the last minute it took 20 to 36 ms. A version conflict
(`versionAt`) read an item's whole path history the same way; it now asks for the
`current.rev - rev + 1` newest commits, which is as far back as the revision it was written
against, as the request budget rule below says it reads. Both costs grow with the history,
which gains thousands of commits a day.

**Why at the entries.** The request handler and `register` are the places every
operation already passes. A timer inside each tool or route would miss the next
one someone adds. Logging alone leaves the architect to read the log; a timed
probe of `/health` from outside cannot say which operation was slow.

**Request budgets.** What a request that reads the history costs follows the range it
asks about, never the length of the history, and a request that asks for more than it
may fails alone while the service goes on. Before this, `changes` rebuilt the whole
board as it was before each deleted document in the range, to find which item the
document hung on: one rebuild took 2.7 to 3.1 s and kept about 510 MB of heap, all of
them stayed until the request ended, and a range with 10 deleted notes ran the heap
into its 4 GB limit and killed the process, with every session's connection and the
owner's page (measured in CI on a synthetic board of the live one's size, 18,000
commits; `scripts/bench-changes.ts`). Three rules follow.

1. *Reads follow the range.* The commits of a query are listed from the range
   alone (`store.log({since, at})`), and a time given to `diff` is resolved by git going
   back from the head to the first commit at or before it (`Store.commitAt`), not
   by listing the history. A document the head no longer holds is found by reading its
   one file in the commit before the one that deleted it. The item it hangs on is
   read from the document itself (a note's target, a card's item field, and for a
   card that is gone too the item the store last saw it on, `Store.cardItem`); an
   item's owner is looked for among the current items and the last versions of the
   items deleted in the range, gathered into one view whose rules are worked out once.
   An item whose owner was deleted before the range has no owner to find, and is
   grouped as the top of its own project. A version conflict reads an item's
   versions back only as far as the revision it was written against and not at all
   for a revision above the current one.
2. *Every request has a budget.* `src/budget.ts` holds it in the request's async
   context. A page request (`src/http.ts`), a tool call (`register` in `src/mcp.ts`),
   the timed wake, the start and a write made outside a request each open one;
   a budget opened inside a request replaces its outer one. `REQUEST_LIMITS`: 64 MB of
   history read, and 32 KB more for each commit of the range the request lists
   (`allowRange`, called by `changes` and by the unread list); one rebuild of a whole
   old board, which only a comparison reaching back before the plan format
   conversion needs; and the heap, which may not pass 75% of its limit. The start
   (`STARTUP_LIMITS`) reads 256 MB and 64 KB per replayed commit, and rebuilds no board.
   A request over a limit fails with an error that says which and how to narrow the
   range (a tool answers with it, a page request with 413).
3. *Three places charge it*, all in `src/store.ts`: reading one historical file
   (`readAt`, charged when git is read and not when the cache answers), rebuilding a whole old
   board (`comparisonSnapshot`) and reading a git command's output
   (`gitRead`, for `log`, `diff` and `ls-tree`; the commands a write runs, and the
   one read its rollback makes of the head, are not charged). Each also looks at the heap, which counts the garbage not yet
   collected and what other requests hold, so the 75% line is the last defense
   against a count that missed something, and the normal queries stay well below it
   (`scripts/bench-changes.ts` prints their peak against the line). With
   `requireBudget` (the daemon sets it), a read of history that runs under no
   budget fails, so a new path that forgets to open one fails the first time it runs;
   a test checks that the only source files that start a process are `store.ts`,
   `net-git.ts` (git against a remote, whose output is never read as history) and
   the two that run `gh` and the notification command, and that those two do not
   run git.

   A read that two requests share (a file read or a board rebuild still pending, and the
   unread list's memo) is charged to the request that started it. If that request's
   budget stops it, the other request fails with the same error, and its retry is
   served; this is accepted because two requests reading the same history at once is
   rare and the failure is only a retry.

The history caches are bounded by the heap they are estimated to hold: parsed
documents 64 MB (16 bytes of heap per byte of file, as the whole-board figures
measured) and 4096 entries, diffs 16 MB, and one whole old board.

*Rejected.* Running history queries in a worker thread with a memory limit works (a
256 MB limit stopped a runaway allocation in 3.4 to 6.4 s and left the main thread
at its normal rate) but needs the board in the thread, 85 to 550 ms and 41 MB for
each copy, a message protocol for the six readers of history, and a test that
no reader stays on the main thread, which is the same test as for budgets. A child
process costs more than a thread and isolates more than is needed. A budget costs
a few counters and stops what actually grew: reading history. A runaway allocation that
reads no history is not stopped by it.

**Deploying.** A second launchd agent, `org.ming-research.wf-board-deploy`,
runs `scripts/deploy.ts` every five minutes (`scripts/install-service.ts
deploy` writes its plist; launchd never overlaps two runs of one job). The logic
is `src/deploy.ts`. A run fetches the main line, `origin/main`, through `netGit`
(Storage): a fetch that outlives its cap of five minutes is killed with its ssh and counts
as a failed try, so a remote that never answers cannot hold the job for good (launchd
never starts a second run while one is going).
When the checkout the daemon runs from is behind it, and the checks on that head
passed (below), the run moves the checkout to the head with a fast-forward,
installs the packages if `package-lock.json` changed, rebuilds the page bundle
and, when a changed path needs it, restarts the daemon. Pull requests merged
within the five minutes are one deploy and one restart.

- **A commit goes live only when its checks passed.** The head the run fetched
  is the commit it asks GitHub about, by its id (`ghCommitChecks` in
  `src/github.ts`, the query `COMMIT_CHECKS_QUERY`), after the refusals about the
  checkout (below) and before anything moves. The answer is read as the board's
  look at the main line reads a commit (What the checks say, in Watching
  GitHub: `summarize`, the one definition of green), so every workflow's checks on the commit
  count, not only the full CI's. Green deploys. A check still running, or no check
  yet (GitHub registers a push's runs within seconds of the merge, so a run that
  starts early finds none), leaves the checkout where it is: the job writes one log
  line and looks again five minutes later, so a head whose CI takes ten minutes is
  deployed at the first run after it ends. A red check holds the commit: the log names the
  failed checks and the next run asks again, so a failed check run again that
  turns green is found, and a newer commit that is green deploys with the red one
  under it (the push lists both). The red is not pushed by the job: the board's
  look at the main line (section 8, Deploys and the red main line) tells it
  once, to the session holding the item that delivered the commit, which is the
  session that fixes it. Checks that cannot be read (`gh` not signed in, GitHub
  not answering, a commit it does not know, an answer of an unexpected shape) are not green: the job does not
  deploy and pushes `deployFailed` once per commit. A head whose checks are
  still unfinished an hour after the job first found it so is pushed once as
  well (`waiting` in the state file keeps when), since nothing else says why the board is not
  deployed; the job keeps waiting. The newest commit decides: while merges follow each other
  faster than CI ends, nothing deploys, which is the cost of one restart for a batch of
  merges; the other choice, deploying the newest green commit among the unreleased ones, was refused for the
  restarts it costs.

- A restart is skipped only when every changed path is in `NO_RESTART`
  (`src/deploy.ts`, the one place the list is defined): the daemon loads `src/`
  and the packages at its start and reads nothing else of the checkout but the
  page files, which it reads from disk on each request. The root's README.md,
  LICENSE, AGENTS.md, `.gitmodules` and Makefile (exact paths) and the `.github/`
  and `design/` directories are read by no code the daemon runs, so they need no
  restart either. A path that only starts with one of those names, such as
  `LICENSE.ts`, restarts. Any other path restarts.
  A daemon that is down at the deploy is restarted whatever changed, since a
  deploy leaves the board up.
- Pages open in the owner's browser are replaced after the deploy, and the job
  does nothing for it. The page's version is a hash of the files the daemon
  serves, `web/index.html`, `web/dist/app.js` and, once built, the diagram
  library `web/dist/mermaid.js` (`src/page-version.ts`): it
  changes exactly when a page loaded now would differ from one loaded before, so
  a deploy of docs or tests changes nothing for an open page, and a rebuilt page
  (or a rebuilt library) changes it with no restart. `GET /` fills the version into the page's own text
  (the `page-version` meta tag), and `GET /api/events` opens with a `page` event
  that carries the version on disk at that moment, to that stream alone. When a
  deploy ends, the `deployed` push (`deployFailed` after a rollback) arrives at
  `POST /api/wake`; the daemon then reads the page files again and, when the
  version differs from the last one it told, sends a `page` event to every open
  page. The pages already open are told only then, never between the job's merge
  and its build, where the files do not agree yet: a page that connects in
  that gap is told the version it sees, and is told again when the deploy ends.
  A page that sees another version than its own reloads (section 7, Updating the
  page). A deploy by hand (`AGENTS.md`, Deploy) that changes only the page tells
  the pages that connect afterwards, not the open ones: restarting the daemon
  tells them too, since their streams reconnect.
- The restart is `launchctl kickstart -k` on the daemon's own label, never a
  kill by process name. The daemon is healthy when launchd reports a process
  other than the one before, `/health` answers, and 5 seconds later the same
  process still answers, all within 90 seconds. The second look catches a
  daemon that starts, crashes and is started again by launchd. A deploy that
  needed no restart waits up to 90 seconds for `/health` to answer, and no
  single probe is trusted: a probe tries for up to 15 seconds, since a daemon
  that is busy or just started can miss one.
- A deploy that fails after the checks passed (the daemon is not healthy, or the install or build
  fails) goes back to the last healthy commit: the checkout's commit when the
  daemon was answering at the start of the run, else the last commit the job saw
  healthy. The checkout is reset to it (`git reset --keep`), the packages (when
  the lock file differs) and the page are built again from that code, and the
  daemon restarts and is waited for if a restart was begun for the deploy or it
  does not answer; a daemon that still answers on the process that served before
  is left alone. A commit that failed after it was in the checkout is not tried
  again until the main line has a newer commit; one that git refused to merge is
  not marked, since that says nothing about it. A `deployFailed` push says what
  happened.
- A deploy is recorded as pending in the job's state file before the checkout
  moves, and the record is cleared when the deploy succeeded or the rollback
  finished. A run that finds one finishes it before anything else, reinstalling
  the packages whatever the lock file says. So a job that died part way, or a
  rollback that failed on the package registry or a stale `index.lock`, is
  retried every five minutes and never leaves the checkout in an unknown state.
  When going back does not finish, the engineer holding the item that delivered the commit is told once (the architect when none does); the owner is told
  on the Mac by a macOS notification, only when the daemon does not answer, since
  then no daemon can push. The job only undoes what it did to a checkout that is
  still the one it moved: on the main line's
  branch, without local changes to tracked files, and on the commit where the
  job last left it (the record keeps that, also while a move is under way), even
  when someone else's hand lands on the deploy's target or the commit to go back
  to. A checkout in any other state was changed by hand since (a deploy by hand, a branch made to look into something): nothing is
  reset or moved, the record is dropped with one push, and the run goes on from
  what the checkout holds, with its usual refusals. If the daemon does not
  answer there, the owner is told on the Mac.
- The checkout is not moved, and one `deployFailed` push per reason and commit
  says why, when it is on another branch, has local changes to tracked
  files (untracked files and the files of a submodule do not count, since a merge that moves a submodule's pointer leaves them behind) or has a commit the main line lacks: the
  edit or commit is someone's, not the job's to move or undo.
- The job asks the board to make the pushes through `POST /api/wake` (section 8). One the
  daemon did not take is kept in the job's state file, and sent first at the
  next run; one it refused with a 4xx answer (a request in the shape an older job
  sent, say) is dropped and logged, since asking again gets the same answer and
  the pushes behind it would never be sent. A fetch that still fails after three tries ten seconds apart (or killed at its cap), and a
  failure of the job itself, are pushed once with `version` null. Each kind of
  standing problem (the fetch, a refusal, a rollback that did not finish, the
  job itself) is remembered separately and forgotten by a run that ends with
  nothing wrong, so a problem that returns is news again and two that come and
  go in turn are not pushed every time.
  The state file, `~/Library/Application Support/wf-board/deploy.json`, is
  outside the board's data directory, which only the daemon writes; one that
  does not parse is set aside as `deploy.json.corrupt` and the job starts empty.

Known limit: if a reset itself fails (a stale `index.lock`) and someone then
repairs the board in place by hand, or launchd restarts the daemon, before the
next run, finishing the rollback can leave a half deploy: the daemon runs the
target's code while the checkout and the page are back on the last healthy
commit. The failure push is the signal; the engineer holding the item (else the architect) is told, and the checkout and
the daemon are checked by hand. Recording the daemon's process id in the pending record
would close it; that was judged not worth the added recovery logic.

**Why the page's version is a hash of its files.** A commit id would change on
every deploy, and every open page would reload for a change to docs or tests. A
page that asked the daemon for its version on a timer would wait up to a period
for the new one and add a timer to every open page. The job reaches the daemon
only through `POST /api/wake`, which it already uses when a deploy ends, so the
hash needs no new route and no change to the job.

**Why a job beside the daemon.** The daemon cannot restart itself onto new code
and also answer for whether that code runs; a deploy that fails must not depend
on the new code to go back. If the job's own script is what breaks, a deploy
is by hand (`AGENTS.md`, Deploy).

**Write cost.** The live board (about 1,500 items, 600 cards, 750 notes and
14,000 content writes in its history) cost 0.28–0.4 s of daemon CPU per
write, a quarter of it garbage collection, because each write deep-copied the
whole board twice and derived the board from scratch about eight times. The
derivation design that replaced this:

- The store publishes one frozen snapshot and never copies it. A write copies
  only the collections it changes, inserts its new documents frozen, and the
  result is the next published snapshot; earlier snapshots stay valid and
  unchanged for whoever holds them.
- One `Rules` object serves every reader of a snapshot (`store.derived`: MCP
  reads, the check scan, the "before" side of a write's validation) within the
  same minute; a Rules object reads the clock only for elapsed time (active
  time, doing days), so its results are exactly `rules(snapshot, t)` for the
  time `t` of the first read in that minute. The store tells the cache which
  state each published one was made from, with the write's changed documents and
  activity delta (`DerivedCache.follows`), and the Rules object of the new state
  is built from that state's one, as the page builds its own (below): it then
  answers for the time that one answered for, in the same minute (`answersFor`). A prospective state inside a
  write gets one Rules object, built again only when the write changes it.
- The activity times the stalled check reads are parsed once and kept as an
  index (`ActivityIndex` in `src/rules.ts`), advanced per snapshot by
  comparing documents by identity instead of rescanning every log, note and
  write. Without an index, `rules` scans the snapshot as before; the
  equivalence of the two after random writes is a test.
- A change event carries the activity's change, not the whole index (see the
  stalled-work rule); the page keeps its copy current from it.
- The check scan after a write, and the page's repaint after a live update,
  rederive only the items the write can reach (`affectedItems` in
  `src/rules.ts`): the written items, cards and notes, then along plan edges
  while an item's derived summary changes, plus every reached item's
  ancestors, and the items whose doing steps name a reached item or one of its
  ancestors (their stalled clock reads it, see the stalled-work rule). A
  session's write moves its place in the activity index, which can change
  whether it still holds the items it was started on (status), so the items
  carrying its unfinished dispatch records are reached too. A change of elapsed
  time alone is left to the minute timers, which rescan and repaint everything
  as before; a session's six-hour window running out is such a change.
- The page builds its rules again for each live change, from the Rules
  object before it (`rules`' `previous`): a change that wrote only items, in
  no field a status reads (`STATUS_FIELDS`), keeps every derived value and
  drops only the checks and stalled counts of the items it can reach — the
  written items and those whose clock or pause spans moved, their owners,
  the items they wait on (a pause check names its waiter's title) and that
  wait on them, and the items whose doing step names one of them or an owner
  of it, each with its owners. Within one minute it answers for the time of the
  first build, as the shared rules do. It derives everything from scratch for
  another change, in a new minute, when a write stamped before that time
  widens the active time (the store's times have whole seconds, and every
  stalled check reads the active time), and when a session's write moves it
  into or out of its window (status reads it). `test/rules-reuse.test.ts`
  holds it against a derivation from nothing after random writes on a board of
  the live board's size, and each guard taken out of a copy must fail it. A log
  write then costs the page about 0.41 times what it did (80 → 33 ms on a hosted
  runner, n-writes-stable-study). The daemon's shared rules reuse the same way since
  board-cpu-usage (the numbers are in the unread list's point below).
- The page keeps what depends only on the rules' structure and on ids through a write that
  reused the rules (section 7, The page): the order of the items, the stops that wait on the
  owner, the unread stops, the counts by status and the ancestors and waiters of open work, which
  cost about 9 of the 31.6 ms one write cost the page (a profile of 72 log writes at 3 a second on
  a hosted runner, one draw per write, the profiler's own cost included). Caching them as whole
  lists, made again when the data changes, would have saved none of it: a write changes the data
  and draws once. In the same profile, per write, `presentationScopes` went from 3.82 to 2.34 ms,
  the stops from 2.09 to 0.42, `countBelow` from 1.30 to 0.52 and `renderPage` from 22.4 to 19.1.
  Measured as n-writes-stable measured (a hosted EPYC 7763 runner with 4 vCPUs, the board of the
  live board's weight, three log writes a second, 6 interleaved rounds of the main line, a twin of
  it and this tree, at the runner's speed and with the page's CPU throttled 1.3 times; main-thread
  busy time, 95% interval of the ratio of the tree to the main line, then the twin's ratio, the
  noise, in brackets): one write costs 0.84 times (0.76–0.93; twin 0.94, ±8.0%) at the runner's
  speed and 0.85 times (0.81–0.88; twin 0.98, ±3.8%) throttled; a press of n that lands while sessions
  write costs a median of 0.90 times (0.86–0.95; twin 1.00, ±3.1%) and 0.88 times (0.83–0.93; twin
  0.99, ±7.0%) throttled, and its 90th percentile 0.87 times (0.74–1.01; twin ±12.8%) and 0.89 times
  (0.73–1.08; twin ±17.9%): no change detected, the intervals include 1. The time to the landing
  is not slower either (median 0.92 times, 0.83–1.01, and 0.96 times, 0.92–1.00; 90th percentile
  0.97 times, 0.88–1.07, and 0.91 times, 0.86–0.96).
- A step diff for the page is kept by its two commits and path, which name
  the same text forever, so a reload asks git again only for new steps.
- The owner's unread list is continued, not walked again. The walk of the history
  after the read cursor (`src/history.ts`) keeps where it stands: its stops, whether
  the last is still open to the next commit of the same author on the same document,
  and how many commits it has passed. A head that descends from the head of the newest
  walk of the same cursor and read marks carries that walk on over its new commits
  alone, copying the open stop before it extends it; a finished stop is kept while the
  walked one is the same object ending at the same commit, so the lists of two heads
  share the stops neither changed. Each list has a version, and the page sends the
  version it holds (`GET /api/unread?since=`): the answer is the number of stops that
  stay (`keep`) and the stops after them, or the whole list when the server no longer
  keeps that version or the reading state moved. `test/history.test.ts` holds the
  continued list, and the page's spliced one, equal to the list derived from nothing
  after random writes, owner comments and reads. Before, each change event made the
  page fetch the whole list again (347 KB with 1,000 stops) and each new head walked
  the history from the cursor again: with the owner 4,000 commits behind, a `set_tags`
  write cost the daemon 67 to 76 ms of CPU against 46.5 ms with nothing unread (a
  hosted runner, `scripts/bench-writes.ts --unread 4000`, board-cpu-usage).

`scripts/bench-writes.ts` measures this path on a synthetic board of the live
board's size (CPU and garbage collection per write, bytes per change event,
peak memory, and the characters of each project's brief); the `bench` workflow
runs it by hand on this tree and on a base commit, without gating; `--unread N`
puts the owner's cursor N commits back and asks for the unread list after each write,
as the open page does, and `--profile` prints where the CPU went.
`scripts/bench-page.ts` measures the page's side: the real page in jsdom on a board of
the live board's weight (`test/e2e/live-board.ts`), given the change events of real
`set_tags` and log writes with the server's answers recorded beforehand, so the time
is the page's own; it prints the busy time from each event until the page is quiet.

**Connecting.** `claude mcp add --scope user --transport http wf-board
http://127.0.0.1:7417/mcp` once for Claude Code, and the equivalent entry in
`~/.codex/config.toml` for Codex. Whether the desktop app's Code sessions read
the user-scope configuration must be checked on the first session.

## 5. Data format

The server writes, agents and the owner read. The format serves three
readers: the server, which needs every field unambiguous; git, whose diffs
should show the changed lines of prose rather than one rewritten line; and an
agent reading with Grep or Read when the server is down.

```
wf-board-data/
  board.yaml              title, eyebrow, goal, projects, tags (the approved tag vocabulary)
  numbers.yaml            the short-number counter: next: <the number the next item or card gets>
  items/<id>.yaml         one file per item
  decisions/<key>.yaml    one file per decision card
  notes/<id>.yaml         one file per owner note with its reply
  glossaries/<project>.yaml  one file per project glossary, named by the project
  messages/<day>.yaml     one file per UTC day: the messages agents sent each other that day (section 8, Messages)
  state/owner.yaml        the owner's read cursor and read-ahead marks
  state/wake/<hash>.jsonl  one agent's wake stream: its session name, events and how far they were delivered (same)
  state/github-watch.json   the time of the last look at GitHub (same)
  state/liveness.json     the silences of the sessions that hold items, with the time of the last round (same; section 8, Liveness)
  state/ci-watch.json       what the look at the checks last saw of each pull request an open item names (same)
  import/                 the original artifact export, kept as provenance
```

Each file is one YAML document; prose fields are literal blocks (`|`), which
keep their lines exactly as written. An item file:

```yaml
title: 示例：换账号时交接当前状态
group: 总管
links:
  - label: Whitefoot#341
    url: https://github.com/Ming-Research/Whitefoot/pull/341
created: 2026-10-11T06:15:40Z
updated: 2026-10-11T06:15:40Z
rev: 3
plan:
  - id: snapshot
    text: 写下交接快照
    state: done
    doneAt: 2026-10-11T06:15:40Z
  - id: example-merge
    item: example-merge
    own: false
    after: []
  - id: accept
    accept: true
    text: 新的总管只读这份快照就能接着做，不用回头问 owner。
    state: todo
head: |
  **问题**：总管（协调会话）换账号时……

  **为什么**：……
log:
  - at: 2026-10-11T06:15:40Z
    by: 总管
    text: |
      写下交接快照；总管职责写进 agents_config 的 coordinator.md。
```

- **Why not JSON.** JSON stores a paragraph as one line with `\n` escapes, so
  a one-word edit shows in git as a whole rewritten line, and Grep and Read
  show escaped text. Its structure is exact, which YAML keeps.
- **Why not Markdown with front matter.** Structured fields live in the front
  matter, but anything structured inside the body, such as a log entry's time
  and author, must be encoded in reserved heading lines, and every new field
  on a log entry (a link, a kind) would stretch that encoding. In YAML the
  whole document is structured and prose stays readable.
- YAML's known traps (unquoted `no` read as false, times read as dates) do not
  reach the data: the server is the only writer, writes through one
  serializer that quotes where needed, and validates every document against
  a schema on read and write.
- `rev` counts writes to the file. A write that replaces content names the
  `rev` it read. For `update_item` it stands when that is the current `rev` or
  when none of the fields it replaces (`title`, `head`, `links`, `data`, `order`) differs
  between the version `rev` names, read back from the history, and the current one;
  the answer then ends with a `note:` saying what changed meanwhile (`+1 log, plan
  changed`). Otherwise, or when the history cannot be read back within the request's
  budget, it fails with the changes in the error. Switching an item to or from a record
  also rewrites its plan's acceptance rows, so it needs the current `rev`. The item that made this
  change counted, in the session records of two days, 6 refused head rewrites, 4 of them
  only because someone else had added a log line (a count not repeated here): each cost a
  re-read and a resend of a head over ten thousand characters.
  Log appends, `set_plan` and `set_targets` carry no caller `rev`: the operations
  queue retries against the latest item while preserving unrelated concurrent writes.
  Replying to an answered note is refused with the previous author and time;
  deliberate replacement requires `replace: true`.
- **Short numbers.** Every item and every decision card carries `num`, a
  permanent positive integer, so the owner can name it as `#812` instead of
  searching by title. Items and cards share one sequence, so a number names
  one document. Notes have none. The owner decided this on 2026-10-13. Keys
  stay the identity everywhere: plan rows, `item` fields, note targets and
  `[[it:key]]`/`[[q:key]]` tokens use keys; a number is only a display and
  lookup alias. Only the store issues numbers, inside its single write queue:
  a put that creates an item or card receives the next number, and
  `numbers.yaml` (`next`) advances in the same commit, so two documents can
  never receive one number and a failed commit issues none. An update keeps
  the stored number; a write that names a different number, or a number on a
  document that has none, is refused. A deleted document's number is never
  reused. On start the store refuses (never repairs) a board where two
  documents share a number, where `next` is not above every issued number, or
  where documents hold numbers without `numbers.yaml`. The field is optional
  in the schema only for data written before numbers existed: on its first
  start the store numbers every unnumbered item and card once, oldest first by
  `created` (cards `at`; `updated` when neither exists), ties broken by key,
  in one commit `Number existing items and cards` that changes only `num` and
  the revision. That commit is bookkeeping: it is not an unread change for the
  owner, adds no active time and resets no stalled clock, and `num` is never a
  reported field change. Board text keeps naming things by what they are, not
  by number.
- **Item plan.** Every item carries one ordered `plan`, its 计划和进展: its own
  steps, the items it owns, the items and cards of others it waits for,
  acceptance steps where the checks happen, and delivery rows after them. The plan replaces the former `steps`, `deps` and
  `parent` fields and the head's completion-condition section; the section
  [Item plans](#item-plans) below defines it.
- **Item target numbers.** Optional ordered `targets` give one row per goal,
  rather than one row per measurement. Each row has a stable `id` with the
  same pattern as step ids, and required nonempty `goal`, `target`, `current`
  and `baseline` text naming the goal, its target value, current value and
  comparison baseline (for example main, Chromium on the same machine and
  page, Redis or PUC Lua). `date` is a server-stamped ISO UTC timestamp:
  creation and changes to `current` stamp it; other edits preserve it.
  Callers never provide dates. Work and record items may have targets;
  existing items without the field have none. A project session measures a
  goal and overwrites its current value; there is no measurement history
  list and no separate duration or throughput statistics.
  `set_targets` accepts exactly one mode: `targets` replaces the ordered
  list, `target` upserts one complete row by stable id, retaining its
  position or appending it, and `remove` deletes an id. Replacement matches
  rows by id to preserve dates unless the current value changes. Duplicate
  ids are refused. Project ownership, concurrent-write retries, one atomic
  commit and no-op behavior match `set_plan`: identical results change
  neither the item nor its revision and write no commit. Target changes
  count as owner-unread progress. Context and brief format each goal as one
  line: `goal: current (vs baseline) → target, YYYY-MM-DD`.
- **Record items.** `record: true` makes an item a record: a head, an
  optional plan without an acceptance step, targets and log, and no status;
  creation and `update_item` can set it. Records are defined with the plan in
  [Item plans](#item-plans).
- **Dispatch records.** An item may carry `dispatches`, oldest first: one
  entry per agent session the architect or the runner started on it (a dispatch), in the
  columns of the dispatch format the architect keeps. An entry holds
  `agentId` (the session's full id, unique on the whole board), `agent` (its
  name), `role` (`工程师` or `审查`), `level` (1–5), `model`, optional
  `effort`, `worktree`, `started` and `did` (which rows of the item the
  session does, one line), `credential` (the SHA-256 of the token the session
  writes with, from the start until the dispatch ends; section 9), and once
  the session has ended a `finish` block:
  `ended`; `result` (`一次通过`, `返工后通过`, `换人` or `放弃`); the counts,
  `reports` and `kickbacks` for an engineer and `rounds` (review rounds: the first review and each re-review count one) for a review, never
  the other role's; optional `waited` minutes (spent waiting for the owner,
  the 14900K or a dependency); `signals`, none or several of `验收没过`,
  `架构师打回`, `做法被否`, `长时间没进展`, `换模型`, each at most once and
  each with an optional note; `usage` (`input`, `cacheWrite`, `cacheRead`,
  `output` tokens); `cost`; and an optional `note`. The fixed options are the
  dispatch format's own and nothing else is accepted for them. Decisions:
  - Stored on the item, not as a new document kind: an item already has its
    history, `changes`, retried writes and project ownership check, while a
    new kind would also change the store's reads and writes, the snapshot,
    the events sent to the page and the page's snapshot. The cost is 6 to 9
    more lines in the item file when a dispatch starts and 17 to 26 once it
    has ended (counted on the serialized YAML), plus the two log entries.
  - Historical detail, like the log: `withoutHistoricalDetail` drops
    `dispatches` with `log` before any owner-facing comparison, so a dispatch
    write is never news to the owner. The page shows neither the field nor a
    summary of it.
  - `cost` is US dollars with at most three decimals (a longer value is
    rounded when written) and is added up as whole thousandths, so a printed
    total always equals its printed rows added up. The board holds no price
    table: a price depends on each message's prompt length (Haiku is tiered),
    which only the session transcript shows, so the caller measures `usage`
    and `cost` and the board records them.
  - A dispatch is recorded on the subtree root item the session was given. The
    board does not check that the item is one, and the tag tally counts the
    dispatch under that item's tags.
  - `credential` holds a hash and never the token, which is answered once by
    `dispatch_start`. `dispatch_finish` removes the hash, and removing it is what
    revokes the credential: no state beside the record tells whether a
    credential is valid.
  - `dispatch_start` and `dispatch_finish` each append a generated line to the
    item's log (`起：…`, `收：…`), the architect's hand-written line in
    machine form: the owner reads only the page, which shows logs and not
    dispatches.
  - Not stored: the judgment records for "research first or do directly"
    (item, what was judged and why, how the misjudgment showed, what it should
    have been). They are a different record and stay written by hand in the
    calibration item's log.
- **Runner reports.** An open work item may carry `runner`, the state the runner (the
  program that starts and follows the engineers' turns) last reported for the work on it:
  `state` (`running`, `ci`, `ask`, `items`, `run`, `wait`, `ready`, `exception` or `done`), `since`
  (when the work entered that state), `at` (when the report last changed anything), `started`
  (when the work began) and, as the state needs, `to` (`owner` or `architect`) and `cards` of
  an ask, `items` of a wait for other items, `what` (one line, required) and `until` (a UTC
  time, optional) of a `wait` for an event, and optionally `note` (one line of at most 120
  characters), `turns` and `cost` (US dollars to three decimals, rounded as dispatch cost
  is). `report_state` writes it and refuses what the state does not carry (`runnerReportProblem`
  in `src/model.ts` words each refusal). The names and the first eight states were agreed with the
  runner's engineer (item `runner-mvp`) and `wait` was added after them (item `board-wait-state`);
  the board sets `since` and `at` from its own clock so the runner's clock decides nothing.
  Decisions:
  - Stored as one field of the item, replaced by each report, not as a new document kind and
    not as an entry of the log: a report is the current state and the whole view reads it
    for every open item at once, while a log entry per turn would grow the item without bound
    and a document kind of its own would change the store's reads and writes, the snapshot,
    the events and the page, as for dispatch records above. The cost is one short block in the
    item file. Rejected: a log entry per report; a document kind of its own.
  - `since` moves only when the state, the party asked, the cards or the items waited for
    change: a report that repeats the state (a new turn, a new cost figure) moves `at` and
    leaves `since`, so how long an item has waited is read from `since` while the board holds
    no heartbeat. A report identical in every field writes no commit at all (the store skips an
    unchanged document), so a runner that reports at every turn start and end adds one commit
    for a change, not one for a call. While the state is `running`, `at` is when the turn began as long as the
    runner reports nothing else during a turn, which is how it behaves; the agent list takes a turn's
    start from the runner's beat (section 7, The live view of a turn) and from `at` only without one.
  - Historical detail, like the log and the dispatches: `withoutHistoricalDetail` drops
    `runner` before any owner-facing comparison, so a report is never news to the owner.
    The page shows no report of its own; the whole view (section 7) draws what it says.
  - Only the architect writes it over a credential (`item.runner`, section 9), so the
    part is one of the process parts and no engineer, reviewer or observer credential carries
    it. The runner has no credential: it writes without one, from the session `执行程序`, as the
    author of the item's project, and the board lets that session do this one part
    (`isRunner`, section 9, The runner). Its first reports were all refused (the service log
    held a `tool report_state` error for each), because the check had only the process writers
    in mind.
  - A record has no runner report: it has no work to report on.
  - A `wait` is the work waiting for an event settled beforehand that needs no one (the
    runner restarting, the main line's next merge, a set time). It carries `what` and an
    optional `until`, the time at which the runner wakes the work; they are the wait's own
    fields, as `cards` and `items` are an ask's and a wait for items', and not the note, so
    that `since` moves when the wait changes (a changed `what` or `until` is another wait)
    and stays when only the figures do. Before the state existed the runner reported such a
    wait as an ask to the architect, which the lists showed with that ask's one-hour limit:
    a wait for 24 hours of logs would have been amber for 23 hours, with nothing to look at.
    The limit is one hour after `until` (the runner wakes the work as the time comes, so the
    hour is room for a runner that was stopped) and, with no `until`, 24 hours, as for a wait
    for items; both are provisional like the other limits (section 6, The whole view). An
    `until` that has already passed by more than that hour when it is reported is accepted and
    the wait is overdue at once: the runner refuses to start such a wait itself, so this is a
    wake time that went by with the work still waiting, which is what the list is for. The
    words of the whole view are 「等：<what>」 with 「（到 MM-DD HH:MMZ）」 after them when there is
    an `until` (`reportText`); the agent list's state column says 「等事件」 and its line of
    text the same event and time (section 7, Agent list).
    Rejected: the event in the note (a changed event would leave `since` where it was, or
    `wait` would need a rule of its own for the note, and the note would be required for one
    state); no limit without an `until` (a wait for something that never comes would show as
    healthy for ever, the false trust in the other direction).
- **Projects.** Every item stores its project in `group`; an item's project
  changes only through `move_item_project`, which moves the item and everything it owns
  together (section 6), and ownership never crosses projects, so the stored field and
  the ownership chain always agree. The legacy `area` was folded into
  `parent` at the artifact migration and `parent` into owned plan rows at the
  plan conversion (section 10).
- **Priority.** Items store no priority and none is derived
  ([Item plans](#item-plans), Priority). The former per-project migration
  switch (`migrated: true` and the legacy priority of
  `src/legacy-priority.ts`) went with the plan conversion (section 10), and
  the stored field was cleared from the data by one migration (section 10,
  Clearing the retired priority).
- **Stalled work.** A work item in progress that has at least one `doing`
  step of its own is flagged after at least one hour of active time without
  a change to the clock's items: `进行中但 1 小时（活跃时间）没有动静`. The
  clock's items are the item itself, each owned item in progress, and each
  item a doing step names with `[[it:key]]`, with every item each of those
  owns down every layer. A shared dependency is another item's work and does
  not count. An item whose progress comes only from owned items has no clock
  of its own; the owned item with the doing step carries the flag. Each board
  content write starts a
  30-minute active interval; overlapping intervals count only once, and the
  measure clips their union to the clock items' latest change through the
  current time. When no one writes, all clocks stop after the last interval ends.
  Item revisions, log entries, cards and notes on a clock item reset its last
  change. Records and items in other statuses are never flagged.
  Effective pauses suppress the flag and freeze the clock: the union of
  historical pause intervals is excluded from active time, including inherited
  pauses. Resuming preserves a descendant's earlier active time rather than
  counting the paused interval. A change to the item still resets its clock.
  `src/rules.ts` defines the durations and the check for both MCP and the page.
  Each check may carry a short visible `label` defined with it: this one is
  `无人推进`, shown beside the item title in place of `需核对` with the full
  text as tooltip; checks without a label keep `需核对`. A folded item whose
  owned subtree holds stalled items shows `无人推进 N` beside its title.
  The store reconstructs an optional snapshot activity index from existing
  git history, retaining every content commit timestamp and each item's last
  change, including overwritten and deleted cards and notes. Card moves
  touch both items; later notes on deleted cards retain their last known
  item. No extra board data file is stored. A start does not derive the index
  from the whole history: a disposable startup cache in git's metadata
  directory (`wf-board-startup-cache.json`) holds the whole index as of one
  commit, with where each card last was and the item projections the pause
  replay continues from (none while no commit had set a pause). A start reads
  it and replays only the commits after it, with the same code that scans the
  history, so its time grows with the commits since the cache, not with the
  history. The cache is trusted only when it has exactly the current format
  (every field of the index present and none unknown: a field added to the
  index must be added to the cache, and does not compile until it is), is of a
  commit the head descends from, and, when it is of the head itself, agrees
  with the documents on whether a pause was ever set. Otherwise (missing,
  damaged, another version, a history rewound or gone another way) the start
  scans the whole history, as the first start after this cache was introduced
  does, and writes the cache at once, so clones and resumed items retain
  restart correctness. A start that only replayed commits leaves the write to
  the timer; afterwards a commit schedules a write at most every two minutes.
  The daemon writes none at shutdown, which must fit the time launchd gives.
  Deleting the file forces a scan on the next start. The cache carries what
  the live updates derived; a scan re-derives it from the commits alone.
  Changing what the cache holds, or how the replay derives it, changes
  `STARTUP_CACHE_VERSION`; the next start is then a scan. Historical pause reads
  extract only project, record, pause and owned-target metadata rather than
  validating against today's write schema. Unreadable blobs are logged and
  skipped; unknown fields and malformed plan entries do not prevent startup.
  Live pause indexing uses the same tolerant projection, since conversion
  transactions include legacy before-documents and records with omitted plans.
  Each write may name the session that made it (`session` on every write
  tool, below); the store records it as a `Session: <name>` trailer on that
  operation's commit, and the same index keeps, per item, the session that
  last wrote to it and when (`activity.sessions`). Cards and notes count for
  their item as they do for its clock. A write without a session changes no
  attribution; a later one replaces it; a restart derives it from the
  trailers in history. This is an observation of who wrote, never an
  assignment of work to a session: no document stores a session, and
  `history` shows the message without the trailer, and `changes` names the session of each commit.
  The same walk keeps, per session name, the last two distinct items it wrote
  to, newest first (`activity.agents`, read by the agent list, section 7). A
  write names the items it touched (an item, its card or a note on either)
  and puts them first by id, ahead of the entries the session already had,
  without repeats; so the list does not depend on the order the store met the
  items in, and a restart gives the list live writes gave.
  Content commits touching board metadata,
  items, cards, notes or glossaries count (and the notice files of history, below); commits containing only
  owner reading cursors, read-ahead marks or messages do not. Current document timestamps
  also supply the available dating evidence for imported or synthetic data.
  A live update carries the activity index's change, not the index: the
  commit's content-write time, the items whose last change moved, the
  whole new span list of each item whose pause spans changed, each item
  whose last-writing session moved and each session whose two items changed
  (its whole new list), made against
  the previous head. The page applies it only to a snapshot at that head; a
  snapshot already at the new head ignores it, and one at another head missed
  or overtook an event and reloads the whole snapshot. MCP recomputes checks
  on read, and the page recomputes them every minute so a quiet item can
  become stalled without another write.
- **Blocking waits.** An owner wait either stops named work or does not. A
  decision card may carry `blocks`, one sentence naming the work that is
  stopped until the owner rules (for example `#398 合并停着`); a card with `blocks`
  is blocking, one without is not, and sessions proceed on its recommendation.
  A legacy `ask` still on an item is always blocking; no tool sets one, and `clear_ask`
  removes it. `src/rules.ts` derives the predicates:
  `cardBlocking(card)` (waiting and carrying `blocks`), `ownerBlocking(item)`
  (a pending ask or a blocking card), and per subtree `blockingBelow(item)`
  (pending asks plus blocking cards) and `nonBlockingBelow(item)` (waiting
  cards without `blocks`), the item included. `write_card` sets `blocks` on
  create or revision; a revision omitting it keeps it and `null` clears it.
  `context` and `brief` show it.
- **No notices.** The board has no notice documents: the 要你知道 list and
  `post_notice` are gone. A change the owner must act on is a decision card;
  one the owner only should know goes in the architect's journal. Notice files
  in history still count as content writes. The one commit that deleted them
  is not a write, and activity skips it.
- A decision card (see [Decision cards](#decision-cards)) holds its `item`,
  `question`, options (a name and a detail each), confidence, status and times,
  and the owner's ruling once ruled. Cards converted from the earlier form
  also keep their old background in `legacy`.
- Each fact is stored once. The export shows what duplication costs: 27 cards
  whose `item` names an item whose `qs` omits them, 572 items carrying both
  `parent` and `area`, 13 notes whose stored title went stale. So a card's
  place is its `item` alone (an item's cards are derived), an item's place is
  the one plan row that owns it (its owner is derived), and a note's title is
  derived from its target.
- A card that blocks is a row of its own item's plan, so an item waiting on
  it is blocked by derivation (see [Item plans](#item-plans)); a card that does
  not block has no row, because the work goes on without it. Four blocked
  items in the export waited on an open card, which the model before card
  dependencies could not express.
- Empty strings are absent fields (`ask: ""` on 117 items, `parent: ""` on
  161).
- A note keeps its original id, so ids that sessions recorded and anchors
  that point at notes stay valid.
- **Glossaries.** Each project keeps a glossary of the words it coined:
  `terms: [{term, definition, updated, by}]` with the file's `rev`. A term is
  one line without surrounding spaces and unique in its glossary; the
  definition is plain Chinese for a reader outside the project; the server
  stamps `updated` and `by`. A replaced term keeps its place. A glossary is
  not an unread document: its changes neither count as 新 nor appear in
  `changes`.
- **Messages.** A file `messages/2026-10-17.yaml` is `{messages, rev}`: the
  messages sent on that UTC day, in the order sent. A message is `{id, from,
  project, to, text, item?, at}`: its id, the sending session and its project,
  the receiving session, one line of at most 150 characters, the item it is
  about, and the time sent. The id is that time to the second, then four random
  hex digits (`20261017T160512Z-3fa9`), so ids sort in the order sent. A
  message is written once and never changed: sending one adds it to the end of
  its day's file. One file a day keeps the number of files, and so git's index,
  growing by one a day however many messages are sent (section 8, Messages).
  Like a glossary, messages are not unread documents, and they are no work on
  the board.
- **Tags.** The board keeps one approved vocabulary, `tags: [{name, meaning,
  projects?}]`, in `board.yaml`; each item carries `tags: [name]`. A name is 1–12
  characters without whitespace or commas and unique; `meaning` is one sentence
  telling agents when to apply the tag; `projects` is absent when every project
  may use the tag. The vocabulary lives in `board.yaml` because it is small
  board-level configuration with the same single writer rule as the project
  list, and a rename or removal must change the vocabulary and every carrying
  item in one commit, which the store's one-commit-per-operation already gives
  for the board plus items; its own document would add a file that every such
  commit must also write. Only `Architect` changes the vocabulary, after the owner
  approves the change on a decision card; the server enforces the author, not
  the card. An item's `tags` are unique, each in the vocabulary and applicable
  to the item's project, and every item needs at least one, records
  included. `tags` is optional on read for data written before tags
  existed; the 缺标签 check lists such items until a session backfills them.
  A tag change is a real change in `changes` and in unread, unlike `num`.
- **Difficulty.** A work item may carry `difficulty`: an integer 1–5, which
  decides the agent that does it (the rules map levels to agents, so the board
  keeps no such table). Text outputs write it as 「难度 N」. A record has none.
  It is a field of the item, not of a plan row, because the unit dispatched to
  an agent is the item; it replaces the temporary 「（难度 N）」 that plan rows
  carried in their text. The architect sets it with `set_difficulty` on an
  item of any project, and an engineer on the items below the one it was started on
  (never that item itself: it was handed over at that level); every change
  appends a log line `难度：<from> → <to>，理由：<reason>` (from 未评 the first
  time), because changing the level changes who does the work. `create_item`,
  which the architect calls anywhere and an engineer inside its subtree, take
  `difficulty` and logs it as the first rating (reason 建条目时评). `changes`
  with `detail` lists every change of difficulty (its default answer counts it
  among the other changes); unread shows a changed level but not a first
  rating (below).
  The board once had a level `architect` (shown as 「架构师做」) for the
  architect's own work, rated but never dispatched. It is retired: every item
  is rated 1–5. No schema accepts the value, but old versions of an item in
  history hold it as `difficulty: architect`, and historical comparison omits
  exactly that value, as it omits the retired fields (section 9). A
  board whose files still hold it refuses to start, naming the one-time
  migration that clears it (below).
  Work an unpaused root needs and that has no difficulty raises the 缺难度
  check only when the rating is the only thing left before it can be
  dispatched. "Can be dispatched" is defined once, as `canStart`: the status is
  todo or idle, an unpaused root needs the item, and one of its ready steps
  (every step before it done) is a todo text step with no `waits` text. The
  next-task list (`brief.todo`) lists what `canStart` allows and has a rating;
  the check asks for the rating of what `canStart` allows and has none. A step
  that is another item or a card, such as an unfinished study sub-item, is not
  such a step, so the item raises no check until that sub-item is done. A
  blocked item, or one someone is working on (a step in progress or a live
  session), raises none either. Whoever may
  rate the item clears 缺难度: the architect, or the engineer whose subtree
  holds it below its root (the root itself is rated by the architect).
- **The read cursor.** The board's history is the git log, an ordered list of
  changes. The owner's reading state keeps a cursor into it and optional
  per-document `readMarks`, each a commit id through which that document is
  read. Document keys are `item:<id>`, `decision:<key>` and `note:<id>`.
  After the cursor, a step's document is unread only when its last commit is
  after that document's mark; a step with no unread documents is neither a
  stop nor counted. A mark also separates consecutive changes, so a later
  change to the same document is new again without reviving its read changes.
  Moving the cursor removes marks it passes; reading every document in a
  prefix advances the cursor over that prefix and removes its marks.
  新 counts items: an item with any unread change in itself, its cards or the
  comments on either counts once, however many changes it holds, and a change
  no item holds (a card without an item, a deleted document) counts once on
  its own. An item's head shows one 新 chip counting the items with something
  new in its subtree, itself included; a card shows no chip of its own unless
  no item holds it. The header total and the kind buttons count the same way.
  `n` walks page order, top to bottom: an item, then each of its cards in the
  order the body shows them (the cards the head places, then the others in
  plan order) with that card's comments, then the item's comments, with
  documents the page does not place last, oldest first. Inside a changed item it visits each new place in turn (a
  changed status, title or body block, a new or changed plan or target row, an
  added link); a new item is one stop at its start. After `m`, `n` goes on below
  where it was. A 新 chip jumps to the first new place in its subtree.
  `m` reads the whole item holding the selection, however selected: its own
  changes, its cards and the comments on both, but not its sub-items; a card
  no item holds is read with its comments. 全部已阅 moves the cursor to the
  head after confirmation. Expanded items and cards mark changes in their own
  content, comparing the document before its first unread step with its current
  state. Blocks are separated by blank lines, except inside fenced code;
  contiguous lists and tables remain whole blocks so rich rendering stays
  intact. A 参考 section (a line starting 「**参考：」 through to the next such
  line or the end of the text, fenced code excepted) is one block, whatever
  blank lines it holds. An item's head shows each one folded under its title;
  the sections a reader opened stay open across re-renders, kept in this
  browser only. Added or changed blocks, a card's changed question included, carry a
  blue line on their left, like the one beside an item's headline, and no colour of
  their own; `n` lands on the first of them;
  removed content is not shown anywhere: no removed block, former title,
  plan row, link, target row, ask or card option. A changed recommendation
  marks the option; a changed question and the closing of a card mark the
  question and the 已裁定 tag. Multi-paragraph card questions use the same
  block comparison as heads, keeping unchanged paragraphs once. Changed
  status rows, and added or changed link rows, are not
  coloured either.
  New items and cards carry no per-block marks; added plan and target rows still mark their own lines. No green background is used
  anywhere: the owner never asked for one. A card with unread changes of its
  own carries a blue line beside its whole body, marking exactly what `m` on it
  reads; a parent whose only new content is below it shows that in its 新 chip
  and carries no line, since `m` leaves sub-items alone. The tree shows only
  head rows, with a short blue line for an item's own unread content; the
  selected item's body and comments appear in the detail column, with a short blue line beside its headline only when the title itself changed (a new item carries it too; a changed body does not).
  The 新 chip counts what is new inside. Added or changed plan rows and target rows, new notes
  and replies, and added link rows use the same blue bar. Plan rows
  and targets compare by stable id against the item before its first unread
  change, so inserting or removing a neighboring row does not mark an unchanged
  row. Reordering or removal still marks the item unread without displaying
  removed rows. Reading the item clears its plan and target marks. A plan row is
  changed when its own stored fields change (text, state, ownership,
  `after`, or a server date); a change in the status of the item a row points
  at is that item's change, not this one's. The 进展
  unread filter selects plan and target changes; head changes, cards and other changes remain in 其他. Logs
  never mark the item new, never enter unread counts or stepping, and never
  receive unread bars, including appended or edited log entries. A log-only
  commit does not extend an unread change or move its comparison baseline.
  A first rating, an item's `difficulty` going from none to a level, is not
  unread either, alone or beside another change (which still counts as
  itself): rating hundreds of items would show each new for one added label.
  Neither is the migration that cleared the retired level (from `architect` to
  none). Changing a level that exists is unread.
  A new reply marks the reply alone, never the
  owner's comment above it, since the owner wrote that. Note
  changes appear only in the comment-list row, never as bookkeeping-field
  diffs. Every document jump, including card references, waiting-stop arrows,
  unread chips, reveals the target and its comment list
  (in the selected item's detail column),
  waits for the baselines affecting that target and its expanded containers,
  then scrolls after rendering. Baselines for unrelated collapsed items or
  explicitly collapsed ancestor comment lists neither delay nor cancel the jump.
  Deleted documents have no body to render but remain countable stops that
  `n` can visit and `m` can read.
  This replaces the 478 per-item read
  records and their snapshots. A history step groups consecutive commits by the same
  author on the same item, so quick step updates read as one change, and
  the owner's own actions (notes and reads) never count as unread. Scrubbing
  back through earlier changes with a slider uses the same history and is
  deferred until needed. Reads update owner state immediately
  and save it locally without a commit. A local save arriving during a data
  commit waits for that commit to finish. Pending owner state normally joins
  the next data commit, so ordinary reads make no commit noise. On orderly
  shutdown, the daemon commits any remaining owner state on its own (locally;
  shutdown does not push).

### Item plans

The owner decided on 2026-10-13 that every item has one list, 计划和进展
(plan and progress), which replaces three things: the completion-condition
section of the head, the dependency list, and the parent/child relation. Before
it, an item's work was spread over a head section the server could only
pattern-match, a `deps` list, a `parent` field that had to be repeated in the
parent's `deps` (174 children in the board of 2026-10-13 are missing from their
parent's list), separate `steps`, and own-work sub-items invented only so a
parent's status could be derived (58 of them). One ordered list holds all of
it, so an item's page reads top to bottom as what remains to be done, and the
tree, status and blocking are all derived from it.

#### Rows

An item may also store `paused: { reason, at }`, with a nonblank reason and
the server's time. Only the architect (`author: Architect`, a session name starting `架构师`) sets or clears it through
`set_pause`, at the owner's request in a comment (the page has no pause or
resume control); project agents cannot set it through
item creation or revision. Records cannot carry it, and pausing done or
cancelled work is refused. This marker never changes plan rows.

A plan is an ordered list of rows, each with an `id` unique in the plan. A row
is one of four kinds:

| Kind | Stored fields | Meaning |
|---|---|---|
| step | `id`, `text`, `state: done \| doing \| todo \| dropped`, `waits?`, `reason?` (required when dropped), `after?`, server dates `doneAt`, `since`, `droppedAt` | Part of this item's own work, as steps were; `waits` belongs on a doing step, and a todo step carrying it gets the 在等文字 check |
| owned item | `id` = `item` (the target key), `item`, `own: true`, `after?` | A part of this item's plan that is an item of its own: the target is this item's sub-item, drawn under it in the tree |
| shared item | `id` = `item`, `item`, `own: false`, `after?` | Someone else's item whose result this item waits for; the tree does not draw it here, and the page marks it 「共用 · 归属在 <owner>」 |
| card | `id` = `card`, `card`, `after?` | A decision card of this item; never owned, never another item's card |
| acceptance | `id`, `accept: true`, `text`, `state`, `reason?`, server dates | A number or check that decides completion, placed where that check happens. It is an ordinary step with the acceptance marker |

- **Ids.** A step's or acceptance step's `id` is caller-chosen and follows the
  step-id pattern (letters, digits, `.`, `_`, `-`, at most 40). An item or card
  row's `id` is the target's key, set by the server, so one plan names each
  target at most once and `after` reads naturally (`after: [halo-gc]`). A step
  id equal to a target key in the same plan is refused.
- **No why on rows.** Item and card rows carry no `why` (owner, 2026-10-13).
  The why existed because dependencies had no place of their own to be read;
  a row now sits in the plan, between the rows before and after it, under the
  item's title and with the target's title, and the plan and the titles say
  what it is for. A step's text already says what it does. Anything more an
  item needs to explain goes in its head's 做法 or its log. The former whys
  are kept in each item's log by the conversion (section 10).
- **After.** `after` lists ids of earlier rows that must be resolved before
  this row can proceed. Absent means after the previous row that is not a
  record row (a record row is no step, see Records; the first row, and a row
  with only record rows before it: after nothing); `after: []` means it can
  start at once. Only earlier rows may be named, so the order relation cannot
  form a cycle. Acceptance uses these same rules, including the previous-row
  default. A row that names a record row in `after` waits for nothing, since a
  record row is always resolved. Removing a row that a later row names in
  `after` is refused, naming the later rows.
- **Acceptance.** A work item's plan has at least one acceptance step; several
  are allowed, for example one per acceptance scenario. A record has none.
  Place each where the check happens, normally before merge or release rows.
  Its text is a completion check, with numbers agreeing with the target
  numbers above the plan. Its `after`, `waits`, state and dates follow ordinary
  step rules; a todo acceptance step with `waits` gets the 在等文字 check.
  Step state writes do not enforce readiness; acceptance has no
  additional completion guard. An item is done only when every row, including
  every acceptance and delivery row, is resolved.
- **Dates.** The server stamps step and acceptance dates exactly as it stamped
  step dates: `doneAt`, `since` and `droppedAt` on entry into a state,
  preserved while the state stays, re-stamped on re-entry; callers never
  supply dates. Elapsed days are whole 24-hour days since `since`, clamped to
  zero. Item and card rows carry no state or dates of their own: their state
  is the target's, derived on read.

#### Row states

Each row is in one derived state, which status and display use:

| Row | resolved | in progress | waiting | open |
|---|---|---|---|---|
| step | done, or dropped with its reason | doing | — | todo |
| owned item | target done, or cancelled (counts as dropped; the target's cancellation log is the reason) | target in progress | target blocked or paused | target todo or idle |
| shared item | target done | — | target open (any status) | — |
| card | card not open (ruled or withdrawn) | — | card open | — |
| record (owned or shared) | always resolved, left out of counts and out of the order: a record is a part kept for reference, not work, and no row waits for it | | | |

A shared row whose target is cancelled is not resolved: someone else dropped
what this item waits for, and the plan's own project must remove or replace
the row. It shows the check 依赖的条目已取消 and keeps the item from completing.

A row is ready when it is unresolved and every row it comes after is
resolved, for ordinary and acceptance steps alike. The ready rows are the
plan's frontier.

#### Status

A work item's status is derived from its plan and effective pause; cancellation
and the separate pause marker are stored.
Cancelling or reopening never changes plan rows, including acceptance states,
dates and prerequisites. The converter's initial `todo` acceptance for an old
cancelled item is a conversion mapping, not a reset performed by cancellation.

1. `cancelled` when the item stores `status: cancelled` (set by `set_status`
   with the reason). Cancelling is refused while an owned row's target is
   open, naming those items: each part gets its own reason first.
2. `done` when every row is resolved, every acceptance and delivery row included.
3. `paused` when this item or any ancestor in its same-project ownership chain
   has a pause marker. Shared rows never inherit a pause. Done and cancelled
   win over pause; records have no status. A record in the ownership chain
   does not interrupt inheritance from a work ancestor.
4. `wip` when any row is in progress: a doing step, or an owned item in
   progress. A doing step with `waits` (CI, a run on the 14900K, something not
   on the board) is still in progress. A todo step with `waits` is not in
   progress, and its check (在等文字) asks for the wait to be written as a
   shared row, a card, the backlog, or a doing step.
5. `blocked` when nothing is in progress and the item has a pending legacy
   ask, or every frontier row is waiting (a shared item still open, an open
   card, an owned item that is itself blocked or paused), or the row that owns
   the item in its owner's plan comes after a row that is not resolved (an
   owner that is a record has no order, so a backlog item is never blocked
   this way). Whether the rows before it are resolved reads only whether their
   items are done or cancelled, never their full status: a full status asks
   back whether the owned item's turn has come, and two plans that each wait
   on the other's earlier row would loop. Such a pair is blocked. A paused
   child is waiting on the owner; a parent that is not paused can therefore be
   blocked by it, under the ordinary frontier rule.
6. `wip` when a session is working on the item: it has an unfinished dispatch
   record, of either role, and that session was started or wrote on the board
   within the agent list's window (`AGENT_WINDOW_MS`, six hours), so status and
   the agent list agree on which sessions are on an item. A session that has
   gone quiet for the window is no longer working on it. The records are read
   by `openDispatches`, the one reading of an item's unfinished dispatches.
   This is not the push's holder (The wake streams, Where a push goes): a push
   goes to the one engineer session that holds the item, whatever the window.
   Status counts a session of either role, because a reviewer is working on the
   item too, and only within the window.
7. `idle` when nobody is working on the item and part of its own work is done: a
   step of its own is done, or an item it owns is done, or an open item it owns
   has begun in this same sense (a dropped step, a cancelled owned item and an
   owned record do not count). What others finished does not count: a shared
   dependency that is done and a ruled card leave the item at `todo`, though
   the progress count still includes those rows; a record row, shared or
   owned, is no step and is not counted. A parent
   therefore leaves `todo` as its parts progress.
8. `todo` otherwise: nothing is done and nobody is working on the item.

The three live states answer three different questions: `wip` says someone is on
it, `idle` says work was done and nobody is on it now, `todo` says nothing
was done. How far an item is and what its rows wait on is not a status; the page
shows them in 计划和进展 (How the page shows a plan). That an item waits for
its turn in its owner's plan shows in the owner's plan, not in its own detail. `idle` is not
the 无人推进 check (Stalled work): `idle` says nobody is working on the item;
无人推进 flags an item someone is working on, with a step in progress, that has
been quiet for an hour.

So a parent is done only when its own steps, acceptance steps and delivery rows are resolved,
not merely when its children are (owner decision 6), and an item is blocked
exactly when everything that could move next waits on another item, another
project or the owner. The previous rule called a parent blocked as soon as one
child was blocked and none was in progress, even with another child ready to
start; under this rule that parent is `todo`, because work can proceed (9
parents change this way in the board of 2026-10-13, reported by the
conversion). The checks that existed only because status was set by hand go
away: 卡住了，但没写在等什么, 可解除阻塞：等的都已完成 and 标为进行中，但还在等别的.

Every work item has a plan with at least one acceptance step, so no work item
has a stored `todo`, `idle`, `wip`, `blocked` or `done` any more. An item with an
empty plan (none exists after conversion; the schema allows it only on a
record) shows the check 没有计划：至少要有一个验收步骤.

Pause and resume log `暂停：<reason>` and `恢复`, respectively, in the same
commit as the marker change. Resume clears only this item's marker; another
paused ancestor or a child's independent pause still applies. Repeating the
same pause reason or resuming open work without its own marker is a no-op.
Done and cancellation leave the marker inactive on that item, but open
descendants still inherit it. An authorized resume can clear this inactive
marker; reopening a cancelled item without that resume retains the owner's
pause. A write by any author but the architect (`Architect` from a session name starting `架构师`) that changes an item from effectively paused
to open, not-paused work is refused, naming its pause source and requiring
the owner or the architect to resume it. This covers moves out of a paused chain
and ownership changes affecting unwritten descendants. Done and cancellation
are closure, not resume: a project's author may complete paused work and
the architect may cancel it (cancelling is reserved for them), either
keeping the marker. Becoming a record is also not open work, but clearing an
explicit marker, including an inactive one, still requires the owner or
the architect. Converting a cancelled item to a record is reserved for
them too, since converting it back to work would reopen it without
`set_status`. Moving work into a paused chain is allowed.
A project edits only its own items and cards; the architect edits any
project's. That reach lifts only the check that the author is the item's
project. Ownership still stays inside one project, and removing an open
owned row still requires moving or cancelling its target first, for
them as for every other author.

#### Ownership, the tree, roots and top items

- **Owner.** An item's owner is the item whose plan holds an owned row for it.
  The tree draws an item's owned rows' targets under it, in plan order; there
  is no separate `parent` field. Ancestors, the line (top item) of an item,
  subtree counts and the 新 chip's subtree all follow owners.
- **Exactly one owner.** No item is owned by two rows. A write that would make
  a second owned row is refused, naming the current owner and directing the
  caller to `move_item`; a stored violation shows 被多个条目拥有.
- **No cross-project ownership.** An owned row's target belongs to the same
  project as the plan's item. A cross-project need is a shared row, which may
  point at any item of the other project; the usual target is the item
  collecting what one project needs from another, but nothing requires it
  (an item that moves to another project leaves such rows behind, below).
  A write that owns across projects is refused; a stored violation shows
  跨项目拥有.
- **Changing project.** `move_item_project` changes the `group` of an item and of everything it owns, so an
  owned part never straddles two projects. Its key, number, history, notes and cards stay with it, because each is
  addressed by the item's key.
  - Rows. An owner that stays behind (the item's owner, or a backlog record) keeps its row as a shared row in the same
    place, since it still needs the result and ownership cannot cross projects. An item left behind may also wait on a
    moved part through an existing shared row; it stays valid (see the previous bullet).
  - Arrival. The item arrives as a top item of the new project. Placing it under an owner there is that project's
    `move_item`: a call that named the new owner would write an item of the other project, and each project writes only
    its own items. Two cases leave an open waiter and no owner in the new project, and the move is refused, naming
    the items and the way out, as the 同项目有条目在等它，却没有条目拥有它 check reports it after the write.
    (a) An open item of the new project already waits on the moved item through a shared row, so the item would arrive
    owned by no item. The new project drops the row first with `set_plan` and, if the item still matters there, lets the
    item that needs it own it with an owned row after the move; or leaves the dependency out.
    (b) The moved item's own plan holds a shared row to a top item T of the new project that nothing owns, so T would
    gain an open waiter. Either an item of the new project owns T first, or the row to T leaves the moved item's plan
    first.
    Only a violation this move newly causes is refused; one that was already there (a top item of the new project that
    an open item of the new project already waits on) does not stop it.
  - Rejected: moving only the named item and leaving what it owns behind (the owned rows would become cross-project
    ownership), and an argument naming the new owner (above).
- **Top items.** An item no row owns is a top item (what earlier sections
  call an area), drawn at the top level of its project. A top item is one of: a root (below); an item another
  project's shared row waits on, such as a collecting item (drawn under the
  existing 被其他项目依赖 separator); or a closed item (done or
  cancelled), which needs nothing further. An open top item that an open work
  item of its own project waits on through a shared row shows
  同项目有条目在等它，却没有条目拥有它, and a write that introduces this is
  refused: within a project, the item whose plan it is a part of owns it, and
  the others share it.
- **Roots.** A root is an item that no open work item depends on through any
  item row, owned or shared, as before (paused work is still open for ownership
  and rootness). An
  owned item under an open owner is never a root. An open item owned by a
  closed item shows 拥有它的条目已关闭 (it can only arise from data written
  before the cancellation refusal).
  An open work item owned by a record is not a root.
- **Backlog.** A project's backlog is a record whose plan owns the items it
  holds. A record is not work, so backlog work is needed only through a
  needed item other than its record (below); moving an item out under an
  unpaused root's plan makes that root need it.
- **Cycles.** Item rows, owned and shared together, may not form a cycle; a
  write that closes one is refused, and a stored cycle shows 依赖成环 as
  today. Owned rows alone therefore form a forest. `after` cannot form a cycle
  because it names only earlier rows.

#### Priority

Items store no priority and the board derives none. The owner found that a
large share of items showed P0 (a root's value reached everything it needs), so
the value ranked nothing. What must come first is a dependency, and which ready
work to start is the architect's call from the owner's principles, kept in the
architect's context and not on the board. Siblings, and `brief`'s paused and
in-progress lists, sort ended items last, then by `order` (`compareSiblings`); the page's
waiting panel lists the longest wait first. A write that still names
`priority` (any tool that took it, or an operation) is refused with a message
saying the field was removed, so a session working from old instructions
learns it at once instead of seeing the argument ignored.

Rejected: keeping the three levels as a coarse rank (it no longer separates
anything, and agents would take it for the architect's choice); a sequence
number the architect maintains on the board (a second ordering beside the
dependencies that must be kept current by hand, for a choice the architect
makes from context the board does not hold).

An open work item is *needed* when an unpaused root needs it: it is an unpaused
root, or an unpaused, open item holds an item row (owned or shared) for it and
is itself needed. A record is not work. So backlog work is needed
only when a needed item other than its record also holds a row for it, and
what hangs under backlog work only when that work is needed; paused work and
work reached only through paused items are not needed; a root that is not
started is. The same walk
decides which items 缺难度 asks a difficulty for (with the state and next-step
conditions above) and which items `brief` lists as startable. Whether an item is needed is part of the summary
`affectedItems` compares, because a pause can change it for an item whose
checks stay the same.

#### Records

A record (`record: true`) may have a plan of steps, owned rows, shared rows
and card rows, and no acceptance step; it has no status, appears in no status
queue, is never waiting or blocking for anyone. It may
own work items (the backlog, the 14900K queue's run items). A record can be
owned or shared by a work item's plan, and its row there, owned or shared, is
no step: it is always resolved, left out of the plan's counts and progress
share, and left out of the order, so a row with no `after` comes after the
nearest row before it that is not a record row. Without that, a record row put
between waiting rows and the acceptance step would count as a finished row the
acceptance step follows, and an item whose every step waits would read as
startable. The same skip applies where the plan is rewritten for a card row
(`write_card` placing a blocking card's row, and removing it when the card stops
blocking) and where an owned item's turn in its owner's plan is read.
Setting `record: true` on a work item removes all its acceptance steps,
logging every step's text; setting `record: false` requires `accept` text for
the new acceptance step. A real change of mode in either direction appends a
server-stamped log line saying the item became a record or a work item; a
call that leaves the mode unchanged logs nothing. Records receive no
status-based checks, and the page shows `记录` in place of a status.
`parent_own_work` no longer exists: an item's own
work is step rows in its own plan, so no conversion ever needs to invent an
own-work sub-item.

#### Closed items and visibility

Archiving does not exist: there is no archive field, API, button or shortcut.
Done and cancelled items are hidden as their own tree and list nodes by
default; the project's 完成 or 取消 status filter shows them. 完成 includes
all done items, while 7 天内完成 remains a recent-completion shortcut.
Closed owners with open descendants remain visible as dimmed tree paths,
so their open work stays reachable.
Their rows in every plan always show the state glyph, title and link;
following a link opens the hidden item's detail without changing filters.
Unread changes on a closed item, its cards and replies remain in 新 and the
navigation stops. Reading and reviewing them does not require drawing the
item in the default tree.

#### Checks

The checks touching plans, replacing the dependency and completion-condition
checks. A cancelled item, and each card of one, shows none of them; the
write-time refusals in the last column still apply to it.

Every kind of check has a fixed id, registered once in `CHECK_KINDS` (`src/rules.ts`),
beside its short label and whether a write that introduces it is refused. A check is made
only through that registry, so its id is never missing and its label never disagrees with
its kind. An id is a short English word chain that is not reused, renamed or given another
meaning. What says two checks are the same one, on two boards or at two times, is the id and
the item or card the check points at (`checkKey`); the text, which may carry a count that
changes while the check stays, is for people. A check whose kind can occur more than once on
an item points at each object it is about (the missing dependency, the waiting item, the
card), which is what tells the occurrences apart. A new kind of check is a new entry in the
registry, and a test raises every registered kind on one board.

| Id | Check | Refused when newly introduced |
|---|---|---|
| `dep-item-missing`, `dep-card-missing` | 依赖的条目不存在 / 依赖的决策卡不存在 (pointing at the missing row's key) | yes |
| `dep-cycle` | 依赖成环 | yes |
| `owned-by-many` | 被多个条目拥有 | yes |
| `owned-across-projects` | 跨项目拥有 | yes |
| `unowned-but-awaited` | 同项目有条目在等它，却没有条目拥有它 | yes |
| `no-acceptance` | 没有计划：至少要有一个验收步骤 | yes |
| `plan-provisional` | 计划待重写 (label `待重写`: the plan is still the conversion's provisional plan, below) | no; conversion only |
| `acceptance-pending` | 验收步骤待补 (the acceptance text is the conversion placeholder) | no; conversion only |
| `dep-item-cancelled` | 依赖的条目已取消 (shared row to a cancelled item) | no |
| `owner-closed` | 拥有它的条目已关闭 | no |
| `only-acceptance-left` | 只差验收：其它行都已完成 (all non-acceptance rows resolved, with at least one acceptance step still todo or doing; the item stays open until its checks are resolved) | no |
| `project-unconfigured` | 项目没有配置：<group> (the item's `group` is not a configured project) | no |
| `card-plan-mismatch` | 卡和计划对不上 (an open blocking card and the plan rows of its item disagree, below) | no |
| `card-unplaced` | 卡没标位置 (an open card the item's head does not place, below) | no |
| `card-options-short` | 选项不足 (label `选项不足`: an open decision card has fewer than three options; the check sits on the card and on its item, and a card with a recorded choice but not yet ruled is not checked) | no |
| `tags-missing` | 缺标签 (the item has no tag; `set_tags` fixes it) | no |
| `difficulty-missing` | 缺难度 (work an unpaused root needs, with no difficulty, that `canStart` allows: todo or idle, and whose next own step is a todo step waiting on nothing; `set_difficulty` fixes it, by the architect, or the engineer whose subtree holds the item below its root; not raised for a record, a closed item, backlog work and what hangs under it, paused work, work only a paused root needs, a blocked item or one whose next step is another item or card) | no |
| `title-too-long` | 标题超过 20 个字 (open items and records only; spaces are not counted, the count is in characters; writes are not refused) | no |
| `stalled` | 无人推进 (stalled, above) | no |
| `waits-in-text` | 在等文字 (label `在等文字`: a todo step writes `waits`, so the item reads as startable; the check lists the rows by id and names the fixes; not for paused, backlog, done or cancelled items; writing it is not refused) | no |
| `pause-conflict` | 暂停了，但 <dependent title> 在等它 (label `暂停冲突`, on the paused target of a shared row held by open, not-paused work, pointing at the waiter) | no |
| `stage-format` | 大步骤格式 (label `大步骤格式`: an open item an engineer holds, that is, an engineer dispatch not ended or a runner report not done, whose plan lacks a `research`, `impl` or `accept` stage row, whose first rows of the stages are not in the order of the flow (`research`, `impl`, `ci`, `accept`, `merge`, `verify`), or whose rounds of one stage do not rise (`impl-2` before `impl`); the text names what is missing or which two rows are reversed, and says so when the `accept` row carries the acceptance mark; a paused item keeps it, as a form check) | no |

Effectively paused items retain all form checks, including provisional plans
and missing acceptance. They receive no stalled check and no 在等文字 check.
An owner linked only by its owned row does not raise 暂停冲突: its row
already waits on the owner and may make the parent blocked. Shared needs
still raise the check on the paused target.

Removed: 上级条目不存在, 上级没有把它列在依赖里, 正文没写完成条件, and the
three manual-status checks listed under Status.

#### Writing plans

- A new work item is created with its acceptance text (`create_item`'s
  `accept`), so every new item has a plan from birth.
- `set_plan` (section 6) edits rows: replace the whole plan, upsert one row,
  or remove one. An owned row may be added only for an item that no row owns
  (a top item of the same project, or a new item through `create_item`);
  taking an item from another owner is `move_item`, so a transfer is always a
  deliberate call logged on both sides. Removing an owned row, or turning it
  into a shared row, is refused while the target is open (use `move_item`, or
  cancel the target first); for a closed target it leaves a closed top item.
  The one exception is `move_item_project`: when the target changes project,
  its owner's owned row becomes a shared row in the same call (see Changing
  project above).
- A replacement preserves matching rows' dates by id; duplicate ids are
  refused; a call whose result equals the current plan changes nothing, not
  even `updated`, and writes no commit.
- Row changes are owner-unread progress (the 进展 filter), compared by row id
  like steps were.
- **Provisional plans.** The conversion (section 10) marks every plan it
  produces `provisional: true`, a server-owned item field no caller can set.
  A provisional plan works like any plan (status and progress are
  derived from it, and single rows can be upserted to record progress), but
  it shows the check 计划待重写, whose label 待重写 appears beside the item's
  title in the tree and beside the 计划和进展 heading, and its owned rows
  carry the same small 待重写 mark. The mark clears only when a session writes
  the whole plan with `set_plan`'s `rows` mode, which is the rewrite of
  section 10's second phase; the server logs 重写了计划 on the item. Items
  created after the conversion are never provisional.

#### When a row becomes its own item

A row of a plan is its own item, owned through an owned row, when at least
one of these holds; otherwise it is a step.

1. It has its own completion check or number, distinct from its owner's
   acceptance step, so it can be accepted on its own.
2. Something other than its owner must point at it: another item waits on it
   (only an item can be the target of a shared row), or it needs a decision
   card of its own (a card belongs to an item).
3. It is tracked as a unit outside the board: its own pull request, release
   or 14900K run (the 14900K queue owns one item per run).
4. It will take more than about one working day of session work, or will
   span sessions, so it needs its own head, log and stall clock for whoever
   picks it up.
5. A different session works on it at the same time as its owner's work, so
   each session records progress in its own item.

Conversely, an item that meets none of these, typically one with a single
step and no acceptance of its own beyond its owner's, folds back into its
owner's plan as a step: its log goes into the owner's log as one entry and
it is cancelled with the reason 并入「owner」的计划. The own-work sub-items the
old model required are the common case.

- *Becomes an item.* Halo's plan for the Firn release has the row "Lua 5.1
  official test suite passes". It has its own number (all of the suite's
  files pass), and Firn's item for coroutine scripts waits on it through a
  shared row, so it is an item owned by Halo's release item.
- *Stays a step.* An item "Firn's rate-limiting script errors match Redis
  word for word" has the row "reword the parser's error messages". It is done
  in an afternoon in the same pull request, nothing else waits on it, and the
  item's acceptance (the four scripts' replies match the oracle) already
  checks it, so it is a step. If it had been converted as a sub-item with one
  step and no acceptance of its own, it would fold back.

#### How the page shows a plan

The detail column of a selected item reads, top to bottom:

1. the head row: status, title, ratio, chips; the left
   tree already shows the owner, so the detail has no ownership line;
   under it the difficulty and tag chips;
2. 目标, the target-number table (unchanged), when the item has targets;
3. 计划和进展, the plan;
4. the head (问题 / 为什么 / 做法), with each card the head places inside it
   (see Decision cards), and the `data` line;
5. 被依赖: the items holding a shared row for this item (the owner is
   already on line 1, so it is not repeated);
6. the item's comment entry and comment list (see Comments below);
7. 日志, folded as today;
8. the ask, checks and references.

The owner set this order on 2026-10-13: progress first, then the stable head,
then the comments on it, then history.

The detail shows no separate progress line: status says whether someone is on the item,
and 计划和进展 at the top of the detail says how far it is and what its rows wait on, so a
line under the title would say the same twice. An item that only waits for its turn in its
owner's plan shows that in the owner's plan, not in its own detail.

The left tree draws a band behind the row of each item whose status is wip or
idle, from the row's left edge over the first `Rules.progressShare` of its
width. The agent list (the sessions panel's unfolded items) draws none. The
share is the sum of the weights of the plan rows that count, over the number of
those rows, 0 when there are none. A row counts unless it is dropped (its
`excluded` flag) or it is a cancelled sub-item, owned or shared, which is left
out of the share and the denominator alike. Weights: a done row 1, a row in
progress ½, a card decided or withdrawn 1 and open 0; a sub-item row weighs by
its status: done 1, wip or idle ½, anything else 0; a record row is left out,
like a dropped step. The plan ratio shown on the detail column is unchanged
except for that: it leaves out the record row too, and still counts a shared
cancelled row. The band's gradient runs from `--prog-from` to `--prog-to` across
the full row width, so a short band shows only the start colour: the colour at
any point of the band is the colour that point has in the whole row. Items of
other statuses draw no band. A tree row that draws a band shows no `done/total`
count, since the band already shows the share; the detail keeps its ratio. A
selected or current row keeps its highlight: its band is drawn at 45 % opacity.
Both colour pairs keep the text tokens at 4.5:1 or more against both ends of
the band, in both themes; the values were computed from the tokens, not
measured in a browser. The owner asked for this on the board, so the left list
shows how far each open item is without opening it.

A plan an engineer wrote by the engineer rules (The plan's stages) is read by
its stages, so the share and the count say how far the item is in the flow and
items written with different numbers of detail rows can be compared. A stage
row is a step without the acceptance mark whose id is `research`, `impl`, `ci`,
`accept`, `merge` or `verify`, with `-2` and up for the round that going back
appends (`impl-2`). `Rules.stages` gives the plan's stages only when it has
both a `research` and an `impl` row, because older plans use `merge`, `impl`
and `accept` for ordinary rows: the live board, read on 2026-10-18, held many
open items with a `merge` row and no other stage id, and `accept` is the id of
the acceptance step in nearly every item, which is why a step with the mark is
never a stage. Without both rows the plan keeps counting every row, as above. For a plan
read by stages, `Rules.progressShare` and the count on a tree row without a
band count only the stage rows, with the same weights (done 1, in progress ½)
and the dropped ones left out; detail rows, sub-item rows and cards do not move
them. The stage ids and names are the engineer rules' own (研究, 实现, 完整 CI,
验收, 合入, 线上验证) and `review` is not among them, as this version has no
review. The tree row also shows the name of the stage the item is at as a small
muted tag, `实现·2` from the second round on: the first stage in progress,
else the first not done, none when every stage is done and none on a finished
or cancelled item. The detail column and the agent list keep the count of all
rows, and the plan lists every row. When going back appends a round, the
stages of the earlier round that were not reached stay in the plan until the
engineer drops them, so a share can fall when a round is added.

The status chip, the tree's left bar, the parent's counts, the status bar and
the project's filter buttons all carry 停滞 as a status of its own: the filter
reads "做完了一部分、现在没人在做的条目" and 未开始 reads "什么都还没做、也没人在做的条目".
Its colour is a blue between the grey of 未开始 and the amber of 进行中, the tokens
`--idle`, `--idle-soft` and `--bar-idle`, defined for both themes.

The plan's look, row by row. One line per row, a 16-pixel gutter on the left
carries the row's glyph in its state colour, the same colours as the status
chips (`--done`, `--wip`, `--block`, `--todo`, `--muted`), so both themes
follow the existing tokens with no new colours:

| Glyph | Row |
|---|---|
| ✓ (done colour) | done step, done owned item, resolved shared item or card |
| ● (wip colour) | doing step, owned item in progress |
| ○ (todo colour) | todo step, owned item not started |
| ⏸ (block colour) | waiting: shared item open, open card, blocked owned item |
| ◌ (muted colour) | paused owned or shared item; the row waits on the owner |
| ✗ (muted, struck text) | dropped step, cancelled owned item |

- **Step row.** `● 写解析器 · 3 天 · 等 CI` — text, then elapsed days for a
  doing step, `等 <waits>` when set, `10-12` (month-day) for a done step, the
  reason after a dropped step.
- **Owned item row.** The glyph carries the child's status, then its
  title as a link (click selects it, Back returns) and its
  own ratio `2/5`, on one line; there is no status chip and no second line.
- **Shared item row.** ⏸ or ✓, the target's title as a
  link, on one line; there is no owner or project line under it.
- **Card row.** ⏸ or ✓ (a withdrawn card counts as ✓), the card tag (阻塞
  purple, 决策卡 red, 已裁定 or 已撤回) and the question's first line as a link.
  A ruled card's row adds the pick: `· 选 B：<option name>`. A click on the
  link or anywhere on the row goes to the card in the item's body (selecting
  it, so `c` and `m` act on it) and keeps the shown item selected; a link
  inside the row keeps its own action. The card is always drawn in the body,
  never under its row, so it exists once on the page and has no fold state.
  Any route to the card (the 等你 row, `n`/`N`, a reference or the item's 决策
  buttons) opens the card's own item and goes to the card there. A card row
  whose card is missing stays a link showing the key.
- **Acceptance row.** Placed where its check happens, labelled 验收 in a
  small tag, full text (it may wrap), with the same glyphs as a step
  (○ ● ✓ ✗). It has no extra separator or spacing; the tag identifies it.
- **Parallel groups.** Each row's level is 0 when it comes after nothing and
  otherwise one more than the highest level among the rows it comes after
  (default: the previous row). Walking the rows in stored order, a maximal run
  of two or more consecutive rows with the same level is one group, drawn with
  a thin vertical bracket in the gutter and the label 可同时进行 above it. Rows
  in one level never depend on one another, so a group is always truly
  parallel; rows of one level that are not adjacent show separately, and
  `context` warns about them (see open questions). Acceptance rows join
  parallel groups by the same level rule as other steps.
- **Completed rows remain visible.** Every plan row is shown in stored order,
  including done and dropped rows; there is no resolved-row fold or saved
  fold choice. The ratio beside the heading is `done/total` over all rows
  except dropped steps, cancelled owned items and owned records, the
  acceptance and delivery rows included.

A mock-up at the detail column's minimum width (380 pixels), for an item in
progress with completed and dropped parts:

```
 计划和进展                                                   1/8
 ✓ 解析器能读配置 · 10-06
 ✗ 旧解析方案 · 已由新解析器替代
 ┌ 可同时进行
 │● 写解析器 · 3 天 · 等 CI
 │● Halo 的协程能挂起 2/5
 └○ 改写文档
 ⏸ Whitefoot 能读出对端地址
 ○ 发布说明
 ○ 验收  四个 Redis 7.0.15 限流脚本的回复与 oracle 逐字一致，
         CI 上连跑 3 次全部通过
 ○ 合并到主线并发布
 ─────────────────────────────────────────────────────────
 [评论这个条目]  评论 2 条，1 条有回复 ▸
```

The same as an HTML snippet, using only existing tokens, so dark mode follows
`:root[data-theme="dark"]` and `prefers-color-scheme` as the rest of the page:

```html
<section class="plan" aria-label="计划和进展">
  <div class="log-head">计划和进展 <span class="steps-ratio">1/8</span></div>
  <div class="plan-row done"><span class="g">✓</span>解析器能读配置 · 10-06</div>
  <div class="plan-row dropped"><span class="g">✗</span>旧解析方案 · 已由新解析器替代</div>
  <div class="plan-group" role="group" aria-label="可同时进行">
    <div class="plan-group-label">可同时进行</div>
    <div class="plan-row wip"><span class="g">●</span>写解析器 · 3 天 · 等 CI</div>
    <div class="plan-row wip own"><span class="g">●</span>
      <a>Halo 的协程能挂起</a> <span class="steps-ratio">2/5</span></div>
    <div class="plan-row todo"><span class="g">○</span>改写文档</div>
  </div>
  <div class="plan-row blocked shared"><span class="g">⏸</span>
    <a>Whitefoot 能读出对端地址</a></div>
  <div class="plan-row todo"><span class="g">○</span>发布说明</div>
  <div class="plan-row accept todo"><span class="g">○</span><span class="tag">验收</span>
    四个 Redis 7.0.15 限流脚本的回复与 oracle 逐字一致，CI 上连跑 3 次全部通过</div>
  <div class="plan-row todo"><span class="g">○</span>合并到主线并发布</div>
</section>
<style>
.plan-row { display: grid; grid-template-columns: 16px minmax(0, 1fr); column-gap: 6px; padding: 2px 0; overflow-wrap: anywhere; }
.plan-row > .g { grid-row: 1 / span 3; text-align: center; }
.plan-row.done > .g { color: var(--done); } .plan-row.wip > .g { color: var(--wip); }
.plan-row.blocked > .g { color: var(--block); } .plan-row.todo > .g { color: var(--todo); }
.plan-row.dropped { color: var(--muted); text-decoration: line-through; }
.plan-group { border-left: 2px solid var(--rule); margin-left: 7px; padding-left: 4px; }
.plan-group-label { font-size: 11.5px; color: var(--muted); }
</style>
```

At phone width (below 560 pixels) nothing changes structurally: rows already
wrap; the chip and ratio of an owned row move to the second line, the group
bracket narrows to 1 pixel, and the 16-pixel gutter stays so glyphs align.
Unread changed rows carry the existing blue bar to the left of the gutter.
A tree row shows its plan ratio (`1/7`) where the steps ratio was, unless it
draws a band (above); leaf counts count owned descendants that own no work
items, by status.

#### Decision cards

A decision card asks the owner one question and lays out the ways to answer
it, each with its grounds, so the owner decides where the head gives the
reasoning. Every decision a design makes is one card, standing in the head
where the design reaches it.

- **Shape.** `item`, `question` (one line, one bold sentence in the head),
  `kind?`, `options` (at least one; a check flags an open card with fewer than three), `confidence`, `status`, `blocks?`, `choice?`, `ruling?`,
  `ruledAt?`, times and `num`. An option is `{key, text, detail?,
  recommended?}`: the board assigns the keys A, B, C… in order; `text` is the
  option's name, one line of at most 20 characters (spaces not counted); `detail`
  says what the option does, its cost and risks, and why it is or is not
  recommended, with no length limit. At most one option is recommended.
  `confidence` is `{score?, reason}`: a score from 1 to 5 (5: the evidence
  settles it; 1: judgment only) and the reason, with what could overturn it. A
  status is `open`, `ruled` or `withdrawn`. `write_card` requires a name and a
  detail for every option and a confidence on a new card, and refuses
  anything else, naming the field and the fix. A card has no background: the
  head is the background.
- **Card kind.** `kind` says what the card asks: `design` (a decision that goes
  into the design tree), `inquiry` (any other question the owner decides) or
  `rule` (a change to the rules). The writer chooses it where the card is written:
  `write_card` refuses a new card without one, or with a word that is none of the
  three, saying what each kind is and to choose by what the card asks, not by how the
  question is worded (the parameter's description says the same, where every agent
  sees it; the shared rules do not repeat the tool's behavior), and a revision may
  change it or leave it out to keep it. A card written before the field existed has
  none stored and is read as `design` (`cardKind` in `src/model.ts`), the kind the
  merge check held it as before; a migration would only guess, since the question's
  wording is all that tells an old inquiry card from a design card, so the architect
  sets the kind of each old open card by revising it. `context` shows the kind as a
  line `kind: design` under the card's first line, on the card and in its item,
  closed cards included. The merge check of the runner (item
  runner-merge-card-kind) reads this line instead of a category written in the
  question.
- **Where it lives.** A card is stored once in `decisions/<key>.yaml` with its
  `item`. Only a card that blocks (`blocks`) is also a row of that item's plan,
  because the work goes on without any other card. `write_card` writes both in
  one commit: the row goes before the plan row named by `before` (default: the
  first acceptance step, which then also waits for the card, keeping the rows
  it already waited for), after the rows named by `after`. Setting `blocks` on a
  revision adds the row in the same way; clearing it removes the row, and rows
  that waited for it wait for what it waited for. The plan tools refuse to add
  or remove a card row, `create_item` refuses card rows, and a row for another
  item's card is refused. The check 卡和计划对不上 reports an open blocking card
  without a row, an open card that does not block but has one, and a row for
  a card of another item; only a write that bypasses the tools can raise it. A
  closed card keeps the row it had, which counts as resolved.
- **Placement.** The head places a card with a line holding only `[[q:key]]`
  (outside a code fence): the card is drawn there, inside the head. A key inside
  a sentence stays a link. The check 卡没标位置 flags an open card the head does
  not place. A placement is a convention of the head's text, not a stored field,
  so a rewritten head can move it with no card write; a revision of the head
  that drops a decision drops its card (`withdraw_card`).
- **Cards with no place.** A card the head does not place (a new card written
  without its line, which raises 卡没标位置, or a closed card whose line a
  rewrite of the head dropped, which the check does not flag) is still drawn
  once in the body, after the head, under a line saying it has no place there
  and how to give it one: add the line, or, for an open card only, withdraw it,
  since `withdraw_card` refuses a card that is not open. Every card is drawn once, in the body: its plan row, its 决策 button and
  any link go to that card, wherever it stands, and nothing expands under a
  row. A closed card is one folded line wherever it stands.
- **Ruling.** The owner's pick on the page is recorded by the board itself:
  sending a choice note sets `status: ruled`, `choice` and `ruledAt` (the send
  time) on the open card in the same commit, so no session has to rule it
  afterwards and a pick can no longer sit sent but unrecorded. The ruling also
  handles the pick's own note when it says nothing but the option (`isPlainPick`
  in `src/rules.ts`: the text the page writes, "选 A", or no text): the commit
  writes that note `done`, with no reply, so it never waits as `sent`, no push
  announces it as a note, and a session that lists the unhandled notes, or the
  runner that gives an item's sent notes to its engineer, never meets it. A pick
  with the owner's words (a text the owner changed) rules the card the same way
  but stays `sent` for the architect, as does a pick sent when its card is no
  longer open: the card keeps its ruling and the note is not handled by it.
  Rejected: closing every pick's note, which would leave the owner's words in a
  closed note nobody is told of; leaving the note `sent` and having each reader
  skip it, since the runner, `brief`, `notes` and the page would each need the
  same test and a later reader would forget it. `rule_card(key,
  choice?, ruling?)` is for a decision the owner made in chat: it takes the
  option chosen, the owner's own words, or both, and the words are kept in
  `ruling` for the design log's approval line. A card ruled in words alone has
  no `choice`. Either way the board tells the session
  holding the card's item with a `card-ruled` push (section 8, A card ruled).
- **Withdrawing.** `withdraw_card(key, log)` closes an open card nobody needs
  any more: the status becomes `withdrawn`, the log text goes to the item's
  log, and a row counts as resolved. It is the one way to retire a card;
  nothing deletes one. Cancelling an item withdraws its open cards in the
  same commit, marked `withdrawnWithItem`; reopening the item restores those
  marked cards to open, and leaves a card withdrawn by hand withdrawn.
- **Legacy text.** Cards converted from the earlier form (by the one-time card
  migration, removed once it ran on the live board) keep their old `background` in
  `legacy`, shown in a fold titled 原卡的背景. Nothing writes `legacy` again,
  and search covers it. An open card's fold starts open, because its reader
  decides from the background; a closed card's starts folded. Their options
  have no name: the old option text is the detail, and the page shows its
  first line where it needs a name.
- **Closed cards.** A ruled or withdrawn card is one line in the body: its
  tag, its question and its pick (the name of the chosen option, or the first
  line of its detail; the ruling when the owner answered in words). The
  options with their details, the confidence, the ruling and the legacy fold
  open under the line on a click; the open state is remembered per card like a
  参考 section, and going to a card from a plan row or a reference opens it.
  Hundreds of converted cards each carry long text, and an item with a dozen of
  them filled the page. Open cards, their checks and the comment block are
  always shown. Rejected: folding all of an item's closed cards under one
  heading (a click to see one card's pick, and the plan row and reference
  could not open a single card); shortening what the migration stores
  (nothing the owner wrote is dropped).
- **Blocking.** A card with `blocks` is blocking: the owner is told on the
  Mac, the page shows it purple and the item waits on its row.

Rejected: keeping the grounds in a long background on the card and only
names in the options (the owner decides where the head gives the reasoning,
and each option's cost belongs beside its name); a stored placement field or an
index per card (the head already says where each question belongs, and a
stored index could disagree with it); a separate decisions section on the page
(a card outside its item is read without the text that asks it); a row in the
plan of every item that waits on the card (a card of another item is a shared
dependency of the item that owns it; migration removed the 73 such rows, all
pointing at ruled cards); a row in the plan for every card (a card that does
not block would hold the item's status for a question the work does not wait
on).

#### Comments

The owner comments on the whole item, not on plan rows. The page puts the
item's comment entry, a visible 评论这个条目 button that opens the existing
composer, and the item's comment list after the head and 被依赖, before the
log. The `c` key remains an entry too, and a comment may carry an anchor: a log entry (`{kind: log, at}`) or another note
(`{kind: note, id}`); a selected dependency row (`dep:<item>@<target>`)
already comments on the item without an anchor. Plan rows follow that: they
are selectable for navigation, `c` on a row comments on the item, and no new
anchor kind is added. Log and reply anchors stay as they are, so existing
notes keep their anchors.

**Threads.** A comment whose anchor names another comment (`{kind: note, id}`)
follows it, and the comments that follow each other form a thread. The page lists
the comments of an item or card in the order written, except that a comment which
follows another comment of the list comes right under it, after the comments that
follow that one in turn (`threadOrder` in `web/threads.ts`, a plain function the
tests call). It is indented one step for each comment it follows in turn, three
steps at most, with a thin rule on its left, and does not name what it follows:
its place says so. `c` on a selected comment opens the comment field under that
comment and the thread below it, so a follow-up is written where it will be listed;
the first comment of a thread, and any comment whose anchor names no comment of the
list (a log entry, a comment that is gone), stays where its time puts it and keeps
its "about" line. The data is unchanged: the anchor already held the relation (on the
live board 68 comments carry one, 19 of them following a comment that itself follows
one), and each comment keeps its own reply, so a session answers a follow-up with
`reply_note` on it, as on any comment. Rejected: a stored list of followers on the
parent, or a `parent` field beside the anchor (a second copy of a relation the anchor
holds, which the storage tree forbids); a screen of its own for a conversation (the
owner asked for the thread where the comments are, and a comment is read with its
item); indenting without limit (a long chain would leave no width for the text).

#### Open questions

Each is written as the assumption the design proceeds on; the owner can
overturn it.

1. **Shared row to a cancelled item.** Proceeding on: it keeps the item from
   completing and is flagged, because a waited-for result that will never
   come is a problem for the waiting project to settle. Alternative: count it
   resolved like a cancelled owned item.
2. **Order of same-level rows.** Proceeding on: rows display in stored order,
   and `context` warns when rows of one level are not adjacent. Alternative:
   the server keeps every plan sorted by level (stable), which always makes
   parallel rows adjacent but reorders what a session wrote.
3. **Closed items after conversion.** Proceeding on: the mechanical
   conversion keeps closed children as provisional rows of their owners'
   plans, fully visible; a rewrite keeps only the closed items its new plan attaches,
   and every other closed item becomes, or stays, a closed top item without a
   flag; no history-only owner is created,
   because an item that only holds finished items is a topic group, which the
   rules forbid. Alternative: a per-project record 已完成 owning loose closed
   items, which would tidy the tree but carries no meaning.
4. **Own-work sub-items.** Proceeding on: the mechanical conversion keeps
   the 58 own-work sub-items as provisional owned rows; the rewrite folds each
   back by the rule in "When a row becomes its own item". Alternative: the
   converter folds them automatically, which rewrites history the sessions
   did not review.
5. **Cancelling with open parts.** Proceeding on: refused, naming the open
   owned items, so each gets its own reason. Alternative: a cascade that
   cancels all open owned descendants with the same reason.

## 6. MCP tools

Every tool returns compact text built for an agent's context: ids, titles,
status and the relevant lines, never whole files unless asked. An item or
card row ends with its short number (`· #812`), and JSON rows carry `num`;
`context` and `graph` accept `#812` or `812` as well as a key, an exact key
winning over a number. A write over a connection that carries a credential
(section 9) is made by the credential's writer: `author` and `session` are left
out, and one that is given and differs is ignored, with a note in the answer.
Without a credential a write takes `author`, the name of the project the
session works for, selected from `projects` by matching `repo` to its
repository's GitHub remote (until the old tools are removed), and a write with
neither is refused. The
architect writes as `Architect`, the project of the agents_config repository, from the session
`架构师`, or another name that starts with it (section 9). Several sessions may share a project and
coordinate among themselves; sessions may be renamed freely. Every tool, reads
included, takes an optional `session` (1–80 characters, trimmed): the calling
session's own name as the app's session list shows it. A write records it as
described under the stalled-work rule's activity index; any session's call, the architect's
included (not another name that starts with `架构师`, such as `架构师轮次`, below, whose stream is empty), is a sign of life for the session and carries what was pushed to it and not
yet delivered (section 8, The wake streams, Liveness).
`context` prints
`last push: <session> · <time to the minute>` for an item with a known last
writer, and `brief` gives each work-in-progress row a `lastPush` with the
same text, so the architect sees whether work is being pushed and what a
closed session left behind. Omitting `session` is allowed; a call without it carries no pushes
and is no sign of life.

### Server instructions

The server's instructions (`src/instructions.ts`) are a short pointer of at
most 2048 characters. They say that how to use the board and write on it is in
the shared rules (the board's rule block `shared-rules`, section "The board",
assembled into every agent's rule file in `$WF_HOME/agents_config`), and give the first steps: call `projects`, pick the
project whose `repo` matches the repository's GitHub remote, call `brief`, and
pass that project's name as `author` and the session's own name as `session`
in every write. They state no rule of their own, so each rule has one
definition.

Why a pointer. Claude Code cuts a server's instructions at 2048 characters
(measured on 2026-10-16 in Claude Code 2.1.295, desktop app: the live
server's 3,722-character instructions appeared in a session's system prompt
cut at character 2048 and marked "[truncated]"), so the board's usage rules
(several times that long) placed in them would reach no agent running there.
The owner decided that board usage must stay in
the agent's context for the whole session. The shared `AGENTS.md` does: every
session started under `~/dev/wf` loads it and keeps it through compaction.
A guide tool or resource would add a call the agent must make and would not
keep the rules in context, so it was not built. The cost is that a session
started outside `~/dev/wf` does not load the rules; the pointer tells it to
read them.

A rule the server enforces is defined in `src/model.ts` or `src/rules.ts`;
the section "Board" states it for agents. A change to a tool's behavior or to a
board rule gets what that section must say written on its item by its engineer, and the
observer changes the section after the merge (`AGENTS.md`, Rules). A test keeps the
instructions within the limit and free of rule text.

### Finding things

| Tool | Answers | Returns |
|---|---|---|
| `search(query, filters)` | Where is X mentioned? | Hits across item heads, plan rows (step and acceptance text), targets (goal, target value, current value and comparison baseline) and logs, cards and notes: id, kind, title, status, area, the matching line with its time. Filters: group, area subtree, status, kind, since. Substring matching, which handles Chinese without a tokenizer |
| `context(id, log?, section?, full?)` | What is this and how did it get here? | The item with its owner chain (each with status); its target lines; its head as the first paragraph of each section; its plan, one compact line per row (below), finished rows other than acceptance steps folded into a count; the items holding a shared row for it, each with its status; its cards (an open card with its `rev`, its question and its option names, a ruled or withdrawn card as its question, the pick and its text); its recent notes; flags; links and at most five PR references; the last five log entries, cut. What is cut or folded, and how to get it whole, is under Lean replies below |
| `graph(id, direction, depth)` | What does this wait on, what waits on it? | The item rows around the item as an indented list, each edge marked owned or shared, marking blocked chains and cycles |
| `history(id, limit?)` | How did this change? | Commits touching the item or card: time, author, summary |
| `diff(id, from, to?)` | What exactly changed? | The textual diff of the file between two commits or times |
| `changes(since, filters, limit?, except?, detail?)` | What needs handling since I last looked? | Rows to handle, each with who wrote it, and counts (below): the flags that newly appeared, the items created, the notes and cards others wrote; the other changes only as counts, and with `detail` also as documents grouped by area, each with its commits and their sessions |
| `prs(repo, number)` | Which items concern this PR? | Items whose text or links reference it |
| `list(filters)` | Structured browsing | Compact rows matching status, area subtree, open ask, flags, updated-since; done/cancelled omitted unless an explicit status filter requests them |
| `overview(group?, status?, detail?)` | The board at a glance | By default one line of counts for each project and, under it, the areas with an owner waiting or a check flagged; `detail` gives every area with its counts, owner actions waiting, blocked items and flags; status narrows those results while retaining area headings (below, Lean replies) |
| `notes(filters)` | What did the owner say? | Notes by state, target subtree, kind, since |
| `dispatches(filters?, rows?)` | How have the sessions started on items done? | The dispatch records of every project, tallied by level, by role and by the item's tags (an item with several tags counts under each, so the tag tallies can add up to more than the total): dispatches, those still running, those ended in each result, the rework share (`返工后通过` plus `换人`, over the ended ones; `放弃` is counted apart), the mean kickbacks over ended engineer dispatches, the mean rounds over ended review dispatches, and the cost; one line each for the total and the failure signals (ended dispatches carrying each). Every figure is added up from the rows; `rows: true` lists them, oldest start first. Filters: item `id`, `role`, `level`, `since` (inclusive) and `until` (exclusive) on the start time, in UTC to the minute or in full |
| `projects()` | Which project matches this repository? | Project configuration, top items and open items by status |
| `brief(project)` | What does this project need now? | Sent notes, checks, owner cards, WIP (status wip with a step in progress or a live session), next TODOs (what `canStart` allows and has a rating: status todo or idle, in the order of `candidates`), paused work, outgoing work (open items of other projects its open items wait on) and its glossary terms; paused items stay out of actionable WIP and TODO queues; each item row carries its plan's unresolved rows and a count of resolved ones; blocked items that only wait for their turn in their owner's plan are not listed but counted per owner in `queued` |
| `candidates(under?)` | Which items could an engineer be started on, and how many engineers are working in each pool? | Every project's startable items nobody holds, in a default order, and the two engineer pools with their working engineers and candidates (below) |
| `whole_view(bucket?, project?)` | Where does every open work item stand? | Every open work item that is not in a backlog, in one of five kinds (waiting too long, nobody's, being worked on, waiting, set aside), from the runner's report, a live session and the plan: the totals, a few rows per kind with the rest counted, and what each project has left; `bucket` lists one kind (up to 40 rows), `project` narrows (below, The whole view) |
| `glossary(project?)` | What does a project's word mean? | Terms with definitions: one project's, or every project's that has terms |
| `messages(filters?)` | Who told whom what? | The messages between agents, newest first, one line each (time, sender with its project → recipient, item, text), by recipient, sender, item and time (`since` inclusive, `until` exclusive); at most 50 unless `limit` says otherwise |
| `followups(minutes)` | What is still unhandled? | Older sent notes with project |

`changes`, `history` and `diff` read the git history, so each call runs under a request budget
(section 4): a range too large for it ends the call with an error that names what ran out
and says to narrow `since` or the filters. In `changes` a deleted document is placed by
the current board and by the documents deleted in the range; an item whose owner was
deleted before the range is its own area.

**The patrol read.** What a reader gets from `changes` stays in its context until it is
compacted, so the default answer holds only what needs handling, and each thing appears
once. A range is the commits after `since` (a time or a commit); `except` names sessions
whose commits do not count.

- *New flags.* A check flag is derived from the whole board and written by no commit, so
  a flag is new when the head board carries it and the board when the range began did
  not. That board is built from the head: each item, card and note the range wrote is put
  back to its version before the range (the `changes` read already holds those), those the
  range created are taken away, those it deleted are brought back, and the board settings
  (projects, tag vocabulary) are put back when a range commit wrote them. Its rules are
  worked out at the time the range began, so a flag that comes with time and no commit (a
  step in progress that stands still) is new when it was not there at that time. The
  session activity that the status of an old-board item reads (a session counts as
  working on an item when it started or wrote within six hours) is the current one,
  not the one of the range's start: the board keeps only each session's latest
  writes, and the earlier ones need a scan of the six hours before the range that
  this case does not justify. A session that wrote after the range began therefore
  counts as working at its start, however long it had been quiet. Only 缺难度 reads
  the difference, on an unrated item with an unfinished dispatch, and the error is a
  flag reported as new that was already there. Both
  boards' checks are worked out in full, so the cost of a call is that of two rule builds
  plus the range's reads; `scripts/bench-changes.ts` measures it against the lines of
  section 4 on a hosted CI runner, and those figures, not a run on another machine, are
  the reference. An earlier version of a document that does not fit today's schema (a
  field since removed) cannot be put back: the document counts as absent from the old
  board, and the answer's first line says how many versions that was. The same holds for
  the board settings of before the range: the head's settings stand, and the version is
  counted. The flags that settings change brings (a newly approved tag vocabulary, say)
  are then not new in that range, unlike the flags of a document that could not be read. A flag is the same
  flag on both boards when its check id (below, Checks) and the item or card it points at are
  equal; its text and short label are for people and play no part. A new flag's row names
  every session that wrote the item in the range, its cards and notes included, whether or
  not `except` names it; with no writer the row says no session wrote it in the range (the
  flag came from another item's change, or from time). Flags are never left out by
  `except`: a flag its own writer caused, such as a pause others still wait on, is exactly
  what a patrol must still see.
- *New items.* Items whose first commit in the range is not an excluded session's, each
  with its creator, its project and title, and its flags on the same row (so they are not
  listed again as new flags).
- *Notes and cards.* A note or card that is new, a note that gained a reply or changed
  state, a card whose status changed, each with the item it is on, a short summary and the
  sessions that wrote it. A draft is not listed (no one has it yet). A note or card an
  excluded session created is not new to the reader, so only how it ended up counts: a
  note with a reply, a card no longer open.
- *The first line* counts every commit of the range, board-settings-only ones included,
  and says how many `except` took out.
- *The rest* only as counts by kind and by session; with `detail`, as the documents
  grouped by area with their commits and each commit's session. Created items and the rows
  above are not listed again.
- *Size.* Each group lists at most `limit` rows (default 30) and counts the rest, so the
  answer follows the rows to handle and not the documents changed.
- The timed wake and this read share one function that tells who wrote to each item in a
  list of commits.

**The candidates read.** `candidates` lists the items an engineer could be started on and how
many engineers are working in each pool, so nobody has to collect the items or count sessions itself. It lists; it
does not choose. Which candidate to start is the architect's decision, so the order below is only the default order of the rows, and no row is
called the next one. `candidates` in `src/candidates.ts` is the one function; the tool prints it,
and the board pushes nothing from it.

- *What is a candidate.* An item that `startable` allows (the one definition above: rated 1–5,
  `canStart`) and that nobody holds. It is held when an engineer dispatch is open on it, even
  when that session has gone quiet: the architect takes such an item over, and listing it again
  would start a second engineer beside a stopped one.
- *Default order.* One comparison, `compareCandidates`, over all projects: the item more open,
  unpaused work items hold a shared dependency row for first (its owner holds an owned row for
  every item it owns, which tells none apart, so it is not counted); then the earlier item
  number. Choosing among the candidates, by any principle, is the architect's. `brief`'s todo list uses the same order, so there is one.
- *Pools.* Level 1 is one pool, level 2 and above the other (`POOLS`). An item belongs to the
  pool of its difficulty, an engineer to the pool of its dispatch's level. The board holds no
  limit on a pool: the owner gives the numbers to the architect, which compares them with the working
  count and decides how many to start.
- *Working.* One engineer per session with an open engineer dispatch, on the item it holds.
  It does not count when the board shows it waiting: the item is blocked (it waits on another
  item, a card or the owner), paused, done or cancelled; or every step it has in progress is the
  review step or waits on a 14900K run (`waitsOnRun`: its `waits` names the machine; the rules
  keep `waits` for a wait outside the board, CI or a 14900K run, and an engineer waiting for CI
  is still working, so only the run frees the slot); or it has no step in progress and an owned
  sub-item on its way is worked by another session (an open dispatch of another session on the
  sub-item or below it).
  An engineer that has marked no step yet counts, so a slot is not freed between its start and
  its first mark. A session that has stopped keeps its slot until its dispatch is closed.
- *The review step* is the plan step whose id is `review` (`isReviewStep`, the one place that
  knows this). The review that waits for a reviewer is that step in progress.
- *Answer.* Per pool: the engineers working and the number of candidates of the pool (`total`,
  written 候选 N in the text), then the first 10 rows in the default order, then the number of
  candidates not listed. The answer names no limit and no free slot. More than 3
  candidates under one parent, of any level, are one row naming the parent and the count of all
  of them, at the place of the best of them in each pool they fall in; the candidates a pool
  counts are counted apart from the groups. `under=<parent>` lists the
  parent's candidates of every level one by one (at most 10).
  The answer is a few lines of text: `test/candidates.test.ts` checks that on a generated board
  of the live board's shape it stays under 1500 characters and shorter than the todo lists of
  `brief`. The character counts were not measured again after the limits went.

**The whole view.** `whole_view` answers in one call what the board's open work is doing, so the
architect no longer assembles it from `overview`, `list` and `candidates`, and the owner's
page draws the same result (section 7). `wholeView` in `src/whole-view.ts` is the one function:
it reads the items, the live dispatches and the runner reports once, and the tool prints it
(`wholeViewText`) without choosing or writing anything.

- *Which items.* Every open work item that is not in a backlog (a record's owned items are
  counted apart: they are not started on purpose) and that is not a container: a parent with
  open sub-items is its sub-items' business, unless a runner report or a live engineer
  session is on the parent itself.
- *The five kinds, in the order the answer lists them.* One item is in exactly one:
  1. 等太久 (`overdue`): it has stayed in its state past that state's limit, or the runner
     reported `exception`.
  2. 没人管 (`unattended`): no report, no live engineer session and it waits on nothing the
     plan can name: either half done (`做了一半：done/total 行`) or not begun (`没开始`).
  3. 在做 (`working`): the runner reports `running`, or an engineer session is live (an open
     dispatch started within the window `src/agents.ts` uses for alive).
  4. 在等 (`waiting`): the runner reports any other state within its limit, or the plan makes
     the item blocked (it waits on an open item, a card or the owner's approval).
  5. 搁着 (`parked`): the item is paused, by itself or by an item above it. One row for each pause, naming
     the item that carries the marker and how many open items stand under it.
  The report decides before a session does, and a session before the plan, because the report is
  the freshest word about what the work is doing.
- *Limits.* `WAIT_LIMITS_MS` in `src/whole-view.ts` is the one place: `running` 5 hours, `ci` 90
  minutes, an ask to the owner 12 hours, to the architect 1 hour, `items` 24 hours, `run`
  (the 14900K) 4 hours, `wait` 24 hours (a `wait` that has an `until` lasts until an hour after
  it instead, `WAKE_GRACE_MS`; `limitOf` counts it from `since`), `ready` 1 hour, `done` 30 minutes,
  `exception` 0, and 72 hours for a
  wait read only from the plan, counted from the item's last change. They are
  provisional starting values, not measured; real data will say which are wrong, and the numbers
  change in that one object. A report's `since` counts, so a limit applies to how long the state
  has held, not to how recently the runner called.
- *Order within a kind.* Overdue: the most overrun first. Unattended: half done before not
  begun, the longest untouched first among the half done, `compareCandidates` among the rest.
  The others: the longest in the state first.
- *Answer.* A line of totals (remaining work, then the count of each kind, then the backlog), then
  each kind that has rows with at most `BUCKET_ROWS` of them (8, 8, 8, 8 and 4 for the pauses)
  and a line counting the rest, then what each project has left. `bucket` lists one kind with up
  to `EXPANDED_ROWS` (40) rows and `project` narrows every count and row to one project. A row
  is one line: key, project, title cut at 24 characters, what it does or waits for, how long,
  the limit when overdue, and what a runner says it spent (time, turns, cost).
  `test/whole-view.test.ts` checks, on an in-memory board of the live board's shape (1603
  items), that the answer comes back in under 2000 milliseconds and in at most 6000
  characters, and that every open item is counted once. The measured values go in the item's
  acceptance rows, from the CI log.

### Lean replies

What a tool returns stays in the caller's context until it is compacted, as the patrol read
says, so the two reads that returned the most carry a summary by default and the detail is
asked for. The architect's session between 15 and 17 October 2026 (counted from its
transcripts) made 433 `context` calls that returned 1.59 million characters (3.7k on average,
32k at most), and `overview` returned 24k characters a call. The same sessions' calls were
refused again and again for a parameter name the tool lacked (18 of 88 `create_item`, 10 of
290 `set_plan`, 8 of 263 `update_item`), and the refusal named no name that would have worked.
This is a temporary trim; the redesign of the tools, which is planned separately, may replace it.

**`context` by default** answers with:

- *The head*, as the first paragraph of each section. A section opens at a line that begins
  with a bold title standing alone or followed by a colon or a bracket (`**问题**：…`,
  `**参考：…**`), or with a `#` heading; the text before the first title is a section called
  `开头`; a line inside a fenced block opens none. The sections laid end to end are the head,
  character for character. A section shows its title line and the paragraph up to the first
  blank line (below a title that stands alone, the paragraph under it), at most 400
  characters; a 参考 section shows its title only. A section with 100 characters or fewer left
  over is shown whole, and a head with nothing cut prints as before. What is left out is
  counted on the line that follows.
- *The plan* with finished rows (done, dropped) folded into `✓ N 项已完成` and `✗ M 项已放弃`
  as `brief` folds them, except the acceptance steps, which stay listed whatever their state
  (the architect checks an item by them); other rows, targets, relations and flags as before.
- *Open cards* with the question, `rev`, `kind`, `blocks`, the option names, the recommendation and
  the confidence (its reason cut at 160 characters); the options' grounds are left out.
  A ruled or withdrawn card is as before.
- *Notes* that are handled (state `done`) as the text and the reply, each cut at 160
  characters and without the original action line; an unhandled note whole. A note that
  follows another (its anchor names a note, section 5, Comments) is followed by the lines
  `follows note <id>: <text>` and `its reply: <reply>`: the followed note's text and reply,
  each cut at 160 characters, in every answer that lists notes (`notes`, `context`) and as
  `follows` in the JSON of `brief` and `followups`, which also carry the `anchor`; a note
  whose anchored note is gone, or whose anchor is a log entry, has no `follows`.
- *Pull requests*: the first five references and the count of the rest (`prs` lists the rest).
- *The log*: the latest five entries, each cut at 240 characters with its full length.
  A call that gives `log` gets the entries it asked for whole.

Every cut or fold says how much it left out and what gets the rest: the head (`… N more
characters (section "…")`, and `section`), the plan and the handled notes (a line naming
`full: true`; the notes also the `notes` tool), a card's grounds (the line naming `context` of
its key), the log (the full length of the entry, and `log: N`), the pull requests (the count
and the `prs` tool). The parameters that get the rest: `section` answers with the head alone,
the one section of it named by its title (or by the start of its title, so `参考` finds every
参考 section) or `all` for the whole head, with the `rev` that an edit of the head needs;
`full: true` answers whole, with nothing cut or folded; the card's key given to `context`
answers with the card whole, and with the notes on it whole.

**A summary is not a head.** The line the head's cut writes (`  … N more characters (section
"…")`) is a mark that text is missing. `update_item` and `create_item` refuse a head that holds
that line, and say to read the whole head with `section: "all"` and write that; a head copied
from a cut answer and written back would drop the text the answer left out. The check is on
the line's exact shape, so a head that quotes the mark in another form is not refused.

**`overview` by default** answers with one line for each project (areas, leaf counts by
status, owner actions waiting, blocked items, checks) and, under it, only the areas with an
owner waiting or a check flagged: a line of counts, then at most five rows of each kind, a
row being the item's key, status and title (the title cut at 36 characters; for a check also
the check's short label), and the count of the rest with `detail: true` named. Blocked items
are counted, not listed. `detail: true` gives every area with all its rows, as the answer was.

**A call the tool refuses.** The MCP SDK checks a call's arguments before the tool runs and
answers a mistake with the bare check text; the board turns that check off (it overrides the
SDK's private `validateToolInput` on the server object; the SDK is pinned, and the test in
`test/lean.test.ts` fails if the bare text comes back) and checks the arguments in the tool's
own handler. A schema loosened for the SDK would not do: it would drop the `required` list
the client is shown, and the SDK would still check what is nested in it. The refusal says what
is wrong in plain words (an unknown parameter, a missing required one, a value of the wrong
type or outside the allowed words, the row of a plan that fails and why), then the tool's
parameter table (name, type, required or optional, the first sentence of its description,
built from the same schema the client is shown) and an example call (built from the required
parameters; written by hand for `create_item`, `set_plan`, `update_item` and `write_card`).

**Mistakes made before the tool can help.** A write on a connection with no credential
that names no author is refused with the call that works: `author=<your project's
name, from projects>` and `session=<your session's name>`, with no word about asking for a credential, since the call needs none (that item's count: 12 sessions met the earlier text once
each, and one went to the PM for a credential). A `write_card` whose JSON does not parse is refused by
the Claude Code client before the call reaches the board, with no position (that item's count: 11 refusals
in 4 sessions), so the board can only say beforehand what the shape is: its description gives
the options array with each bracket closed once and the escapes for a double quote and a
line break. A `set_plan` whose `rows` was meant as one row would replace the whole plan, so
the description and the parameter's own text say that `rows` deletes every row it leaves out
and that `row` changes one.

**Names the tools read as others.** A parameter the tool lacks is read as the name it has,
and the answer ends with `note: <name> read as <name>`: `key` and `id` for each other,
`item` and `note` as `id`, `project` as `group`, `plan` and `steps` as `rows` in `set_plan`;
and a parameter written beside a tool's `filters` that the `filters` take (`limit`, `state`,
`since`, `group` …) is moved into them. A read tool given an `author` ignores it (`note:
author ignored`), since a write needs one and a read takes none. Nothing is read when the right
name is also given, and a name that matches none stays unknown and is refused as above with the
tool's parameters; so `move_item` given a `reason` (only the tools that log a reason take it) is
told it has none and shown what it has, and the other writes are not changed to take one.

**Measured** (a copy of the live board's snapshot on 17 October 2026, computed once by the
engineer outside the repository; "whole" is the answer before this change, "default" the
answer now):

| Calls | Whole | Default | Default as share of whole |
|---|---|---|---|
| `context` of five items the architect read often (a project's parent item, a push-notification item, a notes item, a role-rules item, a CI item) | 53,448 | 18,250 | 34% |
| `context` of one of those, read as an engineer's own item | 7,405 | 4,518 | 61% |
| those six calls together (the acceptance set; `brief` is not part of it) | 60,853 | 22,768 | 37% |
| `brief` of `wf-board` | 21,290 | 21,290 | 100% (unchanged) |
| `context` of the 19 items the architect named most often in its calls | 130,157 | 62,843 | 48% |
| the same 19 without the largest (a rules item with a 29k head, 31,068 → 3,527) | 99,089 | 59,316 | 60% |
| `overview` of the whole board | 170,878 | 25,201 | 15% |
| `overview` of the project `wf-board` | 3,753 | 1,789 | 48% |

An item whose size is mostly its plan, relations and notes shrinks little (the first, 95%);
one with a long head or log shrinks most (a role-rules item, 19%).

### Changing things

A plan line in `context` and `brief` is `L<level> <glyph> <id> <text>`, with
`<glyph>` as on the page (✓ ● ○ ⏸ ◌ ✗); an item row adds `[own]` or
`[shared @<owner key>]`, the target's title and status, and for an owned item
its current doing step; a card row adds the card's status and, once ruled, the
pick; `‖` marks rows of
a 可同时进行 group. `brief` folds resolved rows into `✓ N 项已完成` for
done rows (including owned records) and `✗ M 项已放弃` for dropped steps
and cancelled owned items. Plans
replace the separate steps, children, deps and parent fields of these
results, and `context` warns when rows of one level are not adjacent.

In this document the architect as a writer means author `Architect` writing from
a session whose name starts with `架构师` (section 9). It may write any project's items, cards and note replies, and so may
the observer's credential (section 9); every other writer only its own project's. Some operations are reserved for the process, which the architect does, and every other writer
is refused before any ownership check: `set_status`, `set_pause`, `move_item_project`,
a changed title in `update_item`, and the page order in `create_project` and
`update_project`. `create_item`, `set_difficulty` and `set_difficulty_many` are
the process's too, except that an engineer's credential makes the items of its own
subtree and rates the ones below its root (section 9). Some are the architect's
alone: `journal_entry`, the tag vocabulary tools, creating a project over a
credential, and other projects' repositories in `update_project`.
Turning a cancelled item into a record in `update_item` is reserved for the
process too, but its refusal comes after the ownership and revision checks,
because it depends on the item's state. Work another project needs is not filed
by a tool: the session that needs it reports it, and the architect creates it in the
project that delivers it, joined by a shared row. A write under the retired
authors `总管` and `PM` is refused by every tool.

| Tool | Does | Checks |
|---|---|---|
| `create_item(key, title, head, accept, owner?, after?, plan?, children?, group?, links?, data?, record?, tags?, difficulty?)` | Adds an item with its plan: `plan` rows (steps, shared and card rows, owned rows for top items of the project) then the acceptance step from `accept`. With `owner`, the owner's plan gains an owned row for it (optional `after`) in the same commit, inserted before the owner's first acceptance step; without it, the item is a top item of `group`. `children: [id]` moves existing items of the project under the new item as owned rows, each removed from its previous owner's plan, as `move_item` does | Key new and well formed; `accept` required for a work item and refused for a record; the architect, or an engineer inside its subtree (below); owner and children in the new item's project; rows' targets exist; ownership and cycle rules (section 5); no `status` argument; at least one valid tag once the vocabulary has a tag applicable to the item's project, none accepted before; `difficulty` a valid difficulty, never on a record, logged as the first rating. Written by the architect anywhere. An engineer's credential has the part `item.create` for its subtree: the new item must be owned by an item of the subtree (a top item, an owner outside it, or `children` taken from outside are refused), and from then on is inside it. Without a credential only the architect creates items |
| `set_plan(id, rows? / row? / remove?)` | Replaces the whole plan, upserts one row by id (keeping its position, or inserting a new row before the first acceptance step, or appending when there is none), or removes one. Row inputs: step `{id, text, state, waits?, reason?, after?, accept?}`; item `{item, own, after?}`; card `{card, after?}` | Exactly one mode; project ownership; no caller revision; server-stamped dates; dropped needs a reason; at least one acceptance step anywhere for work, none for records; acceptance uses ordinary step state and readiness rules; `after` names earlier rows only; an owned row only for an unowned item of the same project; removing or un-owning an owned row only for a closed target, else refused pointing to `move_item`; removing a row named in a later `after` refused; ownership and cycle checks; writing the whole plan (`rows`) clears a provisional plan's mark and logs 重写了计划; one commit with concurrent-write retry; identical result writes no commit |
| `set_targets(id, targets? / target? / remove?)` | Replaces goal numbers, upserts a complete goal by stable id, or removes one; values overwrite the previous row | Exactly one mode; project ownership; required nonempty text; no caller revision or date; server stamps date on current-value changes; one atomic commit with concurrent-write retry; identical result writes no commit |
| `set_tags(id, tags)` | Sets the item's whole tag list | Project ownership; at least one tag, no repeats; every tag in the vocabulary and applicable to the item's project, else refused naming the allowed tags; no revision (like `set_targets`, a whole-list write that retries on concurrent writes; `update_item` would need a revision read for a field that is replaced whole); identical list writes no commit |
| `set_tags_many(items: [{id, tags}])` | Sets the whole tag lists of many items in one commit, for backfilling the 缺标签 check | Each entry checked as `set_tags` checks it, naming the entry it refuses; one refused entry refuses the whole write; each item once; entries whose list is unchanged write nothing, and no commit is made when none changes |
| `set_difficulty(id, difficulty, reason)` | Sets the item's difficulty (1–5) and appends the log line for the change | The architect for an item of any project, an engineer's credential for the items below the one it was started on (`item.difficulty` at the scope `below`: the root itself is refused), nobody else; a work item, not a record; `reason` nonempty, also for the first rating; no revision (a whole-field write like `set_tags`); an unchanged value writes no commit |
| `set_difficulty_many(items: [{id, difficulty, reason?}], reason?)` | Sets many items' difficulty in one commit, for rating a backlog of unrated items | Each entry checked and logged as `set_difficulty` does, naming the entry it refuses; `reason` is the default for entries without their own, and an entry with neither is refused; one refused entry refuses the whole write; each item once; unchanged entries write nothing, and no commit is made when none changes |
| `tags(project?)` | Lists the vocabulary with meanings and project limits; `brief` also lists the tags for its project | |
| `set_tag(name, meaning, projects?)` | Adds a tag or changes its meaning or projects (`null` projects: every project) | Only `Architect`, after the owner approves on a decision card (process rule, not enforced); configured projects; narrowing refused while an item of an excluded project carries the tag |
| `rename_tag(name, to)` | Renames a tag in the vocabulary and on every carrying item, with a log line on each, in one commit | Only `Architect`; `to` unused |
| `remove_tag(name, replace?)` | Removes a tag | Only `Architect`; refused while any item carries it unless `replace` names another tag applicable to all their projects, which they then receive in the same commit |
| `append_log(id, text)` | Adds a log entry with the server's time | Text nonempty, no reserved headings |
| `dispatch_start(id, role, level, model, effort?, agent, agentId, worktree?, startedAt?, did?)` | Issues the session's credential (answered once, only its hash kept) and records a session started on the item and appends `起：会话 …（号 …），角色，N 级 模型，推理强度，工作树，时间` to its log. `startedAt` is UTC to the minute or in full, the server's clock when omitted | Project ownership (the author is the item's project, as for `append_log`); `role` and `level` from the fixed options; `agentId` unused anywhere on the board; no revision, a concurrent write is retried |
| `dispatch_finish(id, agentId, result, usage, cost, reports?, kickbacks?, rounds?, waited?, signals?, note?, endedAt?, replace?)` | Completes the dispatch with its result, counts, usage, cost, failure signals and note, and appends `收：…` with every column to the item's log | The `agentId` is on the item (the error lists the item's own); an engineer needs `reports` and `kickbacks` and refuses `rounds`, a review the reverse; `result` and each signal kind from the fixed options, a kind at most once; token counts non-negative integers; `cost` non-negative, rounded to thousandths; `endedAt` not before the start; an ended dispatch is changed only with `replace: true`, which states the whole record again and logs `收（更正）：…` |
| `report_state(id, state, to?, cards?, items?, what?, until?, note?, turns?, cost?, startedAt?)` | Reports the runner's state on an item: it replaces the item's last report, the board stamps `since` and `at`, and a report that changes nothing writes no commit | Only the architect (`item.runner`), and without a credential the session `执行程序`; not a record; `state` one of `running`, `ci`, `ask`, `items`, `run`, `wait`, `ready`, `exception`, `done`; `ask` needs `to` (and `cards` for `owner`), `items` needs `items`, `wait` needs `what` and takes `until` (a UTC time, kept in full), and none carries another's fields; `note` one line of at most 120 characters; `cost` non-negative, rounded to thousandths; `startedAt` not later than the report |
| `journal_entry(text)` | Adds one timed entry to today's architect journal: the record `architect-journal-YYYY-MM-DD` (local date, server clock) under `architect-notes`, created with the 协作流程 tag on the day's first call; the entry goes to the end of its head as `**HH:MM** text` | Only `Architect`; the day's key must not be a non-record item; text nonempty |
| `update_item(id, rev, fields, reason?, accept?)` | Changes title, head, links, `data`, `order` (top items only) or record mode | `rev` is the current one, or none of the fields the write replaces changed since (the answer's `note` says what did); switching record mode needs the current one; a changed title, and turning a cancelled item into a record, only by the architect; a changed head requires `reason`, which becomes a log entry, and is refused when it holds the line a cut `context` answer writes (Lean replies); `record: true` removes all acceptance steps and logs their texts; `record: false` requires `accept` |
| `set_status(id, status, log)` | Cancels a work item (`cancelled`) or undoes a cancellation (`open`), with a log line; every other status is derived from the plan | Only the architect; never records; cancelling refused while an owned row's target is open, naming them; the log line is required |
| `set_pause(author, id, paused, reason?)` | Sets or clears only this item's pause marker; same-project owned descendants inherit it; plan rows stay unchanged; server time and a log entry in one commit | Only the architect, at the owner's request in a comment; reason required when pausing; never records; closed work refuses pausing but an existing inactive marker can be cleared |
| `move_item(id, owner?, after?)` | Changes ownership: removes the item's owned row from its current owner's plan and adds one to `owner`'s plan, inserted before its first acceptance step; a log line on the item and on both owners names the move. Without `owner` the item becomes a top item of its project | Same project; no cycle (the new owner is not the item or below it); without `owner`, the move is refused when an open item of the same project still waits on it through a shared row, naming them |
| `move_item_project(id, project)` | Moves the item and every item it owns, at any depth and in any state, to another project in one commit: each gets the new `group` and a log line. An owned row to a moved item in the plan of an item left behind (the item's owner, a backlog record included) becomes a shared row in the same place, with a log line on that owner. The item arrives as a top item of the new project. Key, number, history, notes and cards stay with it | Only the architect, before any ownership check; the project is configured and differs from the item's; every moved item belongs to that project and none is owned across projects (the existing 跨项目拥有 check, named); every tag of a moved item applies to the new project; refused, naming the items and the way out, while the move would leave an open waiter and no owner in the new project: an open item of the new project waits on the item through a shared row, or a moved item's plan holds a shared row to a top item of the new project that nothing owns (the existing 同项目有条目在等它，却没有条目拥有它 check, read after the write; a violation that was already there does not stop the move); work leaving a paused chain is allowed, because the architect can resume it |
| `clear_ask(id, log)` | Removes a legacy ask after the project has replaced it with a decision card or settled it | Every owner wait is a decision card with options; a yes or no uses option A (do it) and option B (don't). Agents cannot create new asks |
| `write_card(key, item, question, kind, options, confidence, blocks?, before?, after?, rev?)` | Adds an open decision card, or revises an open card; `kind` is `design`, `inquiry` or `rule`; `options` are `{text, detail, recommended?}` (the board assigns the keys); `confidence` is `{score?, reason}`; `blocks` makes it blocking and gives it a row in the item's plan (set it only when named work cannot proceed until the owner rules; `null` on a revision clears it and removes the row) | Item exists and does not change on a revision; one-line question; one to 26 options, each with a one-line name of at most 20 characters and a detail, at most one recommended; confidence and `kind` required on a new card (a revision that omits `kind` keeps it); `blocks` nonempty; `rev` required to revise; `before` and `after` only when a card starts to block, and then it and its row are one commit |
| `rule_card(key, choice?, ruling?)` | Records a decision the owner made outside the page, for example in chat: the option chosen, the owner's words, or both | At least one of them; choice is an option key; the card is open. A pick sent on the page is recorded by the board when it is sent |
| `withdraw_card(key, log)` | Closes an open card nobody needs; the reason goes to the item's log | The card is open |
| `reply_note(id, reply, replace?)` | Answers a note, stamps `repliedAt`, marks it done | An existing reply requires explicit replacement, and `replace` replaces only the reply the same author wrote; another author's is refused, unless the writer is the architect, who runs the process and replaces any reply, an old one with no author recorded and a retired author's included. An author is a project name, so two engineers of one project can replace each other's replies; their trees rarely cross, and recording the session would change the data format |
| `create_project(name, repo?)` | Configures a project; accepts any author string | Unique project name; `after` only by the architect |
| `update_project(name, repo?, mainline?, after?)` | Sets or changes a project’s repository, its main line branch (`null` clears it) or its place in the page order | Repository and main line: author is that project or the architect; the main line has no whitespace; order: only the architect |
| `close_note(id, log)` | Closes a note and records handling in its item's log | Author is the note target’s project; not draft |
| `set_term(term, definition)` | Adds or replaces a term in the author's own glossary | Author is a configured project; term one line without surrounding spaces; definition nonempty. The description asks for words the project coined and uses repeatedly, not industry-standard terms, never in place of describing the phenomenon in plain words |
| `delete_term(term)` | Removes a term from the author's own glossary | The term is in it |
| `send_message(to, text, item?)` | Sends a message from the caller's session (section 8, Messages) | A session name; `to` the architect's session, a session with an open dispatch, or a long-lived credential's session, else refused naming those that work; `text` one line of at most 150 characters, refused, never cut, when longer; `item` exists |

## 7. The page

The current template is kept. Its data layer, `window.claude.use("db")` and
`window.claude.use("comments")`, is replaced by a small client that loads a
snapshot from `/api/snapshot`, applies changes from `/api/events`, and shows the owner's notices as
`owner` events on the same stream; it posts the owner's notes and reads to
`/api/...`. The rules module
moves out of the page into `src/rules.ts` and is loaded by both.

The page shows two columns while an item is selected. With no selected item,
the right column and divider collapse and the tree uses the full width.
Selecting an item opens its detail again at the last dragged column width;
there is no layout toggle, and viewport width never changes whether detail is open.
It uses the full window with compact tree
margins and equal, smaller detail side padding.
The left column contains the header, summary and
navigation, project groups and filters, and the nested item tree.
The tree hides done and cancelled items by default. A project's 完成 or
取消 filter shows them in their stored ownership positions; 7 天内完成
narrows completed items by age. Every plan row stays visible regardless of
these filters. A plan reference, search result or unread stop opens a hidden
item's detail without changing the filters. Closed items' unread changes,
including card and reply changes, still reach 新 and the navigation stops.
Paused work remains visible by default, with a grey `◌ <number>` status chip,
its own 暂停 filter and a separate paused leaf count. Plan item rows use only
the grey `◌` glyph, distinct from waiting `⏸`. The detail head of open work
offers 暂停 with a small inline reason field, or 恢复 for its own marker.
Inherited pauses name and link their nearest source and show its reason;
resuming a child cannot clear that ancestor. Closed work with an inactive
own marker offers only 恢复, so the owner can also release open descendants
under a record without asking an agent to clear the marker. Records have
no pause control.
The detail shows an item's difficulty and tags on their own line directly under
the title: the difficulty first, as a plain outlined chip (「难度 3」)
so it reads apart from the teal tags, then the tags; an item with a difficulty
and no tags still has the line. Tree rows show no difficulty.
Each project's filter row also offers one button per tag applicable to the
project (with the count of its items); selecting tags, any number, keeps the
items carrying any selected tag and their ancestors as dimmed path, as the other
filters do. The page shows nothing special for an untagged item beyond the 缺标签
check tag.
An item's status chip shows its short number (`812`) rather than a status
word: the chip's background and text colour carry the status, and its tooltip
names it (TODO, WIP, BLOCK, DONE, DROP, ◌ PAUSE, 记录). Every item status chip
does this alike: tree rows, the detail header, dependency rows and search
rows. An item not yet numbered shows the status word. A decision card's header
shows its number before the question.
Each item shows only its head row: fold toggle, status, title, its
tags as small neutral grey chips (never a status colour; the tooltip is the tag's meaning),

new-content count, owner-wait counts and leaf counts. Clicking the row selects the item and
highlights it without changing its sub-item fold; the ▸/▾ toggle folds only
sub-items. Split tree titles, badges and counts use one smaller text size.
A tree row's right-hand counts show only open parts (todo, idle, in progress,
blocked, paused); done and cancelled parts are not counted there, and a cancelled
item shows no check tags. Each tree row stays on one line: caret, status, title, chips
and counts. The tree draws each item's owned items under it in plan order
(section 5, Item plans); a shared row draws nothing. An item that owns work
items counts, at the right of its row, its owned descendants that own no work
items; the counts leave out cancelled ones and
show numbers in their status color, with status names in accessibility labels. They shrink and clip away
completely before the title truncates with an ellipsis, retaining a minimum width of 6ch and
a full-title tooltip. New-content and owner-action chips remain visible.
The send box remains available.

In tree rows, the blue new-content chip, the filled dark purple chip (blocking
waits in the item and below it, asks included) and the filled dark red chip
(waiting cards without `blocks`, in the item and below it) show only their
numbers; a chip whose count is 0 is absent. Their tooltips and
accessibility labels retain their full meaning, and a purple or red chip leads
to the first such wait. The purple differs from the light-purple 卡住 status
styling, which is unchanged.
Every 新 chip shows only its number, including detail headlines and cards.
The existing ☰ menu help states which shortcuts require a selection and explains
only the blue new-content number, the purple and red wait numbers and
right-side status-colored leaf counts alongside its keyboard actions.

A card's header tag is a purple 阻塞 (tooltip: its `blocks` text) for a
blocking card and a red 决策卡 otherwise; an item's ask row carries 阻塞.

The summary groups three concerns into separate rows. The unread row has no visible label.
Row 1: purple 阻塞 N › (blocking waits, asks included) and red 决策卡 M ›
(waiting cards without `blocks`), each hidden at 0, followed by the existing
等你 panel. Row 2: blue 新 N ›, a thin vertical divider using the theme's rule color,
then 进展, 其他 and 评论回复, each hidden at 0 unless selected, then 清除筛选
(only while a filter is on) and 全部已阅. Controls wrap as width requires.
The divider is decorative and appears only between 新 and following controls.
Progress means plan-row and target changes; logs do not count as new.
Row 3: 全部折叠, 展开第一层, the status legend and the per-project links.
The arrow keys, 阻塞 and 决策卡 walk the waits blocking first.

The 等你 panel sits under row 1 and shows only while a blocking wait exists:
one row per blocking card or ask with a purple dot, the project, the `blocks`
(or ask) text and the shortened card question, ordered by how long it has waited (card creation time; an ask's item update
time). A click jumps like the `/` search and remembers the place for Back. A
line 另有 M 张决策卡不挡工作 follows when M > 0.

There is no sticky path bar. Navigation and visibility checks use the viewport
top, and jumps leave only the ordinary 8-pixel edge gap without reserving space
or scroll margins for a bar. The existing send-box top button remains.

A vertical divider resizes the left column with pointer dragging. Its width is saved per viewer in browser
localStorage. At desktop widths, the tree retains a minimum width of 300 CSS
pixels and detail 380. In viewports of 704 CSS pixels or less, both columns
shrink equally to fit without horizontal page scrolling; header controls and
project links wrap.

The right column is sticky, fills the viewport height and scrolls independently.
It shows the selected item's head row with the same marks and chip, followed
by the order given in section 5 under "How the page shows a plan": the
目标, 计划和进展, head text with its cards and data,
被依赖, the comment entry and comment list, collapsed 日志, ask, checks and refs. 被依赖 leaves out cancelled items. Clicking blank space clears both
the tree highlight and the detail selection and collapses the right column.
Clicks on controls or the divider and drags that select text preserve selection.
All change marks, fresh lines, notes and
replies retain their meanings. Selection inside the detail column retains
the existing item, log, card and note selection keys and actions; a plan
row is selectable as a dependency row was (`row:<item>@<row id>`), and
comments on a selected row go to the item without an anchor.
The selected item is saved per viewer in browser localStorage and restored
when it still exists; unavailable storage does not prevent using the page.

The blocks of the right column (the head text, the log, comments, the ask, cards, checks, the dependency lists and the
comment field) set no maximum width: each is as wide as the column, so a wide window is used whole. A cap in
characters would keep lines short but leave the right of a wide window empty, which the owner ruled out.

Enter on a focused head selects its item; j/k move focus without opening detail.
Reading requires a current selection or a selected detail item;
with neither, it reads nothing. Comment and explain actions fall
back to the selected detail item or the top visible tree row. After clearing
selection, j/k followed by Enter or an unread/wait jump opens detail again.

`n`, `N` and 新 chips select the stop's item and open its detail. When its
tree node is visible, they unfold its ancestors and bring that row into view;
closed-item stops do not change the filters or require a tree node. They then
scroll the right column to the exact fresh mark, card or note. Dependency links,
Backspace/`[` and the 下一条 walk through the waits also select their target item and
show its detail. Tree folding and detail selection are independent.

`m` acts on the item holding the current selection: the item for `it:` and
`log:<item>@<time>`, the card's item for `q:`, the target's item for `note:`.
The same selection works after the 下一条 walk through the waits, a click, `n`, a 新
chip or following a dependency. It reads each of that item's documents' displayed
unread changes, including those hidden by freshness filters, through its
latest unread step, without reading another document or a change arriving
after the action. A selection with nothing unread shows “这里没有新内容”, or,
on an item whose new content is all in its sub-items, how much is there.
The selected item's blue bars, chips and counts clear immediately while
the write is pending and return with a visible error if it fails, using the
same eight-second deadline and no automatic retry as other owner controls.
If a later change joins a pending read's step, that combined step waits for
the server's read result to separate its later unread changes.

In a comment, typing `#` opens a small popup of the items and decision cards
whose title or key contains the text typed after it (ignoring case; up to eight
shown). A key equal to the text comes first, and so does the item or card holding that
number when the text is a number; the other matches follow in board order. Up and down choose, Enter or a click writes a reference token over
`#…`, and Esc closes only the popup. A `#` glued to a word before it, as in
`Repo#341`, starts nothing. The token is `[[it:<key>]]` for an item and
`[[q:<key>]]` for a decision card: the prefix is there because an item and a
card may share a key, and double square brackets begin no other markup in
block text (a link needs `](`). The note keeps the token as typed, so a
session reading it through the MCP tools sees the key. Wherever block text
renders (heads, steps, log entries, comments, replies, cards), a token whose target
exists shows the target's current title as a link; a click selects that item
(for a card, its item with the card shown) and shows its detail. When the
tree node is visible, its ancestors unfold; a hidden closed item opens
without changing filters. Back returns, as with a dependency link. A token
whose target is gone shows its key struck through. Tokens inside code spans or
fenced code stay as typed. When a target's title changes, or a target appears
or goes, and any item, decision card, note or the board goal refers to it, the
page renders again.

`/` anywhere except while typing in a text field opens a search box over every
item and decision card by title or key, matched as in the popup (ignoring case,
substring, any language; `812` or `#812` puts that number's item or card
first, and so does a key equal to the text), done and cancelled ones included. A row shows the
status, the title, the project and the owner item (a card's holding item). Up
and down choose, Enter or a click goes there as for a reference, and Esc or a
click outside closes it.

Choice, approve/done and explain controls show their pending state immediately,
before sending the write, and restore the authoritative state with a visible
error if it fails. `POST /api/draft` sets or clears a target's draft of that
kind in one owner operation: replacing a choice makes one commit, preserving
sent and completed notes. Its response carries the affected draft and deleted
ids so the page can settle its pending state without waiting for live updates.
The affected control stays busy until that write settles. Sending waits for
pending draft writes and stops if one fails, so an immediately displayed choice
cannot be omitted from the send by a slower draft request.

Every displayed unsent note has 编辑 beside 删除. The existing rules for
which notes appear on the page stay the same. Editing replaces its displayed
text with an in-place textarea prefilled from the existing note; 保存 updates that exact
note and 取消 discards the local edit. This includes displayed comments and
explanation requests; the exact-id API supports every draft kind, including
generated answers. The existing action kind and selected option stay fixed; the page keeps their action label and displays edited text.
`POST /api/draft` also accepts the strict edit shape `{id, rev, text}`. It
changes only a draft's text, preserving its id, target, kind, choice, creation
time and anchor. It rejects sent or handled notes, a stale revision, and an
empty or whitespace-only comment. Its response uses the same authoritative
`note`, `deleted` (empty for an edit) and `commit` fields as control writes.
An edit conflict is returned to the page, never retried with a newer revision.

Approve and done notes match a legacy ask by its exact original action text.
The first edit of either kind captures that original text in the optional,
server-owned `answerText`; later edits keep it. Ask matching uses `answerText`
when present and otherwise the stored text. Editing therefore neither changes
which ask was answered nor turns an originally mismatched answer into an
approval. Agent context and sent-note summaries include the original action
text when it is present. Creating a note cannot supply this field. A new
selection through the existing action control resets it to that control's current action.

The editor keeps its typed text and original revision across live updates and
scoped renders. A sent or deleted note closes its editor. While a save is
pending its editor and delete action are disabled; sending waits for that
save and stops if it fails. Edit acknowledgements obey the existing revision
ordering, so a late response cannot overwrite a newer live update. Editing
uses the same eight-second deadline, connection checks and no-retry policy
as other owner writes.

Live changes, unread results and loaded baselines schedule a shared render on
the next animation frame. A 100-millisecond timer runs the callback if the
frame has not fired; whichever runs first cancels the other, and the callback
runs once. When animation frames are unavailable, a zero-delay timer is used.
The same scheduler drives jump animation, so a suspended animation-frame
stream cannot leave navigation waiting indefinitely. Changes arriving before
that callback share one render. Note
changes update their item or card, and an item or card change updates its
affected subtree and summaries; unrelated cards keep their DOM elements.
These same scoped render paths update the selected item's
detail in place and preserve its scroll position. Unrelated changes do not
rebuild the detail column.
A card of the shown item is replaced in place when it changes; a card added to
or removed from the item redraws the item's body, and the plan order moves the
cards without rebuilding the others.
The header counts and send box update with the affected content. Unread
refreshes are debounced across each burst, and superseded results cannot
replace newer state. Rendering preserves the editor's focus and caret and
the reading position.

A draw starts from the rules of the snapshot the page already holds. The page builds
`rules(snapshot)` again only when its input changes: a snapshot, a live change, or the
minute tick (elapsed times move with the clock). A click, a fold, a filter, an unread
mark or a draft's overlay changes the view and keeps them, and the view's own cache, the
indexes a draw reads, is emptied at each draw. What depends on the data alone is kept
until the data changes: the counts on every project's filter buttons are made in one pass
over the board, where each button once passed over it, and each item's part of them is kept,
so a live change counts again only the items it reaches (`affectedItems`) and a snapshot or
the minute counts them all; the page keeps its copy of an item while the item is the same
object; and the cards each head places are
found once for each version of an item (a write makes a new object), so a write does not scan
all the heads again.

What depends only on the rules' structure and on ids is kept in a third cache, the page's
structure, and outlives a live change that reused the rules (the condition of section 4, Write
cost, with the head of every changed item the same as before, because the head places an item's
cards): the order of the items as the tree lists them and the first place of each, the ids of
the items an item owns and of those that wait on it, the ancestors of open work, the counts by
status, the comments of each target, the stops that wait on the owner (an item's pending ask and
its open cards, in the order the item shows them, found from the open cards and the asks and not by
walking every item) and the list of unread stops, which also reads the unread steps and is made
again when the list is another one (the page keeps the array it had when a refresh brings the
same list, so a write that brings no new unread step does not make it again). The caches hold ids,
not items, so a change to an item's text, title or log leaves nothing stale in them. What is
the view's and not the structure's stays out and is applied when the structure is read: a card whose
choice is being sent leaves the stops, and a draft being sent shows as sent among the comments.
Every other live change, a snapshot and the minute make the structure again. A navigation (n, a number on an
item, a link) unfolds the rows above the item, selects it and opens its cards and
comments in one draw, and draws once more when the baselines it needs have loaded. The
rows that first draw paints around the target ask for their own baselines too, and the
navigation waits for those with its own, 100 ms at most: their marks then come in that
second draw and not one draw for each row. A baseline that is slower than that, or never
comes, holds the landing for 100 ms and draws its row when it arrives. After
the owner marks something read the page asks for the unread list, which carries the new
cursor and the steps still unread, and not for the board, which a read does not change
(15 MB on the live board). After a live change it asks with the version of the list it
holds and splices in what the server says changed (section 4, Write cost). The panel of
work that waits on the owner is drawn again only when its rows' markup changes, and the
whole view is made again when the board changes or a minute passes, not when only the
unread list does: a `set_tags` write, which moves the unread list, otherwise drew the
header twice, the panel and the whole view each time. The page leaves a performance mark for each draw, each build
of the rules, each build that derived them from scratch, with its reason, each count of
every item's filters, each time the structure is made again, with its reason, and each time
the list of stops that wait on the owner and the list of unread stops are made (`board:render`,
`board:rules`, `board:rules-full`, `board:filter-counts`, `board:structure`, `board:stops`,
`board:fresh-stops`) and clears it at once, so the browser test can count them
(section 11) and a page left open for days piles up nothing.

After a jump, the page holds the target at its landing position through
subsequent renders, including baseline loads and unrelated live changes.
The owner's scrolling, key press or click ends that pin; a new jump establishes
its own target. Programmatic scroll corrections do not end it.

Every page write has an eight-second deadline, including reading the response.
On timeout the page restores the control and shows a banner saying that the
board server did not answer and to refresh. It never automatically retries a
write, because the server may already have applied it. A dropped live-update
connection immediately shows “已和看板服务器断开，正在重连…” and refuses
writes with that message. Reconnection retries every five seconds; writes
resume and the banner clears only after a live connection and a successful
snapshot reload restore the page's current state.

Code blocks. A fence's first info word names its language (` ```wf `, ` ```rust `);
`web/highlight.ts` tokenizes line by line, with no library. `wf` and `whitefoot`
blocks mark comments (`//`), keywords (the lowercase fixed atoms of the Whitefoot
grammar), primitive and capitalized type names, numbers (suffixes such as `7_u64`
included) and strings. Other named languages mark comments (`#` for sh, bash,
yaml, python, toml; `//` for the C-like languages), strings and numbers only. An
unlabeled fence, and an unknown language, is plain, so output, logs and LLVM
attributes stay as written. Highlighting only wraps text in spans, so the text
content is exactly the source. A block of 3 or more lines shows line numbers from 1,
blank and comment lines counted; each line is a span whose CSS counter
`::before` draws the number, so the gutter is neither selectable nor copied.
Blocks of 1 or 2 lines show none. Long lines scroll horizontally. Change
marking wraps whole blocks, and glossary links skip text inside code, so
neither writes markup into a token.

Diagrams. A fence whose language is `mermaid` is drawn as a diagram, in item
heads and log entries alike (`web/mermaid.ts`). `codeBlock` wraps such a block in
`<div class="mermaid-block">` around its ordinary code block, and the page draws
each wrapped block it shows, whichever render put it there: a `MutationObserver`
on the body sees every block added, so a live update that repaints an item draws
its blocks again, from a cache of what the library made of each source (by color
scheme and source), which also keeps a block from showing code for a moment; a copy
from the cache gets ids of its own, since the line markers of a diagram are found by id
and the first copy may sit in a folded section. The
library is mermaid from npm, pinned in `package.json`, bundled as one file,
`web/dist/mermaid.js` (`web/mermaid-entry.ts`, built by `build:web` beside the
page bundle), served at `GET /mermaid.js` with an `ETag` so the browser asks
again and gets a 304 for an unchanged file. The page imports it only when it
first meets a block, so a page that shows no diagram never fetches it and the
main bundle does not carry it. The library runs with `securityLevel: "strict"`:
board text is written by agents, and strict makes the text of a diagram plain
text and leaves out the click handlers that call functions of the page. A drawn
diagram stands in for its code (the code stays in the page, hidden). The page asks the library
for a compact drawing: the classic look (the default look writes a larger padding into every box and draws a
decision as a hexagon about 95 px high), 8 px of padding in a box, and 20 px between boxes and between layers
(`flowchart.nodeSpacing` and `flowchart.rankSpacing`). ELK, the layout the library draws flowcharts and the
state, class and ER diagrams with, does not read those two settings, only dagre does: the library writes
its own gaps into the graph it hands ELK, 40 px between boxes and layers at the top, and in a subgraph 50 px
between boxes and a 30 px straight run before an arrow. The bundled entry (`web/mermaid-entry.ts`) therefore
wraps the call that hands the graph to ELK (`layout` of elkjs, which the library calls once for each diagram).
The wrapper reads the two settings from the configuration in force for that diagram, which is the
page's with the diagram's own frontmatter over it, and sets them as ELK's gaps between boxes and between layers
on the graph and on every subgraph in it; the library's own unscoped name for a subgraph's gap between boxes is
removed, since ELK reads both names as one option and the two values would compete. It also keeps a straight
run of 12 px before an arrowhead (a shorter one leaves the head on a bend; at a total gap of 12 the run was
3 px) and 10 px between lines that run side by side. In the CI's browser the synthetic role chart goes from 3420 to 2406 px high (30% less) and a chart with three lanes from 2477 to 1657 px (33% less), every arrow still entering a box from above (other fonts give other sizes: the study measured 3214 to 2430 and 2443 to 1801). Dagre, which reads the settings, draws the role chart 12% shorter again (2124 px) but 10 of its 28 arrows enter a box from the side. The classic look alone saves 16% (3420 to 2868 px), and ELK's layering and edge-merging settings change the height by at most 4% and some widen the drawing. The
wrapper reaches ELK because the library calls it through elkjs's `layout`; should the library move ELK into a
web worker or leave elkjs, the wrapper stops acting, the gap between layers returns to 40 px and the
browser check fails (the library would then be patched instead). The settings a diagram brings in a frontmatter
block at its start win over the page's, as they do wherever mermaid is used: the page does not strip them,
and a block that asks for 60 px gets 60. A state, class or ER diagram is drawn by ELK too and takes the same
two settings of `flowchart`, not its own; a diagram that asks for `layout: dagre` keeps dagre, which reads them. A sequence diagram is not drawn by
ELK and keeps its own spacing. Its width on the page
is the smaller of its own width and the width of the text, times the zoom, set in CSS from the
width of the drawing: a diagram wider than the text is shrunk to it and never enlarged by fitting,
nothing is measured by script, and the page never scrolls sideways. The height follows the width; a tall
diagram makes the page scroll instead of being squeezed into the window, where its text would
shrink until it could not be read. A narrow one is centered. A drawn diagram sits in a frame, and
its toolbar is the top row of the frame, above the diagram, so it never covers the diagram. From
the left: smaller, the size as a percentage of the diagram's own width, larger, 适应宽度 (back to
the default size, which is the diagram's own width or the box's, whichever is less), then 60%, 90% and
100%, each a share of the diagram's own width (100% is the diagram at its own size, so a diagram wider than a
narrow box scrolls sideways in it; the size shown is pressed, and pressed again it gives the width of the box back), and at the right a hint, 双指缩放，拖动或滚动查看, shown at every size. A diagram zooms with Ctrl and the
wheel too, about the cursor (Chromium sends a pinch on a trackpad as Ctrl and the wheel; other
browsers are not checked). The plain wheel is left alone and scrolls the page.
An enlarged diagram wider than its box scrolls sideways in the box, which keeps a scroll
bar of its own (the system's hides itself when idle, so a diagram that went past its box looked
cut off), shows a grabbing hand and shades the side that has more to show,
along the whole height of the diagram (the scroll bar of a tall diagram is far below the part on
the screen); a mouse drags it sideways in the box and up or down along the page. The box never scrolls vertically, so the wheel is never taken by it.
Zoom and sideways scroll are kept per source: a diagram drawn again with the same source (a live
update repaints its item, the page changes theme) keeps its view, and one whose source changed
starts at the default size. The detail pane draws the diagrams it already has as soon as it is
repainted, before it restores its scroll position, so that position is not cut short by the
code a diagram stands in for. A block that
does not parse keeps showing its code with the library's error under it, and the
other blocks and the rest of the page are untouched. The diagrams use the
library's `dark` theme when the page shows its dark colors (the owner's
`data-theme` attribute on the root element, else the system's) and `default` otherwise,
and are drawn again when either changes.

Glossary links. In item heads, steps and log entries, card questions, option names
and details, a card's ruling and legacy text, and note texts and replies, a glossary
term links to its definition. The page has no glossary section. Titles are not linked. Terms
match as plain substrings, the longest at each position; the text's own
project's glossary wins over another project's for the same term. Text inside
code, code blocks and links is never matched. Only the first occurrence of each
term in one text links: an item's head, steps and its shown log, in display order, are
one text, and each card and each note with its reply is its own. A link click
acts before the clicked element's own handlers, so a term in an option chooses
nothing; it opens a popover beside the link with the term in bold and its
definition from the glossary of the project named in the link. The page does
not scroll or navigate. A click anywhere else, Escape, a scroll or a click on
another term closes the popover; only one is open at a time. A glossary change
re-renders the page.

The plan, its rows, groups and mock-up are specified in section 5
(How the page shows a plan). Doing-day counts refresh with the page's
existing minute timer without a server write. The 目标 table above the plan
has columns 目标 / 当前 / 目标值 / 比较对象 / 日期. Each row is one goal; the
date shows YYYY-MM-DD. The table is hidden for items without targets and
wraps at phone width. 日志 is collapsed by default for every item, including
items with an empty log.
One click opens the complete history and another closes it. Log entries retain
their existing comment anchors and reference links; manually opening history
does not make it unread.

### Agent list

Above the projects and below the summary, the page lists the programmers the board
sent out (the sessions a dispatch record names) that wrote to the board lately: one
row per session name, then the two items it wrote to last. The owner reads it to see which work has someone on it, at which
level, and whether that someone is working, waiting or has gone quiet.

- **Data.** Only the board's own records: the per-session index of section 5
  (`activity.agents`), the dispatch records on items, and what the runner reports
  to the board: its report on each item it holds (section 5, Runner reports) and
  its beats for the turns running now (The live view of a turn, below). Nothing reads the
  machine the board runs on, and no session reports apart from the writes it
  already makes with its session name; the runner, the one resident program of
  the new agent system, pushes its reports to the board. This is what lets the board run on
  another machine and keep the list; the owner required that. Rejected: asking
  the host for its session list (`claude agents`) or reading its state files,
  which is exact but ties the board to the machine; a reporter process of the
  list's own beside the sessions or hooks that report, which add a process or a Claude Code format
  to keep alive (the runner is not one: it runs the engineers' turns and reports their state already); the item's last writer alone (`activity.sessions`), which
  loses a session's earlier items when another session writes the same item and
  needs the in-progress row to know whose item it is. The dispatch records are
  read because they give the level a session was started at and the time it
  started, before it has written anything (a reviewer may never write).
- **Who is listed.** A session that a dispatch record names (`agent`) and whose
  last activity is at most six hours old. Activity is a write with its session
  name, or the start of that record, whichever is later; a reviewer that only
  reads has a row from its start. The architect's own session is
  left out: on 2026-10-16 the architect's made 521 of the 1158 board writes since
  00:00 UTC and would head the list every time. A name whose newest dispatch
  record has ended is not listed until it writes again more than a minute after
  the recorded end (the end may be recorded to the minute); names are reused (one
  item's study and its implementation are both named after the item), so the
  newest record decides. A session no dispatch record names is not listed,
  whatever it wrote. The board has no PM any more: only the architect and the
  programmers the board sends out work on it, and a dispatch is recorded for each
  of those. What else writes is no such programmer: on 2026-10-18 three of the five
  rows behind 「其他 5 个」 were programs (the board's own, the runner's own, an
  architect turn that had answered ten minutes before), and the other two a name
  used by mistake and an old session. None of them has a dispatch record, so none
  is listed, and no table of program names is kept: a name written by mistake and
  the architect's helper sessions are left out by the same rule. A turn that ends is
  gone from the list, and the one running is drawn under the work that asks it (the
  runner's block). A session the owner started by hand (the observer) is not
  listed either; its writes are in the logs of the items it wrote to.
- **The runner's block.** Above those rows, one row for each piece of work the
  runner holds (`runnerRows`, `src/runner-rows.ts`): an open, unpaused item that
  carries a runner report and has an unfinished engineer dispatch that began with
  it. Their starts are within five minutes of each other (`runnerHolds`): the
  runner records the dispatch and reports in the same breath, so a report left
  from an earlier job does not make a session started on the item later the
  runner's. All the rows are unfolded: the older rule unfolds only a session with a
  dispatch alive within six hours, which would fold a job that waits for the
  owner overnight, and a job waiting for CI, a card or the architect is what the
  owner opens the list to see. The older rows leave out the sessions the runner
  holds, so no session is drawn twice. The whole view is not changed: it answers
  what is left and who has nobody, by item, and the architect reads it too; the
  two repeat a job on purpose. Rejected: folding the runner's rows by the older
  six-hour rule; dropping the whole view's rows that the block repeats, which two
  questions each need; unfolding a report with no dispatch of the runner's job
  behind it, which is a leftover.
- **The runner's table.** The block is a table, a row for each piece of work, so
  that the jobs the runner can hold at once (16 at the owner's current limits, ten
  of level 1 and six above) are as many lines that line up. The columns: the title, with the session's level as a
  small number before it; the state in a word (`stateWord`: 在跑, 等 CI, 等主人,
  等架构师, 等条目, 等 14900K, 等事件, 等合入, 要人看, 待收尾; a beat adds 「第 N 轮」 to
  在跑); one line of what the work does or waits for; how long it has been in that
  state (for a turn running, how long the turn has run); and the time, turns and cost
  since the work began. The stylesheet cuts the title and the line of text to one
  line, and the hover of each says the rest. The owner's list then has no second
  place for the level (the model and effort are on the number's hover), no
  second time (the older cell's 「N 分钟前」 is not drawn), and no key: the
  item's key stands only on the title's hover, and the items a report waits for
  and the cards an ask to the owner names are written as titles and questions,
  with their keys on the hover (`runnerLine`).
  - *The line of text* is the last action of the turn running when the runner
    beats (the engineer's, or the architect's turn for a work that asks the
    architect: 「架构师在答：…」), else the report's note (after the event of a `wait`
    with its wake time, `waitFor`, as after the titles of the items and the questions
    of the cards a report waits for), else for a turn running
    that the runner has not described, 「还没报这一轮的动作」. A beat not
    repeated for 90 seconds reads 「没有动静 N 分钟」 in amber, and the hover keeps
    what it last said. The hover of a turn is its number, how long it has run, how
    long since its last action and the action.
  - *What the list does not show.* A commit id and a path on the machine the runner
    runs on do not stand on the list, in the line of text or on a hover:
    `listText` leaves a commit id (seven to forty hexadecimal digits holding a
    digit and a letter, with the 「提交」 before it) out and shortens a path under
    `~`, an environment variable or a system root to its last name, so
    「看 ~/Library/Logs/wf-board.log 的最后几行」 reads 「看 wf-board.log 的最后几行」.
    The owner cannot use either, and the runner and the engineers write them into
    notes freely; the board's data keeps the text as written, and the whole view
    shows it as written. A path inside the repository (`web/app.ts`), a pull
    request and a run number stay.
  - *The order.* What a person has to look at comes first and is red: an ask to
    the owner and an exception; then the work past the time its state may last
    (`limitOf`, amber); then the turns running; then the waiting ones; the longest
    in their state first within each. The older order put only the late first, so an
    ask to the owner could sit among the quiet waits.
  - *A narrow list.* In a column narrower than 760 px (the tree's column with an
    item open is about 300 px) the five cells fall to three lines of a row: the
    title; the state beside the line of text; the two times. A container query on
    the list's own width decides, not the window's, because one window holds both
    layouts.
  - Rejected: a group for each state, which moves a job to another group at each
    report and so makes a job that is watched jump; the earlier small cards kept
    tidy, which at 16 jobs is 32 lines that do not line up; the item's status
    chip, the arrow that unfolds its sub-items and the link into the tree, which
    the owner reaches by the title and which draw a second status beside the
    runner's.
- **A row.** Name; level; state word; how long ago it wrote (「N 分钟前写过」,
  or 「N 分钟前起」 when the last activity is a dispatch start); its two items.
  The level is the one in the newest dispatch record naming the session, which
  is what it was started at (「审查 3 级」 for a review).
- **State word.** Read from the steps in progress on its two items, never from
  the host. A step with `waits` text: 「在等：」 and that text, whatever the
  time (the text is the session's own); amber when it has not written for over
  an hour, the age at which Claude Code stops an idle session, so the wait may
  be a stopped one. A step in progress without `waits`: 「干活」 within 30
  minutes of its last activity, 「可能停了」 after. No step in progress: no
  word, only the time. A review dispatch gets no word at all: the steps on the
  item it reviews are the engineer's, and a reviewer reads for minutes without
  writing, so any word would claim more than the board knows. The 30 minutes
  come from three hours of 2026-10-16 with 13 sessions, comparing each session's
  status timeline with the board's write times: of 428 moments a session was
  working, 0.2% were more than 30 minutes after its last write (22% more than
  10, 11% more than 15), and the longest gap between two writes of one engineer
  was 25 minutes; waiting for the architect lasted up to 61 minutes. One
  afternoon is a small sample: reopen the threshold if a working session is
  seen silent for longer. The word is
  inferred from declarations, so the list says so on its face and every row
  carries the time since the session wrote.
- **Who is expanded.** Listed is not drawn: on 2026-10-16 at 20:40 UTC the list
  held 37 rows, many of them finished sessions nobody had closed out, and the
  running ones were hard to find. Only running rows are drawn in full; the
  others are one last line, 「其他 N 个」, that opens them in the same order and form
  (the choice is kept in the browser like the list's own fold). The heading
  counts the running rows. A row is running when the session has an unfinished
  dispatch record, of either role, and is alive, meaning it started or wrote
  within the list's window (`liveDispatches`, the reading that rule 6 of Status
  uses for a session working on an item, either role and the same window, not
  the push's holder). So an engineer just started or waiting for the merge with
  every row done, and a review still being read, are running although they
  marked no step, and 「可能停了」 stays expanded, being the exception the owner most
  needs to see. Nothing else makes a row running. A session whose
  dispatch has ended is folded, even when the items it touched have a step in progress: those steps
  are another session's, and its state word is still read from them. A review is
  not given a shorter bound than the window, so a review nobody closed out stays
  expanded until six hours after its last activity, which is when Status stops
  counting its record as a session working on the item too. Rejected: hiding the
  other rows, because a session that finished but was never closed out could
  then not be found, and the owner would not notice the unclosed record; telling
  running by the time since the last write alone, because a session waiting for
  CI or for the architect writes nothing for an hour and is running; inferring
  it from a step in progress on the items it touched, because a session whose
  dispatch ended and that wrote a later log on an item another session holds
  would be taken for running, the board having no way to tell whose step it is;
  a bound of 30 minutes since the last write for a review, because no review run
  was measured, a review writes nothing until its report, and a second
  definition of alive would disagree with Status about the same record; folding
  「可能停了」 with the rest, because it holds a step in progress and is the case the
  list exists to show.
- **Reading a row with the tree.** Each item cell has the status chip and
  number, the title (a click selects the item and shows its detail), the time
  it was touched, an arrow and 「在树中」. The arrow unfolds the item's
  sub-items under the cell as item rows, which unfold further like the tree's.
  The rows of a cell are the tree's item rows drawn under a mount: their
  element ids start with the row's own prefix instead of `it-`, so every lookup
  of a tree row by id still finds only the tree's, and the mount keeps its own
  fold state (`board-agent-open`), so one item folds on its own in the list, in
  another session's row and in the tree. The selection mark and the current
  mark show in the tree only. 「在树中」 is the dependency jump: it remembers
  the place, unfolds the item's ancestors in the tree, scrolls to its row and
  selects it; 返回 goes back to where the list was scrolled to. It is offered
  only when the tree draws a row for the item (a done item drawn nowhere has
  none). The list folds under its heading, and 全部折叠 folds its cells.
- **Staying current.** A change event carries the lists that moved; the list is
  repainted with the same frame as the rest of the page, and only when what it
  shows changed (its inputs are compared). The minute timer that re-derives
  active time also moves the 「N 分钟前」 texts. The page test measures a
  session's write to its row's update against the two seconds the item set.

### The live view of a turn

A turn can run ten minutes and more (an engineer's first turn in the second trial run took 9.5
minutes), and the runner's report on the item changes only when a turn starts or ends,
so the report cannot say whether a running turn is moving. The runner therefore beats: about
every 30 seconds, for each turn whose process runs, it calls `report_live` with the item, the
role (`工程师`, or `架构师` for the architect's turn that answers the engineer's question on
that item), the turn's number, how many seconds it has run, how many seconds since its last
action (the runner reads the session transcript's last change) and the action in one line of at
most 80 characters (for example 「改 web/app.ts」).

- *Memory only.* `LiveStore` (`src/live.ts`) keeps the newest beat for each (role, item) in the
  daemon's memory. A beat makes no commit and writes no file, is lost when the daemon stops and
  is filled again by the next beat, so the page misses at most 30 seconds after a restart. It is
  presence, not a record: nothing is lost that a restart could lose, and the owner's first
  priority, that nothing on the board is lost or silently changed, concerns records. A beat older
  than a day is dropped when the next is stored. The runner sends durations and the board
  counts back from the moment the beat arrives (the same rule as the report's `since`), so the
  runner's clock decides nothing.
- *The writers* are those of `report_state` (the same part, `item.runner`, section 9): the runner
  from its own session, and the architect. The tool is `write` class of the time limits, but
  it does not wait in the write queue, since it commits nothing.
- *To the page.* The event stream sends a `live` event with all the beats when it opens and after
  every beat (a few entries; the page replaces its list). It is not a change of the board: the page
  counts no change, keeps its snapshot and redraws only the agent list, and only when the minutes
  it would show differ.
- *Silent.* A beat that has not been repeated for 90 seconds (three beats) is silent. The
  board cannot tell a stopped runner from a stopped turn, so the row keeps what the runner last
  said and says it has heard nothing for that long, in amber, instead of showing a turn running
  or stopped. The 90 seconds are provisional; reopen them if rows go silent while their turns run.
- Rejected: a commit for each action, since every board write is a git commit and a turn
  makes tens of actions a minute; the runner's report on the item renewed every five minutes,
  which is up to 12 commits an hour for each running turn (about 860 a day with the runner's three
  slots busy, against the 1158 writes the whole board made on 2026-10-16), each waiting in the
  write queue, and an action up to five minutes old, which cannot say whether the turn is moving
  now; the board asking the runner (a port on its machine, or its files), which a board on another
  machine cannot reach; showing only the report, which says 「跑一轮」 for the ten minutes that the
  owner cannot tell a running turn from a stopped one.

### The whole view

Above the agent list, a block of the open work by what is being done about it: the
same five kinds, counts and rows as the architect's `whole_view` (section 6, The whole view),
because the page calls the same `wholeView` function, bundled like `src/agents.ts`.

- *The heading* is a button: `▾ 全貌 · 没做完 N 件`, with the counts of 等太久 and 没人管 when
  they are not zero. It opens and folds the block, and the choice is kept in the browser
  (`localStorage` `board-whole`). The block is folded until the reader opens it, because
  opened it is a screen tall (up to 36 rows) and would push the agent list and the tree down: with
  it open by default, the browser test of the agent list, which expects the list near the top,
  failed. The block is hidden when nothing is open.
- *A kind* lists the rows the tool's default answer lists, and a button at its foot opens it
  to 40 rows and closes it again. A row shows the item's title (a click selects it in the tree),
  its project, what it does or waits for, how long and, for a runner's report, the time, turns and
  cost it has taken. Each pause is one row with the number of items under it and its reason.
- *Time.* The page's one-minute timer redraws the block, and the ages shown are part of what
  decides a redraw, so a page left open shows 「3 小时」 become 「3 小时 1 分」.
- *Not shown.* Items in a backlog and items that a parent's sub-items cover, as in the tool.
- Test layers: `test/dom/whole.test.ts` compares the block's counts with the tool's first line
  on a generated board, runs a report through the server and watches the item move kind,
  and folds and opens the block and a kind.

### Messages list

At the top right of the page, beside the shortcut menu (☰) and fixed there like
it, a button 「消息」 opens the messages agents sent each other (section 8,
Messages) in a list that lies over the page and moves nothing. Each row shows sender（project）→ recipient, the item as a link that
selects it, how long ago, and the text with its inline formatting; the newest
is first. The button counts, as 「新 n」, the messages that came since the list
was last open; the newest message seen is kept in the browser, so a reload
keeps the count. A message joins the list from the change event that carries
it and repaints only the list. The page is sent, with the board, the days of
messages that hold the newest 200 (`PAGE_MESSAGES` in `src/http.ts`), so the page
does not grow with the board's history; `messages` finds older ones.

### Updating the page

The page's live updates carry data, never code, so a page left open through a
deploy would run the old page until it was reloaded by hand. The daemon says
which version of the page it serves in a `page` event on `/api/events`: when a
stream opens, and when a deploy has changed the page files (section 4,
Deploying). The page knows the version it was served as from the `page-version`
meta tag that `GET /` fills in. A page served without a version (the bundle was
being built) never acts on an announcement. The same version changes nothing.

Another version makes the page reload itself (`web/update.ts`):

- At once, unless the owner is writing: a comment box open, a comment typed and
  not saved (also after Esc, which keeps the text), a saved draft being edited,
  or a request to the server in flight. Then a line 「看板已更新」 shows at the
  top, and the page reloads when the writing is done; it looks again every half
  second. Drafts saved but not yet sent are on the server and do not hold the
  reload.
- Before the reload the page keeps in `sessionStorage` where the list and the
  detail were scrolled, and the page that follows scrolls them back once it is
  drawn (a position older than 30 seconds is ignored). The selected item, the
  folds, the open comment lists and the filters are in `localStorage` already.
- A reload toward a version that left the page on another version less than a
  minute ago is not repeated: the line asks for a reload by hand. Without this,
  a page and a daemon that disagree about the version would reload without end.

## 8. Waking sessions

"发给 Claude" posts to `/api/send`. Draft notes become `sent`, and each
sent note produces one `note` event on the wake stream (below). Sending
does not mark a note handled, except a choice that says nothing but its option
and rules its open card in the same commit, which is written `done` (section 5,
Decision cards, Ruling). A note stays `sent` until a project agent replies with
`reply_note` or closes it with `close_note`. Closing stamps the handler and
time and appends `关闭评论：<log>` to the owning item, atomically; it adds no
reply text and refuses draft notes; an existing reply is preserved.

`/api/send` also takes `{ids:[...]}` to send only those drafts, with the same
effects and wake events as the batch send for each; an id that is unknown or
not a draft refuses the whole request and sends nothing. The page uses it for
the "发送" button after a decision card (enabled once the card has a choice
draft, sending that card's drafts) and under a saved draft comment; the send
box still sends every draft.

The page immediately hides a card whose choice is being sent and shows the
affected comments and explain requests as sent, while saving and sending in
the background. Sending still waits for every pending draft save; a failed
save prevents sending. A failed save or send restores the previous controls
and draft text and shows the error; the committed snapshot stays authoritative.

### The wake streams

The board pushes on one stream per recipient. Every agent the board pushes to (a
session holding an item, a reviewer, the observer, and the architect, whose session is named
「架构师」) has its own stream at `/wake/<session name>` (Agents' streams, below), with its
own numbers and retention and a record of how far it was delivered. No stream is the PM's: the
PM is retired (The PM is retired, below). What an agent does with a push, and how it listens, is in
its rules and in the shared rules, section "The board".

**Where a push goes.** The kinds table gives each kind `to`: `architect`, the stream of
the session 「架构师」; `{holder: <field>}`, the stream of the session holding the item that
field names (`only: true` on it: a push for a holder alone, not made when nobody holds the
item; the caller asks `Wake.holds` first and `push` refuses it; `otherwise: "architect"` on it:
the architect's stream instead when nobody holds the item or the field is null); or
`{session: <field>}`, the stream of the session that field names. A session
*holds* an item while an engineer dispatch record on the item (section 5)
names it as `agent` and has not ended; when several have not ended, the newest
start wins, so a takeover holds the item from its start (`holderOf` in
`src/dispatch.ts`). This is not what status calls
someone working on an item (Item plans, Status rule 6): that counts a session of
either role, within a window. The dispatch record is written by the script that starts
the engineer and ended when it is finished, so holding needs no call of the
engineer's own and is never forgotten. Rejected: a claim and a release tool the
engineer calls, which adds two calls an engineer can forget and a second record
that can disagree with the dispatch; inferring the holder from who last wrote an
item with a step in progress (the agent list's inference), which another
session's single write turns to the wrong session.

**What is pushed.** Twelve kinds, defined in one table (`WAKE_KINDS` in
`src/wake.ts`; `push` refuses a kind or field set the table does not list).
Each is something one session has to act on, as the architect's rules and the engineer rules say.
`note`, `timed-architect`, `backup-behind` and `slow-op` go to the architect; `main-red` and
`deployFailed` go to a holder, else to the architect; `dep-merged` goes to the holder of the waiter,
else to the architect; `deployed`, `item-done`, `ask-alive` and `card-ruled` go to a holder alone; and
`message` goes to its recipient:

- an owner note, to the architect: a note becomes `sent`, on any project's item or
  card, so the owner's comments on an engineer's item reach the architect too. Every kind
  of note is one: a comment, an explain request, an approval, a choice on a card. A sent choice
  note also rules its open card in the same commit (see Decision cards), so the
  architect does not rule it afterwards; and a choice that says nothing but its option is
  written handled by that commit, so it is never `sent` and is not pushed as a note: the
  ruling is pushed instead (A card ruled);
- the architect's timed wake (`timed-architect`), every 60 minutes, with what changed
  since the last one and the number of items being worked on, so the architect looks over
  what is in progress once an hour;
- what the look at GitHub finds (Watching GitHub, below): a main line whose
  checks failed (`main-red`). The checks of a pull request are not pushed, a red one or one
  that can merge: an engineer watches its own (The look at the checks, below) and merges
  it once they pass, and a pull request no item names is found by the architect's patrol;
- a page request or tool call that took longer than its time limit (`slow-op`,
  section 4, Time limits), once per operation per hour;
- a remote copy of the board's data that has stayed behind for an hour
  (`backup-behind`; section 4, Storage);
- a deploy result, from the deploy job (section 4, Deploying): `deployed` when
  the checkout moved and the board is healthy on it, `deployFailed` when a
  deploy did not happen. The job asks through `POST /api/wake` (below), and the
  board makes the pushes (Deploys and the red main line, below);
- an item that became done (`item-done`), to the session holding each open item
  that waits on it; when nobody holds that item nothing is pushed;
- an item whose merge row became done (`dep-merged`), to the session holding each open item
  that waits on it by a shared row, and to the architect for one nobody holds (A merge
  a waiter waits on, below);
- a session holding an item that has given no sign of life for 30 minutes
  (`ask-alive`), to that session, unless the runner reports on the item (Liveness, below);
- a message one agent sent another (`message`; Messages, below);
- a card that was ruled (`card-ruled`): an open card became ruled, whether the owner
  sent a choice on the page or a session recorded one with `rule_card`. It goes to
  the session holding the card's item, which may be stopped on the card; when
  nobody holds the item, a pick the owner sent on the page goes to the architect and a
  ruling a session recorded to no one (A card ruled, below).

Not pushed: a blocking card (the owner is told in open pages, below),
an item's ask, any check (the checks are shown on the board and the page, and
whoever acts on one finds it in the whole view), draft-PR CI. The kinds that were pushed to the PM
and are no longer made are in The PM is retired, below. A later kind is one entry in the
table and one row below.

**A card ruled.** The owner's pick on the page used to reach the architect as a `note`
(a sent choice note also rules the card), and the engineer rules had the architect
forward it to the session stopped on the card. One ruling was never forwarded, and
the engineer holding its item stayed stopped for two days. So the board tells that
session itself, from the one place both ways of ruling a card pass: the change in
which an open card becomes ruled, not the note, since a decision recorded with
`rule_card` has no note. A card's plan row stands only in its own item's plan
(section 5, Decision cards), so the session waiting on a card is the one holding its
item. The frame carries the card's key and question, the key and name of the option
chosen and the owner's words, so the line says what was decided without a read of the
board; runs of white space in the question, the option's name and the words are one
space, so the line stays one line.

When nobody holds the item, a pick the owner sent on the page goes to the architect
as the same frame: a pick that says nothing but its option is written handled by the
commit that rules the card (section 5, Decision cards, Ruling), so the `note` that
told the architect of it is never pushed, and without this frame a pick on an item
nobody holds would reach no one. The change is the owner's when its author is
`owner`, which only a page send has. A pick with the owner's words is still a `note`
and its ruling is pushed as well, so the architect has both lines. A ruling a session
recorded was made by a session that knows it, and is pushed to no one when nobody
holds the item. A card that is withdrawn, or written again while open, is not ruled and
pushes nothing. Rejected: leaving it to the architect to forward, which rests on one
session remembering and is what failed; pushing a ruling a session recorded to the architect
when nobody holds the item, which hands it a line it can only pass on, since that session made
the ruling; pushing every pick to the architect
as well as to the holder, which gives the architect a line it can only pass on while the
holder acts, and gives a kind two recipients where the table gives each kind one route;
pushing the owner's note itself to the holder, which would send every comment and explain
request on the item to the engineer before the architect has judged it, and says nothing
of the option chosen.

**Free slots are the architect's to count.** The board holds no limit per pool and pushes no
offer, so no push says a slot is free. The architect compares the working count and the candidates
that `candidates` answers with the limits the owner gave it, and decides whether to start an
engineer. It learns of a slot that frees from the runner's reports (section 5, Runner reports), which the whole view
shows, and reads `candidates` on its patrol and when the owner gives it a new list. No push says that an
engineer's item became done or reached its review step (`finished` and `review` were the PM's, who
stopped and started sessions; The PM is retired, below). Rejected: the board holding the limits and pushing a free slot, which keeps a second
copy of the owner's numbers that can drift from what the owner said; a push naming the next
item, which makes the board choose among the candidates.

**Deploys and the red main line.** A pull request's merge to the main line is made by the
engineer that holds its item, so what the merge did to the main line is told to that
session. The deploy job sends the commits its deploy concerns as `<short hash> <subject>`
with the repository as `Owner/Name`; the look at GitHub reads the subject of the newest commit
of the main line. A subject names a pull request in the forms `Merge pull request #N …` and
`… (#N)` (`pullNumbers` in `src/merges.ts`); the item that delivers it is the item whose
改动 section names that pull request in that repository, done or not, since its session
stays until the runner finishes it (`deliveries`). `deployed` is pushed to each session holding
such an item, one push per pull request and item, and to nobody when none does. `deployFailed` is pushed
the same way and, when no delivering item is held, to the architect, naming the first delivering
item if there is one. `main-red` names the pull request of the main line's newest commit and is pushed
once for each branch and commit, to the session holding the first delivering item, and to the architect
when none does. The job names at most `MAX_CHANGES` commits in a request and counts the rest, so a pull
request only a later commit names of a deploy that carried more gets no push. Rejected: pushing every deploy to the architect (earlier, the PM) to forward, which hands
it a message it can only pass on; telling the engineer of the last commit only, which
misses the others a deploy carried.

**A merge a waiter waits on.** An item that waits on another by a shared row is held up by that item until
it is done, but the work it waits for is often only the item's merge: an engineer stacked on a pull request, or
about to rebase on it, goes on at the merge, while the item stays open until its later steps (the deploy, the live
check) are done, and `item-done` is not pushed before. So a merge row turning done (Watching GitHub, Merge rows;
marked by the look at GitHub or by a session by hand) is pushed as `dep-merged`, once for the change that did it
(`newlyMerged` in `src/merges.ts`, read from the item before and after the write: a row open before and done
after, with the pull requests that counted for it before; a dropped row, a row naming no counted pull request
and an item written new push nothing), to each open, unpaused item with a *shared* row on the item (`dependents`
without `own`), one push for each. A session holding the waiter gets it; when nobody does it goes to the
architect, who starts or hands on the work nobody holds, and an item that is
paused is not told. An owner's row on a part is not a wait: the owner learns of the part at `item-done`, and
an owner that nobody holds would send the architect a line for every merge of every part. `item-done` is
unchanged, and an item whose last row is its merge row produces both pushes. The kind is one entry in the
table, route `{holder: "waiter", otherwise: "architect"}`, and a restart repeats nothing, since a push is made by the write
that turned the row done and is not read from the state. Rejected: pushing only the holders, which leaves an item that nobody holds waiting until the
architect's patrol; telling the owners of the item as well, as above;
pushing at `item-done` only, which is after the point the waiter needed to go on.

**Address.** A client opens a WebSocket to
`ws://127.0.0.1:<port>/wake/<session name>` (the running daemon uses port 7417; Agents'
streams, below). The server answers 404 for any other path, `/wake` itself included (it was
the PM's stream), and 403 unless the `Host` header is `127.0.0.1:<port>` or
`localhost:<port>` and any `Origin` header equals `http://<host>`; a
command-line client sends no `Origin`.

**Pushing from outside.** The deploy job runs in its own process, so it cannot
call `push`; it posts `{event, ...fields}` to `POST /api/wake`. Only a kind the
table gives an `external` list is taken (`deployed` and `deployFailed`), with exactly the
fields that list names, which are not the frame's: `deployed` takes `version`, `previous`,
`changes` (the commits as `<short hash> <subject>`), `restarted` and `repo`
(`Owner/Name`, null when the job cannot read it); `deployFailed` takes `version`, `running`,
`reason`, `changes` and `repo`. The board turns the request into the pushes of the sessions
it concerns (Deploys and the red main line) and answers `{pushed}`, how many it made, which is
0 for a deploy that happened and concerns no held item. The board's own kinds are not taken,
whatever fields come with them. Another kind, a field set that is not exactly the kind's, a body
that is not a JSON object, or more than 16 KiB is refused with 400 and nothing is sent. The
Host and Origin rules are those of every other write, so only a program on this machine can
ask. A request also makes the daemon read the page files again and tell the open pages if
their version changed (section 4, Deploying), whether or not a push was made.

**Frames.** Each event is one text frame holding one JSON object. `n` is its
number, 1 for the first event and rising by 1; `at` is its time. These are all
the forms the server sends:

| Frame | Sent when |
|---|---|
| `{n, at, event:"note", note, target, kind, title, project}` | A note changes from not sent to `sent`; it goes to the architect's stream. A choice that says nothing but its option is written `done` by the commit that rules its card and is not pushed (A card ruled). `note` is its id, `target` is `it:<item>` or `q:<card>`, `kind` is the note's kind (comment, explain, approve, choice, done), `title` is the card's question, else the item's title, else `target` itself, and `project` is the item's project |
| `{n, at, event:"timed-architect", since, changed, working}` | Every 60 minutes after the last one on the architect's stream (the first, after the daemon's start). `since` is the time of the last one, or of the start. `changed` lists the items whose documents, cards or notes changed after the last one, as `{item, project, title, status, by}` where `by` are the writing sessions (or authors, when there is no session); an item only the architect's own session wrote is left out. At most 20 entries, then `{more: n}`. `working` is how many open items outside the Architect project someone holds (status `wip`, with a step of its own being done or a live session; an item that is `wip` only because an item it owns is, is not counted). Nothing else: the lists of open items repeat from one wake to the next, and `list` gives them. The time of the last one is kept in the architect's stream file |
| `{n, at, event:"main-red", repo, project, branch, commit, failed, url, item, pr}` | The newest commit of a configured repository's main line has failed checks and no push was made for this commit. `repo` is `Owner/Name`, `project` the project that owns it, `branch` the main line, `failed` the names of the failed checks, `url` the commit's page. `pr` is the pull request the commit's subject names and `item` the item that delivers it, null when none is found; it goes to the session holding `item`, the architect's when nobody does (Deploys and the red main line) |
| `{n, at, event:"slow-op", op, ms, limitMs, params}` | A page request or tool call took more than its time limit (section 4, Time limits) and this operation was not told in the last hour. `op` is the operation (`GET /api/snapshot`, `tool context`), `ms` its time, `limitMs` its limit, and `params` a one-line summary of its parameters that holds no body text (a search query shows, cut at 60 characters), empty when it has none. A call that is not the first slow one within the hour is only logged. It goes to the architect's stream |
| `{n, at, event:"backup-behind", commits, lastSuccess, reason}` | The board's data has had commits the remote lacks for an hour (the copy was last known current an hour ago, or the daemon started an hour ago and none was confirmed since), and no `backup-behind` was pushed since the copy was last current. `commits` is how many it lacks, `lastSuccess` the time (ISO) the copy was last known current, null if not since the start, and `reason` the last push failure's message, null if none. It goes to the architect's stream |
| `{n, at, event:"deployed", version, restarted, item, project, title, pr}` | The deploy job moved the checkout and the board is healthy on it, and the commits deployed name pull request `pr`, which `item` delivers. One for each such pull request and item that a session holds, to that session; none otherwise. `version` is the commit now served, `restarted` whether the daemon was restarted (`NO_RESTART` in `src/deploy.ts` says which changes need none) |
| `{n, at, event:"deployFailed", version, running, reason, item, project, title, pr}` | A deploy did not happen. `version` is the commit not deployed, or null when the job could not find one out (the fetch failed, or the job itself failed), `running` the commit the board serves once the checkout is back on it, else null, and `reason` says why: the daemon did not come up and the checkout went back, going back did not finish (the job tries again), or the checkout was not moved (another branch, local changes, a commit the main line lacks), the checkout was changed by hand while a deploy was unfinished and the job took over from what it holds, the remote could not be fetched, the checks of the head could not be read or were not finished after an hour, or the job itself failed. `item`, `project`, `title` and `pr` are the pull request the commits not deployed name and the item that delivers it, null when none is found. One for each such pull request and item that a session holds, to that session; when none is held, one to the architect, naming the first |
| `{n, at, event:"item-done", item, project, title, parent}` | An item's status became done (every row done or dropped). One event for each open item `parent` whose plan has a row on it, owned or shared, that a session holds; it goes to the stream of that session, and nothing is pushed for a `parent` nobody holds. `item`, `project` and `title` are the done item's. The set of done items is seeded at start without sending, so a restart announces nothing; an item reopened and done again is announced again |
| `{n, at, event:"dep-merged", item, project, title, prs, waiter}` | A merge row of `item` turned done, whether the board marked it after GitHub reported the pull requests merged or a session did by hand. One event for each open, unpaused item `waiter` with a shared row on `item`; it goes to the stream of the session holding `waiter`, and to the architect's stream when nobody does. `prs` lists the pull requests that counted for the row, as `Owner/Name#N`, and `item`, `project` and `title` are the item whose row turned done. Nothing is pushed for an owner's row, a dropped row, a row that names no counted pull request, or a paused `waiter`. Made by the write that turned the row done, so a restart announces nothing |
| `{n, at, event:"ask-alive", item, project, title, since}` | A session holding `item`, an item in progress, gave no sign of life for 30 minutes (Liveness). It goes to the stream of the session holding `item`. `since` is the time (ISO) its silence began: its last sign, or the first time the board saw it holding an item in progress if later, moved on by the time the board was stopped in between. One per silence, and not made for an item the runner reports on (Liveness) |
| `{n, at, event:"message", message, from, project, to, item, text}` | A message was sent (Messages, below). `message` is its id, `from` the sending session and `project` its project, `to` the receiving session, `item` the item it is about or null, and `text` its whole text. It goes to the stream of `to` |
| `{n, at, event:"card-ruled", card, item, project, title, choice, option, ruling}` | An open card became ruled (the owner sent a choice on the page, or a session recorded one with `rule_card`) and a session holds `item`, the card's item; it goes to that session's stream. When nobody holds the item, a pick the owner sent on the page goes to the architect's stream, and a ruling a session recorded to no one (A card ruled). `card` is the card's key and `title` its question; `choice` is the key of the option chosen and `option` its name, both null when the owner answered in words alone; `ruling` is the owner's words, null when there are none |
| `{event:"connected", latest}` | First on every connection. `latest` is the number of the newest event of the stream, 0 before any |
| `{event:"gap", oldest, latest}` | After `connected`, when events the client was never given were dropped by retention: the stream keeps only its newest events, and `oldest` is the number of the oldest one kept. The client reads the board for what it missed; the kept events that follow are all numbered from `oldest` and none is taken for a repeat |

`connected` and `gap` carry no number and are not events. Every event frame also carries
`line`, the one line the agent is shown for it (Size, below).

**Delivery and reconnect.** Events are numbered and kept on the stream they were pushed to, so numbers continue across
a restart (Agents' streams, below). The server sends `connected`, then `gap` if needed, then every kept
event not yet delivered, then live events, with no event missed or sent twice between replay and live.
The server pings every 25 seconds and closes a socket that did not answer the previous ping; it also
closes a socket with more than 4 MiB of unsent frames. A client reconnects after any close. No call to a
tool is a receipt for a stream as a whole: delivery is what the agent's stream records (below), and the call
that carries the pushes marks only those it showed.

**Agents' streams.** A client opens a WebSocket to
`ws://127.0.0.1:<port>/wake/<session name>`, the name percent-encoded; the
Host and Origin rules are those of Address, above. The server answers 400 for an empty
name, one longer than 80 characters, one holding a slash or a control character,
a name that does not decode, and any query string. The name `PM` is an ordinary name like any other. The board, not the client, keeps how far the stream was
delivered, so the client sends no number: it gets `connected`, then `gap` when
events never delivered were dropped by retention (it reads the board for what
it missed), then every kept event not yet delivered, then live events of this
stream only. Once it has printed the events up to `n`, the client sends the
text frame `{"ack": n}`; from then on they are delivered and never sent again,
on any connection or in any tool result. An ack at or below the delivered
number, above the newest, or not a whole number changes nothing. The frame
`{"alive": true}` is a sign of life of the session (Liveness, below); any other
message is ignored. A client killed between printing and acking gets those
events once more: a repeat, never a loss. An agent's stream keeps its newest
200 events, at most 256 KiB, with the delivered number and the session name, in
`state/wake/<hash>.jsonl`, the hash being the first 32 hex digits of the name's
SHA-256: a name of 80 Chinese characters would be 720 bytes percent-encoded,
past the 255 a file name may hold, and two names that differ only in case would
share one file on a disk that ignores case. Numbers and delivery survive a
restart. A stream with everything delivered, no push or delivery for seven
days, whose session holds no item and has no socket on it, is dropped with its
file; an `ask-alive` left undelivered counts as delivered here, since a call
answers it and a session that died with one pending would otherwise leave its
stream for good.

Rejected, for agents: a per-event receipt the agent sends with a tool call after
handling the event, resending every unanswered event on each connection
(the resource agent's earlier design), because the same event would reach the
agent's context several times and each event would cost a call; the
rule the PM's stream once had, that any call answers everything, because an engineer calls
the board all the time while it works, and would answer events it never saw.

**In a tool result.** A session that is working is not running its wait script,
so the board gives it its undelivered events in the next tool result it gets:
any tool, read or write, whose caller is a session, the architect's
included (the credential's session when the connection has one, else the `session` the
call names, trimmed). After the tool's own text and a blank line come the line
`【看板推送】` and one line per event, oldest first, at most five; more are
counted by kind in one more line and wait for the next call. The events shown
are delivered. A kind the table marks `answeredByCall` (`ask-alive`) is not
shown: the call that would carry it is its answer, so a line would only add to
the agent's context. It counts as delivered, and a wait script prints it. Rejected: waiting for the wait script alone, which leaves an
owner's change of direction unseen through hours of implementation; an inbox
tool the agent must remember to call, which costs a call each time and is
mostly empty.

**Liveness.** The board asks whether a session holding an item in progress is
still there (`src/liveness.ts`, from the server's minute timer). Only an item
whose status is in progress counts: a session holding a paused, done, cancelled
or blocked item is waiting or finished, not silent (a blocked item waits on a
card or another item). The
status is the board's derived one, so what counts as in progress follows it. A
*sign of life* is a call to any tool as that session (the same name the tool
result uses), or an `{"alive": true}` frame from its wait script on its stream.
A connection is none, and neither is its end. A session that gives no sign for
30 minutes is asked: an `ask-alive` goes into its stream, and any sign answers
it. The board goes no further: whether a session that does not answer has stopped is for
the architect's patrol to find in the whole view (section 6, The whole view). A sign ends the
silence; the next one starts over, so one silence is asked once. A session holding no item
in progress (a reviewer, the observer, the holder of a paused item) is not
watched, what the board knew of it is dropped, and its silence starts when it
holds an item in progress. An item the runner reports on (`item.runner`, section 5,
Runner reports) is not watched either: the runner's turns are separate `claude -p` runs with
no session between them, so asking whether their session is there has no meaning, and whether
their work is there is what the report says (the whole view shows it).

The silences are kept in `state/liveness.json` beside the board (git excludes
it), written at every round with the time of the round. A restart counts the
time the board was stopped since its last round as no silence: it is added to the
time every silence is counted from, so a session silent for 20 minutes before a
restart is silent for 20 minutes after it. Restarts, which follow every merge,
thus neither delay nor repeat a push, and an asked silence stays asked until a
sign. Rejected: counting every silence from the restart, which lets restarts
less than 30 minutes apart postpone the ask for good.

The connection of a wait script is no sign, because it outlives its session. On
2026-10-17 a probe held a connection to a copy of the board from a background
command of a session; `claude stop` ended the session at 17:51:40, the probe's
shell was taken over by process 1, and the connection was still open in the copy's
log at 17:53:11, 1.5 minutes after the stop (the session itself was never
idle, since a command was running, so the reclaiming of an idle session was not
observed). So the script sends the alive frame only while the session that
started it is running, at least every 10 minutes (a silence is asked at 30), and
ends when that session is gone; the board counts the frame and not the
connection, so a script that outlives its session, or is an older one that sends
none, makes the session look as silent as it is. Rejected: counting the
connection, which the measurement refutes; counting calls only, which makes a
session that waits on a script call the board by hand every 30 minutes or be
reported; the script calling a tool as the session every 25 minutes, which hands
the script the session's credential and costs a tool call for what one frame says.

The 30 minutes to the ask is a provisional choice. On 2026-10-16, over thirteen sessions at work, a session was
more than 30 minutes past its last board write 0.2 % of the time (15 minutes:
11 %); only writes were counted, and reads now count too. Rejected: 15
minutes, which would flag engineers at work; 60 minutes, which leaves a
stopped session unknown for an hour. Reopen if more than a tenth of the asks of the first
week come while the session was working. A second 30 minutes after which `no-answer` told the
PM is gone with the PM (The PM is retired, below).

**Size.** Whatever the board pushes or returns stays in the receiving agent's
context until it is compacted, so a push to an agent says what needs handling
and leaves the details to a read. Its one line (`lineOf` in `src/wake.ts`) is
the number, the kind's label and what it is about (an item or pull request
with its project, a title, counts instead of lists), at most 200 characters,
cut with … past that; the tests measure it for every kind with the longest
fields. A message's line cuts only what comes before its text (Messages,
below). An event reaches an agent once (above). No push carries a whole list that repeats from one to the next: the
PM's timed wake once carried the lists of every open item of two projects each time, 74% of the characters pushed over a day
(measured on 2026-10-16 and 17: 198,000 of 266,000), and the architect's timed wake carries what changed and a count.

**The architect's stream.** The architect's stream is an agent's like any other, under the
session name 「架构师」: its client is the generic wait script, a push is delivered when the
script printed it or a tool result of the architect's carried it, and a delivered push is not
given again. The owner is told when the architect has not been given a push
for an hour: when the oldest push to the architect still undelivered is one hour old (the limit is an
option for tests), the board tells the owner once, 「架构师 1 小时没响应」, naming that push. The architect
has stopped: its session crashed, waits at a permission prompt, or no longer holds the Monitor that
carries the stream. A delivery starts the count again, and the alert state is in the stream's file, so a
restart neither repeats an alert nor forgets one. No other agent's stream is watched this way:
a session holding an item is watched by the liveness check (above), and the runner's items by its
reports. The time of the architect's last timed wake is kept in the same file. Decision: the architect
uses the agents' stream, the owner's rule that any agent can be reached the same way, one protocol and
one set of state for a recipient. Rejected: a second stream of the kind the PM had for the architect
(a number the client keeps, receipt by any call), which is a second protocol and a second set of state
for one recipient and puts the owner's notes in a stream the architect's calls answer without having
been shown them; pushing each note to both streams, because two receipts for one note leave it unclear who
handled it; the PM forwarding the notes, because it would have to judge which are about content, and that
judgment is the architect's. While a PM ran, the architect's calls also answered the PM's stream, which
hid the PM's silence from the owner; that ended with the PM (The PM is retired, below).

**The architect's sessions.** The owner often has several architect sessions at once: the
conversation the owner talks to, one that tidies old projects, one that works as the observer
(the architect's duty of improving the process), and the turns the runner starts to answer an
engineer. All write as author `Architect` from a session name that starts with `架构师`
(`ARCHITECT_SESSION` in `src/model.ts`): the runner's turns use `架构师轮次`, the others a name of
their own such as `架构师·观察` or `架构师·整理`, which the history and the activity index show
apart. Only the exact name `架构师` belongs to the conversation the owner talks to, and the pushes
are its alone: a second session under that name would be carried the conversation's pushes by its
first tool result and mark them delivered. The rights and the pushes go by different tests. The
rights (section 9) are the architect's for every such name (`isArchitect`, `isArchitectName`, which
ignores spaces around the name); the pushes go by the exact name alone (`isArchitectSession`): the
stream under `架构师` is carried only in a tool result of that session, and the architect's timed
wake leaves out only what the session `架构师` wrote, so the writes of the other names are listed
there: the conversation did not make them. Decision: every session name that starts with `架构师`
has the architect's rights and none of its pushes, because the owner starts a new kind of architect
session now and then and a name is all it needs. Rejected: one name, `架构师轮次`, for every
auxiliary architect, because the board then shows the runner's turns and the owner's other
sessions as one writer, and the name was defined as the runner's; auxiliary sessions without the
architect's rights, writing as ordinary project authors, because they could not create items in
other projects, retitle, or write the architect's log, and the architect would relay every such
write; a narrower role for each kind of auxiliary session, because each new kind needs a table of
its own and each new board operation a decision in every table, and a session name is not
authenticated, so a narrower table guards against a wrong write and not against impersonation; a
role of its own for the turns, with a narrower access table, because a turn does
the architect's whole work (answering, cards, pauses, new items, ratings, the architect's
journal) so the narrower table is the architect's or breaks the next time a part is added; the turns
writing as `架构师` and the board finding another way to keep the pushes, because it needs a name or a
credential to tell the turns apart, which is this decision with an extra layer; the runner
writing the answers itself, because it would translate every judgment write of the architect
and need the architect's rights itself. The names are for the architect alone: a credential of
another role under one, and a dispatch for one, are refused (section 9).

**The owner's notifications.** A decision card that stops work (open, with
`blocks`, newly so or with changed `blocks`) tells the owner, and so does the
alert that the architect's stream is behind. Each notice goes to every open board page, as an `owner`
event on `/api/events`, carrying the title, the message and a target
(`{kind: "card" | "item", key}`, or none). The page shows a browser
notification (Notification API) when the owner allowed notices. The
notification's tag is `card:<key>` or `item:<key>`, or the title when the notice
has no target, so open tabs show one notice for the same card or item. A click
focuses the page and opens the card or item, or the home view when there is no
target. The event is live only: a page that connects later gets nothing from
before its connection, and a reconnect does not replay. A closed page gets
nothing; Web Push is not used. The daemon shows no macOS notification of its own;
the deploy job's notice on the Mac (section 4, Deploying) is the only one that runs `osascript`,
and it runs when the board does not answer.

A card without `blocks` tells no one. The notice that the architect's stream is behind has
as its target the item or card its oldest undelivered push is on, when that is a `note` event; any other
kind names neither, so its notice has no target.

**Why not MCP push.** Plain MCP lets a server send notifications, but Claude
Code does not start a turn in an idle session for them. Claude Code's
*channels* do exactly that (`notifications/claude/channel` from a server
declaring the `claude/channel` capability), but as of 2026-10-11 they are a
research preview: a channel must be a stdio subprocess of the session, and a
custom channel loads only when the session is started from the command line
with `--dangerously-load-development-channels`, which the desktop app's Code
sessions cannot pass. The wake events are therefore defined independently of
transport, so a thin stdio channel that relays `/wake/<session name>` can replace the
Monitor once channels allow it, without changing the server. Until then a
session runs a small client (the wait script) under Monitor, which lasts 30 minutes at most and
is started again: the delivered number the board keeps carries it across the gap.

### Messages

An agent tells another which item to read and what it waits for with a
message through the board, not with a message between sessions: the recipient
gets it whether or not its process is running, and the message stays on the
board, where the owner and later readers find it.

- **Sending.** `send_message(to, text, item?)` adds one message to the end of
  its day's file (section 5) under the caller's session and project, in one
  commit. The
  recipient is the architect's session, a session with an open dispatch of any
  role (an engineer or a review; `openAgents` in `src/dispatch.ts`), or the
  session of a long-lived credential (the observer, the resource agent).
  Another name, the PM's included, is refused with the names that work, so a mistyped name fails at
  once instead of filling a stream nobody reads. The text is one line of at most
  150 characters (`MESSAGE_TEXT_LIMIT` in `src/model.ts`); longer text is
  refused, never cut: a message is a doorbell, and the content belongs on the
  item. Every role may send (part `message.send`, section 9). The board sends too, as
  the session 「看板」 with an item's project: the finished checks of a pull request
  (Watching GitHub, The look at the checks, below).
- **Delivery.** The write pushes one `message` event to the recipient's
  stream: the session's own, the architect's among them. With no
  process connected it waits there, and reaches the session once, on its wait
  script's next connection or in the result of its next board call (The wake
  streams, above).
- **Size.** Its line is the number, 「消息」, the sender with its project and
  the item, cut at 49 characters (`MESSAGE_PREFIX_LIMIT` in `src/wake.ts`), then
  a colon and the whole text: at most 200 characters, the line limit, because
  the text is at most 150.
- **Reading.** `messages(filters)` lists them (section 6). The page shows the
  newest at its top right (section 7, Messages list).
- **No work.** A message changes no item: it starts no active time, moves no
  session's items in the agent list, reaches no check and is not unread for the
  owner. Its write skips the item rules' checks for the same reason.

Rejected: keeping messages only in the recipient's stream (a local state file
outside git), which keeps only the newest few hundred and loses them with the
machine, so the owner's history of messages could not be complete; writing a
message into an item's log, which has no place for a message about no item
(asking for the 14900K, reporting a rule problem) and gives the page no list by
time; 500 characters cut when pushed, because a cut text may lose the item to
read, and the line limit would then not hold; one file per message, because
every file is one more for the board to read at start and for git to check on
every commit: with 50,000 messages (about a year at 140 a day) on a board of the
live one's size, opening took 17.2–17.8 s instead of 5.3–5.4 s and an ordinary
write 153–158 ms instead of 73–76 (three interleaved rounds on a GitHub-hosted
runner, a rough measure; the write benchmark, `scripts/bench-writes.ts
--messages`); archiving old messages into monthly files instead, because it
keeps a second place to read messages from and a job that moves them.

### Watching GitHub

The board looks at GitHub itself and does with the answer what a person would otherwise do by
hand on each round: it tells when the checks went red on the main line, and it marks the merge row of a
merged pull request done (`src/watch.ts`, `src/github.ts`). A second look, every 30 seconds,
tells the engineer when the checks of a pull request have finished (The look at the
checks, below; `src/ci-watch.ts`, `src/ci-source.ts`).

**The look.** Every five minutes, and not oftener, because every session on the
owner's account shares GitHub's quota and every GraphQL question costs some of it (the look at the
checks, below, asks REST conditionally and so can run oftener). The time of the last look is kept in
`state/github-watch.json` beside the board (git excludes it), so a restart waits
out what is left of the interval (no record: it looks at once; a record in the
future, from a clock that went back, counts as at most one interval). The daemon asks
`gh api graphql`, signed in as the owner, one question per configured
repository: the newest commit of the main line with its checks, the open
pull requests (newest 100) with draft state, base branch, newest commit,
mergeability and checks, and, by number, the pull requests the open items'
merge rows name, in any state. A repository that fails, has more open pull
requests than one look reads, or lacks its configured main line branch is
reported by `/health` (`github.problems`) and logged once; the other
repositories go on. `GithubSource` (`src/github.ts`) is the interface the
tests replace.

**Which pull requests.** Those the 改动 section of an open item names
(`changesSection` in `src/rules.ts`). The section starts at a `## 改动` heading,
or at a line that is `**改动**` with or without a colon after it (text after the
colon on that line belongs to it). It ends at the next heading (after a `##`
heading, one of its own level or above, so `### Repo#N` subsections stay inside),
at the next line that is a bold section name alone, or at a line that starts a
参考 section. A pull request is written as
`Owner/Repo#N`, `Repo#N` (a repository a project configures, unique by name) or its
URL; a text that names a repository no project configures names no pull request
the board watches. Pull requests named elsewhere (logs, links, other sections)
are not watched.

**What the checks say.** The board reads the checks on a commit itself, not
GitHub's roll-up state, which counts a cancelled run as a failure (`summarize` in
`src/github.ts`). Every check on the commit counts, whatever event started it: a
repository's real checks may run on push, on pull request or both (Firn-wf,
Halo-wf, Snowghost-wf and Whitefoot run theirs on push, and their pull request
runs are mostly skipped gates), and the same set is read in each case. A check
that failed (failure, timed out, startup failure, action required, an unknown
conclusion, or a status that failed or errored) makes the commit `failure`,
whatever else is still running. Within one round of checks (a check suite: one
workflow run for one event, and its reruns) the attempts at one check, the same
name, count only by the latest, by start time and, at equal time, the worse one,
so a red that a rerun replaced says nothing. Different rounds count each by
itself: the push round and the pull request round of one workflow are two
checks, and a red in either is a red, since the pull request round tests the
branch merged with its target and the push round the branch alone. A cancelled
run, which a newer push replaced, says nothing as long as another run of its
check is in the same round; a check with only cancelled runs in its round has
not run, so the commit is `pending`. Otherwise an unfinished check, or more
checks than one answer holds (100), make it `pending`. Otherwise at least one
successful check makes it `success`; a skipped or neutral check is no failure
and no pass, since a gate that was skipped ran nothing. A commit with no check
to read, or only skipped or neutral ones, is `none`, which is not green: GitHub
runs no pull request check for a pull request with a merge conflict, and a
commit nobody has run yet looks the same. A commit status counts like a check
(`success` passes, `failure` and `error` fail, anything else is pending). The
full CI of a pull request reaches the board only this way: a run started by
hand is not among the checks a pull request lists, so it writes its outcome as
the status `full-ci`, pending until then (section 11, Fast checks while
writing). The deploy job reads the checks of the commit it is about to deploy
the same way, by the commit's id (`ghCommitChecks`; section 4, Deploying).

**The push about checks.** Only `main-red`: the checks of the main line's newest commit say
failure; it goes to the session holding the item that delivers the pull request the commit's
subject names, the architect's when none does (Deploys and the red main line): the red is usually
a combination of merges that only the main line's own checks catch. A push is made once per branch
and commit. The keys of the events still kept are read again at start (`Wake.kept`), so a restart
neither repeats a push nor loses one (an event the log dropped may be told once more).
The checks of a pull request are not pushed, a red one, a draft's, or one that can merge: an engineer
watches its own (The look at the checks, below) and merges it once its checks pass, and a pull
request that no item names is found by the architect's patrol. Both were pushed to the PM (`pr-red`,
`pr-orphan`) and are not made now (The PM is retired, below). The state file `state/github-watch.json`
holds the time of the last look only; an older file also holds the repositories looked at and the
pull requests of the first look, which the pushes about pull requests used and nothing reads now.

**Merge rows.** A merge row is a step of an open item that is not done, not
dropped, not an acceptance step and says 合入 (`isOpenMergeStep`), and that names
a pull request, in the forms above, which the item's own 改动 section names as
well (`mergeRowPulls` in `src/query.ts`). Those are the pull requests that count
for the row. A line that waits for another pull request to merge names it too,
and that one is not the item's own, so it does not count and a line naming only
such pull requests is no merge row. When GitHub reports every pull request that
counts for the row merged (`mergeRowDone`), the board marks the row done and
appends a log entry naming them and their merge times, in one commit, as the
item's project and session 看板. That write (`markMerged`, an operation without
an MCP tool) reads the row as it is by then: a row that was edited, dropped,
removed or already done since the look, or whose counted pull requests are no
longer all merged, is left as written. A row that also says more (a deployment)
is marked as a whole, so a merge row says only the merge. A write that fails is
tried at the next look.

### The look at the checks

An engineer that waits for its pull request's checks should know within seconds
that they have finished, and should not spend the owner's GitHub quota to find out.
The board looks at every pull request an open item names, every 30 seconds, and
tells the session holding the item when the checks on the pull request's newest
commit have all finished (`src/ci-watch.ts`; the requests are `src/ci-source.ts`).

**Why a second look.** The look above asks GraphQL, whose answers cannot be asked
conditionally: every question costs quota, so it stays at five minutes. The REST
API answers a request that carries the `ETag` of an earlier answer with 304
when nothing changed, and a 304 is not counted against the hourly quota (measured
on this board's repository: the quota left stayed the same over 304 answers to the
pull request list, a commit's check runs and its commit status; GitHub's
documentation says the same). So this look uses REST with conditional requests and costs
quota only when something changed. The five-minute look is unchanged: it tells a red main line and marks merge rows. The two do not share state.

**What is asked.** For each pull request that the 改动 section of an open item names
(`watchedPulls`, as in Watching GitHub; draft or not), three requests, signed with the token of
the account `gh` is signed in as (`gh auth token`, read once and again after a 401):
the pull request itself (its newest commit, and whether it is still open: a merged
or closed one is dropped), the commit's check runs (`filter=all`, every attempt of
every round, which the default would cut to the latest run of each name and so hide a red in
one round behind a green of the same name in another) and the commit's statuses (where the full CI that a hand
starts writes `full-ci`, section 11). They are read into the same shape as the GraphQL
look reads, and `readChecks` (`src/github.ts`) gives the same states and failed names. A request that repeats
an earlier one carries the answer's `ETag` in `If-None-Match`, with the same `Accept` header
(GitHub varies its answer on it and answers 200 again otherwise); the answers are kept in memory, at most 400.
Out of quota or told to slow down (429, or 403 with `Retry-After` or no requests left)
the look makes no request until the time GitHub names (a minute when it names none); any other
failure is that request's. A repository that fails is shown by `/health` (`ci.problems`, with
the quota left from the newest answer as `ci.remaining`) and logged once; the other repositories
go on. Up to four pull requests are asked at once.

**When a round is over.** A round is over when nothing on the commit is unfinished:
no check run or status that is not finished, no check with only cancelled runs, and
no more checks than one answer holds (100). The one status not waited for is `full-ci` when
it is pending and links to no run: a mark written on every new commit of a pull request (`ci-mark.yml`,
section 11) that says no full CI was started; the engineer's wait script treats it the same way. Once a
run is started the status links to it, and the round is not over until the run writes its result. A red check does not end it while another
still runs, since the engineer waits for the whole round. A round that ended with
no check that ran (none, or only skipped ones) is told nothing. It ended with `success`, or with `failure` and the names
of the failed checks. It is told once: again when the commit changes, when something is seen
unfinished again (a rerun, or the full CI that a hand starts on the same commit, which writes
the status `full-ci`, pending until its run ends), and when the result differs from the one told
(a rerun that ended between two looks). What was last seen of each pull request, the commit and what
was told for it, is kept in `state/ci-watch.json` beside the board (git excludes it), so a restart
neither tells a round twice nor loses one. A look that is stopped halfway (the board is
restarted) forgets no record of the pull requests it did not reach. The first look at a repository tells nothing of a
round already over (`judge`, baseline): those are the backlog from before the board looked.
A pull request that an item names later, in a repository looked at before, is
news when first seen finished, since the engineer has just opened it. Known limit: a check GitHub
creates only after the first looks of a new commit is not there yet to be waited for, so a
round read as over in the first seconds after a push may be followed by another message when that check ends.

**Who is told.** The session holding the item that names the pull request (section 8, The wake
streams; an item that no session holds tells nobody, and a reviewer holds nothing), by
a message (Messages, above) sent as the session 「看板」 with the item's project and the item
named, one for each holding session. Its text is one line, for example
`CI 跑完：Ming-Research/wf-board#80 提交 bb81c7b 全部通过` or `… 有失败：test、e2e`; names that do not
fit the 150 characters become a count. A message that could not be written is sent again at the
next look to the sessions it did not reach, and only to those (their names are kept in
`state/ci-watch.json` until sent); one the board refuses (the session ended meanwhile) is not.

Rejected: GitHub webhooks, which cannot reach a board that listens on the local address only
without a relay service; the engineer's own wait script, which asks GitHub itself every five minutes
and so waits up to five minutes after the last check and spends the shared quota once per engineer; asking
`gh api` for every request, which starts dozens of processes every 30 seconds and hides the
status code and headers a conditional request needs; the open pull request list of a repository
as one request for every newest commit, which misses a named pull request beyond its first 100 and
saves little; telling at the first red check, which the engineer cannot act on while others run.

### The PM is retired

The PM was the session that opened and closed the engineers' sessions by hand and read what the
board pushed to it. The runner now starts and ends the engineers' turns and reports each item's state
(section 5, Runner reports; section 9, The runner), and the architect looks over the whole board
(section 6, The whole view, The candidates read). What the PM left behind was still in the board: nine kinds of push went to its
stream, the architect's calls counted as receipts for that stream (so its pushes showed as
delivered though nobody read them, and with the architect's conversation closed the hour without a receipt told the
owner of a PM that did not exist), the liveness check asked the sessions of the items the runner works on
whether they were there (the runner's turns are `claude -p` runs with no session between them), and the
name `PM` still wrote every project's items without any check of who used it.

What is kept, now to the architect: `backup-behind` and `slow-op`; `main-red` and `deployFailed` when no
session holds the item that delivered the commit. What is not made any more, with the reason for each:

- `timed`, every 30 minutes with counts and the keys of the reviews and finished items not yet taken up: the
  PM's reminder to look over the board. The architect's hourly wake (`timed-architect`) stays.
- `stalled`, an item gained the 无人推进 check: the check stays on the board, the page and the whole view; nothing
  pushes it.
- `review` (an item's review step went in progress with no reviewer on it) and `finished` (an item a session
  holds became done, which the PM stopped): the PM opened and closed those sessions; the runner does, and an engineer
  resumes its own reviewer. `reviewRequested` in `src/rules.ts` is removed with them.
- `no-answer` (a session asked 30 minutes before gave no sign for 30 more): the whole view shows
  the runner's report on each item, and the architect's patrol finds a session that stopped.
- `pr-red` and `pr-orphan`: the engineer waits for and reads the checks of its own pull request (The look at the
  checks), and the architect's patrol finds a pull request no item names. Of the 121 `pr-orphan` pushes in the record
  when this was studied, 111 were the first look's backlog, all made within 30 milliseconds.

The PM's stream at `/wake`, its file `state/wake.jsonl`, the receipts and the alert 「PM 1 小时没响应」 are
gone; the daemon deletes the file at start, and the upgrade at `/wake` is answered 404. The architect's stream
and its alert (The architect's stream) are as before, and a call to a tool is no receipt for any stream. The
author `PM` is refused like `总管` (section 9); the project `PM` stays configured so that its items and history are
read; the role `PM` is out of the roles, the long-lived roles and the access table; the session name `PM` is an
ordinary name; and `mayRunProcess` is the architect's alone. No long-lived credential of the role `PM` had been issued: when this was done the
credential file's default path did not exist on the machine and the daemon's configuration names no other.

Rejected:
- Pushing `pr-red` and `pr-orphan` to the architect as well: the engineer that waits for the checks of its own pull request
  sees them, so the architect would have nothing to do on receipt, most orphans were drafts or the first look's backlog, and
  the patrol reads the list every hour.
- Pushing all nine kinds to the architect: most were for a session that opened and closed sessions (`review`, `finished`,
  `no-answer`, `timed`), the architect has no action on them, and the lists of the PM's timed wake were 74% of the characters
  pushed in a day, which would fill the architect's context.
- Keeping the identity `PM` and its role after the pushes are gone: the name is not authenticated, so any session could use it to
  write every project's items with no one answerable for it; adding a PM again later costs one identity, less than keeping an
  unowned way in.

## 9. Project responsibility

Responsibility belongs to the project, the existing `group` page heading;
there is no extra item layer. `board.projects` contains unique project names
and an optional repository identifier such as `Ming-Research/Halo-wf`:
`{name, repo?, mainline?}`. `mainline` names the branch merges land on when it
is not the repository's default branch (wf-board's main line is its default
branch `main`, so it sets none); the GitHub watch reads the checks of that
branch, or of the default branch when `mainline` is absent.
Identity is the project itself. Each project has a responsible
agent session started in its repository; several sessions may share that
responsibility and coordinate among themselves. A session's name is recorded
with its writes as an observation, never as ownership (section 6). This model supersedes per-project
agent lists as well as per-item `agent` ownership and child handovers. An
area with an absent or unconfigured group gets a shared rules check; older
boards without `projects` load with an empty list.

At a repository root, a session calls `projects`, picks the project whose
`repo` matches its repository’s GitHub remote (the architect uses `Architect`, from
the session `架构师`), uses that project’s name as `author` in every write, then reads
`brief(project)`. No claim or session registration is needed.
The page displays configured projects in `board.yaml`'s project list order.
`create_project` configures `{name, repo?}` and accepts any author string
when appending the project last. Its optional `after` names an existing
project to place the new project immediately after; only the architect may supply it.
`update_project(author, name, repo?, mainline?, after?)` sets or changes a repository
or main line branch (`mainline: null` clears the branch): a project may change
its own repo and mainline, and the architect may change any project’s. Only
the architect may set `after` to move a project immediately
after another configured project; omitting it preserves the current order.
An unknown `after` or moving a project after itself is refused. An order-only
update needs no `repo` or `mainline`. Ordering is defined in `src/rules.ts`.
Each call combines repository and ordering changes in one data
commit. Both run in the same operations queue as item writes, including
prospective board checks.

Every agent mutation except `create_project` requires a configured project
as author. An unknown author is refused with the configured projects and an
instruction to call `projects` and use the project whose repo matches the
caller’s repository. Item mutations require `author === projectOf(target)` or
the writer is the architect (`author === Architect`, a session name starting `架构师`); this applies to items, their cards and owner-note
replies or closures. Only the architect creates items in any project; an
engineer's credential creates them inside its own subtree (below).
`set_term` and `delete_term` change only the author's own glossary,
`Architect`'s included. Moving work requires the source and destination to
belong to one project, which the author must own unless it is the architect
(`move_item_project` leaves its source project, so only the architect may use
it, section 6), and revising a card’s owning item checks both owners the same
way. A refusal names the item’s project
and directs the caller to report what it needs from the item to the architect. Cross-project
dependency targets remain allowed on a project’s own items. The page’s
owner-note, send and read operations are separate from agent
operations and remain unrestricted. This is how a call that carries no
credential is checked, until the old tools are removed: project names are then
supplied by the callers, and the checks enforce the workflow rather than
authenticate against a caller impersonating another project. A call that
carries a credential is checked as described under *Credentials* below.

The architect's identity is author `Architect` writing from a session whose name starts with
`架构师` (`isArchitect` in `src/model.ts`; `架构师` itself is the conversation the owner talks to,
and every longer name, such as `架构师轮次` of the turns the runner starts to answer an engineer or
`架构师·观察` of an observing architect, has the rights without the pushes, section 8, The
architect's sessions); `mayRunProcess` is the same test. The author name is needed because
it is also a project: `Architect` is the
project of the agents_config repository, and an engineer who does an item there writes as
that project's author, as every project's engineer writes as its project.
Without the session such a write is an ordinary project author's: it may write
that project's own items and nothing reserved. The session name is not
authenticated, as no project name is; the rule stops misuse, not impersonation.
The architect's writes carry `Architect` as commit author and log `by`, so history and logs
show that the architect made the change, not the item's project. The
operations reserved for the process are listed with the tools (section 6); the
check is `onlyProcess` in `src/ops.ts` and what only the architect does is
`onlyArchitect`; project order uses the same judgement as the process in
`src/rules.ts`. The coordinator project `总管` and the project `PM` stay configured, so
their items, glossary and history remain readable, but `run` in `src/ops.ts`,
the one path every agent write takes, refuses any write under either author
(`RETIRED_AUTHORS` in `src/model.ts`) with a message naming `Architect` (session `架构师`), which does the
process and keeps the rules. The session name `PM` is an ordinary name now. Store migrations commit under `总管`
directly and do not pass through it; the historical authors stay as written (section 8, The PM is retired).

**The runner.** The runner is the resident program that starts the engineers' turns and
reports their state on the items (item `runner-mvp`). It has no credential. It calls the board
as the author of the project of the item it touches, from the session `执行程序`
(`RUNNER_SESSION` in `src/model.ts`). Three kinds of its calls and what the board does with them:

- `report_state` is a part of the process (`item.runner`), which without a credential only the
  architect can write, so the runner's reports were refused. The board takes the
  session `执行程序` over no credential for the runner (`isRunner`), and that session may do this
  one part. The name is read only when no credential is carried, as the architect's is; it is
  reserved like it (no credential file entry and no dispatch carries
  it), and it takes no pushes: the board makes no stream for it. Anything else of the
  process (creating, rating, pausing, cancelling, retitling) is still refused to it.
- `dispatch_start` and `dispatch_finish` pass without a credential. They carry no process
  check: without a credential they check the item's project (the author is the item's project,
  as for `append_log`; the tool table in section 6 says so), and over a credential the table
  gives `dispatch.start` to the architect alone and `dispatch.finish` to the architect and the resource agent. They
  should stay as they are for a writer with no credential: an author that writes without a
  credential may already change everything on its own project's items, and a dispatch issues
  a credential limited to the subtree of that one item (below), so nothing is enlarged. When
  the path without a credential is removed, the runner needs a credential for these two.
- `append_log` and `send_message` are any project's author and any session's, as for every
  writer.

Decision: the runner is known by its session name, the same device as the architect's names. Rejected: a role and a credential of its own for the runner, because the
runner stays refused until the owner has issued a token and put it in the runner's
configuration, and the path without a credential would still need a rule for it until that
path is removed (it can be added beside the name, and the two do not conflict); opening the
report to every project author without a credential, because any session could then write a
false state on any item of its project, and the whole view reads it to say what each item
waits for; the architect's credential, because it would carry all the architect's rights for one
part, and the name it carries would take the architect's pushes.

There is no inbox. Work another project needs is not filed into that
project: the session that needs it reports it to the architect, who creates the
item in the project that delivers it and joins it to the needing item by a
shared row. The board once had `create_request` and `triage_request`, which
filed an item into another project's inbox with a `request: {by, at}` marker;
both tools, the marker in the item schema, the inbox rules and the page's inbox
are removed. Items in older commits can still hold the marker. Past commits
are read as written (`show`, `diff`), and `comparisonSnapshot`, which
validates a past commit's whole board with the current schema, drops the
marker, together with the other retired fields listed in the plan conversion
section, and no other unknown field. Live data holding a marker is refused at
start with the schema's own error, so nothing is read and silently discarded.

`projects` reports name, repo, top-item counts and open item status counts.
`brief` supplies sent item/card owner notes, checks including cleared blockers, open cards
still awaiting the owner, items someone is working on (a doing step of their own or a live session),
the next ten items rated 1–5 that `canStart` allows (status todo or idle), in the order of `candidates` (section 6),
outgoing work (the open items of other projects that its open items wait on), and the project's glossary
terms. Relevant item rows include compact plan and target lines, and the
item's difficulty when it has one. `brief.progress` adds
`{id, title, plan?, targets?}` rows for records and blocked items
that are not already represented in the checks, WIP, TODO or
outgoing rows, except blocked items that only wait for their turn in their
owner's plan and that nobody is working on: `brief.queued` counts those per
owner as `{owner, num, title, count}`. It does not repeat those rows or add closed work and the TODO
backlog. The outgoing list holds the open items
targeted by its items’ cross-project shared rows. Read rows, project summaries
and `followups` have no agents field; `list` selects a project through its
`group` filter. The page counts
sent notes per project, such as `已发出 3 条：Halo-wf×2 · Firn-wf×1`.
The page creates no work items: the owner asks for work through notes, which reach
the architect (section 8, The wake streams).

Keys bear on it. The rule that every key starts with its session's prefix
exists so that sessions writing one database never collide. The server now
refuses a duplicate key, so the prefix no longer prevents anything, and after
a handover it names the wrong session: the export holds 236 `old-prefix-*`
items under other sessions' areas and 21 more items whose prefix differs from
their area's session. The owner chose (2026-10-11, option A): new keys need
not carry a session prefix; existing keys stay, because notes and log text
cite them.

### Credentials

Who is writing is told by the connection, not by the caller's own words. A caller
that names its project and session itself can name them wrongly or borrow another's,
and nothing in the call tells. So a request carries a credential, and the board reads
the writer from it.

- **What it protects against.** A wrong name and a borrowed one by mistake. It does not
  protect against an agent on this Mac that reads another agent's configuration on
  purpose: every agent has a shell. The credentials keep the checks honest; they are not a
  boundary between mutually distrusting programs.
- **The credential** is a random token, `wfb_` and 256 bits, sent as `Authorization: Bearer
  <token>`; the board keeps only its SHA-256. Two kinds exist:
  - A *dispatch credential* is issued by `dispatch_start`, answered once, and bound to the
    dispatch record: the session's name (`agent`), its role (`工程师` or `审查`), the item the
    dispatch is recorded on (the root of the subtree the session works on) and that item's
    project. `dispatch_finish` removes it. A session that is stopped and resumed
    keeps its credential, while the dispatch has not ended: a resumed background session
    reads its MCP configuration file again (tested 2026-10-16, Claude Code 2.1.300), so the
    start script puts the credential in that file.
  - A *long-lived credential* belongs to the architect (`架构师`, or a longer name starting with it, such as
    `架构师轮次` for the turns the runner starts), the observer (`观察者`) or the
    resource agent (`资源管理`): session name, role, project and, for the resource agent, the
    records it keeps. Their hashes are in a file outside the data directory (`WF_BOARD_CREDENTIALS`; by default
    `wf-board/credentials.json` in the user's configuration directory), because only the service writes the data directory. The service
    only reads the file, again whenever it changes; `scripts/credential.ts` writes it and
    prints a token once, when it issues one. A file that does not parse refuses every credential that is not a dispatch one, and
    the service log says why.
- **The session names that start with `架构师`, and `执行程序`** are the architect's and the runner's alone: without a
  credential the board takes author `Architect` writing from a session name that starts with `架构师` (`架构师`, `架构师轮次`,
  `架构师·观察`, and so on) for the architect
  (section 6), and skips the process checks for them. A
  file entry of another role under any such name is refused, so is any entry under `执行程序` (the runner has no credential), so is an entry of the architect's role
  under a name that does not start with `架构师` or in another project than `Architect`, and so is `dispatch_start` for an agent whose name starts with `架构师` or is `执行程序`
  (spaces around it are ignored, as everywhere the board compares it). An entry of the role `PM` is refused as a
  role the file does not know (`LONG_LIVED_ROLES` in `src/model.ts`), and `PM` is an ordinary session name. A name that merely contains `架构师`
  (`x架构师`) is an ordinary session name. The credentials of the conversation, of the turns and of the other architect
  sessions are separate entries side by side. With a credential, a
  write is the architect's when the credential's role is, whatever names it carries; what
  the role's session name still decides is the pushes, which only the exact name `架构师` has (section 8,
  The architect's sessions).
- **A request** with no `Authorization` header can read the board; it can write only in the
  old way, naming its author and session, until the old tools are removed. One with an
  invalid header (an unknown token, or a revoked one) is refused on every call, reads
  included, and never falls back to the old way: a revoked session that still names an
  author would otherwise write on. One with a valid credential writes as the credential's
  project and session, whatever it names itself; the call is told when it named another.
- **What each role may write** is one table, `ACCESS` in `src/model.ts`, from role to the
  *parts* of the board a write changes and how far: `board` (any item of any project),
  `subtree` (the items the credential names, with everything they own, and the writer's own
  project's glossary), `below` (a `subtree` without the items the credential names) or `own` (no item, only the writer's own message). `ops.run` takes the parts of every write as an argument, so a write
  cannot omit them, and refuses a part the role lacks before it reads anything; for a
  `subtree` or `below` part it then checks, once the write is complete, that every document it changes
  is inside the subtree. The check covers every document the write changes, the board's own effects on other
  items (an owner's log line, say) as well as what the call names. It also counts what a plan row takes in: a row that owns
  an item puts it under the writer, so a subtree credential may own only items it already
  writes. A write with a `below` part that changes a named item is refused: the engineer was
  handed that item at its level, and the architect changes the level of what it hands out.
  - The architect has every part but `item.merge-row`, on the whole board. No role has
    `item.merge-row`: only the GitHub watch marks a merge row done, and it writes without a
    credential.
  - The observer has every part but the ones only the architect has:
    `project.create`, `tag-vocab`, `journal`, `item.create`, `item.title`, `item.difficulty`,
    `item.cancel`, `item.pause`, `item.move-project`, `item.runner` and starting or ending a dispatch (an engineer has
    `item.create` inside its subtree and `item.difficulty` below its root). It writes items of
    any project, recorded under its credential's project and session.
  - The resource agent writes the log of any item and ends dispatches; it writes the head
    and plan of the records its credential names. This is a first answer, to be revised
    when the resource agent's own design (item `resource-ops-study`) says what it needs.
  - An engineer writes the log, plan, targets, links, cards and glossary terms of its
    subtree, and the head of its items, which is the whole body until bodies are stored by
    section (item `mcp-sections`); it narrows to the 改动 section then. It also makes
    the sub-items of its tree (`item.create`), rates the ones below its root
    (`item.difficulty` at `below`), tags them and the root (`item.tags`), and replies to the owner's notes on the subtree's items and cards
    (`note.reply`), replacing only a reply it wrote itself (the architect replaces any); it does not close a note without a reply, rule a card, move an item,
    or write the tag vocabulary. A new item counts as inside the subtree only when an item
    of the subtree owns it, so an engineer cannot make a top item. Without a credential,
    creating an item and rating one stay the architect's alone (the old way, until the
    old tools are removed).
    `write_card` names `card.write`, `item.plan` (a blocking card is also a row of its
    item's plan) and `item.log` (clearing `blocks` on a revision logs the removed row);
    `withdraw_card` names `card.write` and `item.log` (the reason goes to the item's log);
    `rule_card` is `card.rule`, which an engineer lacks.
  - A review writes the log of its subtree.
  - Every role sends messages (`message.send`, section 8, Messages). Its scope is `own`: a
    message changes no item, so no project or subtree bounds it, and it does not make a role
    one that writes any project.
- **Rejected.** Passing the credential in an environment variable: a background session
  does not receive the environment of the command that started it (tested 2026-10-16). A
  per-directory MCP configuration (`claude mcp add --scope local`): it applies to the
  whole repository and its worktrees, so it cannot give each session its own credential
  (tested 2026-10-16, and it redirected other sessions' board connections while it was
  there). Recording the credential per MCP session: the endpoint has no session.

## 10. Migration

1. Convert the export into the file format, keeping every id, in one commit.
   The survey of the export found no broken dependency, cycle, bad timestamp
   or invalid status; the conversion applies these mechanical cleanups:
   - derive projects from top-level area groups in their displayed order,
     without agents; drop every item's `agent`,
     with separate area and child counts in the conversion report;
   - fold `area` into `parent` and `text` into `head`; drop empty strings and
     the ignored status and priority on 17 and 6 parents;
   - turn the 18 bare-string deps (all on done queue items) into entries
     whose why says it was not recorded;
   - add the 2 unfinished sub-items their parents do not list (under
     example-rules and example-proof), with a why taken from the sub-item's
     title;
   - set `updated` to the newest log time on the 5 items where it is missing
     or older; take a ruled card's `ruledAt` from the owner's choice note;
     parse `confidence` into optional score and reason, preserving unscored
     text verbatim and every recorded log author;
   - leave bare `#NNN` references as written: a project's items also cite
     other repositories' pull requests (Snowghost items cite `Whitefoot #348`),
     so the item's project does not name the repository; `prs` reads both
     `Repo#N` and `Repo #N` and reports the rest as repository unknown;
   - give the one item without a title a placeholder title, to be named
     after the migration;
   - move the 50 notes and 49 reads whose target was deleted to
     `import/orphans.json` instead of dropping them.

   The legacy schema's redundant fields are folded as follows: a nonempty
   `parent` wins over `area`, an existing `head` wins over `text`, card `item`
   owns placement instead of item `qs`, and note titles derive from their
   targets. Null note anchors and empty optional strings are omitted. Board
   `updated` and `revision` belong to the replaced artifact store; git history
   replaces them, and `freshSince` participates in read reconstruction instead
   of becoming current board metadata. Reply metadata is retained even when
   no reply text exists. Unknown nonempty fields are refused, not discarded.

   Migration records an as-read checkpoint followed by the current checkpoint.
   Item snapshots restore title, head (or legacy text), data, status, priority
   and dependency signatures; `qs` supplies evidence of which cards existed.
   The latest item snapshot applies even without a newer item update timestamp;
   a later all-read or freshness floor supersedes that snapshot.
   Log entries after the effective read time are excluded. Cards dated after
   their item's read are excluded even if the item itself has not changed.
   Without `at`, a card listed in the snapshot is known to have existed;
   otherwise its earliest update/note time, or export time, supplies the available
   dating evidence. This cannot recover an undated card's actual
   creation time. Card contents and rulings were not snapshotted and stay
   current for cards that remain. Item parent, group, order,
   links, ask and created also stay current; older snapshots leave any missing
   fields current. Note contents stay current except unread replies are hidden using
   target/all read times (the legacy item freshness floor does not read replies).

   Every agent operation checks the prospective board and refuses the newly
   introduced violations that section 5 (Item plans, Checks) marks as
   refused. Existing flags can still receive progress.

   Judgment cleanups go to the responsible sessions as items after the
   migration: 3 asks whose cards are all ruled, 3 done items with an open
   dep, 2 archived items still open, 35 heads holding dated progress, the
   example-queue history (75 done queue entries), the 236 `old-prefix-*`
   backlog items living under other sessions' areas, and 4 near-duplicate
   pairs.
2. Verify the conversion against an oracle independent of the converter: for
   every document of the export, the server's view of it reproduces each
   field.
3. Point the page at the server and check it against the artifact page side
   by side.
4. Rewrite the board sections of `agents_config` (AGENTS.md "Status board",
   coordinator.md) for the new tools, tell every session, and leave the
   artifact as a read-only pointer to the new board.

The project schema remains strict: existing `board.yaml` project entries
with `agents` are refused as unknown fields. Adopting project identity
therefore requires the primary agent to migrate that configuration in one
data commit before loading it with the new server; the server does not
silently discard fields. Historical documents returned by `store.show`
remain exactly as written, including historical session authors and fields.

### Plan conversion

The plan model (section 5, Item plans) replaces `parent`, `deps`, `steps`, the
stored work statuses and the head's completion-condition section. Today's
hierarchy is not a plan: the owner rates it at most 50 out of 100, with topic
groups, own-work sub-items, children kept under an item only to be archived,
and dependencies that were never parts. Turning it mechanically into plans
would freeze that structure under a new name. Conversion therefore has two
phases:

1. **Data conversion**, mechanical and lossless, in one data commit. Its only
   job is to keep every item, log, card, note, target and ordinary step,
   make the new shape valid, and report every status difference
   caused by the approved new derivation rules. Every plan it produces is provisional
   (section 5, Writing plans), and the board flags it 计划待重写.
2. **Plan rewrite**, per project, by the project's session: each plan is
   written again from what the work actually needs, root first, and existing
   items are attached to it, created or cancelled. A plan stops being
   provisional only when a session rewrites it.

**What phase 1 converts.** Counts from a read-only survey of `wf-board-data`
on 2026-10-13; the converter recomputes every number and its report is the
record: 1336 items, of which 186 have children and 91 have no parent; 650 are
done or cancelled (derived status), 55 of them with no parent (34 of those
archived); the owner has archived 356 items; 3 records; 93 items with steps;
281 item dependencies that are not parent links (115 across projects, 166
within a project) and 58 card dependencies; 174 children their parent does not
list in its dependencies (all closed); 58 own-work sub-items (their log says
接过「…」自己的工作); 7 open items whose head has no completion-condition
section (5 of them parents) and 466 closed ones; 10 in-progress leaves with
no doing step; 9 parents whose derived status changes under the new blocked
rule; and one root item of 总管, with 119 closed
children.

**How phase 1 runs.** The converter is a pure function from the old snapshot
to the new snapshot plus a report, in `src/convert-plans.ts`. A dry run on a
copy of the data (a few seconds of Node, no build) prints the report without
writing; after the owner approves the report, the daemon applies the same
function at startup as a store migration in one commit authored by `总管`,
and refuses to start if the data has changed since the approved dry run (the
dry run records the data commit it read). Unread history compares legacy
commits directly and converts only
endpoints spanning the schema change, caching historical documents and
yielding between commits. A legacy status, parent or dependency edit counts
as an `other` change on the edited item, rather than normalized plan progress
on its owner, preserving what the owner saw before plans.
Parsed historical documents are cached up to an estimated 64 MB of heap (and 4096
entries) and one normalized whole-board snapshot is kept, evicting the oldest
insertions so walking old history does not retain every parsed version
indefinitely; a whole-board snapshot is built at most once per request (section 4,
Request budgets).
Normalized page baselines use the same converter;
the conversion itself marks nothing new and is not a history step.
`npm run convert:plans -- --data <copy> --dry-run --report <file>` writes the
report outside the data directory and leaves the copy untouched. The report
records `sourceHead`, the exact data commit. After the owner approves it,
`WF_BOARD_PLAN_CONVERSION_HEAD=<sourceHead>` enables the daemon's startup
migration; the offline CLI accepts `--approved-head <sourceHead>` and the
approved `--report <file>` only with the daemon stopped. Both refuse a changed
data head or unresolved verification failures. Conversion log entries use
the executing caller's real timestamp. The conversion deletes the retired
owner archive field and reports the total number of entries removed, including
ineffective and orphan entries; all other owner state is unchanged. The temporary migration and old-shape
reader stay until conversion and the historical comparison baselines that
need them have finished; raw audit `show` and `diff` remain unchanged.
Older versions can also hold fields that the current schema does not accept:
an item's area short name (`short`) and session (`agent`) and a project's
session names (`agents`), which data-repository migration commits removed,
the removed inbox's `request` marker on an item, and an item's `priority`,
which the migration of section 10 (Clearing the retired priority) removed. Normalizing a historical
whole board omits exactly these named fields, in every shape, before the
schema for that shape reads it, so those versions stay comparable. `show` and
`diff` still return them as written. Any other unknown field still refuses the
old version instead of being dropped, and current reads and writes stay
strict.

**Phase 1 mapping, item by item.**

1. `group` is set on every item to its line's project.
2. The plan is built in this order, and the item is marked
   `provisional: true` (a record too, when it gets any row):
   1. One row per entry of `deps`, in that order, each with `after: []`
      because the old data never recorded order: an item dependency whose
      target's `parent` is this item becomes an owned row, any other item
      dependency a shared row, a card dependency a card row. A target named
      twice gets one row.
   2. One owned row for each child the item does not list in `deps`, with
      `after: []` (report: child not listed).
   3. Existing steps, with their ids, text, states and dates unchanged, in
      their order: the first has `after: []`, preserving its former lack of
      a preceding step; later steps follow the previous step by default.
   4. The acceptance step (below), except on a record.
   Dependency rows precede old steps so a later plan rewrite can make a blocked
   item's first open step wait for them while `after` names only earlier rows.
3. **Whys go to the log.** Rows carry no why (section 5). When an item had
   any dependency whys, the converter appends one log entry listing them, one
   line per dependency in the old order: `转换前的依赖说明：` followed by
   `- 「<target title>」（<key>）：<why>` lines, a card shown by its question.
   Nothing else is written to logs except the stored-priority retirement in
   step 7; status labels never cause fabricated steps or edits to old steps.
4. **Acceptance text.** The head section that the old check recognized (a
   heading, or a bold label at the start of a paragraph, naming 完成条件 or
   怎样算完成) is cut from the head, through the line before the next heading
   or bold-label paragraph, and its body becomes the acceptance text. When
   the head has no such section, the text is the placeholder
   `（转换时没找到完成条件，待补）` on an open item, which raises the check
   验收步骤待补, and `（转换前已结束，当时没写完成条件）` on a closed one,
   which raises nothing. When the recognizer matches more than once, or
   inside a paragraph, the converter leaves the head unchanged, uses the
   placeholder and reports it (report: ambiguous condition); it never picks
   one. Its state is done (dated at the item's last update) when the old
   derived status was done, todo otherwise, including cancelled items so
   reopening still requires acceptance.
5. **Deriving each status.** The new plan determines the status under the
   approved rules. Old ordinary steps keep their states, text, dates and
   sequence; no step is added, promoted, dropped or given new waits just to
   preserve an old status label, and no dependency row is removed for that
   purpose. Every old-versus-new status difference is listed with the item
   id, project, title and cause (for example, an open shared row it waits on
   or a doing step). A difference alone is not a conversion error. The
   independent oracle derives the expected status from the converted plan
   and refuses a mismatch with the current rules' result.
6. Stored `status` values other than `cancelled` are removed, as are
   `parent`, `deps` and `steps`.
7. **Priority.** The converted items carry no priority: the board no longer
   has the field (section 5, Priority), so the conversion neither seeds nor
   compares one, and the report lists no priority differences. Whitefoot-kit,
   总管 and 网站 are migrated in the same commit: every non-root gets the log
   line `迁移到依赖结构：优先级改由依赖它的条目决定，原来写的 PX 不再使用`, as the
   former project migration did; the `migrated` field leaves `board.yaml`.
   Roots get no such line, and the value a root held is not carried over.
8. **Removing archives.** The conversion drops the owner's entire retired
   `archived` field and reports `counts.droppedArchives`, the count of all its
   entries, not just effective archives. Read cursors and read-ahead marks
   survive unchanged. No archive timestamp is advanced and there is no
   before/after archive visibility rule. Already planned data that still has
   the old owner field uses an archive-only conversion: its plans, content,
   item revisions and provisional flags remain unchanged. The owner field
   removal and report enter the same approved commit; a failed commit restores
   the exact original owner sidefile.

**Phase 1 report.** A short Chinese summary comes first: how many items were
converted, how many status differences there are, their causes,
the number of retired archive records dropped and whether all content
survived verification. A separate line flags old wip items with no progress
row for phase-two plan writing, giving the actual counts becoming todo and
blocked instead of treating the whole cause group as todo.
The detailed tables give every status difference, including item
id, project and title; cause groups include
examples. Findings also identify ambiguous completion sections, duplicate
or dangling targets and children not listed by their old parents. The
report is `import/plan-conversion.yaml` in the data repository. Structural
rewrite pointers are left to phase 2, where each project's session judges
what its plan should contain.

**Phase 1 verification.** An oracle independent of the converter checks:
every old parent link is exactly one owned row and every owned row was a
parent link; every old dependency is exactly one row of the same target or a
reported duplicate, with all whys in the one log entry; ordinary steps keep
exact ids, text, states, dates and sequence; heads lose only the acceptance
section; every converted work plan has its one generated acceptance row last, and
all nonempty converted
plan is provisional. It independently derives status from the
converted plans and compares them with the current rules' output, checks
that every difference appears in the report, and verifies every item, card,
note, target and original log by id. Added logs have an exact whitelist;
the retired archive field is absent, its removal count is exact, and all
other owner state is unchanged. Archive-only upgrades preserve the original
`planConversionAt` provenance used to normalize old comparison baselines;
the new report's `at` still records this upgrade's real time. Raw historical
evidence is never rewritten.

**Phase 2: rewriting plans, per project.** The coordinator files one item into
each project, "Every plan of <project> is rewritten from the work it needs".
Its acceptance step: the project has no provisional plan left, and every open
item of the project is either a root, another project's collecting item
or owned by exactly one row, and has an acceptance step that is
not the placeholder. The board shows progress as the number of 待重写 flags
left. The project's session follows this procedure:

1. **Order.** Roots first; then each goal the root's new plan names (the
   items the root owns, such as a release's goals); then each work item those
   plans own, down to items with only steps. A plan is rewritten only after
   its owner's, so ownership is decided from the top. Items not reached from
   any root (stray open top items, the backlog) come last.
2. **Write the plan from the work, not from the old tree.** For the item at
   hand, decide how it will actually be pushed to completion: its acceptance
   step (the number or check that decides it, agreeing with its target
   numbers), then the rows needed to get there, in order, with `after` where
   rows can run in parallel. Apply "When a row becomes its own item" (section
   5) to each row: most become steps; a row that meets the rule becomes an
   item.
3. **Attach existing items.** For each row that is an item, look for an
   existing item that already covers it, wherever it sits in the old tree (in
   this plan's provisional rows, elsewhere in the project, in the backlog).
   Attach it: if it is a provisional owned row of this plan, keep it; if
   another item owns it, take it with `move_item`; if it is a top item, own it
   with the new plan. Create the items no existing item covers with
   `create_item`. Rows that point at another project are shared rows to that
   project's collecting item; when none exists, the session reports it to
   `Architect`, who creates it in that project.
4. **Dispose of what the new plan does not use.** Every open item that was a
   provisional owned row of this plan and is not in the new plan is either
   moved under the item that needs it (`move_item`), moved into the backlog
   record, or cancelled with the reason naming what replaces it, such as
   被「<item>」的计划取代 or 并入「<owner>」的计划 (for an item folded into a
   step by the rule). The server refuses to drop an open owned row, so none is
   lost silently. Closed items the new plan does not attach become closed top
   items when their row is removed; they raise nothing and remain hidden from
   the default tree until the completed/cancelled filter shows them.
5. **Write the plan in one call.** `set_plan` with `rows` writes the whole new
   plan, which clears the provisional mark and logs 重写了计划. The session
   appends a log entry saying in a few lines how the new plan differs from
   the old structure (items attached, created, moved, cancelled).

The old whys in each item's log are material for steps 2 and 3, not rows to
restore. A provisional plan keeps working in the meantime: sessions record
progress on it with single-row upserts, and its status stays
derived from it, so the board stays correct while phase 2 runs.

**Closed items.** Phase 1 converts done and cancelled items like any other:
an existing child remains a provisional owned row in its parent's plan.
Its row state follows the converted child's new derived status; the page
shows every row, including completed and dropped rows. An item without a
parent stays top-level; a closed top item needs no owner and raises no check.
Phase 2 keeps a closed item in a plan only when the new plan attaches it, for
example a finished goal of an open release; every other closed item becomes,
or stays, a closed top item. No history-only owner is created (section
5, open question 3). Closed items stay reachable from plan rows, explicit
filters and unread navigation.

**Report on structure for phase 2.** Alongside the phase 1 report, the dry
run lists, per project, what the rewrite should look at first; these are
pointers, not findings, and phase 2 settles each in passing:

| Kind | What it points at |
|---|---|
| missing condition | open item whose acceptance is the placeholder (7) |
| own-work sub-item | 58 items created only to hold a parent's own work; the rule normally folds them into steps |
| possible topic group | open parent without a completion condition (5) |
| unowned shared | open top item a same-project item waits on through a shared row (2); flagged 同项目有条目在等它，却没有条目拥有它 |
| same-project shared | every shared row within one project (166); the rewrite decides whether each target is a part of the plan, and then owns it, or a shared need |
| record | the 3 records, which keep plans without acceptance steps |

Every work item has an acceptance step from phase 1 on, so 没有计划：至少要有一个
验收步骤 is empty from the first day and stays a refused write.

### Clearing the retired difficulty level

The board refuses to start on an item file that holds the retired level
`architect` (「架构师做」, section 5, Difficulty). The one-time clearing ran on
the live board, in one commit, `clear_architect_level N items`, which left
each such item unrated with one more log line. The command that wrote that
commit is removed. What stays is the omission of the value from old versions in
historical comparison, and unread's reading of the clearing as bookkeeping.

### Clearing the retired priority

The live board's files hold `priority` on every root (section 5, Priority).
`Store.open(dir, { clearPriority: true })` reads those files without the field
and writes one commit, `clear_priority N items`, which rewrites each such file
without it. A board that holds the field and is opened without the option
refuses to start and names the files. The daemon opens with the option, so the
first start after the deploy clears the field by itself (a refusal there would
only make the deploy job roll back) and prints the report to its log: the totals
by value, then one line per item with its key, project and the value it held.
The commit sets no `updated` and adds no log line to the items, so no item looks
changed. The value each item held stays in git history, as the lines the commit
removed, and in that report. The offline command that did the same on a copy is
removed; the live run is the one that counts.

The commit is bookkeeping, not work on the items: historical comparison omits the
field from old versions, so unread shows nothing for it, and activity and the
timed wake leave the commit out, so no item's last-change time or no-progress
clock restarts and the wake lists nothing it wrote. A second start writes
nothing. The command and its test are removed. The module, the start option, the
daemon's use of it, the two checks that leave the commit out of activity and the
timed wake, and the transaction flag (`rewrite`) that lets it write unchanged
documents stay until a later cleanup removes them; what stays for good is the
omission of the field from old versions in historical comparison.

### Owner-wide rules to change

Changes to the owner-wide rules that follow from this design are tracked on
the board.

### Open questions on the conversion

6. **Order of converted dependency rows.** Proceeding on: every converted
   item or card row is `after: []` (all parallel), because the old data never
   said otherwise, while converted steps keep their sequence; phase 2 sets the
   real order. Alternative: convert everything sequentially, which would
   invent an order.
7. **Owner approval of the dry-run report** before the live conversion.
   Proceeding on: yes, as a decision card with the report's counts.
8. **Records and the "every item has a plan" rule.** Proceeding on: records
   are exempt from the acceptance step, since nothing completes them; a
   record without rows raises nothing.
9. **What dropping the why loses.** A shared row into another project no
   longer says, on the row, why the other project needs the item; the
   receiving session reads it from the needed item's head and acceptance step
   and from its first log line. `context` and `graph`
   show titles only, and the old whys live only in logs, which `search`
   still covers. The rule "every dependency carries a why" disappears from
   the server instructions, the operations' checks and CLAUDE.md. Proceeding
   on: accept this, as the owner decided; if a receiving session finds the
   item unclear, it asks with a note or comment, not a row field.
10. **What clears the provisional mark.** Proceeding on: any whole-plan write
    by the session clears it, so a session could clear it by rewriting the
    rows unchanged. The coordinator checks each project's phase 2 item log,
    which must say how each plan changed. Alternative: also require a
    `rewrite` reason argument, stored in the log, on the clearing call.
11. **Cancelling a redundant item another project waits on.** Phase 2 may
    find an item redundant while another project's shared row points at it;
    cancelling it raises 依赖的条目已取消 there. Proceeding on: the procedure
    moves such an item, or keeps it and points the redundant work at it,
    rather than cancelling it; when it must be cancelled, the session tells
    the waiting project's session first.
12. **Unread volume during phase 2.** Each rewrite changes the item, the
    items it moves or cancels and their owners, so the owner's 新 counts
    grow while a project rewrites. Proceeding on: accept it; the owner can
    read a project at a time with the 进展 filter. Alternative: author phase
    2 moves as not unread, which would hide real structural changes.

## 11. Testing

- Unit tests for the rules module, the file format round trip, `rev`
  conflicts, append ordering and every write check, each shown to fail on the
  wrong input it guards against.
- An MCP integration test with the SDK client against a server on a temporary
  data directory.
- The conversion checks of section 10, including the plan conversion's
  oracle, and for the plan rules a case per derived status, per refused
  ownership or cycle write and per check, each failing on the wrong input.
- A derivation equivalence test: after every write of a seeded random
  sequence, the shared and incremental derivations (shared Rules objects, the
  activity index, a write's prospective rules, the page's activity deltas)
  equal a from-scratch `rules` scan, and every item whose painted
  presentation changed is among the affected items.
- The agent list: the per-session index of the last two items, checked in that
  random sequence against a reverse scan of the commits and rebuilt after a
  restart; the rows (window, state words, level, dispatch records and ended
  names) on hand-built snapshots, each boundary on both sides; the page in a
  fake DOM; the page in a DOM library (the list above the projects, 在树中
  selecting the tree's row and 返回 coming back, a cell unfolding in place with
  every tree click still landing, the line of the sessions with no dispatch
  record); and in a real browser where the list lies and how far the jump
  scrolls.
- CI on GitHub-hosted runners: the full CI on each main-line merge and, on a
  pull request, when the engineer starts it (below); the browser file and a
  report of the time of n in a real browser in a workflow of their own
  (`.github/workflows/browser.yml`) on each main-line merge, nightly and by
  hand (below, The browser file); a temporary quick
  workflow for the pushes in between; the benchmarks run by hand as a
  workflow (`.github/workflows/bench.yml`): the write-path benchmark reports and never fails the run,
  and the history-query benchmark fails it when a check fails.
- A private-content check on every pull request and every push to a branch
  (below), in its own workflow.

### Four test layers

The page is tested in four layers. Each catches a class of fault the layer
below cannot see, and a page bug gets its test in the lowest layer that can.

1. **Rules, store and server** (`test/*.test.ts` other than the page test):
   the board rules, the file format, writes and their checks, the HTTP and
   MCP surfaces, each against synthetic fixtures.
2. **The page in a fake DOM** (`test/web.test.ts`): the bundled page runs
   against a hand-written DOM with modeled geometry and a small synthetic
   board. It is fast and checks controls, render scopes and scrolling, but it
   computes no CSS and no real layout, and its fixtures hold few of the real
   board's shapes.
3. **The page in a DOM library** (`test/dom`, run by `npm test`): jsdom runs
   the real page (`test/dom/page.ts` bundles `web/app.ts` as a script and
   evaluates it in a window) against the real server on the generated board
   of layer 4, through Node's real `fetch` and a reader of the real event
   stream, with no browser. A window has no layout, so its boxes are one box
   at the top, nothing is under a point and nothing scrolls; what the page
   decides from positions always says yes. The few checks of style read the
   stylesheet's cascade (`test/dom/styles.ts`: specificity, order,
   inheritance, `var()`, the scheme and width media queries) instead of a
   layout. It runs every check that needs only the page's logic, its DOM
   and the board's rules: the cost of a browser per check is gone, the page's
   own draws cost more than in a browser (the parser and the element
   constructors are JavaScript). Two things it is given for the diagrams: the
   library the page loads by address is answered by a stand-in
   (`test/dom/mermaid-library.ts`; the bundle is built with `import()` turned
   into `require()`, which the window answers, so the page's source is
   untouched), and the diagram boxes are laid out by a small model
   (`test/dom/mermaid-layout.ts`) whose widths are the page's own stylesheet
   evaluated for a box of given width.
4. **The page in a real browser** (`test/e2e/browser.e2e.ts`,
   `npm run test:e2e`, the workflow `browser.yml`): headless Chromium
   (Playwright) loads the real page from the real server (the wiring of
   `src/main.ts`, in process) on a temporary data repository, so the page
   talks to the real API and event stream. It keeps what needs a layout: where
   a box lands, how wide it is, what a browser hides, hit-testing and
   scrolling, and what the real diagram library draws, in one small file that
   runs after a merge and not on a pull request (The browser file, below).

The browser layer exists because five page bugs in one day passed every test of
the first two: saving a comment folded the card's comment list and hid its
send button; the purple and red numbers jumped to another project's card
after unrelated re-renders; a card row in a plan jumped to another item
instead of unfolding in place; a global `code` rule kept code blocks out of
Monaco; an empty pause row sat under every title. None of them shows in a
fake DOM over a small board.

**The board.** `test/e2e/board-gen.ts` generates a board from a seed; no real
text is copied. `test/e2e/shapes.ts` names the structural shape categories,
and `test/board-gen.test.ts` (layer 1) requires every one of them in the
generated board. The categories come from a survey of the real board on
2026-10-13: 1522 items in six projects (574 done, 481 todo, 203 cancelled,
107 blocked, 94 paused of which 87 by inheritance, 56 wip, 7 records);
ownership up to six levels deep, 27 items owning more than ten; 119 items
owned under a record; 272 items named by shared rows, 151 of them across
projects; 707 plans with parallel rows; 596 cards (83 open, 24 open and
blocking), 2 open cards on done items, one on a record; 754 notes (603 on cards, 201 with
replies, 23 anchored); 257 heads with code blocks; 28 tags, every item
tagged. The generated cards have the shape of section 5 (Decision cards),
which the real board has once the card conversion has run: options with a name
and a detail and a confidence; a row in the plan only for a card that blocks (and
for some closed cards that had one); some cards placed in the head, the converted
old cards in a section at its end, and some not placed at all; some ruled by an
option, some in words, some with a nameless option and a legacy background, some
withdrawn. Shapes the real
board lacks today but the schema allows and the page handles (pending asks) are
generated too.
Viewer state is part of the shape: the tests fold comment lists in
localStorage and unfold every tree row.

**The invariants.** `test/dom/checks.ts` (the style ones in
`test/dom/style-checks.ts`) clicks every kind of clickable thing and compares
where the page landed with what the element claims, computed independently
from the stored board with `src/rules.ts` and the server's unread history
(`test/e2e/invariants.ts` holds the oracle and what still needs a browser:
the right column's widths, the layout of a card row in a plan, the visibility
of a folded card, the progress bands and the alignment of the difficulty chip,
in `test/e2e/browser.e2e.ts`):

- a tree row's title selects that item and shows its detail;
- in a plan, an item row goes to its item and 返回 comes back; a card row
  names its question (and the pick once ruled) and goes to that card in the
  body, never drawing it under the row, keeping the selected item; a step row
  selects the step and keeps the item;
- each card shows once in its item's body with its question once, its option
  names and details (the recommended one marked) and its confidence or, once
  closed, one line with its pick and the rest folded under it, its old
  background folded (open on an open card), and at the line of the head that
  places it; a card the head does not place follows the head under a line that
  says so;
- each 被依赖 row goes to its dependent and 返回 comes back;
- the purple and red numbers after a title equal the blocking and other waits
  in the item's owned subtree, and clicking a number as often as it says
  visits each of those waits once, in its own item;
- the header's 阻塞 and 决策卡 numbers and the wait panel cover exactly the
  board's waits;
- each blue number counts the items under it holding unread content and
  leads to one of them; 新 counts the unread units; n reaches every item
  holding unread content and nothing else;
- each project filter's number counts its matches; pressed, the tree shows
  every match undimmed and nothing else of the project undimmed;
- the "/" search lists an item or card first by its short number, and
  choosing it shows it;
- a comment saved on a folded list stays in view with its 发送 button, which
  sends it;
- code blocks are set in Monaco at 13.5px, inner code included; no empty row
  sits under an item's title; tag chips name the item's tags and contrast
  with their background at 4.5:1 or more in both themes (chips in rows the
  page dims on purpose are left out).

Each family runs on a freshly loaded page, then again on one page kept open
while a burst of writes lands on other items before each family (new waits
on the first item in board order, progress, log lines, a ruling, replies, a
new item), so incremental re-renders happen in between. The families run in
several files (`test/dom/page-*.test.ts`), each with a board and a page of its
own and short enough to be dealt out to the shards (the longest of the layer's
13 files takes 27 seconds on a hosted runner, all 13 together 220), so the files
run side by side.

Diagrams are checked in two places. The page's own doing runs in the DOM layer
(`test/dom/mermaid-page.test.ts`, `mermaid-view.test.ts`) against the stand-in library:
a block in a head and one in a log are drawn; a block that does not parse shows its code
and the error while the blocks after it are drawn; the library is asked for when a block is
shown and only once, and with the strict security level and the diagram's text whole; the
diagrams are drawn again after a live update repaints their item; the same diagram drawn
twice, the first copy in a folded section, has no id twice and the visible copy's line
markers are its own; the settings in a diagram's frontmatter reach the library; the diagram
follows the system's color scheme and the `data-theme` attribute over it; a diagram is as wide as itself or
its box, whichever is less, centered when narrow, with nothing to scroll sideways in the box; the
buttons, and Ctrl with the wheel, zoom about a point that stays put, the plain wheel is left
to the page, a zoomed diagram is dragged and 适应宽度 restores the default size; the 60%,
90% and 100% buttons draw it at that share of its own width; the toolbar is the top row of
the diagram's frame with its items in order, the hint at the right and the frame around
it; an enlarged diagram says it can be moved (a scroll bar of its own, the hand, a
shade at the edge with more) and the toolbar and the bar read in both color schemes; a
view survives a live update that leaves the source alone and a changed source starts
at the default size; the page configures the library for a compact drawing (the classic look,
padding 8, gaps of 20). The stand-in is what the page depends on of the library and nothing
more: the same text gives the same drawing, its ids and their references begin with the id
the page gave, text that does not parse is refused, and the frontmatter's theme wins over the
page's. The widths come from the model of the boxes, not from a layout; the model also
clamps a box's scroll to what its `overflow-x` allows. Each check also runs on a page with
the one part it protects taken out by an edit applied while the page is bundled
(`test/dom/mermaid-spoiled.ts`), where it must report the part's absence.

What only the real library and a real layout show stays in
`test/e2e/browser.e2e.ts` (the checks are in `test/e2e/mermaid-checks.ts`): a head's diagram has its Chinese labels and a size, and the library's
error under a bad block; hostile text (a script in a label, a `javascript:` link) leaves nothing
that runs under the strict level; the real library names the ids and line markers so that a
second copy of a diagram has none in common with the first; the settings in a diagram's own
frontmatter win over the page's in the real library; a diagram is as wide as itself or its box at a
window 1500 px wide and at one 700 px wide, with nothing to scroll sideways in the box or the page;
an enlarged diagram can be scrolled to both its ends,
the plain wheel scrolls the page, the 60%, 90% and 100% buttons in a narrow column;
a view and the page's scroll survive a live update; labels and lines read in both color schemes; and a drawing is
compact: a synthetic role chart (28 arrows, 2406 px high against the library's own 3420) and a synthetic chart
with three lanes (17 arrows, 1657 px against 2477) stay under 2500 and 1900 px high; their boxes are as far apart
as the page asked, 20 px (60 px for a chart whose settings block asks for 60); no arrow enters a box from the side
and each runs at least 6 px straight before its head; no edge label covers a box or another label and no line
crosses a box that is not its end (`checkCompact` in `test/e2e/mermaid-compact.ts`, which holds the measurement).
The file keeps no page with a part taken out and no hand-made drawing (the section "The browser file"). A diagram that never appears
can only be observed by waiting, so the wait is short, and the reported line must say what was
waited for and what the page held, not a bare timeout or a page that did not start.

The jump to the next unread change (n) has a lane of its own, on a board of the live board's weight, which runs in
Node and not in the browser: [The n-key lane](#the-n-key-lane).

**Evidence.** Each check runs on the current page, where it must find
nothing, and on the page with the thing it guards spoiled, where it must
report it. The spoiled page is the source text edited as it is bundled
(`test/e2e/variant.ts`), by a literal replacement that removes just the fix,
so no test reads the repository's history. In the DOM layer `test/dom/witnesses.ts`
(run by `witnesses-*.test.ts`) holds one per page check, and each scenario file
(agents, messages, styles, mermaid, changed-blocks, width-caps) its own, each
naming the reason it must fail for; the fixes of the page's update run in the
fake-DOM layer (`test/web.test.ts`, whose `page` takes the fixes to reverse),
because a window has no page reload. A witness whose edit no longer matches
the current file fails and is updated or retired on purpose. The browser file
keeps no witness: a test of a fact that needs a box is shown to fail once, when
it is written, on a page with the thing it guards spoiled (The browser file,
below).

### The n-key lane

The owner reads the board a stop at a time with n and wants the page to answer within 0.2 s (board-read-fast). On the live board a press that landed on another item
took 0.3–0.5 s, because each of its four draws rebuilt the board's rules and counted every filter again (page-n-fast). The default generated board has
176 items and a press of n there takes about a quarter of the time, so the lane (`test/nkey/`, the CI job `nkey`, `npm run test:nkey`) runs on a board of the
live board's weight (`test/e2e/live-board.ts`: about 1,600 items, 770 cards, 780 comments, a 15 MB snapshot and 330 unread commits). The unread commits, which
through the store are four git processes each, are made by one `git fast-import`, the documents written as the store writes them, and the board is then
opened again as a daemon starts. The lane runs the real page in jsdom (`DomPage`, `test/dom/page.ts`) against the real server in the same process, and no
browser. Its first version ran in headless Chromium (`test/e2e/press-n.e2e.ts`) and took most of that job; the layout it needed was never part of the question.

**A tape of the server's answers.** A first walk of n on the real server records the answers to the page's reads; every other window is answered from that
tape, so a window's busy time is the page's own and the server's git reads fall into no window. A write, and a read the tape has no answer for, go to the real
server and are counted as misses; a window of the current page with a miss fails its check, while the base page's only warns (an older page may ask for what the current one does not). The change events of "sessions write while the owner reads" are
the `change` events of real writes (a log entry on an open item), one per landing, recorded off the real server's stream after the tape and delivered to
the page right after the key, each against the commit before it. A virtual clock stands for the page's timers longer than a frame and for the answers a test
holds back, so a baseline that arrives 300 ms late is 300 ms of the clock's time and no real waiting.

**Counts**, exact on any machine, from the page's performance marks (`countEvent` in `web/app.ts`): a press that lands on another item builds the board's rules
no time, counts the filters no time and draws once or twice, every draw from the key until the page is quiet counting, those of the rows around the target
included; and writes no more than the markup (characters assigned to `innerHTML`) and the elements (`createElement`) it wrote when the numbers were set, held at
the median over the landings of the first walk (`WRITES` in `test/nkey/lane.ts`; a change to the page that moves them changes the numbers and the pull request
says why). The draws depend on when the baselines of the rows around the target answer, because the navigation waits for them 100 ms at most, so a
test sets that time on the virtual clock: the rows around the target answer after 300 ms and the others after 20 ms. On a copy of the page whose wait is
2 s, the landing draws twice at most; on the page itself it draws twice and then the late rows on their own, every later draw of other items' rows alone;
whether two late rows share a frame is the frames' timing and not checked. The page without the wait, and the page with a wait that has no limit, must be
reported by the first and the second. While sessions write, each write builds the rules again, derives them from scratch no time except in a new minute
(the mark `board:rules-full` names the reason), counts every item's filters no time, makes the page's structure again no time except in a new minute
(`board:structure`) and lists the stops that wait on the owner and the unread stops no time except once after such a minute (`board:stops`, `board:fresh-stops`); a quiet press
makes the structure and both lists no time either. The writes of the lane only add log entries, which neither the rules' structure nor the unread
list read. After m the page asks for the unread list and does not fetch the board.

**Time**, compared and never limited by a fixed number of seconds: the seconds the event loop was busy (`eventLoopUtilization().active`) from the key until
the page is quiet, as the page of the commit over the page of its base (the merge base with the main line, or the commit before a push to it; built from that
commit's `web/` and `src/`; none when `web/` and `src/` are as they are there), with the board quiet and with a write in each press. Windows of the base,
of the twin of the base (the same page again, the control) and of the page when it differs are open side by side, opened in a random order, and press n in turn, in an order drawn at
random afresh each round, with a seed of each run's own that the log names (What a press inherits, below), so that landing k of every window is one pair. 30 pairs are measured after 2 that are thrown away. The ratio of one window to another is the geometric mean of
its per-pair ratios, with the Student-t 95% interval of the logs (`test/nkey/stats.ts`). The twin shows this run's noise: the run counts when the twin's interval
against the base is no wider than the noise floor of that kind of press, wherever it lies. The page and the witness are then judged against a reference
that is, per pair, the geometric mean of the base and the twin, two samples of the same page (`reference`): slower when the interval lies wholly above 1,
whatever its size, and ok otherwise. The twin's interval is not required to hold 1: identical windows keep a residual bias of 1–3% (What a press inherits,
the last point), which a twin over 90 pairs resolves, and in the acceptance run 39193876275 of `tmp-accept` such a twin (×1.013 [1.002, 1.024] and ×1.027
[1.016, 1.038]) left a page ×1.076 and ×1.085 slower undecided, so it passed. Judging the page against the base and the twin in turn, and slower only when
slower than both, lost the power instead: in run 39194638605 a page with 6 ms more per press was confirmed slower in 4 of 5 writing runs, and the fifth
passed because in its second run the base window itself read about 4% slow (twin/base ×0.959 [0.918, 1.003]), leaving the page ×1.037 [0.991, 1.086]
against the base while it read ×1.081 [1.061, 1.101] against the twin. Against the mean of the two, a slow press of either falls half into the reference,
and the bias between them is averaged; the second run of a red draws it afresh. A residual bias the lane's arrangement still has (What a press inherits, the last point)
would make a single run red too often, so a page judged slower is measured again in fresh windows (`timeLayer` in `test/nkey/lane.ts`) and is red only
when the second run judges it slower too; both runs' numbers are in the log, and a first red the second run does not repeat is a warning. The phase takes
one run more only when the first is red. Measured in the acceptance run 39195304717 of `tmp-accept`, 10 runs per phase on hosted runners: a copy of the
base in the changed page's place was never judged slower, not even in a first run (copy/ref ×0.965–1.015 quiet, ×0.974–1.020 writing), and a page with
a fixed 5 ms (quiet) or 6 ms (writing) more per press, 5.8–10.6% of the base's median press, was red in all 10, both runs slower each time (first runs
×1.061–1.111). The copies' estimates spread with a standard deviation of 1.5% quiet and 1.3% writing between runs, against a median half width of 2.0%
and 2.9%; with these (deduced, assuming a normal spread) a page the same as its base is slower in one run in about 9% (quiet) and 1% (writing) of runs
and red in both in about 0.9% and under 0.1%, a page 5% slower is red in about 94% and 88%, and one 2% slower in about 24% and 6%. These are the
properties of the 95% interval and are not traded for a threshold. When the twin's interval is wider than the floor, 30 pairs more are made in fresh windows (replaying the same tape), twice at most; still not, the layer says
"undecided" in a warning and passes. The floor is the widest half width the twin showed in 15 comparisons of a page with itself, over 30 pairs each (5 hosted
runners, 3 rounds each): 6.9% quiet and 7.6% while writing. The first round of a run is the noisier one (while writing 3.8–7.6%
against 1.6–2.4% in the rounds after it, quiet 3.1–5.8% against 2.3–6.9%), so a run that makes a second round is expected. A run with `NKEY_FLOOR=3` in the environment makes 3 rounds whatever the twin shows and prints each round's twin interval alone: that is how the floors are measured again when the runner image or Node changes. The absolute 0.2 s is not held here: jsdom's time is not a browser's, the speed of a hosted
runner differs by up to a factor of two between jobs, and every fixed number made a pull request red or green by the runner.

**What a press inherits.** The windows live in one process, so a press inherits what the presses before it left, those of other windows included,
and an order that always puts the same window before another carries its effect into the comparison. Over the 60 main-line and hand-started runs
before this was changed, the twin of the base read 0.77% slower than the base in the writing phase (standard error 0.20%, one round of 30 pairs
each) and 0.22% quiet (0.18%), while its own interval missed 1 in only 1 of 60 rounds per phase: the interval was right about the noise and the
bias was beside it. A probe on 14 hosted runners (each press recorded with its window, the window before it, its busy time and the pauses of the
garbage collector inside it) found three sources, and the lane removes each:
- *The young generation of the shared heap.* Whichever press fills it pays the collection, for the allocations of other windows too: the
  per-pair log ratio of twin and base follows the difference of their collection pauses (correlation 0.69–0.87), and in the order the lane
  used (a rotation, in which the base comes right after the slow witness in three presses of four and the changed page never) the twin read
  +0.57% (±0.34%) and a third copy of the base in the changed page's place +1.02% (±0.54%), over 20 rounds. A minor collection before each
  key, outside the time, leaves the young generation empty, so a press pays only for what it allocates itself; it costs about 4 ms a press
  (0.6 s a round). A full collection instead cost 250 ms a press (30 s a round), and subtracting the measured pauses from the busy time left
  differences of up to 1% between identical windows and would drop the page's own collections from its cost.
- *Compiled code shared by equal source texts.* V8 compiles a source text once for the process, so the base and its twin shared their
  compiled code and the one that reached a function first paid for both, while a page of other text (the changed page, the witnesses) paid
  all its own. With the minor collection alone a copy of the base in the changed page's place still read +1.5% (±0.5%) quiet; with a last
  line of its own for every window's text it read +0.0% (±0.3%), and the page with 1.5 ms more per draw read +3.0% instead of +3.7%.
- *The windows before.* The rotation balanced only the place in the round. A cycle of n−1 rounds in which each window comes right after
  each other one exactly once (tried next) left the base two presses after the slow witness in two rounds of three, and over 30 single
  rounds per phase on 12 hosted runners the twin then read 0.82% (±0.26%) quiet and 1.13% (±0.21%) writing faster than the base, a copy
  of the base in the changed page's place 0.44% (±0.25%) and 0.66% (±0.32%): what a press leaves reaches further than the next press.
  The order of each round is therefore drawn at random (`randomOrder` in `test/nkey/stats.ts`), with a new seed each run (`NKEY_SEED`
  repeats one): whatever the windows before leave falls on every window alike on average and widens the spread of the pairs, which
  the interval measures, instead of standing beside it as a bias.
- *The window opened first.* With the order of the presses random, the base still read 0.9% slower than its twin and the copy while
  writing (80.7 ms against 80.0 ms a press, every count of the page's work the same in all three), and the base was the window each
  round opened first. With the windows opened in a random order as well, over 32 single rounds per phase on 8 hosted runners, the window
  opened first read 0.98% above the mean of the three same pages while writing; one full collection once the windows are open, outside
  the time (about a quarter of a second a round), brought that to 0.27%, within the noise of the estimate (about 0.3%). Each round now
  opens its windows in a random order and then collects fully, so no window is always the one whose page was built first.
- *What is left.* Measured with all of the above, over 32 single rounds per phase (run 39192981801 of `tmp-accept`), a copy of the base in
  the changed page's place read ×0.9979 [0.9898, 1.0060] writing and ×1.0073 [1.0011, 1.0135] quiet, the twin ×0.9972 and ×1.0054: in the
  quiet phase the base read about 0.6% faster than the other two. A second set of 36 rounds per phase on the same code (run 39193425761)
  read the copy ×1.0013 [0.9956, 1.0070] quiet and ×0.9967 [0.9905, 1.0030] writing, so the first may be chance or a bias of a few
  tenths of a percent whose source was not found. It is known and not searched further; judging a page against the mean of the base and the twin, and
  confirming a red (Time, above), keep it from turning a page the same as its base red.

With the first two and the balanced cycle (before the last two were found), over 16 rounds writing and 12 quiet of five windows, the twin read +0.37% (±0.27%) and −0.26% (±0.50%), and the copy of the base −0.12%
(±0.30%) and +0.03% (±0.34%). A single-threaded V8 (`--single-threaded`) doubled the noise per pair and made the windows differ by 1–4%. The
probe's data are in the artifacts of the runs of the temporary workflow `tmp-probe` on the branch of item nkey-lane-false-red (runs 39189114067, 39189922884,
39190549744), those of the balanced cycle with four windows and of the random orders in runs 39191754978, 39192249677, 39192671312 and 39192981801 of the
temporary workflow `tmp-accept`, which also holds the acceptance runs of the confirmation.

**Witnesses.** Each layer also runs on the page with what it protects taken out, where it must report: the three changes of the counts one at a time and all
three together, the rules from scratch at every write and the filters of every item counted at every write, the navigation that does not wait and the one that
waits without a limit, a page that fetches the board after m, and for the time layer a page whose draw takes 15 ms more, in every time phase (the current page with that edit,
judged against the reference like the page; ×1.5 of the base in a quiet phase on an unchanged page).

**Parts.** The lane is four files, each a job of the full CI that seeds the board and records its own tape, so they take the time of the longest, not the sum: counts
(the current page's counts quiet and while writing, and the changes taken out one at a time), witnesses (the late rows, all three changes taken out, m), and the two
time phases. The jobs take 30 to 55 s including the 10 to 17 s the runner needs before the tests start. `test/nkey/stats.test.ts` holds the arithmetic and the
verdict on made-up pairs whose answer is known.

### Fast checks while writing, and the full CI at the end

The full CI (`.github/workflows/ci.yml`: `start`, `no-tmp-workflow`, `check`,
`test` in 20 shards, `nkey` in 4 parts and `result`) is meant to take a minute from the push to the
last check (The time gate), and the browser tests are not in it; a change under way
is pushed many times. A push to a pull request branch therefore does not
start it. A project that adopts this scheme copies `ci.yml` and `ci-mark.yml`
and changes the test jobs and the job list in `needs` of `result`, which reads
only the jobs it lists.

- **While writing**, the engineer adds a temporary workflow
  `.github/workflows/tmp-<name>.yml` that a push to the branch triggers and
  that runs only what the change touches: the test files and browser tests it
  changed or affects, with the type check when it touches shared types. The
  push result is listed on the pull request like any push check. Wait for it
  with `wait-ci.mjs <owner/repo> --commit <sha>`, which waits for every run
  of the commit; the pull request form would wait on `full-ci` below. The
  skeleton, whose setup steps are those of the `test` job of `ci.yml` and the
  `layout` job of `browser.yml`: keep each step the selected tests need and drop the others:

  ```yaml
  name: tmp-quick
  # Temporary: delete before the last full CI, which fails while this file exists.
  on:
    push:
      branches-ignore: [main]
  concurrency:
    group: tmp-quick-${{ github.ref }}
    cancel-in-progress: true
  jobs:
    unit:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v5
        - uses: actions/setup-node@v5
          with:
            node-version: 24
            cache: npm
        - run: npm ci
        - run: npm run build:web
        - run: git config --global user.name ci && git config --global user.email ci@example.invalid
        # The test files the change touches.
        - run: node --test test/watch.test.ts
    browser:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v5
        - uses: actions/setup-node@v5
          with:
            node-version: 24
            cache: npm
        - run: npm ci
        # The browser steps of browser.yml's `layout` job, from `id: playwright`
        # through `playwright install`, unchanged.
        - run: git config --global user.name ci && git config --global user.email ci@example.invalid
        - run: npm run build:web
        # The browser tests the change touches, picked by test name.
        - run: node --test --test-name-pattern='the list of messages' test/e2e/browser.e2e.ts
  ```

- **At the end**, once the change is done and reviewed: merge the main line
  into the branch, delete the `tmp-` file, push, start the full CI with
  `gh workflow run ci.yml --ref <branch>` and wait with
  `wait-ci.mjs <owner/repo> <PR> <sha>`. Green on the head commit is what lets
  the pull request be marked ready; a later push needs a new run.
- **The main line** runs the full CI on every push, as before; the browser file
  runs beside it in its own workflow (below).
- **No leak**: the job `no-tmp-workflow` fails when any `tmp-*` file is in
  `.github/workflows`. It runs in every full CI beside the other jobs, so the
  last run before a merge stops a temporary workflow that was not deleted, and
  the main line's own run stops one that got in anyway. It once ran ahead of the
  test jobs so as to fail within seconds; that put its ten seconds on the path of
  every green run, which the time gate (below) counts.
- **Status `full-ci`**: a run started by hand is attached to the head commit
  (`gh run list --commit` and the commit's check-run list show it), but it is
  not among the checks a pull request lists, which is what `gh pr checks`, the
  engineer's wait script and the board's watch read. Observed on 2026-10-17
  on a test pull request (wf-board#69, closed): the run started with
  `gh workflow run ci.yml --ref <branch>` on a branch with an open pull
  request had the pull request's head commit as its commit, and the checks it
  wrote were absent from `gh pr checks` and from the GraphQL roll-up of both
  the pull request and the commit, five minutes and more after the run ended.
  GitHub's documentation does not say this. Reopen the choice if GitHub lists
  such runs among a pull request's checks: `start` and `result` would then
  go, and the wait script and the board would read the run itself.
  `ci-mark.yml` would need another way to tell a pull request that never had
  a full CI, because such a pull request still lists neither `test` nor
  `check`.

  The status is written in three places. `ci-mark.yml` writes `full-ci` as
  pending on every pull request push, unless the commit already has one. The
  first job of a run started by hand (`start`) writes it as pending again, so
  the red of an earlier run of the same commit does not stand while the new
  one runs; the last job (`result`) writes the outcome of the run's jobs
  (success or failure, linking to the run). To try a commit again, start the
  full CI again; rerunning only the failed jobs leaves the earlier red
  standing until `result` runs. A run cancelled by hand leaves the pending
  that `start` wrote, over any earlier success of the commit, until the next
  run of the commit; that direction is safe, since pending blocks "can be
  merged".

  A pull request therefore reads pending until a full CI has run on its head
  commit, and the board does not push "can be merged" for a commit that never
  had one, except in the seconds between a push and the mark (about 8 seconds
  in the run seen, against a look every five minutes), or when the mark job
  does not run (queued, or Actions minutes used up): then only the checks that
  did run are read and a commit without a full CI can be taken for passed.
  The main line has no branch protection and no required checks, so `full-ci`
  does not stop a merge by itself: whoever merges reads `full-ci` on the head
  commit first and merges only when it is `success`.
- **The merge**: the run a pull request starts tests the branch merged with
  the main line as it was at that push; a run started by hand tests the branch
  head. The engineer merges the main line into the branch before starting it,
  so the head is what a merge would land. If the main line moves again without
  a conflict, the pull request is merged as it is and the main line's own run
  covers the combination of the merged changes.

Alternatives. The board reading the commit's check suites instead of a status:
it would fix the board only, not `gh pr checks` or the wait script, whose pull
request form would still turn green at once on the checks that did run.
Starting the full CI by a pull request label: a label would have to be added
and removed for each run, and any other label would start it too. Neither was
tried; both are rejected on those grounds.

### Sharding the script tests

The script tests (`npm test`: every `*.test.ts` file under `test/`) run in the
full CI as 20 shards (8 until the checks of the browser moved into the suite, 16 until the largest files were split), each in a job of its own, beside the type check, which is a
job of its own too. One runner took 82 to 118 seconds for the suite, and the type
check ahead of it added to that.

**Decision**: `scripts/test-shard.ts` deals the files out, longest first, each to
the shard with the least cost so far, instead of Node's `--test-shard`, because
that one cuts the sorted list by position and the files take from 0.1 to 30
seconds: three shards measured 21.6, 47.5 and 39.8 seconds of tests. The cost of
a file is the seconds of its own entry in the runner's report, from the start of
its process to its end, on a hosted runner, kept in `test/shard-costs.json`. It is
not the sum of the file's tests, which leaves out loading the file and its hooks:
`shutdown.test.ts` is 8.5 seconds of tests and 19.7 as a file. A file the table
does not name costs a default (`DEFAULT_COST`) and is dealt out like the rest, so
a new test file is run from its first push and never missed. The table is brought
up to date from the table of seconds per file that every shard writes to its job
summary and log (`scripts/test-times-reporter.ts`); the time gate names a shard
that took more than 1.5 times the mean of the others as the sign. A shard lists
its files longest first, which is the order the runner starts them in, three at a
time.
A shard's test step is cut at 60 seconds and a single test at 40
(`--test-timeout`), so that a hung shard or test is named in the log of the red
run and not only reported as a job that ran long. With the 13 files of `test/dom`
(section 11, Four test layers) the steps of the 8 shards took 25 to 46 seconds in
one run, because three files share the four cores and a page file takes 1.2 to 2.3
times as long among them as alone; a cut at 45 seconds then stopped
shards in two runs while their tests were passing, and 60 leaves 1.3 times the
longest step.

`test/ops.test.ts` is two files with the same tests (`ops.test.ts`, the writes,
and `ops-roles.test.ts`, pause and who may write what), because one of its tests
alone takes 7 seconds and the file about 28, which kept any shard above the others.

**Measured** (hosted runners, 4 cores, 8 shards, the costs as above): the step
`tests` of a shard took 12 to 26 seconds, the rest of its job (checkout, Node,
`npm ci`, the build, the start and end of the job) 12 to 16, and a run from its
start to the end of its last shard 40 to 45 seconds in 9 of 10 runs of one commit; in the tenth a shard waited 46 seconds for
a runner (the others 3 to 5) and the run took 70. A shard takes about as long as
the largest file it holds, and eight files take 13 to 20 seconds each when three
share a runner, so the costs balance the sums but the floor is the largest file.
Two settings were tried once each, and neither is worth keeping: 16 shards left
the longest `tests` step at 20 seconds against 26 for the 8 of that run, and
`--test-concurrency=6` was no faster than the default 3 (mean 18.9 against 19.4
seconds over 8 shards). Both differences are inside the spread between runs. The
next lever is splitting the largest files, as `ops.test.ts` was.

**Measured again** (hosted runners, 4 cores, 18 October 2026, after the checks of the
browser had moved into the suite: 90 files, 906 seconds of file time): with the 8 shards the step `tests` took 33 to 56
seconds (mean 45.5) and the job of the slowest shard 68, so a full CI took 73 seconds
against the line of 60, with the table's costs out of date (a file such as `page-numbers` held
at 20 seconds took 30). With the costs brought up to date from the shards' tables, 12
shards left the longest job at 61 seconds (`tests` 20 to 45) and 16 shards at 51
(`tests` 17 to 35, wait for a runner 3). Three runs of the 16 side by side gave the longest
job 46, 49 and 50 seconds, `tests` 16 to 34, the waits 4 at most, so a full CI of 16
shards is about 50 to 54 seconds from the push. What is left is the floor of the largest
files, 25 to 33 seconds each among two others (`page-cards`, `page-tree`, `page-filters-after`,
the three `rules-reuse` files, `page-numbers`, `page-plan`): more shards do not shorten
a shard that holds one of them, and a typical 50 seconds needs those files split. The
costs in the table are the mean of four runs of the 16.

**After the split** (hosted runners, 19 October 2026): the files of 25 seconds and more
were split: each `rules-reuse` seed into two files that replay the same 100 writes and
compare half of them each (the replay takes 2.3 seconds of the 26, the comparison 24, and
the writes depend on each other, so the writes cannot be dealt out but the comparison can,
and `rules-reuse-share.test.ts` shows that the parts find what one comparison of every
write finds), and the page files into 11 (the families, the two passes, the project
filters over two files). A split file alone took 7 to 22 seconds; among two others on one
runner 12 to 29. The sum of the files' seconds went from 906 to 941 (the earlier measurement and two main-line runs
before the split) to 1,064 to 1,099 (four full CIs after it), since each page file builds
its own board and bundle and an "after" pass replays the bursts of the rounds before it.
With the largest file at about 29 seconds the floor is gone: a shard's step is about the
sum of its files' seconds divided by three plus a second. The sums of the 16 shards
differed by up to 25% from run to run for the same costs (51 to 89 seconds: the speed of the
runner and of the files that share it), so the shard that ends last is about 5 seconds
over the mean step. Four full CIs of the 16 (the cost table the mean of the runs before)
ended the last test shard 49, 53, 53 and 56 seconds after the start of the run
(`tests` 17 to 32, mean 25.5). The same scripts dealt to 20 shards in one run took `tests` 17
to 27 seconds (mean 22.0), the longest job 42; to 24 shards 12 to 25 (mean 18.7), the longest
job 41. A job is about 5 seconds of wait for a runner and 10 to 15 of set-up around its
step. Twenty shards put the last test shard about 47 seconds after the start (42 plus the wait);
twenty-four ones only one second sooner.

**With 20 shards** (the cost table frozen, five full CIs of one commit, one after the other):
the last test shard ended 51, 50, 46, 47 and 50 seconds after the start of the run (median
50), its `tests` step took 14 to 31 seconds (mean 22.1; the longest of each run 31, 26, 27,
27, 27), and the sum of the file seconds of a shard ranged from 37 to 68 seconds within a
run (the table has about 54 for each). The total of the run was 58, 52, 52, 53 and 59
seconds, the last job in each being a part of the n-key lane (`witnesses` or `time-writing`,
ended 52 to 59 seconds after the start), so the test shards are no longer what ends a run
last.

**Rejected**: Node's `--test-shard` (positional, uneven, above). A hand-kept
list of the files of each shard: a new test file would belong to no shard and
nothing would run it, which the table with a default cost cannot do.

### The time gate

The last job of a full CI started by hand (`result`) reads the run's jobs through
the Actions API (`scripts/ci-time-gate.ts`) and puts into the run's summary the
seconds from the start of the run to the end of the job that ended last, a table
with the wait, the run and the end of each job, and the table of the shards.
Above 50 seconds the total is yellow, above 60 red (the target is a pull request
checked within a minute of the push; two runs of one configuration differed by
13%, so the target is a typical 50 seconds, which leaves the line 20% above).
It starts from the start of the attempt, not from the creation of the run, so a
rerun does not count the time before it.

The gate is set to `TIME_GATE=enforce` in `ci.yml`: a total over the line fails
the gate's step, and `result` writes the status `full-ci` as failed and ends the
run red. It only reported while the browser tests were a job of the full CI, whose
minutes put every total over the line. The shard table reads the jobs named `test shard N` and their step
`tests`; when it finds none, the summary says so, which shows a rename.

### The browser file

`test/e2e/browser.e2e.ts` is the browser layer, apart from one report below: 15
tests on one headless Chromium, one generated board and one page, each test
clearing the viewer's state and loading the page again. Its checks are in
`test/e2e/invariants.ts` (the page's layout), `browser-checks.ts`,
`mermaid-checks.ts` and `mermaid-compact.ts`, so that a test only picks the page's state for one of them.
It holds what a script cannot see:

- the page loads, a click opens an item, and the page does not scroll sideways;
- the right column's blocks fill their boxes and the page does not scroll
  sideways, in windows 2400, 1500 and 700 px wide;
- a plan's card rows keep the link to their question 20 px wide or more and a
  click brings the card into the pane; a closed card shows only its line while
  folded; the progress bands are as wide as the plan's share in both color
  schemes; the difficulty chip lies on the tags' line, below the title;
- the agent list lies above the projects, 在树中 scrolls the item's tree row
  into view and 返回 scrolls back; nothing covers the list of messages;
- the real diagram library: the head's diagrams, the error under a bad block,
  hostile text that runs nothing, the ids of a diagram drawn twice, a diagram's own
  frontmatter; the fit to the box at windows 1500 and 700 px wide; zoom, wheel,
  both ends and drag; the 60%, 90% and 100% buttons in a narrow column; the view
  kept through a live update; labels and lines in both color schemes; three synthetic
  charts drawn compact (short, the gaps the page asked, arrows entering from above,
  nothing covering anything).

**Limits.** At most 15 tests, so that a script keeps what it can see: a test is
added only when no script can see the fact, and the pull request that adds it
says why. `test/browser-limits.test.ts` counts the `test(` calls of the file,
each on a line of its own so that a loop cannot declare many, and fails a pull
request that goes over. At most 90 seconds: the step runs under `timeout 90` and
a red run says so. Neither limit is a measurement of the page; both keep the file
what it is for.

**Where it runs.** `.github/workflows/browser.yml`, two jobs side by side: `layout`
(the file) and `press-n` (the report below). It runs on each push to the main
line, every night at 03:17 UTC, and by hand with
`gh workflow run browser.yml --ref <branch>` once the workflow is on the main
line, because GitHub offers a workflow to start by hand only from there. It is
not on a pull request's path, so a pull request is checked by the script tests
alone and the full CI's time gate holds. A layout break that reaches the main line
is fixed on the main line; the red run of the merge's commit is where it shows.
Most of the bugs of this kind that the witness comments of the former browser job
name were found by the owner or a reviewer, not by that job (75 merged pull
requests and 45 witness comments read for the research of the CI's time).

**No variants.** The former browser job ran each of its witnesses on the current page
and on a page with the fix reversed, which doubled the tests and the time; this file
runs each test once. A test is shown to fail once, when it is written, by serving the
page with a literal edit applied as it is bundled (the same replacement as the spoiled
pages of the DOM layer, `test/e2e/variant.ts`) and running the check on it: the pull
request that adds the test records that run, a line for each test with the edit and the
violation it reported. Nothing of that stays in the repository, so a change to the
stylesheet does not leave edits that no longer match.

**Measured** (hosted runner, ubuntu-latest, one run on 18 October 2026): the 15 tests
took 48.2 s together: the plan's card rows 13 s, the compact drawing 9 s, the right
column's widths 8 s, the real library's head, hostile text, ids and frontmatter 4.5 s, a
closed card's fold 4.6 s, the page's load and click 2.5 s, the fit at two windows 1.7 s,
zoom 1.6 s, the view kept through an update 1.7 s, the size buttons 1.4 s, and the
other five under 1 s each. The job, with its checkout, `npm ci`, the build and the
browser from the cache, took 63 s.

**The time of n in a real browser** is reported, never judged
(`test/e2e/press-n-report.e2e.ts`, `npm run test:press-n-report`, the job `press-n`): the
main thread's busy time from the key until the page is quiet, over 30 presses of n on
a board of the live board's weight (`test/e2e/live-board.ts`), with the board quiet and
the page's minute tick held still, to the log and to the job's summary. One run measured
the median at 95 ms, the 90th percentile at 130 ms and the longest at 181 ms (against
the former limits of 200 and 300 ms), in 38 s with the board built. The number is for
reading over the days; a fixed limit on it turned red with the runner (a hosted
runner's speed differs by up to a factor of two between jobs): 19 of the 56 red runs of
the former job between 16 and 17 October failed on the time limits of n alone.

**Rejected**: the browser file on a pull request's path (its job took 63 s against the
60 s that a pull request's whole run may take, and two runs of one configuration
differ by 13%); no browser layer (nothing else sees a width, a place or a hit); the
browser tests as a job of the full CI that some runs leave out (a run started by hand
then has no browser result unless it asks, and the time gate could only report); a
page with the fix reversed for each test on every run, or in a second file for the
night (the first doubles the file past its limits, the second goes out of date unseen
while nobody runs it).

### Private content check

The repository is public, so what a commit adds stays visible in its history.
`scripts/check-private-content.ts` (rules in `scripts/private-content-rules.ts`,
workflow `.github/workflows/private-content.yml`) fails a push to any branch or
a pull request that adds one of these kinds of thing:

- an address in a private IPv4 range (RFC 1918, or 100.64/10, which
  carrier-grade NAT and Tailscale use), a user's home directory other than a
  placeholder or the CI runner's, an SSH key file or option, a private key
  block, a token in a known format (GitHub, Anthropic and OpenAI `sk-`, AWS,
  Slack, a `Bearer` header value), a secret assigned as a quoted literal, a path under the home
  directory with a key, token, secret, credential or password word in it, a
  link to the old board page;
- a path under a directory named `scratch` or `.scratch`, a `.bak` file, an
  environment file (`.env`, but not a template such as `.env.example`).

It reads only what the change adds: the added lines of the diff between the
base and the head, the added or changed paths, the messages of the commits in
the range and, for a pull request, its title and body. It reads the net
change of the range; pull requests are merged with a merge commit, so a value
added and removed again inside one pull request stays in `main`'s history, and
only the push that added it is checked. What the history already holds is not read again, and
author lines are not read (an author address carries the machine's host name,
which is not private). It prints the rule and the place, never the matched
text, because the log of a public repository is public; for the same reason it
reads the pull request's title and body from the event file, not from
environment variables, which the runner prints. An edit to a pull request's
title, body or base branch runs the check again. A push to a branch is public
at once, so the check also runs on every push; it can only report after the
push, not prevent it. A line that must hold such a value on purpose, a fixture,
carries the text `private-content: allow` and is skipped; the marker shows in
review. `test/check-private-content.test.ts` holds, for every rule, a line it
must flag and a line it must let through, with the shapes real values take.

The rules are general and carry none of the owner's real values. The check
runs in a public repository, so a list of real values (an address, a user
name, a key file name) kept in the workflow would sit in the repository, and
one kept in a secret could not be shown in the log; kinds of thing (any
private address, any home directory) are public by nature. The cost is a miss
for a private value that fits no kind, such as a host name, a person's name,
an address outside the ranges above (link-local, IPv6 local), or an `sk-`
string with no digit in it, which review still has to catch. The `sk-` rule
asks for a digit because real keys (`sk-ant-api03-...`, `sk-proj-...`) carry
digits and hyphenated words such as `sk-assessment-for-the-board-process-document`
carry none; without the digit the rule would flag ordinary prose. Alternative:
a secret list of real values for exact matches (`PRIVATE_EXTRA`); left out
because it needs a secret kept current and nothing has needed it.
Alternative: `.gitignore` entries for the working directories; left out
because the list never ends (a new temporary directory tomorrow) and the
check catches the path wherever it sits. The check is not a
required status check; requiring it is a repository setting the owner decides.
