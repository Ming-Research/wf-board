# wf-board design

The local server implements this model. Project responsibility in sections 8–9
records the owner’s settled decisions and supersedes per-item `agent` ownership.

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
sub-items, effective priority, the 需核对 flags, freshness) are JavaScript
today. One module, `src/rules.ts`, serves both the page and the server, so an
agent sees exactly the flags the owner sees. MCP has an official TypeScript
SDK.

**Storage.** The data is a git working tree, `~/dev/wf-board-data`, with the
private remote `Ming-Research/wf-board-data`. The server is the only writer:
each logical operation is one commit whose author is the writing session and
whose message summarizes the operation. The server pushes to the remote when
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
title: 示例：换账号时交接当前状态
parent: example-parent
status: wip
priority: P1
deps:
  - id: example-merge
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
  changes. The owner's reading state is one cursor into it, a commit id: what
  lies after the cursor is unread. The page walks the unread changes oldest
  first, showing each as its diff; 已阅 moves the cursor past the change shown,
  and 全部已阅 moves it to the head. This replaces the 478 per-item read
  records and their snapshots. A step groups consecutive commits by the same
  author on the same item, so five quick log appends read as one change, and
  the owner's own actions (notes, archiving) never count as unread. Scrubbing
  back through earlier changes with a slider uses the same history and is
  deferred until needed. Owner state is committed with the next data commit,
  never on its own, so moving the cursor makes no commit noise.

## 6. MCP tools

Every tool returns compact text built for an agent's context: ids, titles,
status and the relevant lines, never whole files unless asked. Writes take
`author`, the writing session's name as the session list prints it, because
the server cannot tell sessions apart (several share one repository).

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
| `overview(group?)` | The board at a glance | Project agents and inbox count once per heading; per area: counts by status, owner actions waiting, blocked items, flags |
| `notes(filters)` | What did the owner say? | Notes by state, target subtree, kind, since |
| `projects()` | Which project matches this repository? | Project configuration, areas, open leaves and inbox counts |
| `brief(project)` | What does this project need now? | Inbox, sent notes, checks, owner cards, WIP, next TODOs and outgoing work |
| `followups(minutes)` | What is still unhandled? | Older sent notes and inbox requests with project and agents |

### Changing things

| Tool | Does | Checks |
|---|---|---|
| `create_item(parent, key, title, head, priority, deps, parent_why, parent_own_work, links)` | Adds an item and lists it in the parent's deps with `parent_why`; when the parent is still a leaf, its own work, status and priority move into the `parent_own_work` sub-item in the same commit, since a parent's status is derived (found in the first CLI trial: a leaf's WIP P1 silently became its new child's TODO P2) | Key is new and well formed; deps exist and carry a why; leaf priority set |
| `append_log(id, text)` | Adds a log entry with the server's time | Text nonempty, no reserved headings |
| `update_item(id, rev, fields, reason?)` | Changes title, head, deps, links, priority | A changed head requires `reason`, which becomes a log entry; deps keep their why |
| `set_status(id, status, log)` | Changes a leaf's status with a log line | Only on leaves; blocked needs an open dep or an ask; cancelled and done need the log line |
| `move_item(id, new_parent, parent_why, parent_own_work?, source_status?, source_priority?)` | Reparents, preserving a destination leaf's own work in a new child | No cycle; updates both parents' deps; the source's last child requires its new leaf status and priority |
| `set_ask(id, text, url?, chat?)`, `clear_ask(id, log)` | Owner actions | |
| `write_card(key, item, question, background, options, confidence)` | Adds or revises an open decision card | One recommended option at most; item exists |
| `rule_card(key, choice, ruling)` | Records the owner's ruling | Choice is an option key |
| `reply_note(id, reply, replace?)` | Answers a note, stamps `repliedAt`, marks it done | An existing reply requires explicit replacement |
| `create_project(name, repo?)` | Configures a project with the author as its first agent | Unique project name |
| `claim_project(project, replace?, reason?)` | Adds the author and optionally removes departed agents | Author not already listed; replacements listed; replacement reason required |
| `create_request(project, key, title, head, priority, why, from?)` | Files into any project's inbox; optionally links the filing item | Project exists; author owns `from`; atomic dependency |
| `triage_request(id, parent?, parent_why?, parent_own_work?, priority?, log)` | Accepts a request into the work hierarchy or as an area | Project member; same-project parent; preserves leaf parent work |
| `close_note(id, log)` | Closes a note and records handling in its item's log | Project member; not draft |

## 7. The page

