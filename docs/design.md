# wf-board design

Item plans (section 5) and plan conversion (section 10) are the owner's
approved design of 2026-10-13. Project responsibility in sections 8–9
records the owner’s settled decisions and supersedes per-item `agent` ownership
and per-project lists of agent session names.

## 1. Problem

The status board that the owner and every agent session share was a claude.ai
artifact. Its data lived in
the artifact's database, read and written with the ArtifactData tool, and its
"发给 Claude" button woke the watching session through the artifact runtime's
comment API (`comments.sendToClaude`).

The board was tied to the account that published it: from another account,
Claude Code can read the page but not its data ("that organization doesn't let
invited editors use artifact data from Claude Code"), and the help center
documents no setting that lifts this for outside invitees. An account switch
therefore cuts every session off from it.

The board is more than a progress display. Its 835 items, 161 decision cards
and 374 owner notes are the shared context of all projects: what each line of
work is, why it was chosen, what it waits on and what the owner ruled. Agents
read and write it all day (from the session transcripts since 2026-10-06:
about 720 item reads, 800 item writes, 600 batches, 130 queries for sent
notes).

## 2. Goals

1. The board works independently of any claude.ai account.
2. Agents find context easily: search across everything, the history of an
   item, why it exists, what it depends on and what depends on it, what
   changed while they were away.
3. Writes are hard to get wrong: the server stamps times, checks the board's
   rules (every row's target exists, every item is owned by at most
   one plan row and never across projects, a work plan has at least one
   acceptance step, a cancelled item says why), and refuses a stale
   overwrite. Today these rules are prose in AGENTS.md that agents must
   remember, and the page only flags violations after the fact.
4. Every change is kept with who made it and when, and nothing is lost.
5. The owner keeps the page as it is today, opened in the desktop app's
   browser pane, including one-click "发给 Claude".

Non-goals for now: access from the owner's phone or other machines, cloud
sessions, multiple human users, authentication beyond binding to localhost.

## 3. What the data shows

From the export of 2026-10-11 07:17 UTC (`wf-board-data/import/`):

| Fact | Consequence for the design |
|---|---|
| Item bodies total about 900k characters; half the items have no log, the largest has 19k characters and 35 log entries | Nobody can read the board whole. Search first, then expand; context returns recent log entries by default and the rest on request |
| 23 areas (top-level items), depth at most 4, 126 parents, one with 77 children | Listings page and summarize |
| 649 deps, 631 with a why; 61 cross areas and 48 cross projects | The dependency graph must span projects and always carry the why; that is where context crosses sessions (since item plans, a row's place in its plan replaces the why; section 5) |
| 150 of 161 decision cards are ruled, each with background, options and ruling | Ruled cards are the main record of why; search covers cards and notes, not only items |
| 1536 bare `#NNN` references in 269 items, without the repository | Index PR references per repository; new text writes `Repo#N` |
| 478 read records holding a full snapshot each (473 KB) | With git history a read needs only a commit id; the snapshot goes |
| `agent` appears only on the 23 areas; no sub-item ever used the handover field | Responsibility is effectively per area plus prose in logs; see section 9 |
| Agents' own pattern: read an item, append a log entry, write the item back with its version (the majority of all writes); 5 version conflicts and several malformed calls in the transcripts | `append_log` becomes one call without a version; appends never conflict |

## 4. Architecture

One local daemon, `wf-board`, written in TypeScript on Node 24, bound to
`127.0.0.1` only. It serves three things from one process:

1. **The page** for the owner, at `http://127.0.0.1:7417/`, with live updates
   pushed over server-sent events.
2. **MCP** for agents, over Streamable HTTP at `/mcp`. Every Claude Code and
   Codex session on the Mac connects to the same process.
3. **The wake stream** at `/wake` (WebSocket), which pushes the architect's
   session what needs it: owner notes, stalled work and a timed wake.

**Why one daemon rather than an MCP subprocess per session.** The usual MCP
setup starts one server process per session (stdio). Several processes
writing the same files would need cross-process locking and could not push
changes to the page. A single process is the only writer, serializes all
writes, and pushes every change to the page and to waiting sessions.

**Why TypeScript.** The page's derived rules (an item's status from its
plan, priority, the 需核对 flags, freshness) are JavaScript
today. One module, `src/rules.ts`, serves both the page and the server, so an
agent sees exactly the flags the owner sees. MCP has an official TypeScript
SDK.

**Storage.** The data is a git working tree, `wf-board-data` beside the wf-board checkout (`~/dev/wf/wf-board-data` with the checkout at `~/dev/wf/wf-board`; `WF_BOARD_DATA` overrides it), with the
private remote `Ming-Research/wf-board-data`. The server is the only writer:
each logical operation is one commit whose author is the writing project (or
`owner` for an owner operation) and whose message summarizes the operation. The server pushes to the remote when
it has new commits, at most every ten minutes, and on shutdown. If the server
is down, agents can still read the files with Grep and Read; nothing is
hidden in a database.

**Running.** A launchd agent starts the daemon at login and restarts it on
exit. `GET /health` reports its state; the page shows a banner when the server
does not answer, and every MCP tool error names the cause.

**Write cost.** The live board (about 1,500 items, 600 cards, 750 notes and
14,000 content writes in its history) cost 0.28–0.4 s of daemon CPU per
write, a quarter of it garbage collection, because each write deep-copied the
whole board twice and derived the board from scratch about eight times. The
derivation design that replaced this:

- The store publishes one frozen snapshot and never copies it. A write copies
  only the collections it changes, inserts its new documents frozen, and the
  result is the next published snapshot; earlier snapshots stay valid and
  unchanged for whoever holds them.
- One `Rules` object serves every reader of a snapshot (`store.derived`: MCP
  reads, the check scan, the "before" side of a write's validation) within the
  same minute; a Rules object reads the clock only for elapsed time (active
  time, doing days), so its results are exactly `rules(snapshot, t)` for the
  time `t` of the first read in that minute. A prospective state inside a
  write gets one Rules object, built again only when the write changes it.
- The activity times the stalled check reads are parsed once and kept as an
  index (`ActivityIndex` in `src/rules.ts`), advanced per snapshot by
  comparing documents by identity instead of rescanning every log, note and
  write. Without an index, `rules` scans the snapshot as before; the
  equivalence of the two after random writes is a test.
- A change event carries the activity's change, not the whole index (see the
  stalled-work rule); the page keeps its copy current from it.
- The check scan after a write, and the page's repaint after a live update,
  rederive only the items the write can reach (`affectedItems` in
  `src/rules.ts`): the written items, cards and notes, then along plan edges
  while an item's derived summary changes, plus every reached item's
  ancestors, and the items whose doing steps name a reached item or one of its
  ancestors (their stalled clock reads it, see the stalled-work rule). A
  change of elapsed time alone is left to the minute timers, which rescan and
  repaint everything as before.
- A step diff for the page is kept by its two commits and path, which name
  the same text forever, so a reload asks git again only for new steps.

`scripts/bench-writes.ts` measures this path on a synthetic board of the live
board's size (CPU and garbage collection per write, bytes per change event,
peak memory); the `bench` workflow runs it by hand on this tree and on a base
commit, without gating.

**Connecting.** `claude mcp add --scope user --transport http wf-board
http://127.0.0.1:7417/mcp` once for Claude Code, and the equivalent entry in
`~/.codex/config.toml` for Codex. Whether the desktop app's Code sessions read
the user-scope configuration must be checked on the first session.

## 5. Data format

The server writes, agents and the owner read. The format serves three
readers: the server, which needs every field unambiguous; git, whose diffs
should show the changed lines of prose rather than one rewritten line; and an
agent reading with Grep or Read when the server is down.

```
wf-board-data/
  board.yaml              title, eyebrow, goal, projects, tags (the approved tag vocabulary)
  numbers.yaml            the short-number counter: next: <the number the next item or card gets>
  items/<id>.yaml         one file per item
  decisions/<key>.yaml    one file per decision card
  notes/<id>.yaml         one file per owner note with its reply
  glossaries/<project>.yaml  one file per project glossary, named by the project
  state/owner.yaml        the owner's read cursor and read-ahead marks
  state/wake.jsonl        the wake stream's events, receipts and marks (not a board document; excluded from git)
  import/                 the original artifact export, kept as provenance
```

Each file is one YAML document; prose fields are literal blocks (`|`), which
keep their lines exactly as written. An item file:

```yaml
title: 示例：换账号时交接当前状态
group: 总管
links:
  - label: Whitefoot#341
    url: https://github.com/Ming-Research/Whitefoot/pull/341
created: 2026-10-11T06:15:40Z
updated: 2026-10-11T06:15:40Z
rev: 3
plan:
  - id: snapshot
    text: 写下交接快照
    state: done
    doneAt: 2026-10-11T06:15:40Z
  - id: example-merge
    item: example-merge
    own: false
    after: []
  - id: accept
    accept: true
    text: 新的总管只读这份快照就能接着做，不用回头问 owner。
    state: todo
head: |
  **问题**：总管（协调会话）换账号时……

  **为什么**：……
log:
  - at: 2026-10-11T06:15:40Z
    by: 总管
    text: |
      写下交接快照；总管职责写进 agents_config 的 coordinator.md。
```

- **Why not JSON.** JSON stores a paragraph as one line with `\n` escapes, so
  a one-word edit shows in git as a whole rewritten line, and Grep and Read
  show escaped text. Its structure is exact, which YAML keeps.
- **Why not Markdown with front matter.** Structured fields live in the front
  matter, but anything structured inside the body, such as a log entry's time
  and author, must be encoded in reserved heading lines, and every new field
  on a log entry (a link, a kind) would stretch that encoding. In YAML the
  whole document is structured and prose stays readable.
- YAML's known traps (unquoted `no` read as false, times read as dates) do not
  reach the data: the server is the only writer, writes through one
  serializer that quotes where needed, and validates every document against
  a schema on read and write.
- `rev` counts writes to the file. A write that replaces content names the
  `rev` it read and fails on a mismatch with the current content in the
  error. Log appends, `set_plan` and `set_targets` carry no caller `rev`: the operations
  queue retries against the latest item while preserving unrelated concurrent writes.
  Replying to an answered note is refused with the previous author and time;
  deliberate replacement requires `replace: true`.
- **Short numbers.** Every item and every decision card carries `num`, a
  permanent positive integer, so the owner can name it as `#812` instead of
  searching by title. Items and cards share one sequence, so a number names
  one document. Notes have none. The owner decided this on 2026-10-13. Keys
  stay the identity everywhere: plan rows, `item` fields, note targets and
  `[[it:key]]`/`[[q:key]]` tokens use keys; a number is only a display and
  lookup alias. Only the store issues numbers, inside its single write queue:
  a put that creates an item or card receives the next number, and
  `numbers.yaml` (`next`) advances in the same commit, so two documents can
  never receive one number and a failed commit issues none. An update keeps
  the stored number; a write that names a different number, or a number on a
  document that has none, is refused. A deleted document's number is never
  reused. On start the store refuses (never repairs) a board where two
  documents share a number, where `next` is not above every issued number, or
  where documents hold numbers without `numbers.yaml`. The field is optional
  in the schema only for data written before numbers existed: on its first
  start the store numbers every unnumbered item and card once, oldest first by
  `created` (cards `at`; `updated` when neither exists), ties broken by key,
  in one commit `Number existing items and cards` that changes only `num` and
  the revision. That commit is bookkeeping: it is not an unread change for the
  owner, adds no active time and resets no stalled clock, and `num` is never a
  reported field change. Board text keeps naming things by what they are, not
  by number.
