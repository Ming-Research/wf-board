# Design tree change log

Newest first. One entry for each pull request that changes the tree: a dated title, `Nodes:` naming every node added, changed or retired, and `Summary:`.

## 2026-10-19 Remove what a press of n inherits from the presses of other windows

Nodes: testing/press-n

Summary: The time layer of the n-key lane read a page the same as its base as slower: over 60 runs the twin of the base was 0.77% slower in the writing phase (standard error 0.20%), and a changed page was red in 4 of 26 runs. A probe on hosted runners found the cause in what the windows of one process share: the young generation of the heap, whose collection is paid by whichever press fills it, and the code V8 compiles once for equal source texts, paid by the window that reaches a function first; the rotating order put the base right after the slow witness in three presses of four. Each press now starts after a minor collection, each window evaluates a source text of its own, and each round opens its windows in a random order, collects fully once they are open and presses in a random order, with a seed of each run's own, since a fixed cycle in which each window follows each other once still left the base about 1% slower than its twin and the window opened first read about 1% slower while writing; identical windows then agree within their noise (with the fixed cycle and five windows the twin read +0.37% writing and -0.26% quiet, standard errors 0.27% and 0.50%). A residual bias of about 0.6% in the quiet phase, and of 1-3% between identical windows over 90 pairs, was not traced; the twin's interval now counts the run when it is within the noise floor wherever it lies, a page is judged against a reference that is per pair the geometric mean of the base and the twin, since a twin required to hold 1 left pages 7-8% slower undecided and requiring a page to be slower than each of the two let one slow reference window pass a page 6% slower, and a page judged slower is measured again in fresh windows and red only when both runs agree. The refused alternatives (a full collection, the busy time less the pauses, a single-threaded V8, the rotation, the fixed cycle, pooling parallel jobs, a 99% interval, a twin that must hold 1, slower than each of base and twin) are in the node; the data are in docs/design.md, section 11, The n-key lane.

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
