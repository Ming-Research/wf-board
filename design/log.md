# Design tree change log

Newest first. One entry for each pull request that changes the tree: a dated title, `Nodes:` naming every node added, changed or retired, and `Summary:`.

## 2026-10-18 Run the browser tests after a merge, not in a pull request's full CI

Nodes: testing/ci-time-gate

Summary: A run of the full CI started by hand leaves out the browser tests unless it is given the input `browser`; the browser tests run on each main-line push and every night, so a pull request's full CI takes the time of the script tests only. The time gate stays report-only, because a run with the browser tests still goes over the line; the node's condition for enforcing it now names the browser checks leaving the full CI. The study is in docs/design.md, section Fast checks while writing.

## 2026-10-17 Shard the script tests and gate the time of a full CI run

Nodes: testing/ci-shards, testing/ci-time-gate

Summary: The script tests of the full CI are dealt out to eight shards by the seconds each test file takes, kept in a table, and the last job of a run reports the run's total time against a 50 and 60 second line, only reporting until the browser tests leave the pull request's path. Both decisions come from the study of why the board's CI is slow; the measurements are in docs/design.md, sections Sharding the script tests and The time gate.

## 2026-10-17 Record the board's design decisions as a tree

Nodes: cards, daemon, daemon/lifecycle, daemon/repeated-writes, daemon/stateless-mcp, daemon/time-limits, deploy, deploy/page-reload, items, mcp, mcp/candidates, mcp/patrol-read, mcp/tool-errors, page, page/agent-list, page/diagrams, page/references, page/writes, plans, plans/ownership, plans/records, responsibility, responsibility/access, responsibility/credentials, responsibility/identities, storage, storage/activity, storage/concurrency, storage/history-reads, storage/identity-numbers, storage/owner-reading, storage/remote-push, storage/schema-evolution, storage/write-path, testing, testing/ci, testing/evidence, testing/press-n, testing/private-content, wake, wake/architect-stream, wake/delivery, wake/liveness, wake/messages, wake/routing, wake/transport, watch, watch/check-summary, watch/github-pushes

Summary: The tree starts from the decisions the board already rests on, with the grounds and refused alternatives that docs/design.md gives for them, organized by concept: the daemon, deployment, storage, plans, item fields, cards, responsibility and credentials, the MCP tools, the push channels, the GitHub watch, the page and testing. Decisions that approved work has removed or is removing (the item priority, the dispatch offer, the engineer pools and the watch of the Actions usage) are left out, and so are decisions for which the document records no ground; derivations and measurements stay in docs/design.md, which the nodes link.