The current template is kept. Its data layer, `window.claude.use("db")` and
`window.claude.use("comments")`, is replaced by a small client that loads a
snapshot from `/api/snapshot`, applies changes from `/api/events`, and posts
the owner's notes, reads and archive actions to `/api/...`. The rules module
moves out of the page into `src/rules.ts` and is loaded by both.

## 8. Waking sessions

"发给 Claude" posts to `/api/send`. Draft notes become `sent`, and each
sent note produces one wake event:
`{event:"note", note, target, kind, title, project, agents}`. Sending does not
mark a note handled. It stays `sent` until a project agent replies with
`reply_note` or closes it with `close_note`. Closing stamps the handler and
time and appends `关闭评论：<log>` to the owning item, atomically; it adds no
reply text and refuses draft notes; an existing reply is preserved.

A newly created request also produces one event:
`{event:"request", item, title, project, agents, by}`. The store's committed
change is the event source, so updates and retries do not announce a request
again. A socket at `/wake?session=*` receives everything; a named socket
receives events whose `agents` include that session. The coordinator listens
to the wildcard stream, forwards to the responsible project agents, and uses
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
there is no extra item layer. `board.projects` contains unique project names,
a unique list of agent session names per project, and an optional repository
identifier such as `Ming-Research/Halo-wf`. Several listed agents share the
work among themselves. An item's agents are those of its top-level area's
project. The item `agent` field is removed, including child handovers.
An area with an absent or unconfigured group, or an empty project agents
list, gets a shared rules check; older boards without `projects` load with
an empty list.

At a repository root, a session calls `projects`, matches the repository,
claims the project with `claim_project` unless already listed, then reads
`brief(project)`. A claim adds its author and may remove named departed
agents, each of which must already be listed. Replacements require a reason.
The commit records the claim, with the reason in its body; no board log or
`.mcp.json` change is needed. `create_project` configures a new project with
its author as its first agent. Both run in the same operations queue as item
writes, including prospective board checks; concurrent claims cannot lose
one another.

The server checks membership before agent mutations to items, their cards
and owner-note replies or closures. Moving work requires membership in both
source and destination projects, and revising a card's owning item checks
both owners. A refusal names the project and agents and directs the caller
to `create_request`. Cross-project dependency targets remain allowed on an
agent's own items. The page's owner-note, send, archive and read operations
are separate from agent operations and remain unrestricted. Session names
are supplied by trusted local callers; membership is workflow enforcement,
not authentication against a caller impersonating another session.

Anyone can call `create_request(project, key, title, head, priority, why,
from?)`. It creates a top-level TODO item in that project with
`request: {by, at}` and a first log recording the author and reason. With
`from`, the author must own the filing item; adding its dependency on the
new request happens in the same commit. Requests stay in a separate inbox,
oldest first, until a project agent triages them. `triage_request` removes
the marker, sets an optional priority, logs the disposition, and either
places the request under a parent in its project or retains it as an area.
Placement also appends `分拣：放到 <parent>：<why>` before the supplied log.
A leaf parent requires `parent_own_work`, preserving its own work as in
`create_item`. Moving a request under a parent in its project also triages
it and logs the placement. Declining with `set_status cancelled` clears the
marker and records the reason. An open inbox request is not an area in
listings; completed or cancelled items are not open requests.

`projects` reports configuration, area counts, open leaf status counts
(excluding inbox requests), and inbox counts. `brief` supplies inbox reasons,
sent item/card owner notes, checks including cleared blockers, open cards
still awaiting the owner, WIP leaves, the next ten TODO leaves by effective
priority, and outstanding work requested from other projects. That outgoing
list includes open requests by the project's agents and open items targeted
by its items' cross-project dependencies, so triage does not hide linked work.
Work queues omit archived items. The page shows agents once on each project
heading, an inbox above its areas, and a small inline owner request form.
The form posts to `/api/requests`; the server creates an owner-authored request
with a random `req-` key, using the submitted text as both head and reason.

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
   - derive projects from top-level areas in their displayed order, collecting
     distinct area agents per group in that order; drop every item's `agent`,
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

   Every agent operation checks the prospective board and refuses newly
   introduced missing blockers, parent dependency omissions, missing dependency
   targets or missing reasons. Existing imported flags can still receive
   progress. This also means splitting a blocked leaf is refused if its new
   own-work child would have no blocker; a split does not silently relocate
   owner actions or their notes.

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

## 11. Testing

- Unit tests for the rules module, the file format round trip, `rev`
  conflicts, append ordering and every write check, each shown to fail on the
  wrong input it guards against.
- An MCP integration test with the SDK client against a server on a temporary
  data directory.
- The conversion check of section 10.
- CI on GitHub-hosted runners for every push.
