# wf-board — agent instructions

Your own rule file applies: each agent's rules are assembled from the
board's rule blocks into `$WF_HOME/agents_config` (the board's rule block
`agents-md-rules` says which file each agent reads). This file adds what is
specific to wf-board.

## Goal

The board the owner and every agent session share, independent of any
claude.ai account: the owner reads and answers on the page, agents find
context and record progress through MCP tools built for collaboration. The
design and its reasons are `docs/design.md`; the decisions it rests on, with
what each beat, are the design tree in `design/` (section "Design tree").

First priorities: nothing on the board is lost or silently changed; then
agents get the context they need in few, compact calls; then the owner's page
matches what the artifact board offered.

## Layout

- `src/model.ts`: document schemas. Every read and write passes through them.
- `src/store.ts`: the data repository: YAML files, revisions, one commit per
  operation, history and diffs. The only code that touches the data files or
  runs git against them; its push runs beside the write queue, not in it, and its repository maintenance is a task of the queue.
- `src/net-git.ts`: the one way the store's push and the deploy job's fetch run
  git against a remote: its own process group, a time cap, killed with its ssh
  (design section 4, Storage). `src/backup-push.ts`: the rounds of pushes to the
  remote, their log lines, ending the push on shutdown, and the push to the
  architect when the remote copy stays behind for an hour.
- `src/budget.ts`: the budget of one request's reads of the board's history (bytes
  read, whole old boards rebuilt, the process heap), held in the request's async
  context; `src/read-cache.ts`: the caches of historical documents, diffs and the one
  old board, bounded by the heap they are estimated to hold. Design section 4,
  Request budgets.
- `src/startup-cache.ts`: the format of the startup cache (what a start derives from the history, kept in git's
  metadata directory so a start replays only the commits since); `src/log.ts`: timestamps on every service log
  line and the start-up step timings.
- `src/rules.ts`: derived board rules (plan status and frontier, ownership,
  parallel groups, checks and freshness).
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
- `src/candidates.ts`: the items an engineer could be started on and the working engineers of the two pools, read from the
  whole board (the `candidates` tool): the board lists and holds no limit, the architect compares the count with the owner's
  numbers and chooses (design section 6, The candidates read).
- `src/whole-view.ts`: the whole view: every open work item in one of five kinds (waiting too long, nobody's, being worked
  on, waiting, set aside) by the runner's report on it (`item.runner`, written by `report_state`), a live engineer session
  and the plan, in one function that the `whole_view` tool prints and the page draws (design section 6, The whole view;
  section 5, Runner reports). Imported by the server and bundled into the page.
- `src/live.ts`: the runner's beats for the turns running now (the turn's number, its length, the last action), kept in the
  daemon's memory only and sent to the page as the event `live`; `src/runner-rows.ts`: the runner's block of the agent list, one row
  for each piece of work the runner holds, read from its report on the item, the dispatch record and the beats (design section 7,
  Agent list, The live view of a turn). Imported by the server and bundled into the page.
- `src/dispatch.ts`: dispatch records (the agent sessions the architect or the runner
  started on items, kept on the item as `dispatches`): reading them across the
  board, the tallies, and the log lines the two write tools append.
- `src/slow-ops.ts`: the routes the page server serves (`PAGE_ROUTES`, which the router in `http.ts` consults) and the
  time limits (a class for every page request and tool call, the numbers in design section 4), the timing at the two
  entries (`http.ts` and the tool wrapper in `mcp.ts`) and the `slow-op` push to the architect.
- `src/write-trace.ts`: where the time of one write call went (the waits in the two queues, each git command, the work between),
  kept in the call's async context and told in the call's log line when it took long (design section 4, Time limits);
  `src/loop-watch.ts`: the log line for a stretch in which the event loop was held, with the process's CPU and garbage collection time and the machine's load in it.
- `src/page-version.ts`: the version of the page the daemon serves (a hash of the page files: `web/index.html`, `web/dist/app.js` and, once built, `web/dist/mermaid.js`) and
  the mark `GET /` fills it into; `web/update.ts`: what the open page does when told another version, as plain functions
  tests call directly (design section 4, Deploying; section 7, Updating the page).
