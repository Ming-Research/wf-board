# Design tree change log

Newest first. One entry for each pull request that changes the tree: a dated title, `Nodes:` naming every node added, changed or retired, and `Summary:`.

## 2026-10-18 Run the data repository's maintenance as a task of the write queue

Nodes: storage

Summary: The first version let git's own maintenance run in the foreground of the commit that triggers it, which removed the race between a background repack and the next write but held one write for 5.7 seconds on the live repository, over the three-second line. The board now turns git's maintenance off and runs a step of its own after every 100 commits as a task of the write queue, with a backlog maintained before the daemon listens; a step packs the loose objects, writes a commit-graph and merges the small packs in batches. The three choices (when, how many commits, what a step does) are the owner's rulings on the study's cards, with the measurements in docs/design.md, section Maintenance.

## 2026-10-18 Keep the page's rules across log writes and count the writes in the press-n test

Nodes: storage/write-path/page-rules-reuse, testing/press-n

Summary: The jump to the next unread change went over its limit on slow hosted runners while sessions wrote, because each write derived the whole board again on the page. The page now keeps what the rules before a write derived when the write changes nothing a status reads, and counts the filters of only the items the write reaches; a paired measurement put a write's cost at 0.46 of the main line's and the busy time while writing at 140 to 142 ms with the page throttled 1.3 times ([Write cost](../docs/design.md#4-architecture)). The press-n counts now cover writes, and the two counts that raced the 100 ms wait no longer depend on tens of milliseconds of real time ([Three test layers](../docs/design.md#three-test-layers)).

## 2026-10-17 Shard the script tests and gate the time of a full CI run

Nodes: testing/ci-shards, testing/ci-time-gate

Summary: The script tests of the full CI are dealt out to eight shards by the seconds each test file takes, kept in a table, and the last job of a run reports the run's total time against a 50 and 60 second line, only reporting until the browser tests leave the pull request's path. Both decisions come from the study of why the board's CI is slow; the measurements are in docs/design.md, sections Sharding the script tests and The time gate.

## 2026-10-17 Record the board's design decisions as a tree

Nodes: cards, daemon, daemon/lifecycle, daemon/repeated-writes, daemon/stateless-mcp, daemon/time-limits, deploy, deploy/page-reload, items, mcp, mcp/candidates, mcp/patrol-read, mcp/tool-errors, page, page/agent-list, page/diagrams, page/references, page/writes, plans, plans/ownership, plans/records, responsibility, responsibility/access, responsibility/credentials, responsibility/identities, storage, storage/activity, storage/concurrency, storage/history-reads, storage/identity-numbers, storage/owner-reading, storage/remote-push, storage/schema-evolution, storage/write-path, testing, testing/ci, testing/evidence, testing/press-n, testing/private-content, wake, wake/architect-stream, wake/delivery, wake/liveness, wake/messages, wake/routing, wake/transport, watch, watch/check-summary, watch/github-pushes

Summary: The tree starts from the decisions the board already rests on, with the grounds and refused alternatives that docs/design.md gives for them, organized by concept: the daemon, deployment, storage, plans, item fields, cards, responsibility and credentials, the MCP tools, the push channels, the GitHub watch, the page and testing. Decisions that approved work has removed or is removing (the item priority, the dispatch offer, the engineer pools and the watch of the Actions usage) are left out, and so are decisions for which the document records no ground; derivations and measurements stay in docs/design.md, which the nodes link.
