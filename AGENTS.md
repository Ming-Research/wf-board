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
- `src/mcp.ts`: MCP tools; `src/http.ts`: page, page API, events and wake
  stream; `src/main.ts`: the daemon.
- `src/convert.ts`: one-time conversion of the claude.ai artifact export.
- `src/convert-plans.ts`: one-time, lossless conversion from the old item
  structure to provisional plans, with an independent preservation check.
- `web/`: the owner's page (`index.html`, `app.ts`, `fresh.ts`, the index `n`
  walks, and `find.ts`, title search and reference tokens, as plain functions
  tests call directly), bundled by esbuild.
- `test/`: `node --test` suites; fixtures are synthetic. Real board data
  never enters this repository.

## Checks

- `npm run check` (TypeScript 7, strict, erasable syntax only: Node 24 runs
  the sources directly), `npm run build:web`, `npm test`. CI runs all three on
  every push.
- Run them locally only when small and needed; CI is the record.

## Rules

- Board data lives in `~/dev/wf-board-data` (private remote
  `Ming-Research/wf-board-data`). Only the daemon writes it; tests use
  temporary directories.
- The daemon binds `127.0.0.1` only.
- A board rule (what a valid item is, how status rolls up) is defined once, in
  `src/model.ts` or `src/rules.ts`, and the agent guidance points to it.

## Board tools

- Use `set_targets` for each goal's target value, current value and comparison baseline, updating the current value after measuring.
- Use `set_plan` for ordered steps, owned and shared items, decision cards
  and at least one acceptance step where the check happens, usually before
  merge or release rows. Status comes from the plan; `set_status`
  only cancels or reopens an item. `move_item` changes the item's owner.
- Only `总管` uses `set_pause` to pause or resume work, at the owner's
  request in a comment, with a reason when pausing. It preserves every plan row, applies through
  same-project ownership, and stops priority propagation and stalled clocks.
- Records have no acceptance step and pass no priority. Open work owned by
  a record stores no priority, but derives the highest priority from open
  shared dependents, or none without them. Record ownership passes none.
