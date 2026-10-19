# Design tree change log

Newest first. One entry for each pull request that changes the tree: a dated title, `Nodes:` naming every node added, changed or retired, and `Summary:`.

## 2026-10-19 Bound the n-key time parts by a time budget

Nodes: testing/press-n

Summary: The time part of the n-key lane that presses while sessions write took 45 to 67 seconds as a job and ended last in 36 of 57 full CI runs read (10-19), where the time gate judges a minute. The cause was less the noise-driven extra rounds the lane makes (1 of 58 runs) than the runner: set-up and tear-down 6 to 19 seconds, the lane's start 10.6 to 22.3 seconds and a round 9.4 to 19.2 seconds, up to a factor of 1.7 apart between runners. The lane now bounds its pairs by time: a time budget of 34 seconds on the test process's clock cuts a round that has made 16 pairs and keeps a further round from beginning unless one as long as the last fits, widening the noise floor for the fewer pairs so that the twin still has to show the same noise per pair, and the witness (the page with 15 ms more per draw) is pressed for 10 pairs of the first round instead of every round. The page and the twin still make 30 pairs a round, the confirmation of a red is not limited by the budget, and the verdict reads as before. Four alternatives are recorded as refused. The derivation and the numbers are in docs/design.md, section 11, The n-key lane, The time budget.

## 2026-10-19 Continue the unread list and the daemon's rules from the state before

Nodes: storage, storage/write-path, storage/write-path/rules-reuse, storage/write-path/page-rules-reuse

Summary: After the quick fixes a `set_tags` write still cost the daemon 36.6 to 46.5 ms of CPU on hosted runners with nothing unread, and 55.5 to 75.7 ms with the owner 4,000 commits behind, because the open page asked for the whole unread list after every change event and each new head walked the history from the read cursor again; the daemon also derived the rules of every published state from nothing, about 16 ms a write in a profile, where the page already built them from the state before. The unread list is now carried on over the new commits of each head and the page gets only the stops after those its version shares; the daemon's rule cache is told which state each published one was made from and reuses the page's step. A write now commits exactly its own paths with `git commit --only` and no longer refuses while something is staged by hand, because starting a git process was about half of the remaining CPU and the start still refuses uncommitted board documents unless a board write to the document came first (node storage). The node page-rules-reuse is renamed rules-reuse, since its decision now governs the daemon's reuse as well as the page's. The refused alternatives (the page deriving the list, the change pushed with every event, the look at the index before every write, a look at the index in the maintenance step) are in the nodes; the numbers are in docs/design.md, section 4, Write cost.

## 2026-10-19 Judge the CI time gate without the wait for a runner

Nodes: testing/ci-time-gate

