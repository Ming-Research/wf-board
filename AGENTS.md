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
- `src/mcp.ts`: MCP tools; `src/instructions.ts`: the server's instructions,
  where agents learn how to use and write on the board; `src/http.ts`: page,
  page API, events and wake stream; `src/main.ts`: the daemon.
- `src/convert.ts`: one-time conversion of the claude.ai artifact export.
- `src/convert-plans.ts`: one-time, lossless conversion from the old item
  structure to provisional plans, with an independent preservation check.
- `web/`: the owner's page (`index.html`, `app.ts`, `fresh.ts`, the index `n`
  walks, and `find.ts`, title search and reference tokens, as plain functions
  tests call directly), bundled by esbuild.
- `test/`: `node --test` suites; fixtures are synthetic. Real board data
  never enters this repository. `test/e2e/` holds the browser layer: a seeded
  board generator with the real board's shapes, the harness (real server,
  headless Chromium) and the click invariants.
- `scripts/bench-writes.ts`: the write-path benchmark (CPU and garbage
  collection per write, change-event bytes, peak memory) on a synthetic board
  of the live board's size; CI runs it on this tree and on the commit the
  branch started from, as a step that never fails the run.

## Checks

- `npm run check` (TypeScript 7, strict, erasable syntax only: Node 24 runs
  the sources directly), `npm run build:web`, `npm test`. CI runs all three on
  every push.
- `npm run test:e2e` builds the page and drives it in headless Chromium;
  CI's `e2e` job runs it on every push. It needs a Playwright browser and is
  never run on the owner's Mac.
- Three test layers, each catching what the one before cannot (design
  section 11): unit and server tests; the page in a fake DOM
  (`test/web.test.ts`), fast but without CSS or layout; the page in a real
  browser on a generated board (`test/e2e`). A page bug gets its test in the
  lowest layer that can see it.
- Run them locally only when small and needed; CI is the record.

## Rules

- Board data lives in `~/dev/wf-board-data` (private remote
  `Ming-Research/wf-board-data`). Only the daemon writes it; tests use
  temporary directories.
- The daemon binds `127.0.0.1` only.
- A board rule (what a valid item is, how status rolls up) is defined once, in
  `src/model.ts` or `src/rules.ts`, and the agent guidance points to it.
- Board usage for agents lives only in the server's instructions
  (`src/instructions.ts`, design section 6), never in this file. A change to a
  tool's behavior or to a board rule changes them in the same commit; keep
  their first 2048 characters self-contained, since Claude Code cuts there.

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
- A blocking card: show a macOS banner. Phone pushes are not delivered, so
  a background node script on the wake stream calls `osascript -e 'display
  notification …'` for each `blocking` event (banners show as Script
  Editor's; Do Not Disturb silences them). Re-arm it in each new
  coordinator session. While the owner is asleep (the owner says so), a file
  `owner-asleep` next to the script suppresses banners; remove it when the
  owner is back.
- A check event (an item newly flagged 无人推进 or 需核对): tell the item's
  project session, or ask the owner to restart one.

### Every ten minutes

- Sessions: allocate them as the server's reading guide says (docs/design.md,
  Server instructions), push each idle session to ready work, and give a project
  that needs a session and has no live one a blocking card asking the owner
  to restart it.
- `followups`: resend notes and requests still unhandled.
- Checks the board flags. A stalled item (see Stalled items) gets a blocking
  card under 总管's item that follows sessions.
- Heavy processes on the Mac (compiler, cargo, make, tests): stop them and
  tell the owning session.
- Usage (see Usage windows).
- Delegation: read each busy session's recent turns and correct it when it
  implements in its own turns instead of delegating, picks a model above the
  task's difficulty, runs heavy work on the Mac or polls GitHub more often
  than every five minutes.

### Stalled items

The board flags a work item with its own doing plan step that has not
changed for one hour of active time; progress derived only from owned items
is flagged on those items, without a separate ancestor clock. Effectively
paused work has no stalled flag, and its paused intervals do not count toward
active time. A moment is active when some session wrote to the board in
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
idle. Weekly window (owner, 2026-10-13): at 95%, tell every session to slow
down: no new investigations or Opus subagents, finish the current step, keep
the board current. At 98%, the same stop without keep-alives, then write a
handoff record and tell the owner. The five-hour window resetting does not
lift a weekly slowdown.