- `src/mcp.ts`: MCP tools; `src/instructions.ts`: the server's instructions,
  a short pointer to the board section of the shared rules (the board's
  rule block `shared-rules`); `src/http.ts`:
  page, page API, events and wake stream; `src/main.ts`: the daemon.
- `src/head-sections.ts`: an item head split into its sections (`context`'s
  default answer and `section`); `src/tool-errors.ts`: the parameter table and
  example a refused call is answered with, and the wrong names the tools read as
  the right ones. Both are in `docs/design.md`, section 6, Lean replies.
- `src/wake.ts`: the push channel (the table of kinds, each agent's numbered
  stream kept in a local file, the alert that the architect's stream is behind);
  `src/liveness.ts`: whether the sessions holding items are still there (the
  ask, its silences kept in `state/liveness.json`);
  `src/timed-wake.ts`: what the architect's hourly wake carries. The protocol is
  `docs/design.md`, section 8. `src/notify.ts`: the macOS notification the
  deploy job shows the owner when the board does not answer.
- `src/merges.ts`: which item delivered a merge (the pull request a commit title names, the item whose 改动 section names it),
  for the deploy pushes and the red main line.
- `src/github.ts`, `src/watch.ts`: the look at GitHub every five minutes (checks, PRs, merge rows);
  `src/ci-source.ts`, `src/ci-watch.ts`: the look at the checks of the PRs the open items name every 30 seconds, with
  conditional REST requests, and the message to the engineer when a PR's checks have finished (design section 8,
  The look at the checks);
- `src/convert.ts`: one-time conversion of the claude.ai artifact export.
- `src/convert-plans.ts`: one-time, lossless conversion from the old item
  structure to provisional plans, with an independent preservation check.
