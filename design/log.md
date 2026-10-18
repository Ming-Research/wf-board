# Design tree change log

Newest first. One entry for each pull request that changes the tree: a dated title, `Nodes:` naming every node added, changed or retired, and `Summary:`.

## 2026-10-17 Test the page in a DOM library between the fake DOM and the browser

Nodes: testing, testing/evidence, testing/press-n

Summary: The page's checks that need no layout (clicks that must land on what they claim, the cards, numbers, filters, search, the agent list, the messages list, and the few style facts read from the stylesheet) run in jsdom against the real server instead of in headless Chromium, so the layers become four and the browser layer keeps what needs a layout. Each moved check keeps a witness in the layer that runs it, on the page's source edited in memory. The page, agent list and message checks took 272 of the 806 seconds of the browser job on a hosted runner; the same checks in jsdom measured 217 seconds of processor time, so the gain is mostly that the files run side by side (docs/design.md, section 11, Four test layers). The link anchors of two nodes follow the renamed heading.

## 2026-10-17 Record the board's design decisions as a tree

Nodes: cards, daemon, daemon/lifecycle, daemon/repeated-writes, daemon/stateless-mcp, daemon/time-limits, deploy, deploy/page-reload, items, mcp, mcp/candidates, mcp/patrol-read, mcp/tool-errors, page, page/agent-list, page/diagrams, page/references, page/writes, plans, plans/ownership, plans/records, responsibility, responsibility/access, responsibility/credentials, responsibility/identities, storage, storage/activity, storage/concurrency, storage/history-reads, storage/identity-numbers, storage/owner-reading, storage/remote-push, storage/schema-evolution, storage/write-path, testing, testing/ci, testing/evidence, testing/press-n, testing/private-content, wake, wake/architect-stream, wake/delivery, wake/liveness, wake/messages, wake/routing, wake/transport, watch, watch/check-summary, watch/github-pushes

Summary: The tree starts from the decisions the board already rests on, with the grounds and refused alternatives that docs/design.md gives for them, organized by concept: the daemon, deployment, storage, plans, item fields, cards, responsibility and credentials, the MCP tools, the push channels, the GitHub watch, the page and testing. Decisions that approved work has removed or is removing (the item priority, the dispatch offer, the engineer pools and the watch of the Actions usage) are left out, and so are decisions for which the document records no ground; derivations and measurements stay in docs/design.md, which the nodes link.