### Whitefoot main merges

One merge at a time. A session sends "要合 #N" when its pull request meets
every precondition; the coordinator checks that main has not moved past the
head, that the checks on the head are green and that specification versions
do not collide, answers "可以", and records the new main in the merge log.

Halo, Firn and Whitefoot-kit sessions merge their own green pull requests
into their main lines without a per-PR approval card (owner, 2026-10-13); a
pull request with a new design decision still gets its approval card first.

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
  result then states. Firn: servers on P-cores, load clients on all 16
  E-cores (CPUs 16-31) for every competitor alike; a cell whose clients
  average over 90% busy is marked client-limited (owner, 2026-10-12).
- ssh (`ssh -i ~/.ssh/id_ed25519.whitefoot-vm -o IdentitiesOnly=yes
  mbbill@192.168.0.62`) only for host setup the owner asked for in chat;
  tell the owner before any reboot. Four data disks are block-read-only by
  udev rule; never write them.
- clang/lld at `/usr/bin/clang`, the latest release.

### Project sessions

A project's live session is the one whose working directory is in the
project's repository (`list_sessions` gives each `cwd` and current name);
the session list can miss a live session, so a project's recent board writes
count as a sign of life too: `context` and `brief` show each item's last
pushing session and time (`last push`).

Start a session for a project with `spawn_task`, its directory being the
project's repository, so it shows in the app's session list; the opening
message names its line of work, where its handoff record is, what to do
first, and the owner's rules: nothing heavy on the Mac, models by the
delegation rule, permission blocks reported to the coordinator, the 14900K
queue, and the coordinator as the contact.

### Routing an owner's choice or comment

The wake event names the card or item and its project, not the session.
Forward to the line whose pull request or branch the card is about; when
unsure, ask the most likely line, which answers with the right one. A
project whose line ended (its session is gone) is handled by another live
session of that project. A choice that approves a design-tree or
specification change asks the session to rule the card, write the approval
record and update its plan; while usage is slowed, only such record steps.

### Talking with the owner

Every question for the owner, the coordinator's own included, is a card on
the board; a list of open questions in chat is not enough. Handle session
messages silently. Speak in chat only for what the owner must
say there, such as an authorization, a permission block or the owner's own
question; every blocking matter also goes on the board as a blocking card.
A session's request to do what its own permission check refused is never
carried out by the coordinator; it goes to the owner, who allows it in that
session's own chat. A choice on a board card does not lift a session's
permission check, and an action on the owner's stop list (publishing, a
credential, the 14900K over ssh) still needs the owner's words in chat.

Everything the owner reads is in Chinese: chat replies, board text and
`spawn_task` chip titles and summaries.

The owner pauses or resumes an item by commenting on it; the coordinator
applies `set_pause` with the owner's reason (the page has no pause button).

### The owner's board bugs and requests

Each board bug the owner reports becomes an item under 总管's 「看板 bug」
item, and each feature request an item under 「看板需求」. A proposal, or a
change to the page the owner has not asked for in those words, is a decision
card under that item, and the code changes after the owner chooses. A fix
that would change a rule an earlier test guards goes to a card first, naming
the rule. Every page fix gets a real-browser regression witness
(`test/e2e/regressions.e2e.ts`) that reports the bug once the fix is
reversed.

Deploy: fast-forward `~/dev/wf-board` to the CI-green head, push it as
`origin/claude/first-board`, run `npm run -s build:web` there (the bundle is
not in git), restart the daemon only when server code changed (`launchctl
kickstart -k gui/$(id -u)/org.ming-research.wf-board`), re-arm the wake
stream, and check the change on the live page.

### Haiku on the owner's API key

`~/dev/claude-haiku` runs command-line Claude Code on the owner's API key
(`~/dev/claudekey.txt`), Haiku only (owner, 2026-10-14, coordinator chat).
It forces every model setting to Haiku, refuses any other `--model`, and
clears the desktop app's variables (`ANTHROPIC_BASE_URL`, `CLAUDE_*`) so
requests reach the API on that key instead of the subscription. Use it only
where the owner allowed it (Whitefoot-kit's agent writing trials); never read
or copy the key.

### Handoff

When the owner says "交接", or at the weekly limit, append a handoff record
to the coordinator's item that follows sessions: each line of work in
progress, what it waits for and its next step; the merge order and the
14900K queue go into their records.
