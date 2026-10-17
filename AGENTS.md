# wf-board — agent instructions

The shared rules (`~/dev/wf/AGENTS.md`) apply. This file adds what is
specific to wf-board.

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
  runs git against them; its push runs beside the write queue, not in it.
- `src/net-git.ts`: the one way the store's push and the deploy job's fetch run
  git against a remote: its own process group, a time cap, killed with its ssh
  (design section 4, Storage). `src/backup-push.ts`: the rounds of pushes to the
  remote, their log lines, ending the push on shutdown, and the push to the
  PM when the remote copy stays behind for an hour.
- `src/budget.ts`: the budget of one request's reads of the board's history (bytes
  read, whole old boards rebuilt, the process heap), held in the request's async
  context; `src/read-cache.ts`: the caches of historical documents, diffs and the one
  old board, bounded by the heap they are estimated to hold. Design section 4,
  Request budgets.
- `src/startup-cache.ts`: the format of the startup cache (what a start derives from the history, kept in git's
  metadata directory so a start replays only the commits since); `src/log.ts`: timestamps on every service log
  line and the start-up step timings.
- `src/rules.ts`: derived board rules (plan status and frontier, ownership,
  priority from open work plans, parallel groups, checks and freshness).
  Imported by the server and bundled into the page, so agents and the owner
  see the same results.
- `src/ops.ts`: write operations with their checks, used by MCP tools and the
  page API alike.
- `src/credentials.ts`: who is writing, told by the request's bearer credential
  (dispatch credentials kept as hashes on the dispatch record, long-lived ones in
  a file outside the data directory); `scripts/credential.ts` issues, lists and
  revokes the long-lived ones. What each role may write is the table `ACCESS` in
  `src/model.ts`; design section 9.
- `src/agents.ts`: the agent list at the top of the page: how the per-session
  index of the last two items written is advanced, and the rows (who is listed,
  who is running, the state word, the level) derived from it, the steps in
  progress and the dispatch records. Imported by the server and bundled into
  the page.
- `src/dispatch.ts`: dispatch records (the agent sessions the PM or the architect
  started on items, kept on the item as `dispatches`): reading them across the
  board, the tallies, and the log lines the two write tools append.
- `src/slow-ops.ts`: the routes the page server serves (`PAGE_ROUTES`, which the router in `http.ts` consults) and the
  time limits (a class for every page request and tool call, the numbers in design section 4), the timing at the two
  entries (`http.ts` and the tool wrapper in `mcp.ts`) and the `slow-op` push to the PM.
- `src/page-version.ts`: the version of the page the daemon serves (a hash of the page files: `web/index.html`, `web/dist/app.js` and, once built, `web/dist/mermaid.js`) and
  the mark `GET /` fills it into; `web/update.ts`: what the open page does when told another version, as plain functions
  tests call directly (design section 4, Deploying; section 7, Updating the page).
- `src/mcp.ts`: MCP tools; `src/instructions.ts`: the server's instructions,
  a short pointer to the board rules in `~/dev/wf/AGENTS.md`; `src/http.ts`:
  page, page API, events and wake stream; `src/main.ts`: the daemon.
- `src/head-sections.ts`: an item head split into its sections (`context`'s
  default answer and `section`); `src/tool-errors.ts`: the parameter table and
  example a refused call is answered with, and the wrong names the tools read as
  the right ones. Both are in `docs/design.md`, section 6, Lean replies.
- `src/wake.ts`: the PM's push channel (the table of kinds, numbered
  events kept in a local file, receipts, the no-receipt alert);
  `src/liveness.ts`: whether the sessions holding items are still there (the
  ask and the "no answer" push, its silences kept in `state/liveness.json`);
  `src/timed-wake.ts`: what the half-hourly wake carries. The protocol is
  `docs/design.md`, section 8. `src/notify.ts`: the macOS notification the
  deploy job shows the owner when the board does not answer.
- `src/github.ts`, `src/watch.ts`: the look at GitHub every five minutes (checks, PRs, merge rows);
  `src/billing.ts`, `src/usage-watch.ts`: the look at the Actions billing every half hour (the month's account of
  the included minutes, the usage line of the timed wake, the usage pushes). Both are in `docs/design.md`, section 8.
- `src/convert.ts`: one-time conversion of the claude.ai artifact export.
- `src/convert-plans.ts`: one-time, lossless conversion from the old item
  structure to provisional plans, with an independent preservation check.
