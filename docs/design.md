# wf-board design

The local server implements this model. Project responsibility in sections 8–9
records the owner’s settled decisions and supersedes per-item `agent` ownership
and per-project lists of agent session names.

## 1. Problem

The status board that the owner and every agent session share was a claude.ai
artifact, https://claude.ai/artifact/7tocXS3iUdthCLCQCMd3ip. Its data lived in
the artifact's database, read and written with the ArtifactData tool, and its
"发给 Claude" button woke the watching session through the artifact runtime's
comment API (`comments.sendToClaude`).

On 2026-10-11 the account that published it reached its spending limit. The
owner moved to another account, and from that account Claude Code can read
the page but not its data: "that organization doesn't let invited editors use
artifact data from Claude Code". The help center documents no setting that
lifts this for outside invitees. The board is therefore tied to whichever
account published it, and an account switch cuts every session off from it.

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
   rules (deps carry a why, a parent lists its open sub-items, a blocked item
   names its blocker, a cancelled item says why), and refuses a stale
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
| 649 deps, 631 with a why; 61 cross areas and 48 cross projects | The dependency graph must span projects and always carry the why; that is where context crosses sessions |
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
3. **The wake stream** at `/wake` (WebSocket), which turns "发给 Claude" into
   a notification in the waiting session.

**Why one daemon rather than an MCP subprocess per session.** The usual MCP
setup starts one server process per session (stdio). Several processes
writing the same files would need cross-process locking and could not push
changes to the page. A single process is the only writer, serializes all
writes, and pushes every change to the page and to waiting sessions.

**Why TypeScript.** The page's derived rules (a parent's status from its
sub-items, priority, the 需核对 flags, freshness) are JavaScript
today. One module, `src/rules.ts`, serves both the page and the server, so an
agent sees exactly the flags the owner sees. MCP has an official TypeScript
SDK.

**Storage.** The data is a git working tree, `~/dev/wf-board-data`, with the
private remote `Ming-Research/wf-board-data`. The server is the only writer:
each logical operation is one commit whose author is the writing project (or
`owner` for an owner operation) and whose message summarizes the operation. The server pushes to the remote when
it has new commits, at most every ten minutes, and on shutdown. If the server
is down, agents can still read the files with Grep and Read; nothing is
hidden in a database.

**Running.** A launchd agent starts the daemon at login and restarts it on
exit. `GET /health` reports its state; the page shows a banner when the server
does not answer, and every MCP tool error names the cause.

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
  board.yaml              title, eyebrow, goal, projects
  items/<id>.yaml         one file per item
  decisions/<key>.yaml    one file per decision card
  notes/<id>.yaml         one file per owner note with its reply
  state/owner.yaml        the owner's read cursor and archived items
  import/                 the original artifact export, kept as provenance
```

Each file is one YAML document; prose fields are literal blocks (`|`), which
keep their lines exactly as written. An item file:

```yaml
title: 总管交接：换账号时的当前状态
parent: coord-sync
status: wip
deps:
  - id: coord-mergetrain
    why: 交接时的合并队列状态取自这里。
links:
  - label: Whitefoot#341
    url: https://github.com/Ming-Research/Whitefoot/pull/341
created: 2026-10-11T06:15:40Z
updated: 2026-10-11T06:15:40Z
rev: 3
head: |
  **是什么**：总管（协调会话）换账号时的交接快照。……

  **看板访问**：……
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
  error. Only log entries are conflict-free appends and carry no `rev`.
  Replying to an answered note is refused with the previous author and time;
  deliberate replacement requires `replace: true`.
- Areas are items without a parent, as today. The fields keep their current
  meanings; `area` is folded into `parent`, `text` into `head`, bare-string
  deps into `{id, why}` entries flagged for a why.