- `web/`: the owner's page (`index.html`, `app.ts`, `fresh.ts`, the index `n`
  walks, and `find.ts`, title search and reference tokens, as plain functions
  tests call directly), bundled by esbuild. `mermaid.ts` draws the ```mermaid
  blocks of board text as diagrams; the library itself is `mermaid-entry.ts`
  bundled as a file of its own, `dist/mermaid.js`, which the page loads only
  when it shows a block and which also makes ELK keep the gaps the page asks for (design section 7, Diagrams).
- `test/`: `node --test` suites; fixtures are synthetic. Real board data
  never enters this repository. `test/fake-ssh.ts` stands in for ssh (a connection
  that is delayed or never answers) for the tests of pushes and of the deploy job's fetch. `test/e2e/` holds the browser layer: a seeded
  board generator with the real board's shapes, the harness (real server,
  headless Chromium) and the layout checks; `browser.e2e.ts` is the one small file of tests that need a real browser
  (at most 15, which `test/browser-limits.test.ts` holds), and `live-board.ts` makes a board of the live board's weight
  for `press-n-report.e2e.ts`, which reports the time of n in a real browser and judges nothing, and for the n-key lane (design section 11,
  The browser file). `test/nkey/`
  holds the n-key lane (`*.nkey.ts`, not picked by `npm test`; design section 11, The n-key lane): the real page in jsdom on that board,
  the counts of one press of n and its time against the page of the base, in four files (`counts`, `witnesses`, `time-quiet`,
  `time-writing`) that are four jobs of the full CI; `lane.ts` is what they share, `press.ts` the tape of recorded answers, the virtual clock
  and the pairs, `stats.ts` the interval and the verdict (`stats.test.ts` runs in `npm test`). `test/dom/` holds the DOM
  layer: the bundled page in jsdom against the real server on the same generated board (`page.ts` the window,
  its shims and the small tools a person has; `styles.ts` the stylesheet's cascade for the style checks; `checks.ts`
  and `style-checks.ts` the checks; `witnesses.ts` and the scenario files the pages with one thing spoiled; `mermaid-library.ts`
  the stand-in for the diagram library the page loads by address, `mermaid-layout.ts` the model of the diagram boxes, and
  `mermaid-checks.ts`, `mermaid-spoiled.ts` and `mermaid-*.test.ts` the diagram checks and their spoiled pages; `changed-blocks.test.ts` and `width-caps*.ts` the stylesheet checks of the changed-block bar and of the right column's widths). Each
  `*.test.ts` there has a board of its own and is kept short enough to be dealt out to the shards (the
  longest takes about 30 seconds on a hosted runner).
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
- `scripts/bench-page.ts`: the page benchmark (the open page's busy time per `set_tags` and
  log change event, in jsdom on a board of the live board's weight, answered from recorded
  server answers so the time is the page's own); the same workflow runs it on this tree, as a
  step that never fails the run. `scripts/profile-summary.ts` prints where the CPU went for
  both write and page benchmarks' `--profile`.
- `scripts/bench-noise.ts`: the noise measurement for the 14900K (pairs of one pinned job
  against its own twin in rounds, the noise floor as the widest interval half width; `--work`
  is the job), run by the `noise-14900k` workflow.
- `design/`: the design tree, one Markdown file per node and the change log
  `design/log.md`; `design/skill` is the Design-skill submodule that checks it.
  `Makefile` holds the two targets that run the check. Section "Design tree".
- `scripts/check-private-content.ts`, with its rules in
  `scripts/private-content-rules.ts`: the CI check that a push or a pull
  request adds nothing private to this public repository (design section
  11). It reads only added lines, paths, commit messages and the pull request's
  title and body, and prints the rule and place, never the matched text.
- `scripts/test-shard.ts` with `test/shard-costs.json`, `scripts/test-times-reporter.ts`
  and `scripts/ci-time-gate.ts`: how the full CI shares the test files among its 20
  shards (each file to the lightest shard by the seconds it takes; a file the table
  does not name is still run), the table of seconds per file every shard writes to its
  summary, and the time gate in the run's last job (design section 11, Sharding the
  script tests, The time gate).

## Checks

- `npm run check` (TypeScript 7, strict, erasable syntax only: Node 24 runs
  the sources directly), `npm run build:web`, `npm test`. The full CI runs all
  three on every main-line merge (`npm test` as 20 shards at once), with the four jobs of the n-key lane beside them, and on a pull
  request when the engineer starts it (`gh workflow run ci.yml --ref <branch>`);
  pushes in between are
  checked by a temporary `tmp-*.yml` workflow that runs what
  the change touches (design section 11, Fast checks while writing). When a test
  file is added, renamed or becomes much slower, bring `test/shard-costs.json` up
  to date from the per-file table in the shards' summaries; the time gate names a
  shard that runs over 1.5 times the others.
- `npm run test:nkey` runs the n-key lane (all four files, one after the other; CI runs each as a job of its own, `node --test
  test/nkey/<part>.nkey.ts`, with `NKEY_BASE` naming the commit whose page the time layer compares with, the merge base or the commit before a
  push to the main line). It needs no browser but is made for hosted runners: a timing run on the owner's Mac says nothing about them.
- `npm run test:e2e` builds the page and runs the browser file in headless Chromium,
  `npm run test:press-n-report` the report of n's time. The `browser` workflow
  (`browser.yml`) runs both on a main-line push, nightly, and when started by hand
  (`gh workflow run browser.yml --ref <branch>`, once the workflow is on `main`); they are not
  in the full CI. They need a Playwright browser and are never run on the owner's Mac.
- Four test layers, each catching what the one before cannot (design
  section 11): unit and server tests; the page in a fake DOM
  (`test/web.test.ts`), fast but without CSS or layout; the page in jsdom against
  the real server on a generated board (`test/dom`, run by `npm test`), for every
  check that needs no layout; the page in a real browser on the same board
  (`test/e2e`), for what needs a layout. A page bug gets its test in the lowest
  layer that can see it.
- Every page fix gets a witness in the lowest layer that can see its bug: a run
  on the page with the fix reversed (a literal text edit, `test/e2e/variant.ts`)
  that reports the bug (`test/dom/witnesses.ts` and the scenario files, or
  `test/web.test.ts` for the page's update). A fact only a real browser shows goes
  into the browser file (`test/e2e/browser.e2e.ts`: at most 15 tests, no
  reversed-fix variants of its own); a test added or changed there is shown to
  fail once on a page with the thing it guards spoiled, and its pull request
  records that run. No test reads git history.
- `make design-lint` checks the design tree's form and the checker's own tests;
  the `design` workflow runs it on every push. `make design-ready` is the
  readiness check, which the same workflow runs on a pull request that is ready
  for review and on `main`. Both need the submodule
  (`git submodule update --init design/skill`).

## Design tree

The shared rules' design-tree section applies; this is how it maps here.

- The live trees are the root nodes `design/<name>.md` named in `DESIGN_TREES`
  in the `Makefile`; a new root is added there. The change log is
  `design/log.md`; the checker is the submodule `design/skill`, changed only in
  Design-skill.
- The research record is `docs/design.md`: the derivations, measurements and
  data a node's reason cites, which a node links to the heading that holds them
  (a bold lead-in such as "Storage" has no anchor, so the link goes to its
  section). Tests slice `docs/design.md` by heading (`test/wake.test.ts`,
  `test/web.test.ts`): renaming or moving a heading they name breaks them.
  Deferred work is an item on the board, never a file here.
- A node records only what is in force on `main`. A change to a decision changes
  its node in the same pull request, with a new entry in `design/log.md`; a
  decision that is removed has its node retired with a rejection reason.
- The readiness check adds nothing to the shared rules'.

## Rules

- The main line is `main`: branch from it and merge into it.
- Board data lives in the directory `WF_BOARD_DATA` names, on the owner's Mac
  `~/dev/wf/wf-board-data` (private remote `Ming-Research/wf-board-data`).
  Only the daemon writes it; tests use temporary directories.
- The daemon binds `127.0.0.1` only.
- A test copy of the board uses its own port and a temporary data directory, never port 7417 or the board's data.
- A board rule (what a valid item is, how status rolls up) is defined once, in
  `src/model.ts` or `src/rules.ts`, and the agent guidance points to it.
- Board usage for agents lives only in the shared rules, section The board
  (the board's rule block `shared-rules`, assembled into every agent's rule
  file in `$WF_HOME/agents_config`), never in this file or in the server's
  instructions, which are a short pointer (`src/instructions.ts`, design
  section 6). When a change alters a tool's behavior or a board rule, its
  engineer hands the changes that section must take to the architect, as
  the engineer rules say (Always, Where the shared rules differ).
- A change to the page that the owner has not asked for in those words, or
  one that changes a rule an earlier test guards, goes to the owner on a card
  before the code changes: the engineer reports it to the architect, naming
  the rule.

## Deploy

A launchd job, `org.ming-research.wf-board-deploy`, deploys the main line within
five minutes of its checks turning green (`docs/design.md`, section 4, Deploying).
It asks GitHub (`gh`, signed in as the owner) for the checks on the head of `main`
and moves nothing while they run or when one is red; once they all passed it
fast-forwards `~/dev/wf/wf-board` to `main`, builds the page, restarts the
daemon when a changed path needs it, waits for `/health`, and goes back to the
last healthy commit when the daemon does not come up. Its log is
`~/Library/Logs/wf-board-deploy.log`; a head still waiting for its checks, or held
for a red one, leaves a line there on every run. A merge goes live as late as its CI
ends (a few minutes), and a red `main` stays off the live board until a newer green
commit or a rerun that passes.

Nobody deploys by hand. The deploy result goes to the
engineer holding the item that delivered the merge (the pull request in the
commit's title, the item whose 改动 section names it): `deployed` names the
version now served, and the engineer checks the change on the live page;
`deployFailed` says why nothing was deployed (a null version means the job
itself could not run, as when its fetch fails; the log has the detail), and
goes to the architect when no engineer holds such an item, where `deployed` is not
pushed at all (a red `main` is told by the board's own `main-red` push, to the same session). The job leaves a checkout alone that is on another branch, has local
changes to tracked files or has a commit the main line lacks, and pushes
`deployFailed` once; fix the checkout and the next run deploys. Checks it cannot read
(`gh` signed out, GitHub not answering) hold the deploy the same way and are pushed once.

Install once, after the PR that adds the job has been deployed by hand (the
merge does not install it):
`WF_BOARD_NODE=/opt/homebrew/opt/node@24/bin/node WF_BOARD_PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin node scripts/install-service.ts deploy`
writes the plist and prints the `launchctl bootstrap` command to run.

By hand, when the job is off, its own script broke, or `gh` cannot read the checks: fast-forward
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