- `web/`: the owner's page (`index.html`, `app.ts`, `fresh.ts`, the index `n`
  walks, and `find.ts`, title search and reference tokens, as plain functions
  tests call directly), bundled by esbuild. `mermaid.ts` draws the ```mermaid
  blocks of board text as diagrams; the library itself is `mermaid-entry.ts`
  bundled as a file of its own, `dist/mermaid.js`, which the page loads only
  when it shows a block (design section 7, Diagrams).
- `test/`: `node --test` suites; fixtures are synthetic. Real board data
  never enters this repository. `test/fake-ssh.ts` stands in for ssh (a connection
  that is delayed or never answers) for the tests of pushes and of the deploy job's fetch. `test/e2e/` holds the browser layer: a seeded
  board generator with the real board's shapes, the harness (real server,
  headless Chromium) and the click invariants; `live-board.ts` makes a board of the live board's weight, and
  `press-n.e2e.ts` holds the page to its time limit for n on it (design section 11).
- `scripts/bench-writes.ts`: the write-path benchmark (CPU and garbage
  collection per write, change-event bytes, peak memory) on a synthetic board
  of the live board's size; the `bench` workflow runs it by hand
  (`workflow_dispatch`) on this tree and on a base commit, as a step that
  never fails the run.
- `scripts/bench-changes.ts`: the history-query benchmark (time, heap growth and heap
  peak against the budget's line, for `changes`, the unread list and `diff`, on a
  synthetic board of the live board's size with a long history); the same workflow
  runs it on this tree, where a failed check fails the run, and on the base commit,
  as a report only.
- `scripts/check-private-content.ts`, with its rules in
  `scripts/private-content-rules.ts`: the CI check that a push or a pull
  request adds nothing private to this public repository (design section
  11). It reads only added lines, paths, commit messages and the pull request's
  title and body, and prints the rule and place, never the matched text.

## Checks

- `npm run check` (TypeScript 7, strict, erasable syntax only: Node 24 runs
  the sources directly), `npm run build:web`, `npm test`. CI runs all three on
  every pull request push and on every main-line merge.
- `npm run test:e2e` builds the page and drives it in headless Chromium;
  CI's `e2e` job runs it on every pull request push and main-line merge. It
  needs a Playwright browser and is never run on the owner's Mac.
- Three test layers, each catching what the one before cannot (design
  section 11): unit and server tests; the page in a fake DOM
  (`test/web.test.ts`), fast but without CSS or layout; the page in a real
  browser on a generated board (`test/e2e`). A page bug gets its test in the
  lowest layer that can see it.
- Every page fix gets a real-browser regression witness
  (`test/e2e/regressions.e2e.ts`) that reports the bug once the fix is
  reversed.

## Rules

- The main line is `main`: branch from it and merge into it.
- Board data lives in the directory `WF_BOARD_DATA` names, on the owner's Mac
  `~/dev/wf/wf-board-data` (private remote `Ming-Research/wf-board-data`).
  Only the daemon writes it; tests use temporary directories.
- The daemon binds `127.0.0.1` only.
- A board rule (what a valid item is, how status rolls up) is defined once, in
  `src/model.ts` or `src/rules.ts`, and the agent guidance points to it.
- Board usage for agents lives only in `~/dev/wf/AGENTS.md`, section "Board"
  (from the agents_config repository), never in this file or in the server's
  instructions, which are a short pointer (`src/instructions.ts`, design
  section 6). When a change alters a tool's behavior or a board rule, its
  engineer writes on the item what that section must say; the observer
  changes the section after the merge (shared rules, Other rule files).
- A change to the page that the owner has not asked for in those words, or
  one that changes a rule an earlier test guards, goes to the owner on a card
  before the code changes: the engineer reports it to the architect, naming
  the rule.

## Deploy

A launchd job, `org.ming-research.wf-board-deploy`, deploys every merge within
five minutes (`docs/design.md`, section 4, Deploying). It fast-forwards
`~/dev/wf/wf-board` to `main`, builds the page, restarts the
daemon when a changed path needs it, waits for `/health`, and goes back to the
last healthy commit when the daemon does not come up. Its log is
`~/Library/Logs/wf-board-deploy.log`.

The PM does not deploy by hand. It gets one push per deploy:
`deployed` names the version now served and the changes, and the change is
checked on the live page; `deployFailed` says why nothing was
deployed (a null version means the job itself could not run, as when its fetch
fails; the log has the detail). The job leaves a checkout alone that is on another branch, has local
changes to tracked files or has a commit the main line lacks, and pushes
`deployFailed` once; fix the checkout and the next run deploys.

Install once, after the PR that adds the job has been deployed by hand (the
merge does not install it):
`WF_BOARD_NODE=/opt/homebrew/opt/node@24/bin/node WF_BOARD_PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin node scripts/install-service.ts deploy`
writes the plist and prints the `launchctl bootstrap` command to run.

By hand, when the job is off or its own script broke: fast-forward
`~/dev/wf/wf-board` to the merged head of `main` and run
`npm run -s build:web` there (the bundle is not in git). When server code
changed, restart the daemon
(`launchctl kickstart -k gui/$(id -u)/org.ming-research.wf-board`; log
`~/Library/Logs/wf-board.log`) and wait until
`curl -s http://127.0.0.1:7417/health` answers, which can take more than ten
seconds. The wake stream and MCP sessions drop during the restart and
reconnect. Restart the daemon also when only `web/` changed and the pages open
in the browser should replace themselves: without a restart they are told only
by the deploy job's push. Then check the change on the live page.