- **Migration switch.** A project's entry in `board.yaml` may carry
  `migrated: true`, set only by `update_project` from the coordinator project
  `跨项目` and never undone; that commit also drops the stored priority of
  every item of the project that is not a root, logging
  `迁移到依赖结构：优先级改由依赖它的条目决定，删除了存的 PX` on each. An item
  belongs to the project of its area's group. A migrated project follows the
  next bullet. An unmigrated one, the default, keeps the legacy priority (`src/legacy-priority.ts`): a leaf stores
  its priority, a parent shows its highest open leaf's, an open waiter raises
  what it waits on and the page strikes the written priority beside the
  raised one; its writes need a leaf priority and refuse none, it gets neither
  new flag and no stored priority is dropped. Across projects a migrated item
  counts an unmigrated dependent at its shown priority, and an open migrated
  dependent raises an unmigrated item, never lowers it, without the strike;
  rootness counts open dependents from both. Write operations follow the
  project of the item written, `create_request` the receiving project, and
  dropping a stored priority follows the project of the item that loses it.
  The legacy path and the switch are removed once every project is migrated.
- **Dependencies and priority** (migrated projects). The hierarchy means
  dependency only, never topic grouping: a parent lists each sub-item among
  its deps. Every item's head states what it delivers and its completion
  condition, under a heading or bold label naming 完成条件 or 怎样算完成, and
  each dependency's why names the part of that condition it is needed for. An
  item that no open item
  depends on (open: status neither done nor cancelled, a parent's derived) is
  a root (a project goal, a downstream project's need or a stand-alone piece
  of work), so an item whose dependents have all closed becomes a root to
  prioritize or cancel. Only a root stores `priority`. Migration leaves no
  stored priority on a non-root, and afterwards every write that makes a
  migrated item a non-root, or writes a migrated non-root, drops its stored
  priority in the same commit and logs `<writer> 让它不再是根：优先级改由依赖它的条目决定，删除了存的 PX`
  on it; the write's result lists the items. So no non-root holds a stored
  priority, and none returns when an item becomes a root again.
  Every other item's priority is the highest among the open items that depend
  on it, across projects and transitively, so a P0 root raises everything it
  depends on to P0 and a child may rank above its parent, never below it. A
  closed item keeps the priority that reached it and passes none on;
  dependencies on decision cards carry none; a cycle that no open outside
  dependent reaches has none. A closed root shows its own stored priority.
  Among the 需核对 flags, an open item whose head lacks the
  completion-condition section shows 正文没写完成条件, and an open root without
  a stored priority shows 没有未完成的条目依赖它，却没写优先级.
- A decision file holds its status, item, confidence, time and options in the
  front matter, and background and ruling as body sections. `confidence`
  becomes `{score?: 1-5, reason}`, and a ruled card records `ruledAt`.
- Each fact is stored once. The export shows what duplication costs: 27 cards
  whose `item` names an item whose `qs` omits them, 572 items carrying both
  `parent` and `area`, 13 notes whose stored title went stale. So a card's
  place is its `item` alone (an item's cards are derived), an item's place is
  `parent` alone, and a note's title is derived from its target.
- A dep may name a decision card as well as an item. Four blocked items in
  the export wait on an open card, which the current model cannot express,
  so the page flags them as blocked without a blocker; with card deps the
  check "a blocked leaf has an open dep or an ask" holds for them.
- Empty strings are absent fields (`ask: ""` on 117 items, `parent: ""` on
  161).
- A note keeps its original id, so ids that sessions recorded and anchors
  that point at notes stay valid.
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
  `n` walks page order, top to bottom: an item, its comments, then each of its
  cards and that card's comments, with documents the page does not place last,
  oldest first. Inside a changed item it visits each new place in turn (a
  changed status, title or body block, a new log entry, an added dependency or
  link); a new item is one stop at its start. After `r`, `n` goes on below
  where it was. A 新 chip jumps to the first new place in its subtree.
  `r` reads the whole item holding the selection, however selected: its own
  changes, its cards and the comments on both, but not its sub-items; a card
  no item holds is read with its comments. 全部已阅 moves the cursor to the
  head after confirmation. Expanded items and cards mark changes in their own
  content, comparing the document before its first unread step with its current
  state. Blocks are separated by blank lines, except inside fenced code;
  contiguous lists and tables remain whole blocks so rich rendering stays
  intact. Added or changed blocks carry no colour of their own (the item's blue
  line says it holds something new, and `n` lands on the first of them);
  removed blocks stay in place, struck through in red. A changed title shows its former title immediately
  after it in small struck text. Multi-paragraph card questions use the same
  block comparison as heads, keeping unchanged paragraphs once. Changed
  status, priority and request rows, and added or changed dependency and link
  rows, are not coloured either; removed dependencies and links remain struck.
  New items and cards carry no per-block marks. No green background is used
  anywhere: the owner never asked for one. In single-column mode an item, and in
  either layout a card, with unread changes of its own carries a blue line beside its whole body, marking exactly what `r` on it
  reads; a parent whose only new content is below it shows that in its 新 chip
  and carries no line, since `r` leaves sub-items alone. In single-column mode a
  folded item shows its head row alone: its body, cards and comment list fold
  together. In split mode the tree always shows only head rows, with a short
  blue line for an item's own unread content; the selected item's body and
  comments appear in the detail column, with a short blue line beside its headline. In both
  layouts the 新 chip still counts what is new inside. New log entries, new notes and replies, and added dependency and link
  rows use the same blue bar. A new reply marks the reply alone, never the
  owner's comment above it, since the owner wrote that. Note
  changes appear only in the comment-list row, never as bookkeeping-field
  diffs. Every document jump, including card references, waiting-stop arrows,
  unread chips, reveals the target and its comment list
  (in the selected item's detail column in split mode),
  waits for the baselines affecting that target and its expanded containers,
  then scrolls after rendering. Baselines for unrelated collapsed items or
  explicitly collapsed ancestor comment lists neither delay nor cancel the jump.
  Deleted documents have no body to render but remain countable stops that
  `n` can visit and `r` can read.
  This replaces the 478 per-item read
  records and their snapshots. A step groups consecutive commits by the same
  author on the same item, so five quick log appends read as one change, and
  the owner's own actions (notes, archiving) never count as unread. Scrubbing
  back through earlier changes with a slider uses the same history and is
  deferred until needed. Reads and archives update owner state immediately
  and save it locally without a commit. A local save arriving during a data
  commit waits for that commit to finish. Pending owner state normally joins
  the next data commit, so ordinary reads make no commit noise. On orderly
  shutdown, the daemon commits any remaining owner state on its own before
  pushing.

## 6. MCP tools

Every tool returns compact text built for an agent's context: ids, titles,
status and the relevant lines, never whole files unless asked. Writes take
`author`, the name of the project the session works for, selected from
`projects` by matching `repo` to its repository's GitHub remote. The
coordinator writes as `跨项目`. Several sessions may share a project and
coordinate among themselves; sessions may be renamed freely.

### Finding things

| Tool | Answers | Returns |
|---|---|---|
| `search(query, filters)` | Where is X mentioned? | Hits across item heads and logs, cards and notes: id, kind, title, status, area, the matching line with its time. Filters: group, area subtree, status, kind, since. Substring matching, which handles Chinese without a tokenizer |
| `context(id, log?)` | What is this and how did it get here? | The item; its ancestors with status; its sub-items summarized; its deps and its dependents, each with the why and status; its cards (open in full, ruled as question and ruling); its recent notes; flags; links and PR references; the last five log entries unless `log` asks for more |
| `graph(id, direction, depth)` | What does this wait on, what waits on it? | The dependency and parent tree around the item as an indented list with whys, marking blocked chains and cycles |
| `history(id, limit?)` | How did this change? | Commits touching the item or card: time, author, summary |
| `diff(id, from, to?)` | What exactly changed? | The textual diff of the file between two commits or times |
| `changes(since, filters)` | What happened while I was away? | Items, cards and notes changed since a time or commit, grouped by area, each with one line on what changed |
| `prs(repo, number)` | Which items concern this PR? | Items whose text or links reference it |
| `list(filters)` | Structured browsing | Compact rows for items matching status, priority, area subtree, open ask, flags, updated-since |
| `overview(group?)` | The board at a glance | Project name and inbox count once per heading; per area: counts by status, owner actions waiting, blocked items, flags |
| `notes(filters)` | What did the owner say? | Notes by state, target subtree, kind, since |
| `projects()` | Which project matches this repository? | Project configuration, areas, open leaves and inbox counts |
| `brief(project)` | What does this project need now? | Inbox, sent notes, checks, owner cards, WIP, next TODOs and outgoing work |
| `followups(minutes)` | What is still unhandled? | Older sent notes and inbox requests with project |

### Changing things

Priority checks below are those of a migrated project; an unmigrated one
requires a leaf priority from `create_item`, `create_request` and `move_item`'s
`source_priority`, as before, refuses none, and has none of the three
restructuring forms below (`create_item` with `children`, `move_item` without
`new_parent`, a leaf destination without `parent_own_work`) (section 5).

| Tool | Does | Checks |
|---|---|---|
| `create_item(parent, key, title, head, priority, deps, parent_why, parent_own_work, links, children?, source_status?, source_priority?)` | Adds an item and lists it in the parent's deps with `parent_why`; when the parent is still a leaf, its own work and status move into the `parent_own_work` sub-item in the same commit, since a parent's status is derived (found in the first CLI trial: a leaf's WIP silently became its new child's TODO); the sub-item takes no priority, and a root parent keeps its own. `children: [{id, why}]` moves those existing items under the new item in the same commit and lists them in its deps with their whys, so it is a parent from birth with no own-work stub; each old parent follows `move_item`'s source rules, with `source_status` and `source_priority` | Key is new and well formed; deps exist and carry a why; an area's priority set; a sub-item's priority refused, since it comes from the items depending on it; children are distinct items of the author's project, not the new item's parent or its ancestors, and come without `status` |
| `append_log(id, text)` | Adds a log entry with the server's time | Text nonempty, no reserved headings |
| `update_item(id, rev, fields, reason?)` | Changes title, head, deps, links, priority | A changed head requires `reason`, which becomes a log entry; deps keep their why; priority only on a root, otherwise refused naming the items it comes from |
| `set_status(id, status, log)` | Changes a leaf's status with a log line | Only on leaves; blocked needs an open dep or an ask; cancelled and done need the log line |
| `move_item(id, new_parent?, parent_why?, parent_own_work?, source_status?, source_priority?, priority?)` | Reparents, preserving a destination leaf's own work in a new child; a destination leaf with no work of its own (todo, no log entry beyond its creation entry) needs no `parent_own_work` and becomes a parent, keeping its stored priority as a root. Without `new_parent` the item leaves its parent and becomes a root area of its own project, keeping its dependents | No cycle; updates both parents' deps; the source's last child requires its new leaf status; `source_priority` only on a root source; without `new_parent`, `priority` is required and no other open item may depend on the item, else the refusal names them; `priority` is refused with `new_parent` |
| `clear_ask(id, log)` | Removes a legacy ask after the project has replaced it with a decision card or settled it | Every owner wait is a decision card with options; a yes or no uses option A (do it) and option B (don't). Agents cannot create new asks |
| `write_card(key, item, question, background, options, confidence)` | Adds or revises an open decision card | One recommended option at most; item exists |
| `rule_card(key, choice, ruling)` | Records the owner's ruling | Choice is an option key |
| `reply_note(id, reply, replace?)` | Answers a note, stamps `repliedAt`, marks it done | An existing reply requires explicit replacement |
| `create_project(name, repo?)` | Configures a project; accepts any author string | Unique project name |
| `update_project(name, repo?, migrated?)` | Sets or changes a project’s repository, or migrates it (section 5): `migrated: true` and, in the same commit, the drop of every non-root's stored priority with its log entry | Repository: author is that project or the coordinator project `跨项目`. Migration: author is `跨项目`, only `true`, and only once |
| `create_request(project, key, title, head, priority?, why, from?)` | Files into any project's inbox; optionally links the filing item, which then gives the request its priority | Author is a configured project; receiving project exists; `from` belongs to author’s project; atomic dependency; priority required without `from` and refused with it |
| `triage_request(id, parent?, parent_why?, parent_own_work?, priority?, log)` | Accepts a request into the work hierarchy or as an area | Author is the request’s project; same-project parent; preserves leaf parent work; priority only when the request stays a root |
| `close_note(id, log)` | Closes a note and records handling in its item's log | Author is the note target’s project; not draft |

## 7. The page

The current template is kept. Its data layer, `window.claude.use("db")` and
`window.claude.use("comments")`, is replaced by a small client that loads a
snapshot from `/api/snapshot`, applies changes from `/api/events`, and posts
the owner's notes, reads and archive actions to `/api/...`. The rules module
moves out of the page into `src/rules.ts` and is loaded by both.

The header’s 视图 row has a 分屏 / 单栏 toggle that switches layouts immediately.
Split mode is on by default; the owner’s choice is saved per viewer in
browser localStorage, and unavailable storage does not prevent use. Viewport
width never changes the choice. Split mode has two columns and uses the full
window with compact tree margins and equal, smaller detail side padding.
The left column contains the header, summary and
navigation, project groups and filters, and the nested item tree.
Each item shows only its head row: fold toggle, status, priority, title, tags,
new-content count, descendant owner-action count and leaf counts. Clicking the row selects the item and
highlights it without changing its sub-item fold; the ▸/▾ toggle folds only
sub-items. Split tree titles, badges and counts use one smaller text size.
Each split tree row stays on one line: caret, status, priority, title, chips
and counts. Parent leaf counts show numbers in their status color in both
layouts, with status names in accessibility labels. In split mode they shrink and clip away
completely before the title truncates with an ellipsis, retaining a minimum width of 6ch and
a full-title tooltip. New-content and owner-action chips remain visible.
The separate decisions section
and send box remain available.

In tree rows in both layouts, the blue new-content chip and the red descendant
owner-action chip show only their numbers. Their tooltips and accessibility
labels retain their full meaning; the item’s own 等你处理 tag retains its words.
Every 新 chip shows only its number, including detail headlines and cards.
The existing ☰ menu help keeps its shortcut sentence and explains only the
blue new-content number, red descendant owner-action number and right-side
status-colored leaf counts alongside its keyboard actions.

There is no sticky path bar. Navigation and visibility checks use the viewport
top, and jumps leave only the ordinary 8-pixel edge gap without reserving space
or scroll margins for a bar. The existing send-box top button remains.

A vertical divider resizes the left column with pointer dragging. Its width is saved per viewer in browser
localStorage. Both columns retain useful minimum widths: 300 CSS pixels for
the tree and 380 for detail. Split mode may overflow narrower viewports;
the owner can turn it off for the phone’s single-column layout.

The right column is sticky, fills the viewport height and scrolls independently.
It shows the selected item's head row with the same marks and chip, followed
by 被依赖, head text, data, 依赖, log, ask, open cards, shown ruled cards,
checks and refs, then the item's comment list. The same detail builder renders
this content inline in single-column mode. With no selection the column says
“点左边的条目标题，在这里看正文”. All change marks, fresh lines, notes and
replies retain their meanings. Selection inside the detail column retains
the existing item, log, dependency, card and note selection keys and actions.
The selected item is saved per viewer in browser localStorage and restored
when it still exists; unavailable storage does not prevent using the page.

With split mode off, the page keeps inline bodies: a head click opens or
folds both its body and sub-items.
No global keyboard bindings change: Enter on a focused head selects its item in the
split layout, and opens or folds it in the single-column layout; j/k move focus as
before. Actions use the current selection in split mode, falling
back to the selected item or the top visible tree row.

In split mode, `n`, `N` and 新 chips select the stop's item, unfold its
ancestors and bring its tree row into view, then scroll the right column to
the exact fresh mark, card or note. A card held by no item keeps its existing
navigation behavior in the separate decisions section. Dependency links,
Backspace/`[` and the 等你处理 下一条 walk also select their target item and
show its detail. Tree folding and detail selection are independent.

`r` acts on the item holding the current selection: the item for `it:` and
`log:<item>@<time>`, the card's item for `q:`, the target's item for `note:`.
The same selection works after the 等你处理 下一条 walk, a click, `n`, a 新
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

Choice, approve/done and explain controls show their pending state immediately,
before sending the write, and restore the authoritative state with a visible
error if it fails. `POST /api/draft` sets or clears a target's draft of that
kind in one owner operation: replacing a choice makes one commit, preserving
sent and completed notes. Its response carries the affected draft and deleted
ids so the page can settle its pending state without waiting for live updates.
The affected control stays busy until that write settles. Sending waits for
pending draft writes and stops if one fails, so an immediately displayed choice
cannot be omitted from the send by a slower draft request.

Live changes, unread results and loaded baselines schedule a shared render on
the next animation frame. A 100-millisecond timer runs the callback if the
frame has not fired; whichever runs first cancels the other, and the callback
runs once. When animation frames are unavailable, a zero-delay timer is used.
The same scheduler drives jump animation, so a suspended animation-frame
stream cannot leave navigation waiting indefinitely. Changes arriving before
that callback share one render. Note
changes update their item or card, and an item or card change updates its
affected subtree and summaries; unrelated cards keep their DOM elements.
In split mode these same scoped render paths update the selected item's
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

## 8. Waking sessions

"发给 Claude" posts to `/api/send`. Draft notes become `sent`, and each
sent note produces one wake event:
`{event:"note", note, target, kind, title, project}`. Sending does not
mark a note handled. It stays `sent` until a project agent replies with
`reply_note` or closes it with `close_note`. Closing stamps the handler and
time and appends `关闭评论：<log>` to the owning item, atomically; it adds no
reply text and refuses draft notes; an existing reply is preserved.

A newly created request also produces one event:
`{event:"request", item, title, project, by}`. The store's committed
change is the event source, so updates and retries do not announce a request
again. A socket at `/wake?session=*` receives everything; a named socket
at `/wake?session=<project name>` receives events whose `project` matches
that name. The coordinator listens to the wildcard stream, finds a project’s
live session by its working directory, forwards the event to it, and uses
`followups(minutes)` for notes and inbox requests older than that age. Agents
need not listen. With no live responsible session, the coordinator asks the
owner to restart one. The server does not detect session liveness or retry
messages itself.

**Why not MCP push.** Plain MCP lets a server send notifications, but Claude
Code does not start a turn in an idle session for them. Claude Code's
*channels* do exactly that (`notifications/claude/channel` from a server
declaring the `claude/channel` capability), but as of 2026-10-11 they are a
research preview: a channel must be a stdio subprocess of the session, and a
custom channel loads only when the session is started from the command line
with `--dangerously-load-development-channels`, which the desktop app's Code
sessions cannot pass. The wake events are therefore defined independently of
transport, so a thin stdio channel that relays `/wake` can replace the
Monitor once channels allow it, without changing the server.

## 9. Project responsibility

Responsibility belongs to the project, the existing `group` page heading;
there is no extra item layer. `board.projects` contains unique project names
and an optional repository identifier such as `Ming-Research/Halo-wf`:
`{name, repo?}`. Identity is the project itself. Each project has a responsible
agent session started in its repository; several sessions may share that
responsibility and coordinate among themselves. Sessions may be renamed
freely, so no session names are recorded. This model supersedes per-project
agent lists as well as per-item `agent` ownership and child handovers. An
area with an absent or unconfigured group gets a shared rules check; older
boards without `projects` load with an empty list.

At a repository root, a session calls `projects`, picks the project whose
`repo` matches its repository’s GitHub remote (the coordinator uses
`跨项目`), uses that project’s name as `author` in every write, then reads
`brief(project)`. No claim or session registration is needed.
`create_project` configures `{name, repo?}` and accepts any author string.
`update_project(author, name, repo)` sets or changes a repository: a project
may change its own repo, and the coordinator project `跨项目` may change any
project’s repo. Both run in the same operations queue as item writes,
including prospective board checks.

Every agent mutation except `create_project` requires a configured project
as author. An unknown author is refused with the configured projects and an
instruction to call `projects` and use the project whose repo matches the
caller’s repository. Item mutations require `author === projectOf(target)`;
this applies to items, their cards and owner-note replies or closures.
Creating an area requires its group to match author. Moving work requires
the source and destination to belong to author’s project, and revising a
card’s owning item checks both owners. A refusal names the item’s project
and directs the caller to file into it with `create_request`. Cross-project
dependency targets remain allowed on a project’s own items. The page’s
owner-note, send, archive and read operations are separate from agent
operations and remain unrestricted. Project names are supplied by trusted
local callers; identity checks enforce the workflow, rather than
authenticate against a caller impersonating another project.

Any configured project can call `create_request(project, key, title, head,
priority?, why, from?)`; its priority rules are the receiving project's, as
section 5 describes, and those below are a migrated project's. It creates a top-level TODO item in the receiving
project with `request: {by: author, at}` and first log
`${author} 提出：${why}`. With `from`, the filing item must belong to author’s
project; adding its dependency on the new request happens in the same commit,
and the request takes its priority from that item, so `priority` is refused.
Without `from` the request is a root and `priority` is required.
Requests stay in a separate inbox, oldest first, until the receiving project
triages them. `triage_request` removes the marker, sets an optional priority
when the request stays a root (no parent and no open item depending on it), logs
the disposition, and either places the request under a parent in its
project or retains it as an area. Placement also appends
`分拣：放到 <parent>：<why>` before the supplied log. A leaf parent requires
`parent_own_work`, preserving its own work as in `create_item`. Moving a
request under a parent in its project also triages it and logs the placement.
Declining with `set_status cancelled` clears the marker and records the
reason. An open inbox request is not an area in listings; completed or
cancelled items are not open requests.

`projects` reports name, repo, area counts, open leaf status counts
(excluding inbox requests), and inbox counts. `brief` supplies inbox reasons,
sent item/card owner notes, checks including cleared blockers, open cards
still awaiting the owner, WIP leaves, the next ten TODO leaves by priority, and outstanding work requested from other projects. That outgoing
list includes open requests with `request.by === project` and open items
targeted by its items’ cross-project dependencies, so triage does not hide
linked work. Work queues omit archived items. Read rows, project summaries
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
a handover it names the wrong session: the export holds 236 `coord-wfbl-*`
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
     coord-rules and proof-bl-g-lang), with a why taken from the sub-item's
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

   Every agent operation checks the prospective board and refuses newly
   introduced missing blockers, parent dependency omissions, missing dependency
   targets or missing reasons. Existing imported flags can still receive
   progress. This also means splitting a blocked leaf is refused if its new
   own-work child would have no blocker; a split does not silently relocate
   owner actions or their notes.

   Judgment cleanups go to the responsible sessions as items after the
   migration: 3 asks whose cards are all ruled, 3 done items with an open
   dep, 2 archived items still open, 35 heads holding dated progress, the
   coord-queue history (75 done queue entries), the 236 `coord-wfbl-*`
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

## 11. Testing

- Unit tests for the rules module, the file format round trip, `rev`
  conflicts, append ordering and every write check, each shown to fail on the
  wrong input it guards against.
- An MCP integration test with the SDK client against a server on a temporary
  data directory.
- The conversion check of section 10.
- CI on GitHub-hosted runners for every push.