Summary: The time gate counted the seconds a job waited for a runner into the run's total, so a run in which one job started 45 seconds late was red with every other job done at 51 seconds (83 seconds, run 39211762302). Of the 52 runs started by hand with the current script (10-19), 8 ended over 60 seconds by the total, 5 of them only for the wait. The waits were read from the Actions API for 7,301 jobs of 143 runs of the organization: the organization's jobs running at once reached 60, the limit of its plan, in 9 runs, and single jobs were given a runner late in 5 of the other 134. The judged time now leaves out each job's wait beyond the quickest job's (the job that reads counting by its start) and adds the delay from the last end to the status; the total and the part of it that was waiting are written in the status description and the summary, a job that is slow itself still counts in full, and the 5 runs come to 46 to 55 seconds while the 3 whose jobs ran slow stay at 61 to 71. A push to the main line runs the same job in a mode that records the summary, writes no status and cannot fail the run, so that the main line keeps the table of waits of every merge. The grounds, the numbers and the refused alternatives (the total as before, the wait only written beside it, the longest job's own time with no wait counted, a run started again, fewer jobs in a run, the job on runs started by hand alone) are in the node; the measurements are in docs/design.md, section 11, The time gate. The node's reason for refusing limits on each job's own time alone no longer says that a lane can slow down by waiting for a runner, which the rule now leaves out, and says that the target is the minute of the whole run instead.

## 2026-10-19 Draw the state timeline of each agent

Nodes: mcp/timeline, storage/activity, page/agent-list

Summary: The agent list showed only the state an agent is in now, so where its time went (each turn, and each wait for CI, the owner, the architect or a 14900K run) could be found only by adding up the runner's lines in the item's log. The activity index now also keeps, for each item, the runner's reports that began a state, derived from the history's `report_state` commits (1463 of 32978 on the live board) by one function for live writes and the replay, so finished work has its lines too and the startup cache changes format once. One function cuts the line of one agent, a dispatch record: an engineer's from those starts and the item's pause spans (work for the turns, a named wait between them, a pause replacing the state), a review's or an architect's turn's as one stretch of work, with nothing before the first session or between two, and a session never finished ending where the next of its role began or the work ended; an item that passed through several agents has several lines. The `timeline` tool, a tool of its own beside `context` and `look`, and the runner's block draw the result: the tool within 6000 characters by folding the earliest segments, the block as a bar of fixed height in the last cell of the agent's row, where a stretch is drawn as long as it took up to three hours and a tenth beyond; the table begins at 900 px. The refused alternatives (one line for a whole piece of work, a fixed number of segments for each agent, a segment stored on the item at each report, a read of the item's history for each request, true scale, equal widths, a thin line under each row, a block apart from the table, a line for the architect's turn made from beats that live in memory) are in the nodes; the derivation is in docs/design.md, section 5 (the activity index) and section 7, Agent list.

## 2026-10-19 Watch the runner by a heartbeat

Nodes: daemon/runner-heartbeat, wake/routing, items

Summary: The board did not know when the runner, the one resident program that starts every engineer's turn, had stopped: its reports on the items stay as they were and only the beats of the turns running go quiet, which the agent list shows turn by turn, so every item could stop with nothing pushed. The runner now calls `report_heartbeat` at every round of its loop; the board keeps the time of the last call by its own clock in memory and in a local file (at most one write a minute), and tells the architect once with the new push `runner-stopped` when the later of that time and the daemon's start is more than 10 minutes old, after a first heartbeat has been kept; the file also keeps that the silence was told, so a restart does not tell it again, and the next heartbeat ends the silence. The 10 minutes are a provisional figure, as the runner's loop was not measured. The push has its own decision in `wake/routing`, with the architect as its one recipient. The same change adds a fifth dispatch result for work put down to wait, which the owner ruled is not giving it up, and `items` records that decision with the three refused ways of recording it. The refused alternatives for the heartbeat (the beats of `report_live`, memory only, a commit for each heartbeat, reading the runner's process) are in the node; the shape is in docs/design.md, section 8, The runner's heartbeat.

## 2026-10-19 Draw data charts with the library's own chart type

Nodes: page/diagrams/data-charts

Summary: Item text could draw flow and structure diagrams but no data chart, and the library the page bundles already draws a bar and line chart (`xychart`) that the page left unusable: its first series color is `#ECECFF`, 1.17:1 on a white page, a Chinese category without quotes is a lexical error, and a bar chart without a y range is cut at the smallest value. The page now gives the library eight series colors for each theme, a clear plate and a height of 360 px, so a chart is written in the same fence as any diagram and drawn in the page's colors; the checks are in the DOM layer (what the page asks) and in the browser layer (what the real library draws). A chart library with a fence of its own, a renderer of our own and images were refused. The grounds, the refused alternatives and the measurements are in the node and in docs/design.md, section 7, Diagrams, Data charts.

## 2026-10-19 Change a head in parts

Nodes: mcp

Summary: A head could be changed only whole, so changing a sentence meant reading the whole head and sending it back (583 whole-head rewrites in eleven architect sessions), and the architect wrote a script of its own that replaced exact texts, which it ran more than a hundred times. `update_item` now also takes `sections` (a whole section replaced by title) and `replace` (a text replaced, found exactly once); the edits are located in the head as it was and may not change the same text, so the order they are written in changes nothing, they are made together or not at all, a text found other than once names the edit and the count, the revision rule is that of a whole head, and the answer shows the lines before and after each change. The refused alternatives (a tool of its own, a patch text, texts only, edits one after another) are in the node; the rules are in docs/design.md, section 6, Changing things.

## 2026-10-19 Look at all the open work in one answer

Nodes: mcp/look, mcp/whole-view

