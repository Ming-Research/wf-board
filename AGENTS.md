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
- `src/mcp.ts`: MCP tools; `src/instructions.ts`: the server's instructions,
  where agents learn how to use and write on the board; `src/http.ts`: page,
  page API, events and wake stream; `src/main.ts`: the daemon.
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
  of the live board's size; CI runs it on this tree and on the commit the
  branch started from, as a step that never fails the run.

## Checks

- `npm run check` (TypeScript 7, strict, erasable syntax only: Node 24 runs
  the sources directly), `npm run build:web`, `npm test`. CI runs all three on
  every push.
- `npm run test:e2e` builds the page and drives it in headless Chromium;
  CI's `e2e` job runs it on every push. It needs a Playwright browser and is
  never run on the owner's Mac.
- Three test layers, each catching what the one before cannot (design
  section 11): unit and server tests; the page in a fake DOM
  (`test/web.test.ts`), fast but without CSS or layout; the page in a real
  browser on a generated board (`test/e2e`). A page bug gets its test in the
  lowest layer that can see it.
- Run them locally only when small and needed; CI is the record.

## Rules

- Board data lives in `~/dev/wf-board-data` (private remote
  `Ming-Research/wf-board-data`). Only the daemon writes it; tests use
  temporary directories.
- The daemon binds `127.0.0.1` only.
- A board rule (what a valid item is, how status rolls up) is defined once, in
  `src/model.ts` or `src/rules.ts`, and the agent guidance points to it.
- Board usage for agents lives only in the server's instructions
  (`src/instructions.ts`, design section 6), never in this file. A change to a
  tool's behavior or to a board rule changes them in the same commit; keep
  their first 2048 characters self-contained, since Claude Code cuts there.
