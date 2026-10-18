# Design tree change log

Newest first. One entry for each pull request that changes the tree: a dated title, `Nodes:` naming every node added, changed or retired, and `Summary:`.

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