Summary: The architect read the board one item at a time (1,193 `context` calls in eleven sessions) because the reads that show a whole each showed a corner, and six paused items were missed when the queue of engineers was filled. A new read, `look`, answers with the tree the owner's board shows, one line for each open work item, in a budget of lines the caller sets: it opens the subtrees that need a reader first, folds a pause into one line with its reason, counts a project's backlog apart, and puts every open item in a line or in a count. What a session saw at its last look is kept in the daemon's memory as a signature for each open item (not in the data repository), so the next look marks what changed, including changes no write made; the memory is kept under the credential's session together with the session the call names. The whole-view node now records what the code already did, that a backlog item the runner reports on is a row, which the look's header counts the same way. The grounds and the refused alternatives (a tree option on `whole_view`, only the time of the last look, a commit for each look, listing every item) are in the node; the shape is in docs/design.md, section 6, The look.

## 2026-10-19 List paused work and work with a start condition beside the candidates

Nodes: mcp/candidates

Summary: The candidates read listed only what could be started, so the architect, refilling the queue from it, answered that no work was left while six items of one project, paused or waiting in a backlog with a written start condition, had become startable under the owner's changed principle and nobody saw them. After each pool's candidates the read now lists, outside their count, the rated items nobody holds that cannot be started: paused work with who paused it, when, for how long and why, merged under the pause that holds it when more than three stand under it, and todo or idle work that cannot be started now (mostly backlog work) with the first sentence of its start-condition section and how long since it last changed, merged under its parent when more than three stand there, at most ten rows for a pool taken a project at a time. The refused alternatives (a separate tool, counting such work as candidates) are in the node; the rules are in docs/design.md, section 6, The candidates read.

## 2026-10-19 Write the CI status from a job that waits, and cache node_modules

Nodes: testing/ci-time-gate, testing/ci-job-setup, testing/ci-shards

