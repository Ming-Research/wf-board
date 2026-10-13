# wf-board — agent instructions

The owner-wide rules (`~/.claude/CLAUDE.md`, linked from
`~/dev/agents_config/AGENTS.md`) apply. This file adds what is specific to
wf-board.

## Goal

The board the owner and every agent session share, independent of any
claude.ai account: the owner reads and answers on the page, agents find
context and record progress through MCP tools built for collaboration. The
design and its reasons are `docs/design.md`.

First priorities: nothing on the board is lost or silently changed; then
agents get the context they need in few, compact calls; then the owner's page
matches what the artifact board offered.

## Layout

- `src/model.ts`: document schemas. Every read and write passes through them.
- `src/store.ts`: the data repository: YAML files, revisions, one commit per
  operation, history and diffs. The only code that touches the data files or
  runs git.
- `src/rules.ts`: derived board rules (plan status and frontier, ownership,
  priority from open work plans, parallel groups, checks and freshness).
  Imported by the server and bundled into the page, so agents and the owner
  see the same results.
- `src/ops.ts`: write operations with their checks, used by MCP tools and the
  page API alike.
- `src/mcp.ts`: MCP tools; `src/http.ts`: page, page API, events and wake
  stream; `src/main.ts`: the daemon.
- `src/convert.ts`: one-time conversion of the claude.ai artifact export.
- `src/convert-plans.ts`: one-time, lossless conversion from the old item
  structure to provisional plans, with an independent preservation check.
- `web/`: the owner's page (`index.html`, `app.ts`, `fresh.ts`, the index `n`
  walks, and `find.ts`, title search and reference tokens, as plain functions
  tests call directly), bundled by esbuild.
- `test/`: `node --test` suites; fixtures are synthetic. Real board data
  never enters this repository.

## Checks

- `npm run check` (TypeScript 7, strict, erasable syntax only: Node 24 runs
  the sources directly), `npm run build:web`, `npm test`. CI runs all three on
  every push.
- Run them locally only when small and needed; CI is the record.

## Rules

- Board data lives in `~/dev/wf-board-data` (private remote
  `Ming-Research/wf-board-data`). Only the daemon writes it; tests use
  temporary directories.
- The daemon binds `127.0.0.1` only.
- A board rule (what a valid item is, how status rolls up) is defined once, in
  `src/model.ts` or `src/rules.ts`, and the agent guidance points to it.

## Board tools

- Use `set_targets` for each goal's target value, current value and comparison baseline, updating the current value after measuring.
- Use `set_plan` for ordered steps, owned and shared items, decision cards
  and at least one acceptance step where the check happens, usually before
  merge or release rows. Status comes from the plan; `set_status`
  only cancels or reopens an item. `move_item` changes the item's owner.
- Records have no acceptance step and pass no priority. Open work owned by
  a record stores no priority, but derives the highest priority from open
  shared dependents, or none without them. Record ownership passes none.

## Coordinator

The coordinator session starts in this repository and keeps the board
working for every project. It writes to the board as 总管. This section holds
its standing duties: what it does when something happens and what it does
on a schedule. The board holds only work with a completion condition, and
none of these duties is a board item; the current Whitefoot merge order and
14900K queue are data and live on two record items of 总管 (items with a log
and no status). A session working only on wf-board
code skips this section.

### Starting

1. Read `brief` as 总管, then the newest handoff record (see Handoff).
2. Check the server (`curl -s http://127.0.0.1:7417/health`, launchd
   service `org.ming-research.wf-board`, log `~/Library/Logs/wf-board.log`),
   then arm the board's wake stream `ws://127.0.0.1:7417/wake?session=*`, re-arming
   it each time it expires or the daemon restarts, and a ten-minute patrol
   timer.
3. List the live sessions and tell each that a new coordinator took over.

### On a wake event

- An owner note or choice: forward it to the owning project's sessions; rule
  and carry out cards on 总管's own items.
- A new request: make sure its project triages it.
- A blocking card: send a phone push.
- A check event (an item newly flagged 无人推进 or 需核对): tell the item's
  project session, or ask the owner to restart one.