- **Item plan.** Every item carries one ordered `plan`, its 计划和进展: its own
  steps, the items it owns, the items and cards of others it waits for,
  acceptance steps where the checks happen, and delivery rows after them. The plan replaces the former `steps`, `deps` and
  `parent` fields and the head's completion-condition section; the section
  [Item plans](#item-plans) below defines it.
- **Item target numbers.** Optional ordered `targets` give one row per goal,
  rather than one row per measurement. Each row has a stable `id` with the
  same pattern as step ids, and required nonempty `goal`, `target`, `current`
  and `baseline` text naming the goal, its target value, current value and
  comparison baseline (for example main, Chromium on the same machine and
  page, Redis or PUC Lua). `date` is a server-stamped ISO UTC timestamp:
  creation and changes to `current` stamp it; other edits preserve it.
  Callers never provide dates. Work and record items may have targets;
  existing items without the field have none. A project session measures a
  goal and overwrites its current value; there is no measurement history
  list and no separate duration or throughput statistics.
  `set_targets` accepts exactly one mode: `targets` replaces the ordered
  list, `target` upserts one complete row by stable id, retaining its
  position or appending it, and `remove` deletes an id. Replacement matches
  rows by id to preserve dates unless the current value changes. Duplicate
  ids are refused. Project ownership, concurrent-write retries, one atomic
  commit and no-op behavior match `set_plan`: identical results change
  neither the item nor its revision and write no commit. Target changes
  count as owner-unread progress. Context and brief format each goal as one
  line: `goal: current (vs baseline) → target, YYYY-MM-DD`.
- **Record items.** `record: true` makes an item a record: a head, an
  optional plan without an acceptance step, targets and log, and no status;
  creation and `update_item` can set it. Records are defined with the plan in
  [Item plans](#item-plans).
- **Dispatch records.** An item may carry `dispatches`, oldest first: one
  entry per agent session the architect started on it (a dispatch), in the
  columns of the dispatch format the architect keeps. An entry holds
  `agentId` (the session's full id, unique on the whole board), `agent` (its
  name), `role` (`工程师` or `审查`), `level` (1–5), `model`, optional
  `effort`, `worktree`, `started` and `did` (which rows of the item the
  session does, one line), and once the session has ended a `finish` block:
  `ended`; `result` (`一次通过`, `返工后通过`, `换人` or `放弃`); the counts,
  `reports` and `kickbacks` for an engineer and `rounds` (review rounds: the first review and each re-review count one) for a review, never
  the other role's; optional `waited` minutes (spent waiting for the owner,
  the 14900K or a dependency); `signals`, none or several of `验收没过`,
  `架构师打回`, `做法被否`, `长时间没进展`, `换模型`, each at most once and
  each with an optional note; `usage` (`input`, `cacheWrite`, `cacheRead`,
  `output` tokens); `cost`; and an optional `note`. The fixed options are the
  dispatch format's own and nothing else is accepted for them. Decisions:
  - Stored on the item, not as a new document kind: an item already has its
    history, `changes`, retried writes and project ownership check, while a
    new kind would also change the store's reads and writes, the snapshot,
    the events sent to the page and the page's snapshot. The cost is 6 to 9
    more lines in the item file when a dispatch starts and 17 to 26 once it
    has ended (counted on the serialized YAML), plus the two log entries.
  - Historical detail, like the log: `withoutHistoricalDetail` drops
    `dispatches` with `log` before any owner-facing comparison, so a dispatch
    write is never news to the owner. The page shows neither the field nor a
    summary of it.
  - `cost` is US dollars with at most three decimals (a longer value is
    rounded when written) and is added up as whole thousandths, so a printed
    total always equals its printed rows added up. The board holds no price
    table: a price depends on each message's prompt length (Haiku is tiered),
    which only the session transcript shows, so the caller measures `usage`
    and `cost` and the board records them.
  - A dispatch is recorded on the subtree root item the session was given. The
    board does not check that the item is one, and the tag tally counts the
    dispatch under that item's tags.
  - `dispatch_start` and `dispatch_finish` each append a generated line to the
    item's log (`起：…`, `收：…`), the architect's hand-written line in
    machine form: the owner reads only the page, which shows logs and not
    dispatches.
  - Not stored: the judgment records for "research first or do directly"
    (item, what was judged and why, how the misjudgment showed, what it should
    have been). They are a different record and stay written by hand in the
    calibration item's log.
- **Projects.** Every item stores its project in `group`; an item's project
  never changes, and ownership never crosses projects, so the stored field and
  the ownership chain always agree. The legacy `area` was folded into
  `parent` at the artifact migration and `parent` into owned plan rows at the
  plan conversion (section 10).
- **Priority.** The former per-project migration switch (`migrated: true` and
  the legacy priority of `src/legacy-priority.ts`) is retired by the plan
  conversion, which migrates the remaining projects in the same commit
  (section 10); every project follows the priority rule of
  [Item plans](#item-plans).
- **Stalled work.** A work item in progress that has at least one `doing`
  step of its own is flagged after at least one hour of active time without
  a change to the clock's items: `进行中但 1 小时（活跃时间）没有动静`. The
  clock's items are the item itself, each owned item in progress, and each
  item a doing step names with `[[it:key]]`, with every item each of those
  owns down every layer. A shared dependency is another item's work and does
  not count. An item whose progress comes only from owned items has no clock
  of its own; the owned item with the doing step carries the flag. Each board
  content write starts a
  30-minute active interval; overlapping intervals count only once, and the
  measure clips their union to the clock items' latest change through the
  current time. When no one writes, all clocks stop after the last interval ends.
  Item revisions, log entries, cards and notes on a clock item reset its last
  change. Records and items in other statuses are never flagged.
  Effective pauses suppress the flag and freeze the clock: the union of
  historical pause intervals is excluded from active time, including inherited
  pauses. Resuming preserves a descendant's earlier active time rather than
  counting the paused interval. A change to the item still resets its clock.
  `src/rules.ts` defines the durations and the check for both MCP and the page.
  Each check may carry a short visible `label` defined with it: this one is
  `无人推进`, shown beside the item title in place of `需核对` with the full
  text as tooltip; checks without a label keep `需核对`. A folded item whose
  owned subtree holds stalled items shows `无人推进 N` beside its title.
  The store reconstructs an optional snapshot activity index from existing
  git history, retaining every content commit timestamp and each item's last
  change, including overwritten and deleted cards and notes. Card moves
  touch both items; later notes on deleted cards retain their last known
  item. No extra board data file is stored. A disposable marker in git metadata
  records the checked HEAD and first pause commit (or that none existed).
  Unchanged history needs no pickaxe; fast-forwards scan only new commits.
  Missing, corrupt or rewound cache state triggers one historical scan, so
  clones and resumed items retain restart correctness. Historical pause reads
  extract only project, record, pause and owned-target metadata rather than
  validating against today's write schema. Unreadable blobs are logged and
  skipped; unknown fields and malformed plan entries do not prevent startup.
  Live pause indexing uses the same tolerant projection, since conversion
  transactions include legacy before-documents and records with omitted plans.
  Each write may name the session that made it (`session` on every write
  tool, below); the store records it as a `Session: <name>` trailer on that
  operation's commit, and the same index keeps, per item, the session that
  last wrote to it and when (`activity.sessions`). Cards and notes count for
  their item as they do for its clock. A write without a session changes no
  attribution; a later one replaces it; a restart derives it from the
  trailers in history. This is an observation of who wrote, never an
  assignment of work to a session: no document stores a session, and
  `history` and `changes` show the message without the trailer.
  Content commits touching board metadata,
  items, cards, notes or glossaries count (and the notice files of history, below); commits containing only
  owner reading cursors or read-ahead marks do not. Current document timestamps
  also supply the available dating evidence for imported or synthetic data.
  A live update carries the activity index's change, not the index: the
  commit's content-write time, the items whose last change moved, the
  whole new span list of each item whose pause spans changed and each item
  whose last-writing session moved, made against
  the previous head. The page applies it only to a snapshot at that head; a
  snapshot already at the new head ignores it, and one at another head missed
  or overtook an event and reloads the whole snapshot. MCP recomputes checks
  on read, and the page recomputes them every minute so a quiet item can
  become stalled without another write.
- **Blocking waits.** An owner wait either stops named work or does not. A
  decision card may carry `blocks`, one sentence naming the work that is
  stopped until the owner rules (for example `#398 合并停着`); a card with `blocks`
  is blocking, one without is not, and sessions proceed on its recommendation.
  An item's `ask` is always blocking. `src/rules.ts` derives the predicates:
  `cardBlocking(card)` (waiting and carrying `blocks`), `ownerBlocking(item)`
  (a pending ask or a blocking card), and per subtree `blockingBelow(item)`
  (pending asks plus blocking cards) and `nonBlockingBelow(item)` (waiting
  cards without `blocks`), the item included. `write_card` sets `blocks` on
  create or revision; a revision omitting it keeps it and `null` clears it.
  `context` and `brief` show it.
- **No notices.** The board has no notice documents: the 要你知道 list and
  `post_notice` are gone. A change the owner must act on is a decision card;
  one the owner only should know goes in the architect's journal. Notice files
  in history still count as content writes. The one commit that deleted them
  is not a write, and activity skips it.
- A decision file holds its status, item, confidence, time and options in the
  front matter, and background and ruling as body sections. `confidence`
  becomes `{score?: 1-5, reason}`, and a ruled card records `ruledAt`.
- Each fact is stored once. The export shows what duplication costs: 27 cards
  whose `item` names an item whose `qs` omits them, 572 items carrying both
  `parent` and `area`, 13 notes whose stored title went stale. So a card's
  place is its `item` alone (an item's cards are derived), an item's place is
  the one plan row that owns it (its owner is derived), and a note's title is
  derived from its target.
- A plan row may name a decision card as well as an item. Four blocked items
  in the export waited on an open card, which the model before card
  dependencies could not express; a card row makes such an item blocked by
  derivation (see [Item plans](#item-plans)).
- Empty strings are absent fields (`ask: ""` on 117 items, `parent: ""` on
  161).
- A note keeps its original id, so ids that sessions recorded and anchors
  that point at notes stay valid.
- **Glossaries.** Each project keeps a glossary of the words it coined:
  `terms: [{term, definition, updated, by}]` with the file's `rev`. A term is
  one line without surrounding spaces and unique in its glossary; the
  definition is plain Chinese for a reader outside the project; the server
  stamps `updated` and `by`. A replaced term keeps its place. A glossary is
  not an unread document: its changes neither count as 新 nor appear in
  `changes`.
- **Tags.** The board keeps one approved vocabulary, `tags: [{name, meaning,
  projects?}]`, in `board.yaml`; each item carries `tags: [name]`. A name is 1–12
  characters without whitespace or commas and unique; `meaning` is one sentence
  telling agents when to apply the tag; `projects` is absent when every project
  may use the tag. The vocabulary lives in `board.yaml` because it is small
  board-level configuration with the same single writer rule as the project
  list, and a rename or removal must change the vocabulary and every carrying
  item in one commit, which the store's one-commit-per-operation already gives
  for the board plus items; its own document would add a file that every such
  commit must also write. Only `Architect` changes the vocabulary, after the owner
  approves the change on a decision card; the server enforces the author, not
  the card. An item's `tags` are unique, each in the vocabulary and applicable
  to the item's project, and every item needs at least one, records and
  requests included. `tags` is optional on read for data written before tags
  existed; the 缺标签 check lists such items until a session backfills them.
  A tag change is a real change in `changes` and in unread, unlike `num`.
- **Difficulty.** A work item may carry `difficulty`: an integer 1–5, which
  decides the agent that does it (the architect's rules map levels to agents,
  so the board keeps no such table), or `architect` for an item the architect
  does itself (a discussion, a walkthrough, a design), which is rated but
  never dispatched. Text outputs write it as 「难度 N」 or 「架构师做」. A record
  has none. It is a field of the item, not of a plan row, because the unit
  dispatched to an agent is the item; it replaces the temporary 「（难度 N）」
  that plan rows carried in their text. Only `Architect` sets it, with
  `set_difficulty` on an item of any project, and every change appends a log
  line `难度：<from> → <to>，理由：<reason>` (from 未评 the first time), because
  changing the level changes who does the work. `create_item`, which only
  `Architect` calls, takes `difficulty` and logs it as the first rating
  (reason 建条目时评). `changes` shows every change
  of difficulty; unread shows a changed level but not a first rating (below).
  Work an unpaused root needs and that has no difficulty raises the 缺难度
  check and is not listed as startable (`brief.todo`); a work item rated
  `architect` raises no check and is not listed either, since the architect
  schedules its own items itself. Only the architect clears 缺难度.
- **The read cursor.** The board's history is the git log, an ordered list of
  changes. The owner's reading state keeps a cursor into it and optional
  per-document `readMarks`, each a commit id through which that document is
  read. Document keys are `item:<id>`, `decision:<key>` and `note:<id>`.
  After the cursor, a step's document is unread only when its last commit is
  after that document's mark; a step with no unread documents is neither a
  stop nor counted. A mark also separates consecutive changes, so a later
  change to the same document is new again without reviving its read changes.
  Moving the cursor removes marks it passes; reading every document in a
  prefix advances the cursor over that prefix and removes its marks.
  新 counts items: an item with any unread change in itself, its cards or the
  comments on either counts once, however many changes it holds, and a change
  no item holds (a card without an item, a deleted document) counts once on
  its own. An item's head shows one 新 chip counting the items with something
  new in its subtree, itself included; a card shows no chip of its own unless
  no item holds it. The header total and the kind buttons count the same way.
  `n` walks page order, top to bottom: an item, each card its plan unfolds
  (in plan order) with that card's comments, the item's comments, then each of
  its other cards and that card's comments, with documents the page does not place last,
  oldest first. Inside a changed item it visits each new place in turn (a
  changed status, title or body block, a new or changed plan or target row, an
  added link); a new item is one stop at its start. After `m`, `n` goes on below
  where it was. A 新 chip jumps to the first new place in its subtree.
  `m` reads the whole item holding the selection, however selected: its own
  changes, its cards and the comments on both, but not its sub-items; a card
  no item holds is read with its comments. 全部已阅 moves the cursor to the
  head after confirmation. Expanded items and cards mark changes in their own
  content, comparing the document before its first unread step with its current
  state. Blocks are separated by blank lines, except inside fenced code;
  contiguous lists and tables remain whole blocks so rich rendering stays
  intact. A 参考 section (a line starting 「**参考：」 through to the next such
  line or the end of the text, fenced code excepted) is one block, whatever
  blank lines it holds. An item's head shows each one folded under its title;
  the sections a reader opened stay open across re-renders, kept in this
  browser only. Added or changed blocks carry a blue bar on their left, as changed
  plan rows do, and no colour of their own; `n` lands on the first of them;
  removed content is not shown anywhere: no removed block, former title,
  plan row, link, target row, ask or card option. Multi-paragraph card questions use the same
  block comparison as heads, keeping unchanged paragraphs once. Changed
  status, priority and request rows, and added or changed link rows, are not
  coloured either.
  New items and cards carry no per-block marks; added plan and target rows still mark their own lines. No green background is used
  anywhere: the owner never asked for one. A card with unread changes of its
  own carries a blue line beside its whole body, marking exactly what `m` on it
  reads; a parent whose only new content is below it shows that in its 新 chip
  and carries no line, since `m` leaves sub-items alone. The tree shows only
  head rows, with a short blue line for an item's own unread content; the
  selected item's body and comments appear in the detail column, with a short blue line beside its headline.
  The 新 chip counts what is new inside. Added or changed plan rows and target rows, new notes
  and replies, and added link rows use the same blue bar. Plan rows
  and targets compare by stable id against the item before its first unread
  change, so inserting or removing a neighboring row does not mark an unchanged
  row. Reordering or removal still marks the item unread without displaying
  removed rows. Reading the item clears its plan and target marks. A plan row is
  changed when its own stored fields change (text, state, ownership,
  `after`, or a server date); a change in the status of the item a row points
  at is that item's change, not this one's. The 进展
  unread filter selects plan and target changes; head changes, cards and other changes remain in 其他. Logs
  never mark the item new, never enter unread counts or stepping, and never
  receive unread bars, including appended or edited log entries. A log-only
  commit does not extend an unread change or move its comparison baseline.
  A first rating, an item's `difficulty` going from none to a level, is not
  unread either, alone or beside another change (which still counts as
  itself): rating hundreds of items would show each new for one added label.
  Changing a level that exists is unread.
  A new reply marks the reply alone, never the
  owner's comment above it, since the owner wrote that. Note
  changes appear only in the comment-list row, never as bookkeeping-field
  diffs. Every document jump, including card references, waiting-stop arrows,
  unread chips, reveals the target and its comment list
  (in the selected item's detail column),
  waits for the baselines affecting that target and its expanded containers,
  then scrolls after rendering. Baselines for unrelated collapsed items or
  explicitly collapsed ancestor comment lists neither delay nor cancel the jump.
  Deleted documents have no body to render but remain countable stops that
  `n` can visit and `m` can read.
  This replaces the 478 per-item read
  records and their snapshots. A history step groups consecutive commits by the same
  author on the same item, so quick step updates read as one change, and
  the owner's own actions (notes and reads) never count as unread. Scrubbing
  back through earlier changes with a slider uses the same history and is
  deferred until needed. Reads update owner state immediately
  and save it locally without a commit. A local save arriving during a data
  commit waits for that commit to finish. Pending owner state normally joins
  the next data commit, so ordinary reads make no commit noise. On orderly
  shutdown, the daemon commits any remaining owner state on its own before
  pushing.

### Item plans

The owner decided on 2026-10-13 that every item has one list, 计划和进展
(plan and progress), which replaces three things: the completion-condition
section of the head, the dependency list, and the parent/child relation. Before
it, an item's work was spread over a head section the server could only
pattern-match, a `deps` list, a `parent` field that had to be repeated in the
parent's `deps` (174 children in the board of 2026-10-13 are missing from their
parent's list), separate `steps`, and own-work sub-items invented only so a
parent's status could be derived (58 of them). One ordered list holds all of
it, so an item's page reads top to bottom as what remains to be done, and the
tree, status, priority and blocking are all derived from it.

#### Rows

An item may also store `paused: { reason, at }`, with a nonblank reason and
the server's time. Only the architect (`author: Architect`) sets or clears it through
`set_pause`, at the owner's request in a comment (the page has no pause or
resume control); project agents cannot set it through
item creation or revision. Records cannot carry it, and pausing done or
cancelled work is refused. This marker never changes plan rows.

A plan is an ordered list of rows, each with an `id` unique in the plan. A row
is one of four kinds:

| Kind | Stored fields | Meaning |
|---|---|---|
| step | `id`, `text`, `state: done \| doing \| todo \| dropped`, `waits?`, `reason?` (required when dropped), `after?`, server dates `doneAt`, `since`, `droppedAt` | Part of this item's own work, as steps were; `waits` belongs on a doing step, and a todo step carrying it gets the 在等文字 check |
| owned item | `id` = `item` (the target key), `item`, `own: true`, `after?` | A part of this item's plan that is an item of its own: the target is this item's sub-item, drawn under it in the tree |
| shared item | `id` = `item`, `item`, `own: false`, `after?` | Someone else's item whose result this item waits for; the tree does not draw it here, and the page marks it 「共用 · 归属在 <owner>」 |
| card | `id` = `card`, `card`, `after?` | A decision card this item waits for; never owned |
| acceptance | `id`, `accept: true`, `text`, `state`, `reason?`, server dates | A number or check that decides completion, placed where that check happens. It is an ordinary step with the acceptance marker |

- **Ids.** A step's or acceptance step's `id` is caller-chosen and follows the
  step-id pattern (letters, digits, `.`, `_`, `-`, at most 40). An item or card
  row's `id` is the target's key, set by the server, so one plan names each
  target at most once and `after` reads naturally (`after: [halo-gc]`). A step
  id equal to a target key in the same plan is refused.
- **No why on rows.** Item and card rows carry no `why` (owner, 2026-10-13).
  The why existed because dependencies had no place of their own to be read;
  a row now sits in the plan, between the rows before and after it, under the
  item's title and with the target's title, and the plan and the titles say
  what it is for. A step's text already says what it does. Anything more an
  item needs to explain goes in its head's 做法 or its log. The former whys
  are kept in each item's log by the conversion (section 10).
- **After.** `after` lists ids of earlier rows that must be resolved before
  this row can proceed. Absent means after the previous row (the first row:
  after nothing); `after: []` means it can start at once. Only earlier rows
  may be named, so the order relation cannot form a cycle. Acceptance uses
  these same rules, including the previous-row default. Removing a row that
  a later row names in `after` is refused, naming the later rows.
- **Acceptance.** A work item's plan has at least one acceptance step; several
  are allowed, for example one per acceptance scenario. A record has none.
  Place each where the check happens, normally before merge or release rows.
  Its text is a completion check, with numbers agreeing with the target
  numbers above the plan. Its `after`, `waits`, state and dates follow ordinary
  step rules; a todo acceptance step with `waits` gets the 在等文字 check.
  Step state writes do not enforce readiness; acceptance has no
  additional completion guard. An item is done only when every row, including
  every acceptance and delivery row, is resolved.
- **Dates.** The server stamps step and acceptance dates exactly as it stamped
  step dates: `doneAt`, `since` and `droppedAt` on entry into a state,
  preserved while the state stays, re-stamped on re-entry; callers never
  supply dates. Elapsed days are whole 24-hour days since `since`, clamped to
  zero. Item and card rows carry no state or dates of their own: their state
  is the target's, derived on read.

#### Row states

Each row is in one derived state, which status and display use:

| Row | resolved | in progress | waiting | open |
|---|---|---|---|---|
| step | done, or dropped with its reason | doing | — | todo |
| owned item | target done, or cancelled (counts as dropped; the target's cancellation log is the reason) | target in progress | target blocked or paused | target todo |
| shared item | target done | — | target open (any status) | — |
| card | card not open (ruled, with the tree, elsewhere) | — | card open | — |
| owned record | always resolved and left out of counts: a record is a part kept for reference, not work | | | |

A shared row whose target is cancelled is not resolved: someone else dropped
what this item waits for, and the plan's own project must remove or replace
the row. It shows the check 依赖的条目已取消 and keeps the item from completing.

A row is ready when it is unresolved and every row it comes after is
resolved, for ordinary and acceptance steps alike. The ready rows are the
plan's frontier.

#### Status

A work item's status is derived from its plan and effective pause; cancellation
and the separate pause marker are stored.
Cancelling or reopening never changes plan rows, including acceptance states,
dates and prerequisites. The converter's initial `todo` acceptance for an old
cancelled item is a conversion mapping, not a reset performed by cancellation.

1. `cancelled` when the item stores `status: cancelled` (set by `set_status`
   with the reason). Cancelling is refused while an owned row's target is
   open, naming those items: each part gets its own reason first.
2. `done` when every row is resolved, every acceptance and delivery row included.
3. `paused` when this item or any ancestor in its same-project ownership chain
   has a pause marker. Shared rows never inherit a pause. Done and cancelled
   win over pause; records have no status. A record in the ownership chain
   does not interrupt inheritance from a work ancestor.
4. `wip` when any row is in progress: a doing step, or an owned item in
   progress. A doing step with `waits` (CI, a run on the 14900K, something not
   on the board) is still in progress. A todo step with `waits` is not in
   progress, and its check (在等文字) asks for the wait to be written as a
   shared row, a card, the backlog, or a doing step.
5. `blocked` when nothing is in progress and either every frontier row is
   waiting (a shared item still open, an open card, an owned item that is
   itself blocked or paused) or the item has a pending legacy ask. A paused
   child is waiting on the owner; a parent that is not paused can therefore
   be blocked by it, under the ordinary frontier rule.
6. `todo` otherwise: some frontier row is a step or an owned item that can be
   started.

So a parent is done only when its own steps, acceptance steps and delivery rows are resolved,
not merely when its children are (owner decision 6), and an item is blocked
exactly when everything that could move next waits on another item, another
project or the owner. The previous rule called a parent blocked as soon as one
child was blocked and none was in progress, even with another child ready to
start; under this rule that parent is `todo`, because work can proceed (9
parents change this way in the board of 2026-10-13, reported by the
conversion). The checks that existed only because status was set by hand go
away: 卡住了，但没写在等什么, 可解除阻塞：等的都已完成 and 标为进行中，但还在等别的.

Every work item has a plan with at least one acceptance step, so no work item
has a stored `todo`, `wip`, `blocked` or `done` any more. An item with an
empty plan (none exists after conversion; the schema allows it only on a
record) shows the check 没有计划：至少要有一个验收步骤.

Pause and resume log `暂停：<reason>` and `恢复`, respectively, in the same
commit as the marker change. Resume clears only this item's marker; another
paused ancestor or a child's independent pause still applies. Repeating the
same pause reason or resuming open work without its own marker is a no-op.
Done and cancellation leave the marker inactive on that item, but open
descendants still inherit it. An authorized resume can clear this inactive
marker; reopening a cancelled item without that resume retains the owner's
pause. A write by any author but `Architect` that changes an item from effectively paused
to open, not-paused work is refused, naming its pause source and requiring
the owner or `Architect` to resume it. This covers moves out of a paused chain
and ownership changes affecting unwritten descendants. Done and cancellation
are closure, not resume: a project's author may complete paused work and
`Architect` may cancel it (cancelling is reserved for `Architect`), either
keeping the marker. Becoming a record is also not open work, but clearing an
explicit marker, including an inactive one, still requires the owner or
`Architect`. Converting a cancelled item to a record is reserved for
`Architect` too, since converting it back to work would reopen it without
`set_status`. Moving work into a paused chain is allowed.
A project edits only its own items and cards; `Architect` edits any
project's. That reach lifts only the check that the author is the item's
project. Ownership still stays inside one project, and removing an open
owned row still requires moving or cancelling its target first, for
`Architect` as for every other author.

#### Ownership, the tree, roots and top items

- **Owner.** An item's owner is the item whose plan holds an owned row for it.
  The tree draws an item's owned rows' targets under it, in plan order; there
  is no separate `parent` field. Ancestors, the line (top item) of an item,
  subtree counts and the 新 chip's subtree all follow owners.
- **Exactly one owner.** No item is owned by two rows. A write that would make
  a second owned row is refused, naming the current owner and directing the
  caller to `move_item`; a stored violation shows 被多个条目拥有.
- **No cross-project ownership.** An owned row's target belongs to the same
  project as the plan's item. A cross-project need is a shared row, which may
  point at any item of the other project; the usual target is the item
  collecting what one project needs from another, but nothing requires it
  (an item that moves to another project leaves such rows behind, below).
  A write that owns across projects is refused; a stored violation shows
  跨项目拥有.
- **Changing project.** `move_item_project` changes the `group` of an item and of everything it owns, so an
  owned part never straddles two projects. Its key, number, history, notes and cards stay with it, because each is
  addressed by the item's key.
  - Rows. An owner that stays behind (the item's owner, or a backlog record) keeps its row as a shared row in the same
    place, since it still needs the result and ownership cannot cross projects. An item left behind may also wait on a
    moved part through an existing shared row; it stays valid (see the previous bullet).
  - Arrival. The item arrives as a top item of the new project. Placing it under an owner there is that project's
    `move_item`: a call that named the new owner would write an item of the other project, and each project writes only
    its own items. Two cases leave an open waiter and no owner in the new project, and the move is refused, naming
    the items and the way out, as the 同项目有条目在等它，却没有条目拥有它 check reports it after the write.
    (a) An open item of the new project already waits on the moved item through a shared row, so the item would arrive
    owned by no item. The new project drops the row first with `set_plan` and, if the item still matters there, lets the
    item that needs it own it with an owned row after the move; or leaves the dependency out.
    (b) The moved item's own plan holds a shared row to a top item T of the new project that nothing owns, so T would
    gain an open waiter. Either an item of the new project owns T first, or the row to T leaves the moved item's plan
    first.
    Only a violation this move newly causes is refused; one that was already there (a top item of the new project that
    an open item of the new project already waits on) does not stop it.
  - Priority. An item that lands as an open root keeps the `priority` it stores, and one with none needs it given. A
    given `priority` replaces the stored one and the log says so when the value changes; it is refused when the item
    does not land as a root, as in `move_item` without an owner. Work owned by a backlog record has no stored priority,
    and a record is not open work, so it lands as a root and needs one.
  - Rejected: moving only the named item and leaving what it owns behind (the owned rows would become cross-project
    ownership), and an argument naming the new owner (above).
- **Top items.** An item no row owns is a top item (what earlier sections
  call an area), drawn at the top level of its project. A top item is one of: a root (below); an item another
  project's shared row waits on, such as a collecting item (drawn under the
  existing 被其他项目依赖 separator, its priority derived); an open inbox
  request (drawn in the inbox until triaged); or a closed item (done or
  cancelled), which needs nothing further. An open top item that an open work
  item of its own project waits on through a shared row shows
  同项目有条目在等它，却没有条目拥有它, and a write that introduces this is
  refused: within a project, the item whose plan it is a part of owns it, and
  the others share it.
- **Roots.** A root is an item that no open work item depends on through any
  item row, owned or shared, as before (paused work is still open for ownership
  and rootness). Only a root stores `priority`; an open
  root without one shows 没有未完成的条目依赖它，却没写优先级, unchanged. An
  owned item under an open owner is never a root. An open item owned by a
  closed item shows 拥有它的条目已关闭 (it can only arise from data written
  before the cancellation refusal).
  An open work item owned by a record is not a root, stores no priority,
  and is exempt from the missing-root-priority check. It derives priority
  from open, not-paused shared dependents, or none without them.
- **Backlog.** A project's backlog is a record whose plan owns the items it
  holds. Records pass no priority (below), so backlog items without open,
  not-paused shared dependents show no priority; moving an item out under an unpaused root's
  plan gives it the root's priority. This replaces the present practice of a
  P2 root named 待选工作, which gave every backlog item P2.
  Setting priority on an open item owned by a record is refused with an
  explanation that record-owned work cannot store priority and takes its
  priority from open shared dependents. Record ownership supplies no seed.
- **Cycles.** Item rows, owned and shared together, may not form a cycle; a
  write that closes one is refused, and a stored cycle shows 依赖成环 as
  today. Owned rows alone therefore form a forest. `after` cannot form a cycle
  because it names only earlier rows.

#### Priority

Unchanged in substance from the migrated rule, now for every project: a
root's priority is its stored one; every other item's is the highest among the
open, not-paused work items whose plans hold an item row (owned or shared) for it, across
projects and transitively. A closed item keeps the priority that reached it
and passes none on; card rows carry none; a cycle that no open outside
dependent reaches has none. One change: a record passes no priority, because
a record is not work. Before, a record counted as an open dependent; three
records exist (the 14900K queue among them). Open work owned by a record
still takes the highest priority from open, not-paused shared dependents,
and shows none without them; the record supplies none.
A root stores `priority`; every write that makes an item a non-root, or
writes a non-root, drops its stored priority in the same commit and logs
`不再是根：优先级改由依赖它的条目决定，原来写的 PX 不再使用` on it, and the
write's result lists the items. So no non-root holds a stored priority, and
none returns when an item becomes a root again. A closed root shows its own
stored priority.

An open work item is *needed* when an unpaused root needs it: it is an unpaused
root, or an unpaused, open item holds an item row (owned or shared) for it and
is itself needed. An untriaged request is not work yet and is neither a root
here nor needs anything, and a record is not work. So backlog work is needed
only when a needed item other than its record also holds a row for it, and
what hangs under backlog work only when that work is needed; paused work and
work reached only through paused items are not needed; a root that is not
started and has no stored priority is. The same walk
decides which items 缺难度 asks a difficulty for and which items `brief`
lists as startable. Whether an item is needed is part of the summary
`affectedItems` compares, because a pause can change it for an item whose
priority and checks stay the same.

Effectively paused work keeps its own stored or derived displayed priority,
but passes none through its item rows. Only open, not-paused dependents
contribute priority to their targets. Pausing changes neither ownership nor
rootness, so it does not discard a root's stored priority.

#### Records

A record (`record: true`) may have a plan of steps, owned rows, shared rows
and card rows, and no acceptance step; it has no status, appears in no status
queue, is never waiting or blocking for anyone, and passes no priority. It may
own work items (the backlog, the 14900K queue's run items). A record can be
owned, and an owned record row is always resolved and left out of the owner's
counts. Setting `record: true` on a work item removes all its acceptance steps,
logging every step's text; setting `record: false` requires `accept` text for
the new acceptance step. A real change of mode in either direction appends a
server-stamped log line saying the item became a record or a work item; a
call that leaves the mode unchanged logs nothing. Records receive no
status-based checks, and the page shows `记录` in place of a status. A record
may retain request metadata but is not an open inbox request.
`parent_own_work` no longer exists: an item's own
work is step rows in its own plan, so no conversion ever needs to invent an
own-work sub-item.

#### Closed items and visibility

Archiving does not exist: there is no archive field, API, button or shortcut.
Done and cancelled items are hidden as their own tree and list nodes by
default; the project's 完成 or 取消 status filter shows them. 完成 includes
all done items, while 7 天内完成 remains a recent-completion shortcut.
Closed owners with open descendants remain visible as dimmed tree paths,
so their open work stays reachable.
Their rows in every plan always show the state glyph, title and link;
following a link opens the hidden item's detail without changing filters.
Unread changes on a closed item, its cards and replies remain in 新 and the
navigation stops. Reading and reviewing them does not require drawing the
item in the default tree.

#### Checks

The checks touching plans, replacing the dependency and completion-condition
checks:

| Check | Refused when newly introduced |
|---|---|
| 依赖的条目不存在 / 依赖的决策卡不存在 | yes |
| 依赖成环 | yes |
| 被多个条目拥有 | yes |
| 跨项目拥有 | yes |
| 同项目有条目在等它，却没有条目拥有它 | yes |
| 没有计划：至少要有一个验收步骤 | yes |
| 计划待重写 (label `待重写`: the plan is still the conversion's provisional plan, below) | no; conversion only |
| 验收步骤待补 (the acceptance text is the conversion placeholder) | no; conversion only |
| 依赖的条目已取消 (shared row to a cancelled item) | no |
| 拥有它的条目已关闭 | no |
| 只差验收：其它行都已完成 (all non-acceptance rows resolved, with at least one acceptance step still todo or doing; the item stays open until its checks are resolved) | no |
| 没有未完成的条目依赖它，却没写优先级 | no |
| 选项不足 (label `选项不足`: an open decision card has fewer than three options; the check sits on the card and on its item, and a card with a recorded choice but not yet ruled is not checked) | no |
| 缺标签 (the item has no tag; `set_tags` fixes it) | no |
| 缺难度 (work an unpaused root needs, with no difficulty; `set_difficulty` fixes it, and only the architect may; not raised for a record, a closed item, an untriaged request, backlog work and what hangs under it, paused work, work only a paused root needs, or an item rated `architect`) | no |
| 标题超过 20 个字 (open items and records only; spaces are not counted, the count is in characters; writes are not refused) | no |
| 无人推进 (stalled, above) | no |
| 在等文字 (label `在等文字`: a todo step writes `waits`, so the item reads as startable; the check lists the rows by id and names the fixes; not for paused, backlog, done or cancelled items; writing it is not refused) | no |
| 暂停了，但 <dependent title> 在等它 (label `暂停冲突`, on the paused target of a shared row held by open, not-paused work) | no |

Effectively paused items retain all form checks, including provisional plans
and missing acceptance. They receive no stalled check and no 在等文字 check.
An owner linked only by its owned row does not raise 暂停冲突: its row
already waits on the owner and may make the parent blocked. Shared needs
still raise the check on the paused target.

Removed: 上级条目不存在, 上级没有把它列在依赖里, 正文没写完成条件, and the
three manual-status checks listed under Status.

#### Writing plans

- A new work item is created with its acceptance text (`create_item`'s
  `accept`), so every new item has a plan from birth.
- `set_plan` (section 6) edits rows: replace the whole plan, upsert one row,
  or remove one. An owned row may be added only for an item that no row owns
  (a top item of the same project, or a new item through `create_item`);
  taking an item from another owner is `move_item`, so a transfer is always a
  deliberate call logged on both sides. Removing an owned row, or turning it
  into a shared row, is refused while the target is open (use `move_item`, or
  cancel the target first); for a closed target it leaves a closed top item.
  The one exception is `move_item_project`: when the target changes project,
  its owner's owned row becomes a shared row in the same call (see Changing
  project above).
- A replacement preserves matching rows' dates by id; duplicate ids are
  refused; a call whose result equals the current plan changes nothing, not
  even `updated`, and writes no commit.
- Row changes are owner-unread progress (the 进展 filter), compared by row id
  like steps were.
- **Provisional plans.** The conversion (section 10) marks every plan it
  produces `provisional: true`, a server-owned item field no caller can set.
  A provisional plan works like any plan (status, priority and progress are
  derived from it, and single rows can be upserted to record progress), but
  it shows the check 计划待重写, whose label 待重写 appears beside the item's
  title in the tree and beside the 计划和进展 heading, and its owned rows
  carry the same small 待重写 mark. The mark clears only when a session writes
  the whole plan with `set_plan`'s `rows` mode, which is the rewrite of
  section 10's second phase; the server logs 重写了计划 on the item. Items
  created after the conversion are never provisional.

#### When a row becomes its own item

A row of a plan is its own item, owned through an owned row, when at least
one of these holds; otherwise it is a step.

1. It has its own completion check or number, distinct from its owner's
   acceptance step, so it can be accepted on its own.
2. Something other than its owner must point at it: another item waits on it
   (only an item can be the target of a shared row), or it needs a decision
   card of its own (a card belongs to an item).
3. It is tracked as a unit outside the board: its own pull request, release
   or 14900K run (the 14900K queue owns one item per run).
4. It will take more than about one working day of session work, or will
   span sessions, so it needs its own head, log and stall clock for whoever
   picks it up.
5. A different session works on it at the same time as its owner's work, so
   each session records progress in its own item.

Conversely, an item that meets none of these, typically one with a single
step and no acceptance of its own beyond its owner's, folds back into its
owner's plan as a step: its log goes into the owner's log as one entry and
it is cancelled with the reason 并入「owner」的计划. The own-work sub-items the
old model required are the common case.

- *Becomes an item.* Halo's plan for the Firn release has the row "Lua 5.1
  official test suite passes". It has its own number (all of the suite's
  files pass), and Firn's item for coroutine scripts waits on it through a
  shared row, so it is an item owned by Halo's release item.
- *Stays a step.* An item "Firn's rate-limiting script errors match Redis
  word for word" has the row "reword the parser's error messages". It is done
  in an afternoon in the same pull request, nothing else waits on it, and the
  item's acceptance (the four scripts' replies match the oracle) already
  checks it, so it is a step. If it had been converted as a sub-item with one
  step and no acceptance of its own, it would fold back.

#### How the page shows a plan

The detail column of a selected item reads, top to bottom:

1. the head row: status, priority, title, ratio, chips (unchanged); the left
   tree already shows the owner, so the detail has no ownership line;
2. 目标, the target-number table (unchanged), when the item has targets;
3. 计划和进展, the plan, with the cards it names unfolded under their rows;
4. the head (问题 / 为什么 / 做法) and the `data` line;
5. 被依赖: the items holding a shared row for this item (the owner is
   already on line 1, so it is not repeated);
6. the item's comment entry and comment list (see Comments below);
7. 日志, folded as today;
8. the ask, the open and shown ruled cards its plan does not name, checks and
   references.

The owner set this order on 2026-10-13: progress first, then the stable head,
then the comments on it, then history.

The plan's look, row by row. One line per row, a 16-pixel gutter on the left
carries the row's glyph in its state colour, the same colours as the status
chips (`--done`, `--wip`, `--block`, `--todo`, `--muted`), so both themes
follow the existing tokens with no new colours:

| Glyph | Row |
|---|---|
| ✓ (done colour) | done step, done owned item, resolved shared item or card |
| ● (wip colour) | doing step, owned item in progress |
| ○ (todo colour) | todo step, owned item not started |
| ⏸ (block colour) | waiting: shared item open, open card, blocked owned item |
| ◌ (muted colour) | paused owned or shared item; the row waits on the owner |
| ✗ (muted, struck text) | dropped step, cancelled owned item |

- **Step row.** `● 写解析器 · 3 天 · 等 CI` — text, then elapsed days for a
  doing step, `等 <waits>` when set, `10-12` (month-day) for a done step, the
  reason after a dropped step.
- **Owned item row.** The glyph carries the child's status, then its
  priority chip, its title as a link (click selects it, Back returns) and its
  own ratio `2/5`, on one line; there is no status chip and no second line.
- **Shared item row.** ⏸ or ✓, the target's priority chip and title as a
  link, on one line; there is no owner or project line under it.
- **Card row.** ⏸ or ✓, the card tag (阻塞 purple or 决策卡 red, as cards
  show today) and the question. In any item's plan, whichever item holds the
  card, clicking the question unfolds the whole card right under the row and
  keeps the shown item selected (background,
  options and their choice buttons, confidence, the ruling when ruled, its
  comment list and comment button) and selects it, so `c` and `m` act on it;
  a second click folds it. It starts folded, and each card's fold is
  remembered in browser localStorage like other folds, so it is the same card
  with the same choices, comments and unread state wherever it unfolds. Only
  the shown item's body is drawn, and a card its own item's plan names is not
  drawn again in that item's card list at the end of the body, so it exists
  once on the page. Any route to the card (the 等你 row, `n`/`N`, a reference
  or the item's 决策 buttons) unfolds it under the shown item's row when that
  item's plan names it, and otherwise opens the card's own item and unfolds
  it there. A card whose own item no longer exists stays a link to the card
  list.
- **Acceptance row.** Placed where its check happens, labelled 验收 in a
  small tag, full text (it may wrap), with the same glyphs as a step
  (○ ● ✓ ✗). It has no extra separator or spacing; the tag identifies it.
- **Parallel groups.** Each row's level is 0 when it comes after nothing and
  otherwise one more than the highest level among the rows it comes after
  (default: the previous row). Walking the rows in stored order, a maximal run
  of two or more consecutive rows with the same level is one group, drawn with
  a thin vertical bracket in the gutter and the label 可同时进行 above it. Rows
  in one level never depend on one another, so a group is always truly
  parallel; rows of one level that are not adjacent show separately, and
  `context` warns about them (see open questions). Acceptance rows join
  parallel groups by the same level rule as other steps.
- **Completed rows remain visible.** Every plan row is shown in stored order,
  including done and dropped rows; there is no resolved-row fold or saved
  fold choice. The ratio beside the heading is `done/total` over all rows
  except dropped steps, cancelled owned items and owned records, the
  acceptance and delivery rows included.

A mock-up at the detail column's minimum width (380 pixels), for an item in
progress with completed and dropped parts:

```
 计划和进展                                                   1/8
 ✓ 解析器能读配置 · 10-06
 ✗ 旧解析方案 · 已由新解析器替代
 ┌ 可同时进行
 │● 写解析器 · 3 天 · 等 CI
 │● [P0] Halo 的协程能挂起 2/5
 └○ 改写文档
 ⏸ [P0] Whitefoot 能读出对端地址
 ○ 发布说明
 ○ 验收  四个 Redis 7.0.15 限流脚本的回复与 oracle 逐字一致，
         CI 上连跑 3 次全部通过
 ○ 合并到主线并发布
 ─────────────────────────────────────────────────────────
 [评论这个条目]  评论 2 条，1 条有回复 ▸
```

The same as an HTML snippet, using only existing tokens, so dark mode follows
`:root[data-theme="dark"]` and `prefers-color-scheme` as the rest of the page:

```html
<section class="plan" aria-label="计划和进展">
  <div class="log-head">计划和进展 <span class="steps-ratio">1/8</span></div>
  <div class="plan-row done"><span class="g">✓</span>解析器能读配置 · 10-06</div>
  <div class="plan-row dropped"><span class="g">✗</span>旧解析方案 · 已由新解析器替代</div>
  <div class="plan-group" role="group" aria-label="可同时进行">
    <div class="plan-group-label">可同时进行</div>
    <div class="plan-row wip"><span class="g">●</span>写解析器 · 3 天 · 等 CI</div>
    <div class="plan-row wip own"><span class="g">●</span><span class="prio p0">P0</span>
      <a>Halo 的协程能挂起</a> <span class="steps-ratio">2/5</span></div>
    <div class="plan-row todo"><span class="g">○</span>改写文档</div>
  </div>
  <div class="plan-row blocked shared"><span class="g">⏸</span><span class="prio p0">P0</span>
    <a>Whitefoot 能读出对端地址</a></div>
  <div class="plan-row todo"><span class="g">○</span>发布说明</div>
  <div class="plan-row accept todo"><span class="g">○</span><span class="tag">验收</span>
    四个 Redis 7.0.15 限流脚本的回复与 oracle 逐字一致，CI 上连跑 3 次全部通过</div>
  <div class="plan-row todo"><span class="g">○</span>合并到主线并发布</div>
</section>
<style>
.plan-row { display: grid; grid-template-columns: 16px minmax(0, 1fr); column-gap: 6px; padding: 2px 0; overflow-wrap: anywhere; }
.plan-row > .g { grid-row: 1 / span 3; text-align: center; }
.plan-row.done > .g { color: var(--done); } .plan-row.wip > .g { color: var(--wip); }
.plan-row.blocked > .g { color: var(--block); } .plan-row.todo > .g { color: var(--todo); }
.plan-row.dropped { color: var(--muted); text-decoration: line-through; }
.plan-group { border-left: 2px solid var(--rule); margin-left: 7px; padding-left: 4px; }
.plan-group-label { font-size: 11.5px; color: var(--muted); }
</style>
```

At phone width (below 560 pixels) nothing changes structurally: rows already
wrap; the chip and ratio of an owned row move to the second line, the group
bracket narrows to 1 pixel, and the 16-pixel gutter stays so glyphs align.
Unread changed rows carry the existing blue bar to the left of the gutter.
The tree row of an item shows its plan ratio (`1/7`) where the steps ratio
was; leaf counts count owned descendants that own no work items, by status.

#### Comments

The owner comments on the whole item, not on plan rows. The page puts the
item's comment entry, a visible 评论这个条目 button that opens the existing
composer, and the item's comment list after the head and 被依赖, before the
log. The `c` key remains an entry too, and a comment may carry an anchor: a log entry (`{kind: log, at}`) or another note
(`{kind: note, id}`); a selected dependency row (`dep:<item>@<target>`)
already comments on the item without an anchor. Plan rows follow that: they
are selectable for navigation, `c` on a row comments on the item, and no new
anchor kind is added. Log and reply anchors stay as they are, so existing
notes keep their anchors.

#### Open questions

Each is written as the assumption the design proceeds on; the owner can
overturn it.

1. **Shared row to a cancelled item.** Proceeding on: it keeps the item from
   completing and is flagged, because a waited-for result that will never
   come is a problem for the waiting project to settle. Alternative: count it
   resolved like a cancelled owned item.
2. **Records pass no priority, and a backlog is a record.** Proceeding on:
   yes; record-owned work derives priority from open shared dependents,
   or none without them. Alternative: keep backlogs as P2
   roots; then every backlog item ranks P2, as now.
3. **Retiring legacy priority.** Proceeding on: the plan conversion migrates
   Whitefoot-kit, 总管 and 网站 and removes the legacy path, because plans make
   every project's structure dependency-only. Alternative: keep the switch;
   the plan model would then need the legacy rule for those three projects.
4. **Order of same-level rows.** Proceeding on: rows display in stored order,
   and `context` warns when rows of one level are not adjacent. Alternative:
   the server keeps every plan sorted by level (stable), which always makes
   parallel rows adjacent but reorders what a session wrote.
5. **Closed items after conversion.** Proceeding on: the mechanical
   conversion keeps closed children as provisional rows of their owners'
   plans, fully visible; a rewrite keeps only the closed items its new plan attaches,
   and every other closed item becomes, or stays, a closed top item without a
   flag; no history-only owner is created,
   because an item that only holds finished items is a topic group, which the
   rules forbid. Alternative: a per-project record 已完成 owning loose closed
   items, which would tidy the tree but carries no meaning.
6. **Own-work sub-items.** Proceeding on: the mechanical conversion keeps
   the 58 own-work sub-items as provisional owned rows; the rewrite folds each
   back by the rule in "When a row becomes its own item". Alternative: the
   converter folds them automatically, which rewrites history the sessions
   did not review.
7. **Cancelling with open parts.** Proceeding on: refused, naming the open
   owned items, so each gets its own reason. Alternative: a cascade that
   cancels all open owned descendants with the same reason.

## 6. MCP tools

Every tool returns compact text built for an agent's context: ids, titles,
status and the relevant lines, never whole files unless asked. An item or
card row ends with its short number (`· #812`), and JSON rows carry `num`;
`context` and `graph` accept `#812` or `812` as well as a key, an exact key
winning over a number. Writes take
`author`, the name of the project the session works for, selected from
`projects` by matching `repo` to its repository's GitHub remote. The
architect writes as `Architect`, a configured project like the others, from
the session `架构师` (section 9). Several sessions may share a project and
coordinate among themselves; sessions may be renamed freely. Every tool, reads
included, takes an optional `session` (1–80 characters, trimmed): the calling
session's own name as the app's session list shows it. A write records it as
described under the stalled-work rule's activity index; a call from the
architect's session (`架构师`) is also a receipt for the wake stream (section 8).
`context` prints
`last push: <session> · <time to the minute>` for an item with a known last
writer, and `brief` gives each work-in-progress row a `lastPush` with the
same text, so the architect sees whether work is being pushed and what a
closed session left behind. Omitting `session` is allowed; a call without it is no receipt.

### Server instructions

The server's instructions (`src/instructions.ts`) are a short pointer of at
most 2048 characters. They say that how to use the board and write on it is in
the shared `AGENTS.md` (`~/dev/wf/AGENTS.md`, section "Board", kept in the
agents_config repository), and give the first steps: call `projects`, pick the
project whose `repo` matches the repository's GitHub remote, call `brief`, and
pass that project's name as `author` and the session's own name as `session`
in every write. They state no rule of their own, so each rule has one
definition.

Why a pointer. Claude Code cuts a server's instructions at 2048 characters
(measured on 2026-10-16 in Claude Code 2.1.295, desktop app: the live
server's 3,722-character instructions appeared in a session's system prompt
cut at character 2048 and marked "[truncated]"), so the board's usage rules
(several times that long) placed in them would reach no agent running there.
The owner decided that board usage must stay in
the agent's context for the whole session. The shared `AGENTS.md` does: every
session started under `~/dev/wf` loads it and keeps it through compaction.
A guide tool or resource would add a call the agent must make and would not
keep the rules in context, so it was not built. The cost is that a session
started outside `~/dev/wf` does not load the rules; the pointer tells it to
read them.

A rule the server enforces is defined in `src/model.ts` or `src/rules.ts`;
the section "Board" states it for agents, and a change to a tool's behavior
or to a board rule changes that section in the same change. A test keeps the
instructions within the limit and free of rule text.

### Finding things

| Tool | Answers | Returns |
|---|---|---|
| `search(query, filters)` | Where is X mentioned? | Hits across item heads, plan rows (step and acceptance text), targets (goal, target value, current value and comparison baseline) and logs, cards and notes: id, kind, title, status, area, the matching line with its time. Filters: group, area subtree, status, kind, since. Substring matching, which handles Chinese without a tokenizer |
| `context(id, log?)` | What is this and how did it get here? | The item with its owner chain (each with status); its target lines; its plan, one compact line per row (below); the items holding a shared row for it, each with its status; its cards (open in full, ruled as question and ruling); its recent notes; flags; links and PR references; the last five log entries unless `log` asks for more |
| `graph(id, direction, depth)` | What does this wait on, what waits on it? | The item rows around the item as an indented list, each edge marked owned or shared, marking blocked chains and cycles |
| `history(id, limit?)` | How did this change? | Commits touching the item or card: time, author, summary |
| `diff(id, from, to?)` | What exactly changed? | The textual diff of the file between two commits or times |
| `changes(since, filters)` | What happened while I was away? | Items, cards and notes changed since a time or commit, grouped by area, each with one line on what changed |
| `prs(repo, number)` | Which items concern this PR? | Items whose text or links reference it |
| `list(filters)` | Structured browsing | Compact rows matching status, priority, area subtree, open ask, flags, updated-since; done/cancelled omitted unless an explicit status filter requests them |
| `overview(group?, status?)` | The board at a glance | Project name and inbox count once per heading; per area: counts by status including paused, owner actions waiting, blocked items, flags; status narrows those results while retaining area headings |
| `notes(filters)` | What did the owner say? | Notes by state, target subtree, kind, since |
| `dispatches(filters?, rows?)` | How have the sessions the architect started done? | The dispatch records of every project, tallied by level, by role and by the item's tags (an item with several tags counts under each, so the tag tallies can add up to more than the total): dispatches, those still running, those ended in each result, the rework share (`返工后通过` plus `换人`, over the ended ones; `放弃` is counted apart), the mean kickbacks over ended engineer dispatches, the mean rounds over ended review dispatches, and the cost; one line each for the total and the failure signals (ended dispatches carrying each). Every figure is added up from the rows; `rows: true` lists them, oldest start first. Filters: item `id`, `role`, `level`, `since` (inclusive) and `until` (exclusive) on the start time, in UTC to the minute or in full |
| `projects()` | Which project matches this repository? | Project configuration, top items, open items by status and inbox counts |
| `brief(project)` | What does this project need now? | Inbox, sent notes, checks, owner cards, WIP, next TODOs, paused work, outgoing work and its glossary terms; paused items stay out of actionable WIP and TODO queues; each item row carries its plan's unresolved rows and a count of resolved ones |
| `glossary(project?)` | What does a project's word mean? | Terms with definitions: one project's, or every project's that has terms |
| `followups(minutes)` | What is still unhandled? | Older sent notes and inbox requests with project |

### Changing things

A plan line in `context` and `brief` is `L<level> <glyph> <id> <text>`, with
`<glyph>` as on the page (✓ ● ○ ⏸ ◌ ✗); an item row adds `[own]` or
`[shared @<owner key>]`, the target's title and status, and for an owned item
its current doing step; a card row adds the card's status; `‖` marks rows of
a 可同时进行 group. `brief` folds resolved rows into `✓ N 项已完成` for
done rows (including owned records) and `✗ M 项已放弃` for dropped steps
and cancelled owned items. Plans
replace the separate steps, children, deps and parent fields of these
results, and `context` warns when rows of one level are not adjacent.

In this document `Architect` as a writer means author `Architect` writing from
the session `架构师` (section 9). `Architect` may write any project's items,
cards and note replies; every other writer only its own project's. Some
operations are reserved for `Architect`, and every other writer is refused
before any ownership check: `create_item`, `set_status`, `set_pause`,
`move_item_project`, `journal_entry`, a changed title in `update_item`, the tag
vocabulary tools, and the page order and other projects' repositories in
`create_project` and `update_project`.
Turning a cancelled item into a record in `update_item` is reserved too, but
its refusal comes after the ownership and revision checks, because it depends
on the item's state. `create_request`, which
files an item into another project's inbox, stays open to every project until
the inbox is removed. A write under the retired author `总管` is refused by
every tool.

| Tool | Does | Checks |
|---|---|---|
| `create_item(key, title, head, accept, owner?, after?, plan?, children?, priority?, group?, links?, data?, record?, tags?, difficulty?)` | Adds an item with its plan: `plan` rows (steps, shared and card rows, owned rows for top items of the project) then the acceptance step from `accept`. With `owner`, the owner's plan gains an owned row for it (optional `after`) in the same commit, inserted before the owner's first acceptance step; without it, the item is a top item of `group`. `children: [id]` moves existing items of the project under the new item as owned rows, each removed from its previous owner's plan, as `move_item` does | Key new and well formed; `accept` required for a work item and refused for a record; only `Architect`; owner and children in the new item's project; rows' targets exist; ownership and cycle rules (section 5); priority only for a new root (no `owner`), refused otherwise; no `status` argument; at least one valid tag once the vocabulary has a tag applicable to the item's project, none accepted before; `difficulty` a valid difficulty, never on a record, logged as the first rating |
| `set_plan(id, rows? / row? / remove?)` | Replaces the whole plan, upserts one row by id (keeping its position, or inserting a new row before the first acceptance step, or appending when there is none), or removes one. Row inputs: step `{id, text, state, waits?, reason?, after?, accept?}`; item `{item, own, after?}`; card `{card, after?}` | Exactly one mode; project ownership; no caller revision; server-stamped dates; dropped needs a reason; at least one acceptance step anywhere for work, none for records; acceptance uses ordinary step state and readiness rules; `after` names earlier rows only; an owned row only for an unowned item of the same project; removing or un-owning an owned row only for a closed target, else refused pointing to `move_item`; removing a row named in a later `after` refused; ownership and cycle checks; writing the whole plan (`rows`) clears a provisional plan's mark and logs 重写了计划; one commit with concurrent-write retry; identical result writes no commit |
| `set_targets(id, targets? / target? / remove?)` | Replaces goal numbers, upserts a complete goal by stable id, or removes one; values overwrite the previous row | Exactly one mode; project ownership; required nonempty text; no caller revision or date; server stamps date on current-value changes; one atomic commit with concurrent-write retry; identical result writes no commit |
| `set_tags(id, tags)` | Sets the item's whole tag list | Project ownership; at least one tag, no repeats; every tag in the vocabulary and applicable to the item's project, else refused naming the allowed tags; no revision (like `set_targets`, a whole-list write that retries on concurrent writes; `update_item` would need a revision read for a field that is replaced whole); identical list writes no commit |
| `set_tags_many(items: [{id, tags}])` | Sets the whole tag lists of many items in one commit, for backfilling the 缺标签 check | Each entry checked as `set_tags` checks it, naming the entry it refuses; one refused entry refuses the whole write; each item once; entries whose list is unchanged write nothing, and no commit is made when none changes |
| `set_difficulty(id, difficulty, reason)` | Sets the item's difficulty (1–5 or `architect`) and appends the log line for the change | Only `Architect`, whatever the item's project; a work item, not a record; `reason` nonempty, also for the first rating; no revision (a whole-field write like `set_tags`); an unchanged value writes no commit |
| `set_difficulty_many(items: [{id, difficulty, reason?}], reason?)` | Sets many items' difficulty in one commit, for rating a backlog of unrated items | Each entry checked and logged as `set_difficulty` does, naming the entry it refuses; `reason` is the default for entries without their own, and an entry with neither is refused; one refused entry refuses the whole write; each item once; unchanged entries write nothing, and no commit is made when none changes |
| `tags(project?)` | Lists the vocabulary with meanings and project limits; `brief` also lists the tags for its project | |
| `set_tag(name, meaning, projects?)` | Adds a tag or changes its meaning or projects (`null` projects: every project) | Only `Architect`, after the owner approves on a decision card (process rule, not enforced); configured projects; narrowing refused while an item of an excluded project carries the tag |
| `rename_tag(name, to)` | Renames a tag in the vocabulary and on every carrying item, with a log line on each, in one commit | Only `Architect`; `to` unused |
| `remove_tag(name, replace?)` | Removes a tag | Only `Architect`; refused while any item carries it unless `replace` names another tag applicable to all their projects, which they then receive in the same commit |
| `append_log(id, text)` | Adds a log entry with the server's time | Text nonempty, no reserved headings |
| `dispatch_start(id, role, level, model, effort?, agent, agentId, worktree?, startedAt?, did?)` | Records a session started on the item and appends `起：会话 …（号 …），角色，N 级 模型，推理强度，工作树，时间` to its log. `startedAt` is UTC to the minute or in full, the server's clock when omitted | Project ownership (the author is the item's project, as for `append_log`); `role` and `level` from the fixed options; `agentId` unused anywhere on the board; no revision, a concurrent write is retried |
| `dispatch_finish(id, agentId, result, usage, cost, reports?, kickbacks?, rounds?, waited?, signals?, note?, endedAt?, replace?)` | Completes the dispatch with its result, counts, usage, cost, failure signals and note, and appends `收：…` with every column to the item's log | The `agentId` is on the item (the error lists the item's own); an engineer needs `reports` and `kickbacks` and refuses `rounds`, a review the reverse; `result` and each signal kind from the fixed options, a kind at most once; token counts non-negative integers; `cost` non-negative, rounded to thousandths; `endedAt` not before the start; an ended dispatch is changed only with `replace: true`, which states the whole record again and logs `收（更正）：…` |
| `journal_entry(text)` | Adds one timed entry to today's architect journal: the record `architect-journal-YYYY-MM-DD` (local date, server clock) under `architect-notes`, created with the 协作流程 tag on the day's first call; the entry goes to the end of its head as `**HH:MM** text` | Only `Architect`; the day's key must not be a non-record item; text nonempty |
| `update_item(id, rev, fields, reason?, accept?)` | Changes title, head, links, priority, `data`, `order` (top items only) or record mode | A changed title, and turning a cancelled item into a record, only by `Architect`; a changed head requires `reason`, which becomes a log entry; priority only on a root, otherwise refused naming the items it comes from; `record: true` removes all acceptance steps and logs their texts; `record: false` requires `accept` |
| `set_status(id, status, log)` | Cancels a work item (`cancelled`) or undoes a cancellation (`open`), with a log line; every other status is derived from the plan | Only `Architect`; never records; cancelling refused while an owned row's target is open, naming them; the log line is required |
| `set_pause(author, id, paused, reason?)` | Sets or clears only this item's pause marker; same-project owned descendants inherit it; plan rows stay unchanged; server time and a log entry in one commit | Only `Architect`, at the owner's request in a comment; reason required when pausing; never records; closed work refuses pausing but an existing inactive marker can be cleared |
| `move_item(id, owner?, after?, priority?)` | Changes ownership: removes the item's owned row from its current owner's plan and adds one to `owner`'s plan, inserted before its first acceptance step; a log line on the item and on both owners names the move. Without `owner` the item becomes a top item of its project | Same project; no cycle (the new owner is not the item or below it); without `owner`, `priority` is required when the item becomes a root and refused otherwise, and the move is refused when an open item of the same project still waits on it through a shared row, naming them; `priority` refused with `owner` |
| `move_item_project(id, project, priority?)` | Moves the item and every item it owns, at any depth and in any state, to another project in one commit: each gets the new `group` and a log line. An owned row to a moved item in the plan of an item left behind (the item's owner, a backlog record included) becomes a shared row in the same place, with a log line on that owner. The item arrives as a top item of the new project. Key, number, history, notes and cards stay with it | Only `Architect`, before any ownership check; the project is configured and differs from the item's; every moved item belongs to that project and none is owned across projects (the existing 跨项目拥有 check, named); every tag of a moved item applies to the new project; refused, naming the items and the way out, while the move would leave an open waiter and no owner in the new project: an open item of the new project waits on the item through a shared row, or a moved item's plan holds a shared row to a top item of the new project that nothing owns (the existing 同项目有条目在等它，却没有条目拥有它 check, read after the write; a violation that was already there does not stop the move); an item that lands as an open root keeps its stored `priority` and needs one given when it has none; a given `priority` replaces the stored one, with a log line when the value changes, and is refused when the item does not land as a root; work leaving a paused chain is allowed, because `Architect` can resume it |
| `clear_ask(id, log)` | Removes a legacy ask after the project has replaced it with a decision card or settled it | Every owner wait is a decision card with options; a yes or no uses option A (do it) and option B (don't). Agents cannot create new asks |
| `write_card(key, item, question, background, options, confidence, blocks?)` | Adds or revises an open decision card; `blocks` makes it blocking (set it only when named work cannot proceed until the owner rules; `null` on a revision clears it) | One recommended option at most; item exists; `blocks` nonempty |
| `rule_card(key, choice, ruling)` | Records the owner's ruling | Choice is an option key |
| `reply_note(id, reply, replace?)` | Answers a note, stamps `repliedAt`, marks it done | An existing reply requires explicit replacement |
| `create_project(name, repo?)` | Configures a project; accepts any author string | Unique project name; `after` only by `Architect` |
| `update_project(name, repo?, mainline?, after?)` | Sets or changes a project’s repository, its main line branch (`null` clears it) or its place in the page order | Repository and main line: author is that project or `Architect`; the main line has no whitespace; order: only `Architect` |
| `create_request(project, key, title, head, accept, why, priority?, from?, after?, tags?)` | Files into any project's inbox with the acceptance step the filing project needs; `why` is the filing reason, kept as the request's first log line; with `from`, the filing item's plan gains a shared row for the request (optional `after`), which gives the request its priority | Author is a configured project; receiving project exists; `from` belongs to the author's project; atomic; priority required without `from` and refused with it; tags as for `create_item`, applicable to the receiving project |
| `triage_request(id, owner?, after?, priority?, log)` | Accepts a request: with `owner`, the owner's plan in the request's project gains an owned row for it (usually the item collecting the filing project's needs); without, it stays a top item | Author is the request's project; same-project owner; priority only when the request stays a root |
| `close_note(id, log)` | Closes a note and records handling in its item's log | Author is the note target’s project; not draft |
| `set_term(term, definition)` | Adds or replaces a term in the author's own glossary | Author is a configured project; term one line without surrounding spaces; definition nonempty. The description asks for words the project coined and uses repeatedly, not industry-standard terms, never in place of describing the phenomenon in plain words |
| `delete_term(term)` | Removes a term from the author's own glossary | The term is in it |

## 7. The page

The current template is kept. Its data layer, `window.claude.use("db")` and
`window.claude.use("comments")`, is replaced by a small client that loads a
snapshot from `/api/snapshot`, applies changes from `/api/events`, and shows the owner's notices as
`owner` events on the same stream; it posts the owner's notes and reads to
`/api/...`. The rules module
moves out of the page into `src/rules.ts` and is loaded by both.

The page shows two columns while an item is selected. With no selected item,
the right column and divider collapse and the tree uses the full width.
Selecting an item opens its detail again at the last dragged column width;
there is no layout toggle, and viewport width never changes whether detail is open.
It uses the full window with compact tree
margins and equal, smaller detail side padding.
The left column contains the header, summary and
navigation, project groups and filters, and the nested item tree.
The tree hides done and cancelled items by default. A project's 完成 or
取消 filter shows them in their stored ownership positions; 7 天内完成
narrows completed items by age. Every plan row stays visible regardless of
these filters. A plan reference, search result or unread stop opens a hidden
item's detail without changing the filters. Closed items' unread changes,
including card and reply changes, still reach 新 and the navigation stops.
Paused work remains visible by default, with a grey `◌ <number>` status chip,
its own 暂停 filter and a separate paused leaf count. Plan item rows use only
the grey `◌` glyph, distinct from waiting `⏸`. The detail head of open work
offers 暂停 with a small inline reason field, or 恢复 for its own marker.
Inherited pauses name and link their nearest source and show its reason;
resuming a child cannot clear that ancestor. Closed work with an inactive
own marker offers only 恢复, so the owner can also release open descendants
under a record without asking an agent to clear the marker. Records have
no pause control.
The detail shows an item's difficulty and tags on their own line directly under
the title: the difficulty first, as a plain outlined chip (「难度 3」, or 「架构师做」)
so it reads apart from the teal tags, then the tags; an item with a difficulty
and no tags still has the line. Tree rows show no difficulty.
Each project's filter row also offers one button per tag applicable to the
project (with the count of its items); selecting tags, any number, keeps the
items carrying any selected tag and their ancestors as dimmed path, as the other
filters do. The page shows nothing special for an untagged item beyond the 缺标签
check tag.
An item's status chip shows its short number (`812`) rather than a status
word: the chip's background and text colour carry the status, and its tooltip
names it (TODO, WIP, BLOCK, DONE, DROP, ◌ PAUSE, 记录). Every item status chip
does this alike: tree rows, the detail header, dependency rows and search
rows. An item not yet numbered shows the status word. A decision card's header
shows its number before the question.
Each item shows only its head row: fold toggle, status, priority, title, its
tags as small neutral grey chips (never a status colour; the tooltip is the tag's meaning),

new-content count, owner-wait counts and leaf counts. Clicking the row selects the item and
highlights it without changing its sub-item fold; the ▸/▾ toggle folds only
sub-items. Split tree titles, badges and counts use one smaller text size.
A tree row's right-hand counts show only open parts (todo, in progress,
blocked, paused); done and cancelled parts are not counted there, and a cancelled
item shows no check tags. Each tree row stays on one line: caret, status, priority, title, chips
and counts. The tree draws each item's owned items under it in plan order
(section 5, Item plans); a shared row draws nothing. An item that owns work
items counts, at the right of its row, its owned descendants that own no work
items; the counts leave out cancelled ones and
show numbers in their status color, with status names in accessibility labels. They shrink and clip away
completely before the title truncates with an ellipsis, retaining a minimum width of 6ch and
a full-title tooltip. New-content and owner-action chips remain visible.
The separate decisions section
and send box remain available.

In tree rows, the blue new-content chip, the filled dark purple chip (blocking
waits in the item and below it, asks included) and the filled dark red chip
(waiting cards without `blocks`, in the item and below it) show only their
numbers; a chip whose count is 0 is absent. Their tooltips and
accessibility labels retain their full meaning, and a purple or red chip leads
to the first such wait. The purple differs from the light-purple 卡住 status
styling, which is unchanged.
Every 新 chip shows only its number, including detail headlines and cards.
The existing ☰ menu help states which shortcuts require a selection and explains
only the blue new-content number, the purple and red wait numbers and
right-side status-colored leaf counts alongside its keyboard actions.

A card's header tag is a purple 阻塞 (tooltip: its `blocks` text) for a
blocking card and a red 决策卡 otherwise; an item's ask row carries 阻塞.

The summary groups three concerns into separate rows. The unread row has no visible label.
Row 1: purple 阻塞 N › (blocking waits, asks included) and red 决策卡 M ›
(waiting cards without `blocks`), each hidden at 0, followed by the existing
等你 panel. Row 2: blue 新 N ›, a thin vertical divider using the theme's rule color,
then 进展, 其他 and 评论回复, each hidden at 0 unless selected, then 清除筛选
(only while a filter is on) and 全部已阅. Controls wrap as width requires.
The divider is decorative and appears only between 新 and following controls.
Progress means plan-row and target changes; logs do not count as new.
Row 3: 全部折叠, 展开第一层, the status legend and the per-project links.
The arrow keys, 阻塞 and 决策卡 walk the waits blocking first.

The 等你 panel sits under row 1 and shows only while a blocking wait exists:
one row per blocking card or ask with a purple dot, the project, the `blocks`
(or ask) text and the shortened card question, ordered by priority (P0 first)
then by how long it has waited (card creation time; an ask's item update
time). A click jumps like the `/` search and remembers the place for Back. A
line 另有 M 张决策卡不挡工作 follows when M > 0.

There is no sticky path bar. Navigation and visibility checks use the viewport
top, and jumps leave only the ordinary 8-pixel edge gap without reserving space
or scroll margins for a bar. The existing send-box top button remains.

A vertical divider resizes the left column with pointer dragging. Its width is saved per viewer in browser
localStorage. At desktop widths, the tree retains a minimum width of 300 CSS
pixels and detail 380. In viewports of 704 CSS pixels or less, both columns
shrink equally to fit without horizontal page scrolling; header controls and
project links wrap.

The right column is sticky, fills the viewport height and scrolls independently.
It shows the selected item's head row with the same marks and chip, followed
by the order given in section 5 under "How the page shows a plan": the
目标, 计划和进展 with its unfolded cards, head text and data,
被依赖, the comment entry and comment list, collapsed 日志, ask, the open and
shown ruled cards the plan does not name, checks and refs. 被依赖 leaves out cancelled items. Clicking blank space clears both
the tree highlight and the detail selection and collapses the right column.
Clicks on controls or the divider and drags that select text preserve selection.
All change marks, fresh lines, notes and
replies retain their meanings. Selection inside the detail column retains
the existing item, log, card and note selection keys and actions; a plan
row is selectable as a dependency row was (`row:<item>@<row id>`), and
comments on a selected row go to the item without an anchor.
The selected item is saved per viewer in browser localStorage and restored
when it still exists; unavailable storage does not prevent using the page.

Enter on a focused head selects its item; j/k move focus without opening detail.
Reading requires a current selection or a selected detail item;
with neither, it reads nothing. Comment and explain actions fall
back to the selected detail item or the top visible tree row. After clearing
selection, j/k followed by Enter or an unread/wait jump opens detail again.

`n`, `N` and 新 chips select the stop's item and open its detail. When its
tree node is visible, they unfold its ancestors and bring that row into view;
closed-item stops do not change the filters or require a tree node. They then
scroll the right column to the exact fresh mark, card or note. A card held by no item keeps its existing
navigation behavior in the separate decisions section. Dependency links,
Backspace/`[` and the 下一条 walk through the waits also select their target item and
show its detail. Tree folding and detail selection are independent.

`m` acts on the item holding the current selection: the item for `it:` and
`log:<item>@<time>`, the card's item for `q:`, the target's item for `note:`.
The same selection works after the 下一条 walk through the waits, a click, `n`, a 新
chip or following a dependency. It reads each of that item's documents' displayed
unread changes, including those hidden by freshness filters, through its
latest unread step, without reading another document or a change arriving
after the action. A selection with nothing unread shows “这里没有新内容”, or,
on an item whose new content is all in its sub-items, how much is there.
The selected item's blue bars, chips and counts clear immediately while
the write is pending and return with a visible error if it fails, using the
same eight-second deadline and no automatic retry as other owner controls.
If a later change joins a pending read's step, that combined step waits for
the server's read result to separate its later unread changes.

In a comment, typing `#` opens a small popup of the items and decision cards
whose title contains the text typed after it (ignoring case; up to eight
shown). When the text is a number, the item or card holding that number
comes first, then titles containing those digits. Up and down choose, Enter or a click writes a reference token over
`#…`, and Esc closes only the popup. A `#` glued to a word before it, as in
`Repo#341`, starts nothing. The token is `[[it:<key>]]` for an item and
`[[q:<key>]]` for a decision card: the prefix is there because an item and a
card may share a key, and double square brackets begin no other markup in
block text (a link needs `](`). The note keeps the token as typed, so a
session reading it through the MCP tools sees the key. Wherever block text
renders (heads, steps, log entries, comments, replies, cards), a token whose target
exists shows the target's current title as a link; a click selects that item
(for a card, its item with the card shown) and shows its detail. When the
tree node is visible, its ancestors unfold; a hidden closed item opens
without changing filters. Back returns, as with a dependency link. A token
whose target is gone shows its key struck through. Tokens inside code spans or
fenced code stay as typed. When a target's title changes, or a target appears
or goes, and any item, decision card, note or the board goal refers to it, the
page renders again.

`/` anywhere except while typing in a text field opens a search box over every
item and decision card by title, matched as in the popup (ignoring case,
substring, any language; `812` or `#812` puts that number's item or card
first), done and cancelled ones included. A row shows the
status, the title, the project and the owner item (a card's holding item). Up
and down choose, Enter or a click goes there as for a reference, and Esc or a
click outside closes it.

Choice, approve/done and explain controls show their pending state immediately,
before sending the write, and restore the authoritative state with a visible
error if it fails. `POST /api/draft` sets or clears a target's draft of that
kind in one owner operation: replacing a choice makes one commit, preserving
sent and completed notes. Its response carries the affected draft and deleted
ids so the page can settle its pending state without waiting for live updates.
The affected control stays busy until that write settles. Sending waits for
pending draft writes and stops if one fails, so an immediately displayed choice
cannot be omitted from the send by a slower draft request.

Every displayed unsent note has 编辑 beside 删除. The existing rules for
which notes appear on the page stay the same. Editing replaces its displayed
text with an in-place textarea prefilled from the existing note; 保存 updates that exact
note and 取消 discards the local edit. This includes displayed comments and
explanation requests; the exact-id API supports every draft kind, including
generated answers. The existing action kind and selected option stay fixed; the page keeps their action label and displays edited text.
`POST /api/draft` also accepts the strict edit shape `{id, rev, text}`. It
changes only a draft's text, preserving its id, target, kind, choice, creation
time and anchor. It rejects sent or handled notes, a stale revision, and an
empty or whitespace-only comment. Its response uses the same authoritative
`note`, `deleted` (empty for an edit) and `commit` fields as control writes.
An edit conflict is returned to the page, never retried with a newer revision.

Approve and done notes match a legacy ask by its exact original action text.
The first edit of either kind captures that original text in the optional,
server-owned `answerText`; later edits keep it. Ask matching uses `answerText`
when present and otherwise the stored text. Editing therefore neither changes
which ask was answered nor turns an originally mismatched answer into an
approval. Agent context and sent-note summaries include the original action
text when it is present. Creating a note cannot supply this field. A new
selection through the existing action control resets it to that control's current action.

The editor keeps its typed text and original revision across live updates and
scoped renders. A sent or deleted note closes its editor. While a save is
pending its editor and delete action are disabled; sending waits for that
save and stops if it fails. Edit acknowledgements obey the existing revision
ordering, so a late response cannot overwrite a newer live update. Editing
uses the same eight-second deadline, connection checks and no-retry policy
as other owner writes.

Live changes, unread results and loaded baselines schedule a shared render on
the next animation frame. A 100-millisecond timer runs the callback if the
frame has not fired; whichever runs first cancels the other, and the callback
runs once. When animation frames are unavailable, a zero-delay timer is used.
The same scheduler drives jump animation, so a suspended animation-frame
stream cannot leave navigation waiting indefinitely. Changes arriving before
that callback share one render. Note
changes update their item or card, and an item or card change updates its
affected subtree and summaries; unrelated cards keep their DOM elements.
These same scoped render paths update the selected item's
detail in place and preserve its scroll position. Unrelated changes do not
rebuild the detail column.
Scoped card updates also reconcile membership and order: an unread reply can
reveal a ruled card, and clearing unread state hides a card that was open only
by that default. Explicit owner choices to open or fold it remain in effect.
The header counts and send box update with the affected content. Unread
refreshes are debounced across each burst, and superseded results cannot
replace newer state. Rendering preserves the editor's focus and caret and
the reading position.

After a jump, the page holds the target at its landing position through
subsequent renders, including baseline loads and unrelated live changes.
The owner's scrolling, key press or click ends that pin; a new jump establishes
its own target. Programmatic scroll corrections do not end it.

Every page write has an eight-second deadline, including reading the response.
On timeout the page restores the control and shows a banner saying that the
board server did not answer and to refresh. It never automatically retries a
write, because the server may already have applied it. A dropped live-update
connection immediately shows “已和看板服务器断开，正在重连…” and refuses
writes with that message. Reconnection retries every five seconds; writes
resume and the banner clears only after a live connection and a successful
snapshot reload restore the page's current state.

Code blocks. A fence's first info word names its language (` ```wf `, ` ```rust `);
`web/highlight.ts` tokenizes line by line, with no library. `wf` and `whitefoot`
blocks mark comments (`//`), keywords (the lowercase fixed atoms of the Whitefoot
grammar), primitive and capitalized type names, numbers (suffixes such as `7_u64`
included) and strings. Other named languages mark comments (`#` for sh, bash,
yaml, python, toml; `//` for the C-like languages), strings and numbers only. An
unlabeled fence, and an unknown language, is plain, so output, logs and LLVM
attributes stay as written. Highlighting only wraps text in spans, so the text
content is exactly the source. A block of 3 or more lines shows line numbers from 1,
blank and comment lines counted; each line is a span whose CSS counter
`::before` draws the number, so the gutter is neither selectable nor copied.
Blocks of 1 or 2 lines show none. Long lines scroll horizontally. Change
marking wraps whole blocks, and glossary links skip text inside code, so
neither writes markup into a token.

Glossary links. In item heads, steps and log entries, card questions, backgrounds,
options and rulings, and note texts and replies, a glossary term links to its
definition. The page has no glossary section. Titles are not linked. Terms
match as plain substrings, the longest at each position; the text's own
project's glossary wins over another project's for the same term. Text inside
code, code blocks and links is never matched. Only the first occurrence of each
term in one text links: an item's head, steps and its shown log, in display order, are
one text, and each card and each note with its reply is its own. A link click
acts before the clicked element's own handlers, so a term in an option chooses
nothing; it opens a popover beside the link with the term in bold and its
definition from the glossary of the project named in the link. The page does
not scroll or navigate. A click anywhere else, Escape, a scroll or a click on
another term closes the popover; only one is open at a time. A glossary change
re-renders the page.

The plan, its rows, groups and mock-up are specified in section 5
(How the page shows a plan). Doing-day counts refresh with the page's
existing minute timer without a server write. The 目标 table above the plan
has columns 目标 / 当前 / 目标值 / 比较对象 / 日期. Each row is one goal; the
date shows YYYY-MM-DD. The table is hidden for items without targets and
wraps at phone width. 日志 is collapsed by default for every item, including
items with an empty log.
One click opens the complete history and another closes it. Log entries retain
their existing comment anchors and reference links; manually opening history
does not make it unread.

## 8. Waking sessions

"发给 Claude" posts to `/api/send`. Draft notes become `sent`, and each
sent note produces one `note` event on the wake stream (below). Sending
does not mark a note handled. It stays `sent` until a project agent replies with
`reply_note` or closes it with `close_note`. Closing stamps the handler and
time and appends `关闭评论：<log>` to the owning item, atomically; it adds no
reply text and refuses draft notes; an existing reply is preserved.

`/api/send` also takes `{ids:[...]}` to send only those drafts, with the same
effects and wake events as the batch send for each; an id that is unknown or
not a draft refuses the whole request and sends nothing. The page uses it for
the "发送" button after a decision card (enabled once the card has a choice
draft, sending that card's drafts) and under a saved draft comment; the send
box still sends every draft.

The page immediately hides a card whose choice is being sent and shows the
affected comments and explain requests as sent, while saving and sending in
the background. Sending still waits for every pending draft save; a failed
save prevents sending. A failed save or send restores the previous controls
and draft text and shows the error; the committed snapshot stays authoritative.

### The wake stream

The wake stream is the board's one push channel. It has one listener, the
architect, who is told only what needs it; every other session reads the board.
What the architect does with an event, and how it listens, is in the
architect's rules and in `~/dev/wf/AGENTS.md`, section "Board".

**What is pushed.** Six kinds, defined in one table (`WAKE_KINDS` in
`src/wake.ts`; `push` refuses a kind or field set the table does not list):

- an owner note: a note becomes `sent`, on any project's item or card, so the
  owner's comments on an engineer's item reach the architect too;
- stalled work: an open item gains the 无人推进 check. No other check is
  pushed: the rest are format flags that whoever wrote the item sees;
- the timed wake, every 30 minutes;
- what the look at GitHub finds (Watching GitHub, below): a main line whose
  checks failed (`main-red`), a pull request an open item names whose checks
  failed (`pr-red`), and one whose checks all passed and which can merge
  (`pr-ready`).

Not pushed: a new request, a blocking card (the owner is told on the Mac and in open pages, below),
an item's ask, any other check, draft-PR CI. A later kind is one entry in the
table and one row below: a pull request on no open item (wf-board item
watch-github, its second row) and a slow board operation (item slow-op-alerts).

**Address.** A client opens a WebSocket to
`ws://127.0.0.1:<port>/wake?after=<n>` (the running daemon uses port 7417).
The server answers 404 unless the path is `/wake`, 400 when `after` is not a
whole number, and 403 unless the `Host` header is `127.0.0.1:<port>` or
`localhost:<port>` and any `Origin` header equals `http://<host>`; a
command-line client sends no `Origin`. A `session` parameter, which the earlier
per-project filter took, is ignored.

**Frames.** Each event is one text frame holding one JSON object. `n` is its
number, 1 for the first event and rising by 1; `at` is its time. These are all
the forms the server sends:

| Frame | Sent when |
|---|---|
| `{n, at, event:"note", note, target, kind, title, project}` | A note changes from not sent to `sent`. `note` is its id, `target` is `it:<item>` or `q:<card>`, `kind` is the note's kind (comment, explain, approve, choice, done), `title` is the card's question, else the item's title, else `target` itself, and `project` is the item's project |
| `{n, at, event:"stalled", item, project, title, text}` | An open item gains the 无人推进 check it did not have, after a committed change or on the one-minute timer (stalled work appears with active time alone). `text` is the check's explanation. A stall that goes and returns is sent again; the set is seeded at start without sending, so a restart announces nothing |
| `{n, at, event:"timed", since, changed, working, architect}` | Every 30 minutes after the last timed wake (the first, after the daemon's start). `since` is the time of the last one, or of the start. `changed` lists the items whose documents, cards or notes changed after the last one, as `{item, project, title, status, by}` where `by` are the writing sessions (or authors, when there is no session); an item only the architect's own session wrote is left out. `working` lists the open items outside the Architect project that have a step being done, and `architect` every open item of the Architect project, each as `{item, project, title, status, flags}` with the labels of its checks. Each list holds at most 60 entries, then `{more: n}` |
| `{n, at, event:"main-red", repo, project, branch, commit, failed, url}` | The newest commit of a configured repository's main line has failed checks and no push was made for this commit. `repo` is `Owner/Name`, `project` the project that owns it, `branch` the main line, `failed` the names of the failed checks, `url` the commit's page |
| `{n, at, event:"pr-red", repo, number, project, title, commit, failed, url, items}` | A non-draft pull request that an open item's 改动 section names has failed checks on its newest commit and no `pr-red` was pushed for that commit. `items` lists `{item, title, project}` for each such item, `url` is the pull request's page |
| `{n, at, event:"pr-ready", repo, number, project, title, base, commit, url, items}` | A non-draft pull request that an open item's 改动 section names has all checks passed and can merge, and no `pr-ready` was pushed for its newest commit. `base` is the branch it merges into. `items` lists `{item, title, project, blocking, approval}`: `blocking` the item's open blocking cards as `{card, question, blocks}`, `approval` the cards the item's merge row for this pull request follows, directly or through earlier rows, as `{card, question, ruled}` |
| `{event:"connected", latest}` | First on every connection. `latest` is the number of the newest event, 0 before any, so a client that has seen none still has a number to come back with |
| `{event:"gap", oldest, latest}` | After `connected`, when the client asked to continue from a number and the events after it are no longer all kept: `after` is more than one below `oldest`, or above `latest`. The client sets the number it remembers to `oldest − 1`, reads the board for what it missed, and goes on. That is right in both cases: when `after` was above `latest` (the numbering went back), it lowers the number, and the live events that follow are numbered above `latest`; when events were dropped, the kept events replayed after the gap frame are all numbered above `oldest − 1` and none is taken for a repeat |

`connected` and `gap` carry no number and are not events.

**Delivery and reconnect.** Events are numbered and kept: the newest 1000, at
most 2 MiB, in `state/wake.jsonl` beside the board (git excludes it), so numbers
continue across a restart. A client remembers the `n` of the last event it
handled and connects with `after=<n>`; the server sends `connected`, then `gap`
if needed, then every kept event numbered above `n`, then live events, with no
event missed or sent twice between replay and live. A client drops an event
numbered at or below the one it remembers (a repeat); a gap frame sets that number
first, as above. Without `after` the client gets live events only. Every connected client gets every event. The server pings every 25
seconds and closes a socket that did not answer the previous ping; it also
closes a socket with more than 4 MiB of unsent frames. A client reconnects after
any close.

**Receipts.** A call to any MCP tool whose `session` is `架构师` answers every
event pushed before the call arrived; the call counts when its arguments pass
the tool's schema, whatever the tool then does. A receipt writes a line to the
file only when it answers something new. The architect is expected to make such
a call after handling a wake, which it does anyway by reading or writing the
board. The timed wake comes every 30 minutes, so an architect that is running
answers within the hour.

**No receipt.** When the oldest unanswered event is one hour old (the limit is
an option for tests), the board tells the owner once: 「架构师 1 小时没响应」,
naming that event. The architect has stopped: its session crashed, waits at a
permission prompt, or no longer holds the Monitor that carries the stream.
No more alerts follow until a receipt arrives and a later event goes unanswered
for an hour. The receipts and the alert state are in the same file, so a restart
neither repeats an alert nor forgets one.

**The owner's notifications.** A decision card that stops work (open, with
`blocks`, newly so or with changed `blocks`) tells the owner, and so does the
no-receipt alert. Each notice goes two ways:

- To every open board page, as an `owner` event on `/api/events`, carrying the
  title, the message and a target (`{kind: "card" | "item", key}`, or none).
  The page shows a browser notification (Notification API) when the owner
  allowed notices. The notification's tag is `card:<key>` or `item:<key>`, or the
  title when the notice has no target, so open tabs show one notice for the
  same card or item. A click focuses the page and opens the card or item,
  or the home view when there is no target. The event is live only: a page that
  connects later gets nothing from before its connection, and a reconnect does
  not replay. A closed page gets nothing; Web Push is not used.
- To the Mac, through `osascript` with a fixed script that shows a macOS
  notification, passing the title (`挡事的卡 · <project>`) and message
  (`<question>（挡住：<blocks>）`) as arguments, not spliced into the script, so
  any text is safe. The daemon is a LaunchAgent in the owner's login session,
  which is what lets it show one; a failed run is tried again, up to three
  times, and then logged. Script Editor must be allowed to notify in System
  Settings. This route goes once the browser route is checked (wf-board item
  chrome-notify).

A card without `blocks` tells no one. A no-receipt notice's target is the item
or card of its oldest unanswered event: a `stalled` event's item, or the item or
card a `note` event is on; a `timed` event names neither, so its notice has no
target.

**Why not MCP push.** Plain MCP lets a server send notifications, but Claude
Code does not start a turn in an idle session for them. Claude Code's
*channels* do exactly that (`notifications/claude/channel` from a server
declaring the `claude/channel` capability), but as of 2026-10-11 they are a
research preview: a channel must be a stdio subprocess of the session, and a
custom channel loads only when the session is started from the command line
with `--dangerously-load-development-channels`, which the desktop app's Code
sessions cannot pass. The wake events are therefore defined independently of
transport, so a thin stdio channel that relays `/wake` can replace the
Monitor once channels allow it, without changing the server. Until then the
architect runs a small client under Monitor, which lasts 30 minutes at most and
is started again: the numbers and `after` carry it across the gap.

### Watching GitHub

The board looks at GitHub itself and does with the answer what the architect
would otherwise do by hand on each round: it tells the architect when a pull
request can merge or the checks went red, and it marks the merge row of a
merged pull request done (`src/watch.ts`, `src/github.ts`).

**The look.** Every five minutes, and not oftener, because every session on the
owner's account shares GitHub's quota. The time of the last look is kept in
`state/github-watch.json` beside the board (git excludes it), so a restart waits
out what is left of the interval (no record: it looks at once; a record in the
future, from a clock that went back, counts as at most one interval). The daemon asks
`gh api graphql`, signed in as the owner, one question per configured
repository: the newest commit of the main line with its checks, the open
pull requests (newest 100) with draft state, base branch, newest commit,
mergeability and checks, and, by number, the pull requests the open items'
merge rows name, in any state. A repository that fails, has more open pull
requests than one look reads, or lacks its configured main line branch is
reported by `/health` (`github.problems`) and logged once; the other
repositories go on. `GithubSource` (`src/github.ts`) is the interface the
tests replace.

**Which pull requests.** Those the 改动 section of an open item names
(`changesSection` in `src/rules.ts`). The section starts at a `## 改动` heading,
or at a line that is `**改动**` with or without a colon after it (text after the
colon on that line belongs to it). It ends at the next heading (after a `##`
heading, one of its own level or above, so `### Repo#N` subsections stay inside),
at the next line that is a bold section name alone, or at a line that starts a
参考 section. A pull request is written as
`Owner/Repo#N`, `Repo#N` (a repository a project configures, unique by name) or its
URL; a text that names a repository no project configures names no pull request
the board watches. Pull requests named elsewhere (logs, links, other sections)
are not watched.

**What the checks say.** The board reads the checks on a commit itself, not
GitHub's roll-up state, which counts a cancelled run as a failure (`summarize` in
`src/github.ts`). Every check on the commit counts, whatever event started it: a
repository's real checks may run on push, on pull request or both (Firn-wf,
Halo-wf, Snowghost-wf and Whitefoot run theirs on push, and their pull request
runs are mostly skipped gates), and the same set is read in each case. A check
that failed (failure, timed out, startup failure, action required, an unknown
conclusion, or a status that failed or errored) makes the commit `failure`,
whatever else is still running. Within one round of checks (a check suite: one
workflow run for one event, and its reruns) the attempts at one check, the same
name, count only by the latest, by start time and, at equal time, the worse one,
so a red that a rerun replaced says nothing. Different rounds count each by
itself: the push round and the pull request round of one workflow are two
checks, and a red in either is a red, since the pull request round tests the
branch merged with its target and the push round the branch alone. A cancelled
run, which a newer push replaced, says nothing as long as another run of its
check is in the same round; a check with only cancelled runs in its round has
not run, so the commit is `pending`. Otherwise an unfinished check, or more
checks than one answer holds (100), make it `pending`. Otherwise at least one
successful check makes it `success`; a skipped or neutral check is no failure
and no pass, since a gate that was skipped ran nothing. A commit with no check
to read, or only skipped or neutral ones, is `none`, which is not green: GitHub
runs no pull request check for a pull request with a merge conflict, and a
commit nobody has run yet looks the same.

**The three pushes.** All are about non-draft pull requests; a draft's checks
are the engineer's. `pr-red`: the checks say failure. `pr-ready`: the checks say
success and GitHub reports the pull request mergeable (not conflicting; still
being computed counts as not yet). A pull request whose checks are pending or
none, or that cannot merge, is told nothing. `main-red`: the checks of the main
line's newest commit say failure. A push is made once per key: `main-red` per
branch and commit, `pr-red` and `pr-ready` per pull request and newest commit.
The keys of the events still kept are read again at start, so a restart neither
repeats a push nor loses one (an event the log dropped may be told once more).

**Merge rows.** A merge row is a step of an open item that is not done, not
dropped, not an acceptance step and says 合入 (`isOpenMergeStep`), and that names
a pull request, in the forms above, which the item's own 改动 section names as
well (`mergeRowPulls` in `src/query.ts`). Those are the pull requests that count
for the row. A line that waits for another pull request to merge names it too,
and that one is not the item's own, so it does not count and a line naming only
such pull requests is no merge row. When GitHub reports every pull request that
counts for the row merged (`mergeRowDone`), the board marks the row done and
appends a log entry naming them and their merge times, in one commit, as the
item's project and session 看板. That write (`markMerged`, an operation without
an MCP tool) reads the row as it is by then: a row that was edited, dropped,
removed or already done since the look, or whose counted pull requests are no
longer all merged, is left as written. A row that also says more (a deployment)
is marked as a whole, so a merge row says only the merge. A write that fails is
tried at the next look.

## 9. Project responsibility

Responsibility belongs to the project, the existing `group` page heading;
there is no extra item layer. `board.projects` contains unique project names
and an optional repository identifier such as `Ming-Research/Halo-wf`:
`{name, repo?, mainline?}`. `mainline` names the branch merges land on when it
is not the repository's default branch (wf-board's main line is its default
branch `main`, so it sets none); the GitHub watch reads the checks of that
branch, or of the default branch when `mainline` is absent.
Identity is the project itself. Each project has a responsible
agent session started in its repository; several sessions may share that
responsibility and coordinate among themselves. Sessions may be renamed
freely, so no session names are recorded. This model supersedes per-project
agent lists as well as per-item `agent` ownership and child handovers. An
area with an absent or unconfigured group gets a shared rules check; older
boards without `projects` load with an empty list.

At a repository root, a session calls `projects`, picks the project whose
`repo` matches its repository’s GitHub remote (the architect uses
`Architect`, from the session `架构师`), uses that project’s name as `author` in every write, then reads
`brief(project)`. No claim or session registration is needed.
The page displays configured projects in `board.yaml`'s project list order.
`create_project` configures `{name, repo?}` and accepts any author string
when appending the project last. Its optional `after` names an existing
project to place the new project immediately after; only `Architect` may supply it.
`update_project(author, name, repo?, mainline?, after?)` sets or changes a repository
or main line branch (`mainline: null` clears the branch): a project may change
its own repo and mainline, and `Architect` may change any project’s. Only
`Architect` may set `after` to move a project immediately
after another configured project; omitting it preserves the current order.
An unknown `after` or moving a project after itself is refused. An order-only
update needs no `repo` or `mainline`. Ordering is defined in `src/rules.ts`.
Each call combines repository and ordering changes in one data
commit. Both run in the same operations queue as item writes, including
prospective board checks.

Every agent mutation except `create_project` requires a configured project
as author. An unknown author is refused with the configured projects and an
instruction to call `projects` and use the project whose repo matches the
caller’s repository. Item mutations require `author === projectOf(target)` or
`author === Architect`; this applies to items, their cards and owner-note
replies or closures. Only `Architect` creates items, in any project
(`create_request` aside, section 6).
`set_term` and `delete_term` change only the author's own glossary,
`Architect`'s included. Moving work requires the source and destination to
belong to one project, which the author must own unless it is `Architect`
(`move_item_project` leaves its source project, so only `Architect` may use
it, section 6), and revising a card’s owning item checks both owners the same
way. A refusal names the item’s project
and directs the caller to file into it with `create_request`. Cross-project
dependency targets remain allowed on a project’s own items. The page’s
owner-note, send and read operations are separate from agent
operations and remain unrestricted. Project names are supplied by trusted
local callers; identity checks enforce the workflow, rather than
authenticate against a caller impersonating another project.

The architect's identity is author `Architect` writing from the session
`架构师` (`isArchitect` in `src/model.ts`). Both are needed because
`Architect` is also the project of the agents_config repository, and an
engineer who does an Architect item there writes as author `Architect`, as
every project's engineer writes as its project. Without the session such a
write is an ordinary project author's: it may write the Architect project's own
items and nothing reserved. The session name is not authenticated, as no
project name is; the rule stops misuse, not impersonation. The architect's
writes carry `Architect` as commit author and log `by`, so history and logs
show the architect made the change, not the item's project. The operations
reserved for it are listed with the tools (section 6); the check is
`onlyArchitect` in `src/ops.ts`, and project order uses the same judgement in
`src/rules.ts`. The coordinator project `总管` stays configured, so
its items, glossary and history remain readable, but `run` in `src/ops.ts`,
the one path every agent write takes, refuses any write under that author
with a message naming `Architect`. Store migrations commit under `总管`
directly and do not pass through it; the historical authors stay as written.

Any configured project can call `create_request(project, key, title, head,
accept, why, priority?, from?, after?)`. It creates a top item in the
receiving project with `request: {by: author, at}`, a plan holding the
acceptance step `accept` that the filing project needs met, and first log
`${author} 提出：${why}`. With `from`, the filing item must belong to author’s
project; its plan gains a shared row for the new request in the same commit,
and the request takes its priority from that item, so `priority` is refused.
Without `from` the request is a root and `priority` is required.
Requests stay in a separate inbox, oldest first, until the receiving project
triages them. `triage_request` removes the marker, sets an optional priority
when the request stays a root (no owner and no open item depending on it),
logs the disposition, and either gives the request an owned row in an item of
its project (normally the item collecting the filing project's needs) or
keeps it a top item. Placement also appends
`分拣：放到「<owner title>」下` before the supplied log. Moving a
request under an owner in its project also triages it and logs the placement.
A receiving project cannot decline a request itself; the architect declines it
with `set_status cancelled`, which clears the marker and records the reason. An open inbox request is not an area in listings; completed or
cancelled items are not open requests.

`projects` reports name, repo, top-item counts, open item status counts
(excluding inbox requests), and inbox counts. `brief` supplies inbox reasons,
sent item/card owner notes, checks including cleared blockers, open cards
still awaiting the owner, items in progress with a doing step of their own,
the next ten items rated 1–5 that an unpaused root needs and whose frontier holds a step that can start, by priority,
outstanding work requested from other projects, and the project's glossary
terms. Relevant item rows include compact plan and target lines, and the
item's difficulty when it has one. `brief.progress` adds
`{id, title, plan?, targets?}` rows for records and blocked items
that are not already represented in the inbox, checks, WIP, TODO or
outgoing rows. It does not repeat those rows or add closed work and the TODO
backlog. The outgoing list includes open requests with `request.by === project` and open items
targeted by its items’ cross-project shared rows, so triage does not hide
linked work. Read rows, project summaries
and `followups` have no agents field; `list` selects a project through its
`group` filter. The page shows an inbox above each project’s areas and counts
sent notes per project, such as `已发出 3 条：Halo-wf×2 · Firn-wf×1`.
Requests come from projects; the owner asks for work through notes and the
coordinator, so the page files none. Delivery belongs to the coordinator:
it finds a project’s live session by its working directory, independently
of its current session name.

Keys bear on it. The rule that every key starts with its session's prefix
exists so that sessions writing one database never collide. The server now
refuses a duplicate key, so the prefix no longer prevents anything, and after
a handover it names the wrong session: the export holds 236 `old-prefix-*`
items under other sessions' areas and 21 more items whose prefix differs from
their area's session. The owner chose (2026-10-11, option A): new keys need
not carry a session prefix; existing keys stay, because notes and log text
cite them.

## 10. Migration

1. Convert the export into the file format, keeping every id, in one commit.
   The survey of the export found no broken dependency, cycle, bad timestamp
   or invalid status; the conversion applies these mechanical cleanups:
   - derive projects from top-level area groups in their displayed order,
     without agents; drop every item's `agent`,
     with separate area and child counts in the conversion report;
   - fold `area` into `parent` and `text` into `head`; drop empty strings and
     the ignored status and priority on 17 and 6 parents;
   - turn the 18 bare-string deps (all on done queue items) into entries
     whose why says it was not recorded;
   - add the 2 unfinished sub-items their parents do not list (under
     example-rules and example-proof), with a why taken from the sub-item's
     title;
   - set `updated` to the newest log time on the 5 items where it is missing
     or older; take a ruled card's `ruledAt` from the owner's choice note;
     parse `confidence` into optional score and reason, preserving unscored
     text verbatim and every recorded log author;
   - leave bare `#NNN` references as written: a project's items also cite
     other repositories' pull requests (Snowghost items cite `Whitefoot #348`),
     so the item's project does not name the repository; `prs` reads both
     `Repo#N` and `Repo #N` and reports the rest as repository unknown;
   - give the one item without a title a placeholder title, to be named
     after the migration;
   - move the 50 notes and 49 reads whose target was deleted to
     `import/orphans.json` instead of dropping them.

   The legacy schema's redundant fields are folded as follows: a nonempty
   `parent` wins over `area`, an existing `head` wins over `text`, card `item`
   owns placement instead of item `qs`, and note titles derive from their
   targets. Null note anchors and empty optional strings are omitted. Board
   `updated` and `revision` belong to the replaced artifact store; git history
   replaces them, and `freshSince` participates in read reconstruction instead
   of becoming current board metadata. Reply metadata is retained even when
   no reply text exists. Unknown nonempty fields are refused, not discarded.

   Migration records an as-read checkpoint followed by the current checkpoint.
   Item snapshots restore title, head (or legacy text), data, status, priority
   and dependency signatures; `qs` supplies evidence of which cards existed.
   The latest item snapshot applies even without a newer item update timestamp;
   a later all-read or freshness floor supersedes that snapshot.
   Log entries after the effective read time are excluded. Cards dated after
   their item's read are excluded even if the item itself has not changed.
   Without `at`, a card listed in the snapshot is known to have existed;
   otherwise its earliest update/note time, or export time, supplies the available
   dating evidence. This cannot recover an undated card's actual
   creation time. Card contents and rulings were not snapshotted and stay
   current for cards that remain. Item parent, group, order,
   links, ask and created also stay current; older snapshots leave any missing
   fields current. Note contents stay current except unread replies are hidden using
   target/all read times (the legacy item freshness floor does not read replies).

   Every agent operation checks the prospective board and refuses the newly
   introduced violations that section 5 (Item plans, Checks) marks as
   refused. Existing flags can still receive progress.

   Judgment cleanups go to the responsible sessions as items after the
   migration: 3 asks whose cards are all ruled, 3 done items with an open
   dep, 2 archived items still open, 35 heads holding dated progress, the
   example-queue history (75 done queue entries), the 236 `old-prefix-*`
   backlog items living under other sessions' areas, and 4 near-duplicate
   pairs.
2. Verify the conversion against an oracle independent of the converter: for
   every document of the export, the server's view of it reproduces each
   field.
3. Point the page at the server and check it against the artifact page side
   by side.
4. Rewrite the board sections of `agents_config` (AGENTS.md "Status board",
   coordinator.md) for the new tools, tell every session, and leave the
   artifact as a read-only pointer to the new board.

The project schema remains strict: existing `board.yaml` project entries
with `agents` are refused as unknown fields. Adopting project identity
therefore requires the primary agent to migrate that configuration in one
data commit before loading it with the new server; the server does not
silently discard fields. Historical documents returned by `store.show`
remain exactly as written, including historical session authors and fields.

### Plan conversion

The plan model (section 5, Item plans) replaces `parent`, `deps`, `steps`, the
stored work statuses and the head's completion-condition section. Today's
hierarchy is not a plan: the owner rates it at most 50 out of 100, with topic
groups, own-work sub-items, children kept under an item only to be archived,
and dependencies that were never parts. Turning it mechanically into plans
would freeze that structure under a new name. Conversion therefore has two
phases:

1. **Data conversion**, mechanical and lossless, in one data commit. Its only
   job is to keep every item, log, card, note, target and ordinary step,
   make the new shape valid, and report every status and priority difference
   caused by the approved new derivation rules. Every plan it produces is provisional
   (section 5, Writing plans), and the board flags it 计划待重写.
2. **Plan rewrite**, per project, by the project's session: each plan is
   written again from what the work actually needs, root first, and existing
   items are attached to it, created or cancelled. A plan stops being
   provisional only when a session rewrites it.

**What phase 1 converts.** Counts from a read-only survey of `wf-board-data`
on 2026-10-13; the converter recomputes every number and its report is the
record: 1336 items, of which 186 have children and 91 have no parent; 650 are
done or cancelled (derived status), 55 of them with no parent (34 of those
archived); the owner has archived 356 items; 3 records; 93 items with steps;
281 item dependencies that are not parent links (115 across projects, 166
within a project) and 58 card dependencies; 174 children their parent does not
list in its dependencies (all closed); 58 own-work sub-items (their log says
接过「…」自己的工作); 7 open items whose head has no completion-condition
section (5 of them parents) and 466 closed ones; 10 in-progress leaves with
no doing step; 9 parents whose derived status changes under the new blocked
rule; and one root item of 总管, with 119 closed
children.

**How phase 1 runs.** The converter is a pure function from the old snapshot
to the new snapshot plus a report, in `src/convert-plans.ts`. A dry run on a
copy of the data (a few seconds of Node, no build) prints the report without
writing; after the owner approves the report, the daemon applies the same
function at startup as a store migration in one commit authored by `总管`,
and refuses to start if the data has changed since the approved dry run (the
dry run records the data commit it read). Unread history compares legacy
commits directly and converts only
endpoints spanning the schema change, caching historical documents and
yielding between commits. A legacy status, parent or dependency edit counts
as an `other` change on the edited item, rather than normalized plan progress
on its owner, preserving what the owner saw before plans.
Parsed historical documents are cached up to 4096 entries and normalized
whole-board snapshots up to 4 entries, evicting the oldest insertions so
walking old history does not retain every parsed version indefinitely;
whole-board snapshots have a smaller bound because each holds the full board.
Normalized page baselines use the same converter;
the conversion itself marks nothing new and is not a history step.
`npm run convert:plans -- --data <copy> --dry-run --report <file>` writes the
report outside the data directory and leaves the copy untouched. The report
records `sourceHead`, the exact data commit. After the owner approves it,
`WF_BOARD_PLAN_CONVERSION_HEAD=<sourceHead>` enables the daemon's startup
migration; the offline CLI accepts `--approved-head <sourceHead>` and the
approved `--report <file>` only with the daemon stopped. Both refuse a changed
data head or unresolved verification failures. Conversion log entries use
the executing caller's real timestamp. The conversion deletes the retired
owner archive field and reports the total number of entries removed, including
ineffective and orphan entries; all other owner state is unchanged. The temporary migration and old-shape
reader stay until conversion and the historical comparison baselines that
need them have finished; raw audit `show` and `diff` remain unchanged.

**Phase 1 mapping, item by item.**

1. `group` is set on every item to its line's project.
2. The plan is built in this order, and the item is marked
   `provisional: true` (a record too, when it gets any row):
   1. One row per entry of `deps`, in that order, each with `after: []`
      because the old data never recorded order: an item dependency whose
      target's `parent` is this item becomes an owned row, any other item
      dependency a shared row, a card dependency a card row. A target named
      twice gets one row.
   2. One owned row for each child the item does not list in `deps`, with
      `after: []` (report: child not listed).
   3. Existing steps, with their ids, text, states and dates unchanged, in
      their order: the first has `after: []`, preserving its former lack of
      a preceding step; later steps follow the previous step by default.
   4. The acceptance step (below), except on a record.
   Dependency rows precede old steps so a later plan rewrite can make a blocked
   item's first open step wait for them while `after` names only earlier rows.
3. **Whys go to the log.** Rows carry no why (section 5). When an item had
   any dependency whys, the converter appends one log entry listing them, one
   line per dependency in the old order: `转换前的依赖说明：` followed by
   `- 「<target title>」（<key>）：<why>` lines, a card shown by its question.
   Nothing else is written to logs except the stored-priority retirement in
   step 7; status labels never cause fabricated steps or edits to old steps.
4. **Acceptance text.** The head section that the old check recognized (a
   heading, or a bold label at the start of a paragraph, naming 完成条件 or
   怎样算完成) is cut from the head, through the line before the next heading
   or bold-label paragraph, and its body becomes the acceptance text. When
   the head has no such section, the text is the placeholder
   `（转换时没找到完成条件，待补）` on an open item, which raises the check
   验收步骤待补, and `（转换前已结束，当时没写完成条件）` on a closed one,
   which raises nothing. When the recognizer matches more than once, or
   inside a paragraph, the converter leaves the head unchanged, uses the
   placeholder and reports it (report: ambiguous condition); it never picks
   one. Its state is done (dated at the item's last update) when the old
   derived status was done, todo otherwise, including cancelled items so
   reopening still requires acceptance.
5. **Deriving each status.** The new plan determines the status under the
   approved rules. Old ordinary steps keep their states, text, dates and
   sequence; no step is added, promoted, dropped or given new waits just to
   preserve an old status label, and no dependency row is removed for that
   purpose. Every old-versus-new status difference is listed with the item
   id, project, title and cause (for example, an open shared row it waits on
   or a doing step). A difference alone is not a conversion error. The
   independent oracle derives the expected status from the converted plan
   and refuses a mismatch with the current rules' result.
6. Stored `status` values other than `cancelled` are removed, as are
   `parent`, `deps` and `steps`.
7. **Priority.** Whitefoot-kit, 总管 and 网站 are migrated in the same commit:
   every non-root loses its stored priority with the log line
   `迁移到依赖结构：优先级改由依赖它的条目决定，原来写的 PX 不再使用`, as
   the former project migration did; the `migrated` field leaves `board.yaml`.
   Roots seed their stored priority from their old displayed value, falling
   back to their stored value when the display was empty; roots never get
   the non-root priority-retirement log. Every
   project's priority now propagates along all item rows under the approved
   rule, including formerly unmigrated projects and closed children gaining
   an owner. Records pass none; their owned work still receives priority
   from open shared dependents. Every old-versus-new
   displayed-priority difference is listed with id, project, title and cause
   (for example, propagation from an owner, moving into backlog or losing
   rootness); the difference alone is not an error. The independent oracle
   computes expected priority from the converted plans independently of the
   converter and compares it with the current rules' output.
8. **Removing archives.** The conversion drops the owner's entire retired
   `archived` field and reports `counts.droppedArchives`, the count of all its
   entries, not just effective archives. Read cursors and read-ahead marks
   survive unchanged. No archive timestamp is advanced and there is no
   before/after archive visibility rule. Already planned data that still has
   the old owner field uses an archive-only conversion: its plans, content,
   item revisions and provisional flags remain unchanged. The owner field
   removal and report enter the same approved commit; a failed commit restores
   the exact original owner sidefile.

**Phase 1 report.** A short Chinese summary comes first: how many items were
converted, how many status and priority differences there are, their causes,
the number of retired archive records dropped and whether all content
survived verification. A separate line flags old wip items with no progress
row for phase-two plan writing, giving the actual counts becoming todo and
blocked instead of treating the whole cause group as todo.
The detailed tables give every status/priority difference, including item
id, project and title; cause groups include
examples. Findings also identify ambiguous completion sections, duplicate
or dangling targets and children not listed by their old parents. The
report is `import/plan-conversion.yaml` in the data repository. Structural
rewrite pointers are left to phase 2, where each project's session judges
what its plan should contain.

**Phase 1 verification.** An oracle independent of the converter checks:
every old parent link is exactly one owned row and every owned row was a
parent link; every old dependency is exactly one row of the same target or a
reported duplicate, with all whys in the one log entry; ordinary steps keep
exact ids, text, states, dates and sequence; heads lose only the acceptance
section; every converted work plan has its one generated acceptance row last, and
all nonempty converted
plan is provisional. It independently derives status and priority from the
converted plans and compares them with the current rules' output, checks
that every difference appears in the report, and verifies every item, card,
note, target and original log by id. Added logs have an exact whitelist;
the retired archive field is absent, its removal count is exact, and all
other owner state is unchanged. Archive-only upgrades preserve the original
`planConversionAt` provenance used to normalize old comparison baselines;
the new report's `at` still records this upgrade's real time. Raw historical
evidence is never rewritten.

**Phase 2: rewriting plans, per project.** The coordinator files one item into
each project, "Every plan of <project> is rewritten from the work it needs".
Its acceptance step: the project has no provisional plan left, and every open
item of the project is either a root, another project's collecting item, an
inbox request or owned by exactly one row, and has an acceptance step that is
not the placeholder. The board shows progress as the number of 待重写 flags
left. The project's session follows this procedure:

1. **Order.** Roots first; then each goal the root's new plan names (the
   items the root owns, such as a release's goals); then each work item those
   plans own, down to items with only steps. A plan is rewritten only after
   its owner's, so ownership is decided from the top. Items not reached from
   any root (stray open top items, the backlog) come last.
2. **Write the plan from the work, not from the old tree.** For the item at
   hand, decide how it will actually be pushed to completion: its acceptance
   step (the number or check that decides it, agreeing with its target
   numbers), then the rows needed to get there, in order, with `after` where
   rows can run in parallel. Apply "When a row becomes its own item" (section
   5) to each row: most become steps; a row that meets the rule becomes an
   item.
3. **Attach existing items.** For each row that is an item, look for an
   existing item that already covers it, wherever it sits in the old tree (in
   this plan's provisional rows, elsewhere in the project, in the backlog).
   Attach it: if it is a provisional owned row of this plan, keep it; if
   another item owns it, take it with `move_item`; if it is a top item, own it
   with the new plan. Create the items no existing item covers with
   `create_item`. Rows that point at another project are shared rows to that
   project's collecting item, filed with `create_request` when none exists.
4. **Dispose of what the new plan does not use.** Every open item that was a
   provisional owned row of this plan and is not in the new plan is either
   moved under the item that needs it (`move_item`), moved into the backlog
   record, or cancelled with the reason naming what replaces it, such as
   被「<item>」的计划取代 or 并入「<owner>」的计划 (for an item folded into a
   step by the rule). The server refuses to drop an open owned row, so none is
   lost silently. Closed items the new plan does not attach become closed top
   items when their row is removed; they raise nothing and remain hidden from
   the default tree until the completed/cancelled filter shows them.
5. **Write the plan in one call.** `set_plan` with `rows` writes the whole new
   plan, which clears the provisional mark and logs 重写了计划. The session
   appends a log entry saying in a few lines how the new plan differs from
   the old structure (items attached, created, moved, cancelled).

The old whys in each item's log are material for steps 2 and 3, not rows to
restore. A provisional plan keeps working in the meantime: sessions record
progress on it with single-row upserts, and its status and priority stay
derived from it, so the board stays correct while phase 2 runs.

**Closed items.** Phase 1 converts done and cancelled items like any other:
an existing child remains a provisional owned row in its parent's plan.
Its row state follows the converted child's new derived status; the page
shows every row, including completed and dropped rows. An item without a
parent stays top-level; a closed top item needs no owner and raises no check.
Phase 2 keeps a closed item in a plan only when the new plan attaches it, for
example a finished goal of an open release; every other closed item becomes,
or stays, a closed top item. No history-only owner is created (section
5, open question 5). Closed items stay reachable from plan rows, explicit
filters and unread navigation.

**Report on structure for phase 2.** Alongside the phase 1 report, the dry
run lists, per project, what the rewrite should look at first; these are
pointers, not findings, and phase 2 settles each in passing:

| Kind | What it points at |
|---|---|
| missing condition | open item whose acceptance is the placeholder (7) |
| own-work sub-item | 58 items created only to hold a parent's own work; the rule normally folds them into steps |
| possible topic group | open parent without a completion condition (5) |
| unowned shared | open top item a same-project item waits on through a shared row (2); flagged 同项目有条目在等它，却没有条目拥有它 |
| same-project shared | every shared row within one project (166); the rewrite decides whether each target is a part of the plan, and then owns it, or a shared need |
| record | the 3 records, which keep plans without acceptance steps |

Every work item has an acceptance step from phase 1 on, so 没有计划：至少要有一个
验收步骤 is empty from the first day and stays a refused write.

### Owner-wide rules to change

Changes to the owner-wide rules that follow from this design are tracked on
the board.

### Open questions on the conversion

8. **Order of converted dependency rows.** Proceeding on: every converted
   item or card row is `after: []` (all parallel), because the old data never
   said otherwise, while converted steps keep their sequence; phase 2 sets the
   real order. Alternative: convert everything sequentially, which would
   invent an order.
9. **Owner approval of the dry-run report** before the live conversion.
   Proceeding on: yes, as a decision card with the report's counts.
10. **Records and the "every item has a plan" rule.** Proceeding on: records
    are exempt from the acceptance step, since nothing completes them; a
    record without rows raises nothing.
11. **What dropping the why loses.** A shared row into another project no
    longer says, on the row, why the other project needs the item; the
    receiving session reads it from the request's head and acceptance step
    and from the filing reason in its first log line. `context` and `graph`
    show titles only, and the old whys live only in logs, which `search`
    still covers. The rule "every dependency carries a why" disappears from
    the server instructions, the operations' checks and CLAUDE.md. Proceeding
    on: accept this, as the owner decided; if a receiving session finds a
    request unclear, it asks with a note or comment, not a row field.
12. **What clears the provisional mark.** Proceeding on: any whole-plan write
    by the session clears it, so a session could clear it by rewriting the
    rows unchanged. The coordinator checks each project's phase 2 item log,
    which must say how each plan changed. Alternative: also require a
    `rewrite` reason argument, stored in the log, on the clearing call.
13. **Cancelling a redundant item another project waits on.** Phase 2 may
    find an item redundant while another project's shared row points at it;
    cancelling it raises 依赖的条目已取消 there. Proceeding on: the procedure
    moves such an item, or keeps it and points the redundant work at it,
    rather than cancelling it; when it must be cancelled, the session tells
    the waiting project's session first.
14. **Unread volume during phase 2.** Each rewrite changes the item, the
    items it moves or cancels and their owners, so the owner's 新 counts
    grow while a project rewrites. Proceeding on: accept it; the owner can
    read a project at a time with the 进展 filter. Alternative: author phase
    2 moves as not unread, which would hide real structural changes.

### Difficulty migration

`npm run migrate:difficulty -- --data DIR [--apply]` moves the temporary
difficulties that plan rows carried in their text into the field. It runs
offline, with the daemon stopped or on a copy, and without `--apply` only
prints the report. For each open work item it reads the rows still to do (todo
or doing): when they all name one level, as 「（难度 N）」 with N in 1–5 or
「（架构师做）」, it sets the field, removes the marker from every row of the
item, and logs the rating and the removed markers, all items in one commit.
Items it will not guess about are listed for a person: unfinished rows naming
different levels, a wording other than those two (「（难度按设计再评）」, or a noted
「（架构师做，含走查）」), only finished rows naming a level, a field that
disagrees with the rows. Closed items keep their row texts. The report also
lists every row of open work that mentions 难度 or 架构师做 yet matches no rule,
so a miss shows before `--apply`, and counts the open work that stays unrated
and will raise 缺难度. A second run migrates nothing. The CLI, its
module and its tests are deleted after the run on the live board.

## 11. Testing

- Unit tests for the rules module, the file format round trip, `rev`
  conflicts, append ordering and every write check, each shown to fail on the
  wrong input it guards against.
- An MCP integration test with the SDK client against a server on a temporary
  data directory.
- The conversion checks of section 10, including the plan conversion's
  oracle, and for the plan rules a case per derived status, per refused
  ownership or cycle write and per check, each failing on the wrong input.
- A derivation equivalence test: after every write of a seeded random
  sequence, the shared and incremental derivations (shared Rules objects, the
  activity index, a write's prospective rules, the page's activity deltas)
  equal a from-scratch `rules` scan, and every item whose painted
  presentation changed is among the affected items.
- CI on GitHub-hosted runners for each pull request push and each main-line
  merge; the write-path benchmark runs by hand, as a workflow that reports and
  never fails the run.

### Three test layers

The page is tested in three layers. Each catches a class of fault the layer
below cannot see, and a page bug gets its test in the lowest layer that can.

1. **Rules, store and server** (`test/*.test.ts` other than the page test):
   the board rules, the file format, writes and their checks, the HTTP and
   MCP surfaces, each against synthetic fixtures.
2. **The page in a fake DOM** (`test/web.test.ts`): the bundled page runs
   against a hand-written DOM with modeled geometry and a small synthetic
   board. It is fast and checks controls, render scopes and scrolling, but it
   computes no CSS and no real layout, and its fixtures hold few of the real
   board's shapes.
3. **The page in a real browser** (`test/e2e`, `npm run test:e2e`, CI job
   `e2e`): headless Chromium (Playwright) loads the real page from the real
   server (the wiring of `src/main.ts`, in process) on a temporary data
   repository, so the page talks to the real API and event stream.

The third layer exists because five page bugs in one day passed every test of
the first two: saving a comment folded the card's comment list and hid its
send button; the purple and red numbers jumped to another project's card
after unrelated re-renders; a card row in a plan jumped to another item
instead of unfolding in place; a global `code` rule kept code blocks out of
Monaco; an empty pause row sat under every title. None of them shows in a
fake DOM over a small board.

**The board.** `test/e2e/board-gen.ts` generates a board from a seed; no real
text is copied. `test/e2e/shapes.ts` names the structural shape categories,
and `test/board-gen.test.ts` (layer 1) requires every one of them in the
generated board. The categories come from a survey of the real board on
2026-10-13: 1522 items in six projects (574 done, 481 todo, 203 cancelled,
107 blocked, 94 paused of which 87 by inheritance, 56 wip, 7 records);
ownership up to six levels deep, 27 items owning more than ten; 119 items
owned under a record; 272 items named by shared rows, 151 of them across
projects; 707 plans with parallel rows; 596 cards (83 open, 24 open and
blocking), 6 named by two plans and 8 by three, 66 named by a done item's
plan, 19 named only by other items' plans, 8 open cards no plan names (one on
a record), 2 open cards on done items; 754 notes (603 on cards, 201 with
replies, 23 anchored); 257 heads with code blocks; 28 tags, every item
tagged. Shapes the real board lacks today but the schema allows and the page
handles (pending asks, inbox requests) are generated too.
Viewer state is part of the shape: the tests fold comment lists in
localStorage and unfold every tree row.

**The invariants.** `test/e2e/invariants.ts` clicks every kind of clickable
thing and compares where the page landed with what the element claims,
computed independently from the stored board with `src/rules.ts` and the
server's unread history:

- a tree row's title selects that item and shows its detail;
- in a plan, an item row goes to its item and 返回 comes back; a card row
  unfolds that card right under the row and keeps the selected item; a step
  row selects the step and keeps the item;
- each 被依赖 row goes to its dependent and 返回 comes back;
- the purple and red numbers after a title equal the blocking and other waits
  in the item's owned subtree, and clicking a number as often as it says
  visits each of those waits once, in its own item;
- the header's 阻塞 and 决策卡 numbers and the wait panel cover exactly the
  board's waits;
- each blue number counts the items under it holding unread content and
  leads to one of them; 新 counts the unread units; n reaches every item
  holding unread content and nothing else;
- each project filter's number counts its matches; pressed, the tree shows
  every match undimmed and nothing else of the project undimmed;
- the "/" search lists an item or card first by its short number, and
  choosing it shows it;
- a comment saved on a folded list stays in view with its 发送 button, which
  sends it;
- code blocks are set in Monaco at 13.5px, inner code included; no empty row
  sits under an item's title; tag chips name the item's tags and contrast
  with their background at 4.5:1 or more in both themes (chips in rows the
  page dims on purpose are left out).

Each family runs on a freshly loaded page, then again on one page kept open
while a burst of writes lands on other items before each family (new waits
on the first item in board order, progress, log lines, a ruling, replies, a
new item), so incremental re-renders happen in between.

**Evidence.** `test/e2e/regressions.e2e.ts` runs the relevant check on the
current page, where it must find nothing, and on the page with a past fix
reversed in a copy served from a temporary directory, where it must report
the bug. A fix is reversed by undoing its commit's hunks, or, where later
work rewrote the lines around it, by a targeted edit that removes just the
fix. A witness whose edits no longer match the current file fails and is
updated or retired on purpose.