Summary: The status `full-ci` came 59 to 65 seconds after a full CI was started (5 runs one after the other): 49 to 57 seconds to the last check, then 7 to 9 for the job that waited for the checks with `needs` to start, set itself up and write. The job that writes the status now starts with the run and waits in the time gate script until the others have ended, and writes the status itself; in three dummy-check rounds side by side it wrote 1 to 2 seconds after the last check, the job with `needs` 6 to 10 and a lean one with `needs` 5 to 6. No job of the full CI may then use `needs`, since such a job is not listed until the jobs it needs have ended, and a test holds that. The time gate's total now runs to the status. The job that writes has no timeout of its own, since a job cancelled for its timeout runs no step after it and the status would stay pending; each of its steps has a timeout (the script's 15 minutes) and the jobs it waits for have 10 minutes, so a job that hangs is cancelled and the script writes a failure naming it, unless the job started more than about 5 minutes late, and a step that times out fails and the step after it writes the failure. Each job that needs the packages gets `node_modules` from a cache keyed by the lock file and `package.json` instead of the cache of npm and `npm ci`: 8.5 seconds at the median for the set-up of a job that found the cache (8 jobs), 12.5 with the cache of npm (12 jobs), the ranges overlapping at 10 and no noise floor measured. The rejection of twenty-four shards in the sibling node names the set-up time of a job as one of its reasons, and now cites the shorter one as well. The grounds and the refused alternatives (a job that needs the others, the last check writing the status, a timeout on the job that writes, no cache, the flags of `npm ci`, the runner's own Node, a history without file contents) are in the nodes; the measurements are in docs/design.md, section 11, The time gate and The set-up of a job.

## 2026-10-19 Mark an item as standing

Nodes: plans/standing, plans, mcp/whole-view

Summary: The board could not say that a long-term promise with work under it, such as keeping board operations within their limits, is work that is always in force and never completes, so a never-ticked acceptance step held it up and status and the checks took it for an item about to complete: read on a copy of the board of 2026-10-16, four of the ten such items raised the check `only-acceptance-left` and all ten raised `difficulty-missing`. An item may now carry `standing: true`, set only by the architect and excluding the record mark, with no acceptance step and no difficulty. It is in progress while it is not paused or cancelled, whatever its rows say; its rows for other standing items are resolved and uncounted, and neither make the target awaited nor conflict with its pause; the checks that ask for acceptance or a rating do not apply; a row of an ordinary item that owns or waits for a standing item is refused, since it could never be resolved; the items it owns stay needed and startable; the whole view lists it only when something works on it. The first design also gave the sub-items of a standing item their own stored priority; the item priority was removed on 2026-10-17, so that part was dropped. The refused alternatives (a never-ticked acceptance step, a record, a tag the checks skip, a flag on a plan row) are in the node; the derivation is in docs/design.md, section 5, Standing items.

## 2026-10-19 Flag a head older than a ruling

Nodes: cards

Summary: An item's approach section could stay at its start after its research, its direction card and its design approval were done, because the rule that the head is current had no check, and the owner, who does not read pull requests, then saw no design. The board now raises the check `approach-stale` on an open work item that has a ruled card whose ruling time is in a later second than the head's last revision, read from the item's creation time and the latest log entry that says the head changed (4,836 such entries on the live board on 2026-10-19), and it clears when `update_item` next changes the head; a card of any kind counts, and a write is never refused. The grounds and the refused alternatives (the design document copied into the item, a stored time of the head's revision, the item's `updated`, design cards only, leaving paused items out) are in the node; the check's definition is in docs/design.md, section 5, Checks.

## 2026-10-19 Give a card a kind

Nodes: cards

Summary: A card had one structured field about what it asks of the owner, `blocks`; whether it was a design card, a rule card or another question was written only in the question's text, so the merge check of the runner, which holds a design card not yet ruled and lets an inquiry card pass, read a bracketed category at the start of the question and held an inquiry card whose question had none. A card now has a `kind`, `design`, `inquiry` or `rule`, which `write_card` requires when it creates the card, a revision may change, and `context` shows as a line `kind: design` on the card and in its item. A card written before the field has none stored and is read as `design`, which is what the check did to it before; the architect sets the kind of each old open card with `write_card`. The refused alternatives (a category written in the question, a hold only for blocking cards, a migration that writes a kind into every card) are in the node; the shape is in docs/design.md, section 5, Decision cards.

## 2026-10-19 Remove what a press of n inherits from the presses of other windows

Nodes: testing/press-n

Summary: The time layer of the n-key lane read a page the same as its base as slower: over 60 runs the twin of the base was 0.77% slower in the writing phase (standard error 0.20%), and a changed page was red in 4 of 26 runs. A probe on hosted runners found the cause in what the windows of one process share: the young generation of the heap, whose collection is paid by whichever press fills it, and the code V8 compiles once for equal source texts, paid by the window that reaches a function first; the rotating order put the base right after the slow witness in three presses of four. Each press now starts after a minor collection, each window evaluates a source text of its own, and each round opens its windows in a random order, collects fully once they are open and presses in a random order, with a seed of each run's own, since a fixed cycle in which each window follows each other once still left the base about 1% slower than its twin and the window opened first read about 1% slower while writing; identical windows then agree within their noise (with the fixed cycle and five windows the twin read +0.37% writing and -0.26% quiet, standard errors 0.27% and 0.50%). A residual bias of about 0.6% in the quiet phase, and of 1-3% between identical windows over 90 pairs, was not traced; the twin's interval now counts the run when it is within the noise floor wherever it lies, a page is judged against a reference that is per pair the geometric mean of the base and the twin, since a twin required to hold 1 left pages 7-8% slower undecided and requiring a page to be slower than each of the two let one slow reference window pass a page 6% slower, and a page judged slower is measured again in fresh windows and red only when both runs agree. The refused alternatives (a full collection, the busy time less the pauses, a single-threaded V8, the rotation, the fixed cycle, pooling parallel jobs, a 99% interval, a twin that must hold 1, slower than each of base and twin) are in the node; the data are in docs/design.md, section 11, The n-key lane.

## 2026-10-19 Let the runner report a wait for an event

Nodes: items

Summary: The runner has a state for work that waits for an event settled beforehand (its restart, the main line's next merge, a set time) and needs no one, but the board had no such state, so the runner reported it as an ask to the architect and the agent list marked it overdue after that ask's one hour, a wait of a day being amber for 23 hours with nothing to look at. A report may now be in the state `wait`, with the event as its own field `what` and an optional UTC wake time `until`; the lists show the event after a word for waiting, with the wake time when there is one, and the wait is on time until an hour after `until` or, with none, for 24 hours (provisional like the other limits), `since` moving when either field changes. The grounds and the refused alternatives (the ask to the architect, the event in the note, no limit without a wake time) are in the node; the derivation is in docs/design.md, section 5, Runner reports.

## 2026-10-18 Deal the script tests out to twenty shards

Nodes: testing/ci-shards

Summary: With the test files of 25 seconds and more split in two or more, the largest file no longer sets the time of a shard: its step takes about the sum of its files' seconds divided by three plus a second, so the number of shards does. Sixteen shards left the shard that ended last 49 to 56 seconds after the start of the run in four runs on hosted runners (median 53), over the 50 seconds a typical run aims at; twenty shards left it 46 to 51 seconds in five runs (median 50), and twenty-four shards, tried in one run, shortened the longest job by only a second. The full CI now deals the tests out to twenty shards. The splitting raised the sum of the files' seconds from about 920 to about 1,090, since every page file builds its own board, so the count stays provisional. The grounds and the refused counts are in the node; the measurements are in docs/design.md, section 11, Sharding the script tests.

## 2026-10-18 Draw the runner's work on the agent list as a table

Nodes: page/agent-list

Summary: The runner's rows were small cards of two or three lines that did not line up: the item's key came first in monospace, a long state text wrapped into a box that pushed the next rows down, a commit id, a path of the runner's machine and an item key stood in the text, and the level and the elapsed time were written twice. The rows are now the rows of a table, one line each: the title first with the level as a number, the state in a word, one line of what the work does or waits for (cut to one line, the whole on the hover), how long in the state and how long in all, with the keys on hovers only, commit ids and machine paths left out, and the work a person has to look at ordered first; in a narrow column a row falls to three lines. The decision that the block lists every job the runner holds, unfolded, is kept; only its wording "in the whole view's words" is dropped, because the list now has words of its own. Grounds and the rejected groups by state and tidied cards are in the node; the derivation is in docs/design.md, section 7, Agent list.

## 2026-10-18 Keep the page's structure through a write that reused the rules

Nodes: storage/write-path/page-rules-reuse, testing/press-n

Summary: A write that reused the rules still made the page build its order of the items, who waits on whom, the ancestors of open work, the counts by status, the stops that wait on the owner and the unread stops from nothing at every draw, about 9 of the 31 ms a write cost the page on a hosted runner, and a write draws once, so a cache emptied when the data changes would not have saved it. The page now keeps these, as ids, through a change that reused the rules and left every changed item's head as it was, and makes the unread stops again when the unread list is another one; any other change, a snapshot and the minute make them again. The n-key lane's counts hold that a log write makes none of them again. The grounds and the refused alternatives (accounting item by item, caching whole lists by data) are in the node; the derivation is in docs/design.md, section 7, The page.

## 2026-10-18 Deploy a main-line commit only when its checks passed

Nodes: deploy

Summary: The deploy job moved the checkout to the main line's head as soon as it saw it, so a merge whose checks went red afterwards (the main line's `nkey time-writing` check on a merge of 10-18) was live within a minute, while the main line's CI takes 2 to 13 minutes. The job now asks GitHub for the checks on the head it fetched, by the commit's id and with the reading the board's look at the main line uses, and deploys only when all of them passed: a head whose checks are running or have not appeared is waited for at the next run, one with a red check is held until a newer commit passes or the check passes on a rerun, and checks that cannot be read hold the deploy and are pushed once. The head alone decides, so a batch of merges is still one deploy and one restart. The grounds and the refused alternatives (deploying at once, the newest green commit among those not yet live, a branch pointer the CI moves) are in the node; the derivation is in docs/design.md, section 4, Deploying.

## 2026-10-18 Give every session name that starts with the architect's the architect's rights

Nodes: responsibility/identities, wake/architect-stream

Summary: The owner runs several architect sessions at once (the conversation, one that tidies old projects, one that works as the observer), but the board gave the architect's write rights to two names only, so an auxiliary session either took the conversation's pushes by writing under its name or wrote as an ordinary project author that cannot create items in other projects, retitle or write the architect's log. The rights now go to every session name that starts with the architect's name (spaces around it ignored), the pushes and the exclusion of the architect's own writes from its timed wake stay with the exact name, and a credential of another role under such a name and a dispatch for one are refused. The grounds and the refused alternatives are in the identities node; the derivation is in docs/design.md, section 8, The architect's sessions, and section 9.

## 2026-10-18 Keep the browser tests in one small file that runs after a merge

Nodes: testing, testing/browser-file, testing/ci, testing/ci-shards, testing/ci-time-gate, testing/evidence

Summary: What only a real browser shows is one file of at most 15 tests on one browser, one board and one page, with no spoiled-page variants, held to 90 seconds by its step's `timeout` and to 15 tests by a unit test, and a report of one press of n in a real browser that judges nothing; both run in a workflow of their own after each merge to the main line, every night and by hand, not on a pull request, so the full CI's total is the script tests' and its time gate is enforced instead of only reporting. A fact that needs a layout is shown to fail on a spoiled page once, when its test is written, and the pull request records that run; the witness file of the browser layer is gone. The grounds, the measurements and the refused alternatives are in the browser-file node and docs/design.md, section 11, The browser file. With the browser's checks now in the suite, the script tests are dealt out to sixteen shards instead of eight, because eight took 73 seconds against the time gate's 60 (section 11, Sharding the script tests); the full CI's node no longer gives twelve minutes as its reason for starting by hand.

## 2026-10-18 Draw the runner's work on the agent list and keep its beats in memory

Nodes: page/agent-list, daemon/live-state

Summary: The agent list read only what sessions write to the board, so the work the runner holds (turns of a minute to ten, waits for CI, a card or the architect) was invisible between writes, and the owner could not tell whether it was running. The list now draws each piece of work the runner holds from the runner's report on the item and the engineer's dispatch record, in the whole view's words and limits, and leaves those sessions out of the older rows, which now list only the sessions a dispatch record names: the board has no PM any more, and the runner, the architect's turns it starts and the board itself, which the older list showed as agents, have no dispatch record. For the inside of a turn the runner beats about every 30 seconds, and the board keeps the newest beat for each turn in the daemon's memory only, with no commit, and sends it to the open pages as an event; a beat not repeated for 90 seconds is shown as silent. The grounds and the refused alternatives (a commit for each action, the report renewed every five minutes, the board asking the runner) are in the two nodes; the derivation is in docs/design.md, section 7, Agent list and The live view of a turn.

## 2026-10-18 Retire the PM's pushes, push stream and identity

Nodes: wake, wake/routing, wake/architect-stream, wake/liveness, wake/delivery, wake/messages, watch, watch/github-pushes, responsibility, responsibility/identities, responsibility/credentials, items, storage, storage/remote-push, daemon/time-limits, deploy, page/agent-list, testing/press-n

Summary: The PM is retired, but the board still pushed nine kinds of push to the PM's stream, counted the architect's calls as that stream's receipts (so pushes nobody read were marked delivered, and the owner was told "the PM did not answer" whenever the architect's conversation was closed), and let any session write the whole process as author `PM`. The kinds that served only the way the PM worked are no longer made (the PM's timed wake, work that has gone quiet, a review step, a finished item, a session that did not answer, a red pull request, an unnamed pull request), the ones still useful go to the architect (a remote copy that stays behind, a slow operation, a failed deploy or red main line that nobody holds), the PM's stream and its receipts are gone while the alert that the architect's stream is behind stays, the author `PM` is refused like the coordinator, the PM has no credential role, and an item the runner reports on is no longer asked whether its session is there. Pushes fall from 19 kinds to 12. The grounds and the refused alternatives are in the nodes; the derivation is in docs/design.md, section 8, The PM is retired.

## 2026-10-18 Close a plain pick's note in the commit that rules its card

Nodes: cards, wake/routing

Summary: A pick the owner sent on the page ruled its card at once, but its note, which says only which option was chosen, stayed `sent`, so the architect closed it by hand and the runner started an engineer turn to read it. The commit that rules the card now also writes that note `done` when it says nothing but the option; a pick with the owner's words, or one sent after its card was ruled otherwise, stays `sent`. The note push no longer carries a plain pick, so `card-ruled` goes to the session holding the card's item and, when nobody holds it, to the architect for a pick sent on the page. The grounds and the refused alternatives are in the two nodes; the derivation is in docs/design.md, section 5, Decision cards, Ruling, and section 8, A card ruled.

## 2026-10-18 Hold the jump to the next unread change in Node, against the base page

Nodes: testing/press-n

Summary: The checks of the jump to the next unread change ran in headless Chromium, held a fixed 0.2 second median and 0.3 second 90th percentile that failed on slow runners, and took most of the browser job. They now run the real page in jsdom in Node with the server's answers recorded once and replayed: the counts (draws, rebuilds of the rules, filter counts, markup written, elements made, each with a page that has the protected part taken out) hold on any machine, and the time is the page of the commit over the page of its base in interleaved pairs with a twin of the base as the control, red only when the interval lies wholly on the slower side and the twin shows the run's noise. The absolute 0.2 seconds no longer fails a pull request; the grounds and the numbers are in the research record.

## 2026-10-18 Draw the page's diagrams compact

Nodes: page/diagrams/layout

Summary: A synthetic role chart was drawn 3420 px high and a chart with three lanes 2477 px, boxes filling 16% of the drawing, and the page's gap settings did nothing because ELK does not read them. The page now asks the library for the classic look, 8 px of padding in a box and 20 px between boxes and between layers, and the bundled library entry wraps the call that hands each graph to ELK so that ELK takes those gaps from the diagram's configuration on the graph and every subgraph, keeping a 12 px straight run before an arrowhead; the role chart comes out 2406 px and the lanes 1657 px, every arrow entering from above. The grounds and the refused alternatives are in the node; the measurements are in docs/design.md, section 7, Diagrams.

## 2026-10-18 Give the architect's turns the architect's rights and none of its pushes

Nodes: responsibility/identities, wake, wake/architect-stream, items

Summary: The runner could not report its state either: without a credential the board let only the PM and the architect write the report, and the runner has none, so each report was refused. The runner's own session name may now do that one part and nothing else of the process, its name is reserved like the others, and the two dispatch tools, which pass without a credential on the item's project alone, keep doing so. The turns the runner starts to answer an engineer write under a session name of their own, so that they do not take the pushes of the architect's conversation, but the board gave the architect's rights to the conversation's name alone, so a turn could not write on the engineer's item. The architect's rights now go to both names, and the pushes, a call's receipt for the PM's stream and the exclusion of the architect's own writes from its timed wake stay with the conversation's name; a credential of the architect's role may carry either name, and no other role or dispatch may. The grounds and the refused alternatives are in the identities node; the derivation is in docs/design.md, section 8, The architect's turns, and section 9.

## 2026-10-18 Show the architect and the owner the whole board's open work in five kinds

Nodes: items, mcp/whole-view

Summary: The architect had no one call that said which open work is being done, which waits and for what, which is set aside on purpose, and which nobody holds, and the owner's page had no such view. The runner's state is now a field of the item, written by the PM and the architect only and never news to the owner, and the open work is put into five kinds (waiting too long, nobody's, being worked on, waiting, set aside) by one function that the `whole_view` tool prints and the page draws, with a bounded answer and the time limits in one provisional object. The grounds and the refused alternatives are in the two nodes; the derivations are in docs/design.md, section 5, Runner reports, section 6, The whole view, and section 7, The whole view.

## 2026-10-18 Check the page's diagrams in the DOM layer against a stand-in library

Nodes: testing

Summary: The checks of the page's diagrams that are the page's own doing (states and errors of a block, when and how often the library is asked for, the strict level, repaint, ids, zoom, drag, toolbar, theme) run in jsdom against a stand-in for the diagram library and a model of the diagram boxes, with each check's spoiled page, instead of in headless Chromium; the browser layer keeps what only the real library and a real layout show. The file took 190 seconds of the browser job on a hosted runner; the 42 checks moved run in two files of the DOM layer (docs/design.md, section 11, Four test layers). The grounds and the refused alternatives are in the node.

## 2026-10-18 Let a text write stand when the fields it replaces did not change

Nodes: storage/concurrency

Summary: A text write on a revision that is behind is refused only when a field it replaces changed since; a log line or a plan row added by someone else no longer fails it, and the answer says what changed meanwhile. The refusal on a changed field, a revision that cannot be read back and the switch to or from a record, which rewrites the plan's acceptance rows, are as before. The count (four of six refusals came from a log line) is from the transcripts of two days; the derivation is in docs/design.md, section Data format.

## 2026-10-18 Tell the session holding a card's item when the card is ruled

Nodes: wake/routing

Summary: A card ruled on the page reached only the architect, as the owner's note, and an engineer stopped on the card stayed stopped for two days because the ruling was not forwarded. The board now also pushes `card-ruled` to the session holding the card's item when an open card becomes ruled, by the page or by `rule_card`, and to no one when nobody holds the item; the grounds and the refused alternatives are in docs/design.md, section 8, A card ruled.

## 2026-10-18 Tell the sessions that wait on an item when its merge row is done

Nodes: wake/routing

Summary: An engineer that waited for another item's pull request to merge learned of the merge only when the architect found it on a patrol, because the board pushed only when an item was wholly done, which is after its deploy and live check. The board now pushes `dep-merged` when a merge row turns done, to the session holding each open item with a shared row on it, and to the architect for one nobody holds; the grounds and the refused alternatives are in docs/design.md, section 8, A merge a waiter waits on.

## 2026-10-18 Test the page in a DOM library between the fake DOM and the browser

Nodes: testing, testing/evidence, testing/press-n

Summary: The page's checks that need no layout (clicks that must land on what they claim, the cards, numbers, filters, search, the agent list, the messages list, and the few style facts read from the stylesheet) run in jsdom against the real server instead of in headless Chromium, so the layers become four and the browser layer keeps what needs a layout. Each moved check keeps a witness in the layer that runs it, on the page's source edited in memory. The page, agent list and message checks took 272 of the 806 seconds of the browser job on a hosted runner; the same checks with their spoiled-page runs measured 220 seconds in 13 files of a hosted runner each, none longer than 27 seconds, so the gain is that the files run side by side (docs/design.md, section 11, Four test layers). The link anchors of two nodes follow the renamed heading.

## 2026-10-18 Run the data repository's maintenance as a task of the write queue

Nodes: storage

Summary: The first version let git's own maintenance run in the foreground of the commit that triggers it, which removed the race between a background repack and the next write but held one write for 5.7 seconds on the live repository, over the three-second line. The board now turns git's maintenance off and runs a step of its own after every 100 commits as a task of the write queue, with a backlog maintained before the daemon listens; a step packs the loose objects, writes a commit-graph and merges the small packs in batches. The three choices (when, how many commits, what a step does) are the owner's rulings on the study's cards, with the measurements in docs/design.md, section Maintenance.

## 2026-10-18 Run the browser tests after a merge, not in a pull request's full CI

Nodes: testing/ci-time-gate

Summary: A run of the full CI started by hand leaves out the browser tests unless it is given the input `browser`; the browser tests run on each main-line push and every night, so a pull request's full CI takes the time of the script tests only. The time gate stays report-only, because a run with the browser tests still goes over the line; the node's condition for enforcing it now names the browser checks leaving the full CI. The study is in docs/design.md, section Fast checks while writing.

## 2026-10-18 Keep the page's rules across log writes and count the writes in the press-n test

Nodes: storage/write-path/page-rules-reuse, testing/press-n

Summary: The jump to the next unread change went over its limit on slow hosted runners while sessions wrote, because each write derived the whole board again on the page. The page now keeps what the rules before a write derived when the write changes nothing a status reads, and counts the filters of only the items the write reaches; a paired measurement put a write's cost at 0.46 of the main line's and the busy time while writing at 140 to 142 ms with the page throttled 1.3 times ([Write cost](../docs/design.md#4-architecture)). The press-n counts now cover writes, and the two counts that raced the 100 ms wait no longer depend on tens of milliseconds of real time ([Four test layers](../docs/design.md#four-test-layers)).

## 2026-10-17 Shard the script tests and gate the time of a full CI run

Nodes: testing/ci-shards, testing/ci-time-gate

Summary: The script tests of the full CI are dealt out to eight shards by the seconds each test file takes, kept in a table, and the last job of a run reports the run's total time against a 50 and 60 second line, only reporting until the browser tests leave the pull request's path. Both decisions come from the study of why the board's CI is slow; the measurements are in docs/design.md, sections Sharding the script tests and The time gate.

## 2026-10-17 Record the board's design decisions as a tree

Nodes: cards, daemon, daemon/lifecycle, daemon/repeated-writes, daemon/stateless-mcp, daemon/time-limits, deploy, deploy/page-reload, items, mcp, mcp/candidates, mcp/patrol-read, mcp/tool-errors, page, page/agent-list, page/diagrams, page/references, page/writes, plans, plans/ownership, plans/records, responsibility, responsibility/access, responsibility/credentials, responsibility/identities, storage, storage/activity, storage/concurrency, storage/history-reads, storage/identity-numbers, storage/owner-reading, storage/remote-push, storage/schema-evolution, storage/write-path, testing, testing/ci, testing/evidence, testing/press-n, testing/private-content, wake, wake/architect-stream, wake/delivery, wake/liveness, wake/messages, wake/routing, wake/transport, watch, watch/check-summary, watch/github-pushes

Summary: The tree starts from the decisions the board already rests on, with the grounds and refused alternatives that docs/design.md gives for them, organized by concept: the daemon, deployment, storage, plans, item fields, cards, responsibility and credentials, the MCP tools, the push channels, the GitHub watch, the page and testing. Decisions that approved work has removed or is removing (the item priority, the dispatch offer, the engineer pools and the watch of the Actions usage) are left out, and so are decisions for which the document records no ground; derivations and measurements stay in docs/design.md, which the nodes link.
