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
  runs git.
- `src/startup-cache.ts`: the format of the startup cache (what a start derives from the history, kept in git's
  metadata directory so a start replays only the commits since); `src/log.ts`: timestamps on every service log
  line and the start-up step timings.
- `src/rules.ts`: derived board rules (plan status and frontier, ownership,
  priority from open work plans, parallel groups, checks and freshness).
  Imported by the server and bundled into the page, so agents and the owner
  see the same results.
- `src/ops.ts`: write operations with their checks, used by MCP tools and the
  page API alike.
- `src/dispatch.ts`: dispatch records (the agent sessions the architect
  started on items, kept on the item as `dispatches`): reading them across the
  board, the tallies, and the log lines the two write tools append.
- `src/mcp.ts`: MCP tools; `src/instructions.ts`: the server's instructions,
  a short pointer to the board rules in `~/dev/wf/AGENTS.md`; `src/http.ts`:
  page, page API, events and wake stream; `src/main.ts`: the daemon.
- `src/wake.ts`: the architect's push channel (the table of kinds, numbered
  events kept in a local file, receipts, the no-receipt alert);
  `src/timed-wake.ts`: what the half-hourly wake carries; `src/notify.ts`: the
  owner's notifications on the Mac. The protocol is `docs/design.md`, section 8.
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
  of the live board's size; the `bench` workflow runs it by hand
  (`workflow_dispatch`) on this tree and on a base commit, as a step that
  never fails the run.
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

The architect does not deploy by hand. It gets one push per deploy:
`deployed` names the version now served and the changes, and the architect
checks the change on the live page; `deployFailed` says why nothing was
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
reconnect. Then check the change on the live page.