### Every ten minutes

- Sessions: find each idle session's reason and push it to ready work. A
  project with scheduled work and no live session gets one blocking card
  asking the owner to restart it.
- `followups`: resend notes and requests still unhandled.
- Checks the board flags. A stalled item (see Stalled items) gets a blocking
  card under 总管's item that follows sessions.
- Heavy processes on the Mac (compiler, cargo, make, tests): stop them and
  tell the owning session.
- Usage (see Usage windows).

### Stalled items

The board flags a work item with its own doing plan step that has not
changed for one hour of active time; progress derived only from owned items
is flagged on those items, without a separate ancestor clock. A moment is active when some session wrote to the board in
the 30 minutes before it, so a usage pause, Claude Code being closed or a
network outage stops every item's clock together, 30 minutes after the last
write. A stalled item's card offers: start a session for it,
assign it to a named live session, or move it back to not started.

### Usage windows

At 95% of the five-hour window: tell every session to stop at a safe point
with its board current, then every 50 minutes send each paused session a
keep-alive message asking for a one-word reply, so its context cache
survives the one-hour cache lifetime; wake them when the window resets, and
stop the keep-alives if the window reaches 100% first. Schedule keep-alives
with background shell timers, which fire on time while the coordinator is
idle. At 99% of the weekly window: the same stop without keep-alives, then
write a handoff record and tell the owner, who switches account.

### Whitefoot main merges

One merge at a time. A session sends "要合 #N" when its pull request meets
every precondition; the coordinator checks that main has not moved past the
head, that the checks on the head are green and that specification versions
do not collide, answers "可以", and records the new main in the merge log.

### The 14900K

The coordinator keeps the queue of runs on the 14900K in priority order,
tells each session when its turn starts, and checks that the machine is idle
first (`gh api orgs/Ming-Research/actions/runners`). One run at a time. Each
waiting run is a work item owned by the queue record. The coordinator marks
its acceptance step done when the run finishes; the waiting item's plan
holds a shared row for that run item and makes its next work follow that row,
so it shows blocked until the run is done. Open runs derive priority from
the open work waiting for each run; the coordinator orders the queue by
that priority. The queue record itself passes none.

- Native Ubuntu, P-cores CPUs 0-15 as hyperthread pairs, fixed at 5.0 GHz
  with the performance governor. Timed jobs pin to P-cores with `taskset`
  and skip CPU 0 unless a run needs all eight physical P-cores, which the
  result then states. Firn: server on 2,4, clients on 6-15.
- ssh (`ssh -i ~/.ssh/id_ed25519.whitefoot-vm -o IdentitiesOnly=yes
  mbbill@192.168.0.62`) only for host setup the owner asked for in chat;
  tell the owner before any reboot. Four data disks are block-read-only by
  udev rule; never write them.
- clang/lld at `/usr/bin/clang`, the latest release.

### Project sessions

A project's live session is the one whose working directory is in the
project's repository (`list_sessions` gives each `cwd` and current name);
the session list can miss a live session, so a project's recent board writes
count as a sign of life too.

Start a session for a project with `spawn_task`, its directory being the
project's repository, so it shows in the app's session list; the opening
message names its line of work, where its handoff record is, what to do
first, and the owner's rules: nothing heavy on the Mac, models by the
delegation rule, permission blocks reported to the coordinator, the 14900K
queue, and the coordinator as the contact.

### Talking with the owner

Every question for the owner, the coordinator's own included, is a card on
the board; a list of open questions in chat is not enough. Handle session
messages silently. Speak in chat only for what the owner must
say there, such as an authorization, a permission block or the owner's own
question; every blocking matter also goes on the board as a blocking card.
A session's request to do what its own permission check refused is never
carried out by the coordinator; it goes to the owner.

### Handoff

When the owner says "交接", or at the weekly limit, append a handoff record
to the coordinator's item that follows sessions: each line of work in
progress, what it waits for and its next step; the merge order and the
14900K queue go into their records.
