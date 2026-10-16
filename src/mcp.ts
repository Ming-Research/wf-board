import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Key, Time, Status, Priority, Link, NOTE_KINDS, PlanRowInput, PlanInput, StepId, ItemTargetInput, ItemTargetsInput, TagName, Difficulty, difficultyText, isArchitectSession, DISPATCH_ROLES, DISPATCH_RESULTS, DISPATCH_SIGNALS, DispatchUsage } from "./model.ts";
import type { Decision, Note, Snapshot } from "./model.ts";
import type { Store } from "./store.ts";
import type { Ops } from "./ops.ts";
import * as q from "./query.ts";
import { dispatchRows, dispatchReport, normalizeTime } from "./dispatch.ts";
import type { DispatchFilters } from "./dispatch.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import type { Wake } from "./wake.ts";

export const STATUS: Record<string, string> = { wip: "WIP", done: "DONE", todo: "TODO", blocked: "BLOCK", paused: "PAUSE", cancelled: "DROP" };
const label = (s: string | undefined) => s === undefined ? "记录" : STATUS[s] ?? s.toUpperCase();
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
export function formatRow(it: Pick<q.Row, "id" | "status" | "title"> & Partial<q.Row>): string {
  return `${it.id} · ${label(it.status)}${it.priority ? ` ${it.priority}` : ""} · ${oneLine(it.title)}${it.tags?.length ? ` · [${it.tags.join(" ")}]` : ""}${it.difficulty === undefined ? "" : ` · ${difficultyText(it.difficulty)}`}${it.group || it.areaId ? ` · ${[it.group, it.areaId].filter(Boolean).join(" › ")}` : ""}${it.num === undefined ? "" : ` · #${it.num}`}`;
}
function formatNote(n: Note & { id: string; title?: string }): string {
  return `${n.id} · ${n.state.toUpperCase()} ${n.kind} · ${n.target} · ${n.sentAt ?? n.at}: ${n.text}${n.choice ? ` (choice ${n.choice})` : ""}${n.answerText !== undefined ? `\n  original action: ${n.answerText}` : ""}${n.reply ? `\n  reply ${n.repliedAt ?? ""} ${n.repliedBy ?? ""}: ${n.reply}` : ""}`;
}
function formatCard(key: string, card: Partial<Decision> & Pick<Decision, "question" | "status"> & { choiceText?: string }): string {
  const lines = [`${key} · ${label(card.status)} · ${card.question}${card.rev ? ` · rev ${card.rev}` : ""}${card.num === undefined ? "" : ` · #${card.num}`}`];
  if (card.blocks) lines.push(`blocks: ${card.blocks}`);
  for (const o of card.options ?? []) lines.push(`  ${o.key}${o.recommended ? " (recommended)" : ""}${o.text ? `: ${o.text}` : ""}${o.detail ? `${o.text ? " — " : ": "}${o.detail}` : ""}`);
  if (card.confidence) lines.push(`confidence ${card.confidence.score === undefined ? "" : card.confidence.score + "/5："}${card.confidence.reason}`);
  const chosen = card.choiceText ?? q.optionName(card.options?.find(o => o.key === card.choice));
  if (card.choice) lines.push(`chosen ${card.choice}${chosen ? `: ${chosen}` : ""}${card.ruledAt ? ` · ${card.ruledAt}` : ""}`);
  else if (card.status !== "open" && card.ruledAt) lines.push(`${card.status} ${card.ruledAt}`);
  if (card.ruling) lines.push(`ruling: ${card.ruling}`);
  // An old card keeps its background from before its grounds stood in the item's head.
  if (card.legacy?.background !== undefined) lines.push(`legacy background: ${card.legacy.background}`);
  return lines.join("\n");
}
export function formatContext(result: ReturnType<typeof q.context>): string {
  if (result.kind === "card") return [formatCard(result.id, result.card!), `item: ${formatRow(result.item as q.Row)}`, ...result.notes.map(formatNote)].join("\n");
  if (!("ancestors" in result)) throw new Error("Invalid item context");
  const it = result.item as Snapshot["items"][string];
  const lines = [formatRow(result as q.Row), `rev ${it.rev} · updated ${it.updated}${it.created ? ` · created ${it.created}` : ""}`];
  lines.push("status derived from plan and owner pause");
  if (result.lastPush) lines.push(`last push: ${q.pushLine(result.lastPush)}`);
  const pausedBy = result.pausedBy;
  if (pausedBy) lines.push(`pause: ${pausedBy.title} · ${pausedBy.reason} · ${pausedBy.at}`);
  if (it.order !== undefined) lines.push(`order: ${it.order}`);
  if (it.head !== undefined) lines.push(`head: ${it.head}`);
  if (result.plan.length) lines.push("plan:", ...result.plan.map(line => `  ${line}`));
  for (const warning of result.planWarnings) lines.push(`plan warning: ${warning}`);
  if (result.targets.length) lines.push("targets:", ...result.targets.map(line => `  ${line}`));
  if (it.data) lines.push(`data: ${it.data}`);
  if (it.ask) lines.push(`ask: ${it.ask.text}${it.ask.url ? ` · ${it.ask.url}` : ""}${it.ask.chat ? " · askChat" : ""}`);
  for (const name of ["ancestors", "dependents"] as const) {
    const rows = result[name];
    if (rows.length) lines.push(`${name}:`, ...rows.map(v => `  ${formatRow(v)}${"own" in v && v.own ? " · 拥有" : ""}`));
  }
  for (const card of result.cards) lines.push(formatCard(card.key, card));
  for (const note of result.notes) lines.push(formatNote(note));
  for (const check of result.checks) lines.push(`check: ${check.text}${check.target ? ` ${check.target.kind}:${check.target.id}` : ""}`);
  for (const link of result.links) lines.push(`link: ${link.label} · ${link.url}`);
  const refs = [...result.prs.qualified.map(p => `${p.repo}#${p.number}`), ...result.prs.unknown.map(n => `#${n} (repository unknown)`)];
  if (refs.length) lines.push(`PRs: ${refs.join(", ")}`);
  lines.push(`log (${it.log.length} shown; ${result.earlierLogs} earlier):`, ...it.log.map(l => `  ${l.at} ${l.by ?? ""}: ${l.text}`));
  return lines.join("\n");
}
export function formatSearch(hits: q.Hit[]): string {
  if (!hits.length) return "No matches.";
  // Bare #N references whose repository is unknown collapse into one line: they may be another repository's PR.
  const bare = hits.filter(h => h.field === "pr" && h.snippet.includes("未写仓库")), rest = hits.filter(h => !bare.includes(h));
  const lines = rest.map(h => `${formatRow(h)} · ${h.kind}.${h.field}${h.time ? ` ${h.time}` : ""}${h.more ? ` (+${h.more} more here)` : ""}\n  ${h.snippet}`);
  if (bare.length) lines.push(`also a bare ${bare[0]!.snippet.replace(/[«»]/g, "").split("（")[0]} without repository (may be another repository's PR) in: ${bare.map(h => `${h.kind}:${h.id}`).join(", ")}`);
  return lines.join("\n");
}
/** At most `limit` documents, then how many were left out, so one large commit (a migration) cannot flood the reader's context. */
export function formatChanges(groups: Awaited<ReturnType<typeof q.changes>>, limit = 40): string {
  if (!groups.length) return "No changes.";
  const total = groups.reduce((n, g) => n + g.documents.length, 0), out: string[] = [];
  let shown = 0;
  for (const g of groups) {
    if (shown >= limit) break;
    const docs = g.documents.slice(0, limit - shown);
    shown += docs.length;
    out.push(`${g.areaId} · ${g.area}`, ...docs.map(d => `  ${d.kind}:${d.id} · ${oneLine(d.title)} · ${d.summary}\n${d.commits.map(c => `    ${c.commit.slice(0, 12)} ${c.at} ${c.author}: ${oneLine(c.message)}`).join("\n")}`));
  }
  if (total > shown) out.push(`… ${total - shown} more changed documents; narrow with since, filters.group or filters.under, or raise limit.`);
  return out.join("\n");
}
function formatGraph(graph: ReturnType<typeof q.graph>): string {
  const lines: string[] = [];
  function walk(n: q.GraphNode, depth: number) {
    lines.push(`${"  ".repeat(depth)}${n.kind}:${n.id}${n.num === undefined ? "" : ` #${n.num}`} · ${label(n.status)} · ${oneLine(n.title)}${n.own === undefined ? "" : n.own ? " · owned" : " · shared"}${n.blockedChain ? " [open blocked chain]" : ""}${n.cycle ? " [cycle]" : ""}${n.truncated ? " [depth limit]" : ""}`);
    for (const child of n.next) walk(child, depth + 1);
  }
  if (graph.up) { lines.push("waits on:"); walk(graph.up, 0); }
  if (graph.down) { lines.push("waited on by:"); walk(graph.down, 0); }
  return lines.join("\n");
}

const author = z.string().describe("the name of the project you work for (from `projects`)");
const session = z.string().trim().min(1).max(80).describe("Your own session's name as the app's session list shows it. Pass it on every call. A write records it, so the board can say who last wrote to an item; it assigns nothing.").optional();
const id = Key.describe("Exact item id or card key found with search or list.");
/** Lookups also take a short number, "#812" or "812"; an exact key wins over a number. */
const ref = Key.or(z.string().regex(/^#[1-9]\d{0,14}$/)).describe("Exact item id or card key found with search or list, or the item's or card's short number such as #812.");
const text = (description: string) => z.string().describe(description);
const clearableText = (description: string) => z.string().nullable().optional().describe(description);
const limit = (n: number) => z.number().int().min(0).describe(`Maximum rows to return; default ${n}. Increase only when you need more context.`).optional();
const scope = {
  group: text("Restrict to this exact project group heading.").optional(),
  under: Key.describe("Restrict to this item and its descendants, including their cards and notes.").optional(),
};
const statuses = z.array(Status).describe("Include items with these derived statuses; for cards/notes this filters their owning item's status.").optional();
/** A dispatch time: UTC to the minute (2026-10-16T09:02Z) or in full. */
const dispatchTime = (description: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/).describe(description);
const count = (description: string) => z.number().int().nonnegative().describe(description);
const tagList = z.array(TagName).describe("Tags from the vocabulary (call tags) that apply to the item's project; at least one once the vocabulary has a tag for that project.");
const links = z.array(Link).describe("Relevant links as {label, url}; use qualified PR labels such as Whitefoot#341.");

export function createMcpServer({ store, ops, now, wake }: { store: Store; ops: Ops; now?: () => string; wake?: Wake }): McpServer {
  const server = new McpServer({ name: "wf-board", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  // Checks depend on elapsed active time, including when no new commit arrived.
  function read() {
    const snapshot = store.snapshot();
    // One shared Rules object per snapshot and minute (store.derived), not one per read.
    return { snapshot, rules: store.derived.rules(snapshot, now ? Date.parse(now()) : Date.now()) };
  }
  function register<S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.output<z.ZodObject<S>>) => string | Promise<string>, write = false) {
    // Every tool takes the session, reads too: a call from the architect's session is the receipt for what the board pushed it
    // (docs/design.md, The wake stream), counted from the calls it makes anyway.
    const full = "session" in shape ? shape : { ...shape, session };
    const schema: z.ZodObject = z.object(full).strict();
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: !write, destructiveHint: write } }, async a => {
      try {
        const args = schema.parse(a);
        if (typeof args.session === "string" && isArchitectSession(args.session)) wake?.receipt();
        return { content: [{ type: "text" as const, text: await fn(args as z.output<z.ZodObject<S>>) }] };
      }
      catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }
    });
  }
  register("projects", "Find the project matching your repository: its name, repo, area and open work counts and inbox size.", {}, () => JSON.stringify(q.projects(read().snapshot)));
  register("brief", "Start or resume a project: inbox, unhandled owner notes, checks, owner cards, current work, next tasks (only items rated 1–5 that an unpaused root needs; unrated items and 「架构师做」 items are not listed), outgoing requests and glossary terms. Item rows carry the item's difficulty when it has one, and relevant ones include compact plan rows with levels, ownership and dates, doing days and waits, and target numbers with comparison baselines and measurement dates; progress also covers records and active work omitted from those rows.", { project: text("Exact configured project name from projects.") }, a => { const x = read(); return JSON.stringify(q.brief(x.snapshot,x.rules,a.project)); });
  register("followups", "Coordinator follow-up: sent owner notes and inbox requests older than the given age, with their projects.", { minutes: z.number().nonnegative().describe("Age threshold in minutes, exclusive; zero returns all older pending work.") }, a => { const x = read(); return JSON.stringify(q.followups(x.snapshot,x.rules,a,now?.())); });
  register("search", "Where is this text mentioned? Search Chinese or other substrings across titles, heads, plan text, target goals, target values, current values, comparison baselines, logs, decisions and owner notes. Read context for a hit before editing it.", {
    query: text("Case-insensitive substring to find, including Chinese text."), filters: z.object({ ...scope, status: statuses, kind: z.array(z.enum(["item", "card", "note"])).describe("Search only these document kinds.").optional(), since: Time.describe("Only fields with timestamps at or after this ISO time; logs and notes use their own times.").optional(), limit: limit(20) }).strict().describe("Narrow the matches to relevant board context.").optional(),
  }, a => { const x = read(); return formatSearch(q.search(x.snapshot, x.rules, a.query, a.filters)); });
  register("context", "What is this item or decision, what does it wait on, and what happened recently? Accepts a key or a short number (#812). Returns compact plan rows, target numbers with comparison baselines and measurement dates, and the latest five log entries; logs are historical detail and never owner unread content. Request all only when needed.", {
    id: ref, log: z.union([z.number().int().min(0), z.literal("all")]).describe("Recent item log entries to include; default 5, 0 omits them, all returns the full log.").optional(),
  }, a => { const x = read(); return formatContext(q.context(x.snapshot, x.rules, a.id, { log: a.log })); });
  register("graph", "What does this wait on, and what waits on it? Accepts a key or a short number (#812). Follow plan dependencies with titles and ownership, marking open blocked chains and cycles; owned and shared item rows are included.", {
    id: ref, direction: z.enum(["up", "down", "both"]).describe("up follows blockers; down follows dependents; both shows each separately."), depth: z.number().int().min(0).max(20).describe("Maximum dependency edges from the root; default 3.").optional(),
  }, a => { const x = read(); return formatGraph(q.graph(x.snapshot, x.rules, a.id, a)); });
  register("overview", "Which areas need attention? Shows leaf status counts, owner actions, blocked leaves and checks, optionally in one project group. status narrows leaf counts, owner actions and checks, including paused work.", {
    group: scope.group, status: statuses,
  }, a => { const x = read(); return q.overview(x.snapshot, x.rules, a).map(project => [ `${project.project} · inbox ${project.inbox}`, ...project.areas.map(area => [formatRow(area), Object.entries(area.counts).map(([st, n]) => `${label(st)} ${n}`).join(" · "), ...area.ownerActions.map(it => `  owner: ${formatRow(it)}`), ...area.blocked.map(it => `  blocked: ${formatRow(it)}`), ...area.checks.map(it => `  check: ${formatRow(it)} · ${it.checks.map(c => c.text).join("; ")}`)].join("\n"))].join("\n")).join("\n") || "No projects."; });
  register("list", "Which items match structured filters? Browse compact rows in page sibling order, then use context on the relevant ids. Done and cancelled items require an explicit status filter.", {
    filters: z.object({ ...scope, status: statuses, priority: z.array(Priority).describe("Match displayed priority: a root stores it; other work inherits it from open dependents. Record-owned work inherits shared dependents' priority, or none without them.").optional(), needsOwner: z.boolean().describe("Filter by whether owner action is waiting.").optional(), hasChecks: z.boolean().describe("Filter by whether board-rule checks need attention, including items with an own doing step and 1 hour of active time without changes.").optional(), updatedSince: Time.describe("Only items updated at or after this ISO time.").optional(), limit: limit(50) }).strict().describe("Structured item filters; omitted means the first 50 open or record rows.").optional(),
  }, a => { const x = read(); return q.list(x.snapshot, x.rules, a.filters).map(it => `${formatRow(it)}${it.needsOwner ? " · owner waiting" : ""}${it.checks.length ? ` · ${it.checks.length} checks` : ""}`).join("\n") || "No items."; });
  register("dispatches", "How have the agent sessions the architect started done? Tallies the dispatch records of every project, by level, by role and by the item's tags: dispatches, how many are still running, how many ended in each result, the rework share, the mean kickbacks and rounds, and the cost; then how many ended with each failure signal. Every figure is added up from the rows, so rows: true lists the rows that add up to it. An item with several tags counts under each of them. since and until bound the start time (since inclusive, until exclusive).", {
    filters: z.object({ id: Key.describe("Only the dispatches on this item.").optional(), role: z.enum(DISPATCH_ROLES).optional(), level: z.number().int().min(1).max(5).optional(), since: dispatchTime("Only dispatches started at or after this UTC time.").optional(), until: dispatchTime("Only dispatches started before this UTC time.").optional() }).strict().describe("Narrow the dispatches counted.").optional(),
    rows: z.boolean().describe("Also list every counted dispatch, oldest start first.").optional(),
  }, a => {
    const f = a.filters ?? {}, snapshot = read().snapshot;
    if (f.id !== undefined && !Object.hasOwn(snapshot.items, f.id)) throw new Error(`id ${f.id}: choose an existing item`);
    // A minute-form time is made the full time it means, and a time that is no date is refused rather than ignored.
    const utc = (field: string, text: string): string => normalizeTime(text) ?? ((): never => { throw new Error(`${field} ${text}: give a UTC time such as 2026-10-16T09:02Z`); })();
    const filters: DispatchFilters = { ...f, since: f.since && utc("since", f.since), until: f.until && utc("until", f.until) };
    return dispatchReport(dispatchRows(snapshot, filters), a.rows);
  });
  register("notes", "What did the owner say? Find notes by state, kind, subtree or time, with project replies, before handling or replying to them.", {
    filters: z.object({ under: scope.under, state: z.array(z.enum(["draft", "sent", "done"])).describe("Include these note states; sent finds unhandled owner messages.").optional(), kind: z.array(z.enum(NOTE_KINDS)).describe("Include these kinds of owner note.").optional(), since: Time.describe("Notes sent, created or replied to at or after this ISO time.").optional(), limit: limit(50) }).strict().describe("Narrow owner notes to relevant messages.").optional(),
  }, a => q.notes(read().snapshot, a.filters).map(formatNote).join("\n") || "No notes.");
  register("glossary", "What does a word a project coined mean? Lists glossary terms with their definitions: one project's, or every project's that has terms.", {
    project: text("Exact configured project name; omit for every project.").optional(),
  }, a => q.glossary(read().snapshot, a.project).map(g => [`${g.project}:${g.terms.length ? "" : " no terms"}`, ...g.terms.map(t => `  ${t.term}: ${oneLine(t.definition)}`)].join("\n")).join("\n") || "No terms.");
  register("tags", "Which tags may I put on an item? Lists the approved tag vocabulary with each tag's meaning and the projects it is limited to: the tags for one project, or all of them.", {
    project: text("Exact configured project name; omit for every tag.").optional(),
  }, a => q.tagVocabulary(read().snapshot, a.project).map(t => `${t.name}: ${t.meaning}${t.projects ? ` (only ${t.projects.join(", ")})` : ""}`).join("\n") || "No tags approved yet.");
  register("prs", "Which board documents concern this PR? Returns qualified repository references separately from bare numbers whose repository is unknown.", {
    repo: text("Repository name under Ming-Research, such as Whitefoot."), number: z.number().int().positive().describe("Pull request number in that repository."),
  }, a => { const x = read(), refs = q.prs(x.snapshot, x.rules, a.repo, a.number); return [`${a.repo}#${a.number}:`, ...refs.qualified.map(it => `  ${it.kind}: ${formatRow(it)}`), "repository unknown:", ...refs.unknown.map(it => `  ${it.kind}: ${formatRow(it)}`)].join("\n"); });
  register("changes", "What changed while I was away? Summarizes changed documents by area with net field differences and their commits, since an ISO time or commit.", {
    since: text("Exclusive starting point: ISO time or git commit/ref you last read."), filters: z.object(scope).strict().describe("Only changes in this group or item subtree.").optional(), limit: limit(40),
  }, async a => formatChanges(await q.changes(store, read().snapshot, a.since, a.filters), a.limit));
  const kind = z.enum(["item", "card", "note"]).default("item").describe("Document kind; card means a decision card; default item.");
  register("history", "How did this document change? Lists its commits newest first; use a commit in diff to inspect the exact text change.", {
    kind, id: text("Exact document id; notes use their original note id."), limit: limit(20),
  }, async a => (await q.history(store, a.kind === "card" ? "decision" : a.kind, a.id, a.limit)).map(c => `${c.commit} ${c.at} ${c.author}: ${oneLine(c.message)}`).join("\n") || "No history.");
  register("diff", "What exactly changed in one document? Returns its YAML diff between commits or ISO times; use after history or changes.", {
    kind, id: text("Exact document id; notes use their original note id."), from: text("Starting git commit/ref or ISO time."), to: text("Ending git commit/ref or ISO time; omitted means current HEAD.").optional(),
  }, async a => await q.diff(store, a.kind === "card" ? "decision" : a.kind, a.id, a.from, a.to) || "No differences.");
  // A write answers with the state it produced: the target's row and every ancestor whose
  // derived status or priority it changed, so the writer need not read context again.
  const result = async (operation: Promise<import("./ops.ts").Result>) => {
    const before = read();
    const res = await operation;
    const after = read(), lines = [`${res.summary}${res.rev === undefined ? "" : ` · rev ${res.rev}`} · commit ${res.commit}`];
    if (res.dropped?.length) lines.push(`dropped stored priority, no longer a root: ${res.dropped.map(d => `${d.id} ${d.priority}`).join(", ")}`);
    if (res.rev === undefined) return lines.join("\n");
    const kind = Object.hasOwn(after.snapshot.items, res.id) ? "item" : Object.hasOwn(after.snapshot.decisions, res.id) ? "card" : "note";
    if (kind !== "note") lines.push(formatRow(q.row(after.snapshot, after.rules, kind, res.id)));
    // The card writer sees its own option check now, not only on the next read.
    if (kind === "card") for (const check of after.rules.cardChecks(res.id)) lines.push(`check: ${check.text}`);
    if (kind === "item") for (const a of after.rules.ancestors(res.id)) {
      const was = Object.hasOwn(before.snapshot.items, a) ? `${label(before.rules.statusOf(a))} ${before.rules.priorityOf(a)}` : "";
      const now = `${label(after.rules.statusOf(a))} ${after.rules.priorityOf(a)}`;
      if (was !== now) lines.push(`ancestor ${a} now ${now}${was ? ` (was ${was})` : ""}`);
    }
    return lines.join("\n");
  };
  register("create_item", "Only author Architect with session 架构师 may create items. Create an item with initial plan rows and one acceptance step appended from accept; use set_plan to add more acceptance steps or move them. owner adds an owned row before its first acceptance step. children deliberately moves existing items into the new plan. Only new roots store priority; records require no acceptance. Only the architect creates items, so only the architect can rate the new one with difficulty.", {
    author, session, key: Key.describe("Unused key for the new item or request."), title: text("What completion delivers."), head: text("Stable problem, why and approach.").optional(), accept: text("Completion check or number appended as one acceptance step; required for work, refused for records.").optional(), owner: Key.describe("Existing same-project owner; omit to keep or make a top item.").optional(), after: z.array(Key).describe("Earlier destination plan row ids; [] starts at once, omitted follows the preceding row.").optional(), plan: PlanInput.describe("Initial ordered rows, which may include acceptance steps; accept appends one more at the end. No caller dates.").optional(), children: z.array(Key).describe("Existing same-project items deliberately moved into this new plan.").optional(), priority: Priority.describe("Only root priority: P0 urgent, P1 soon, P2 later; refused for owned or backlog work.").optional(), record: z.boolean().describe("A record has no work status or acceptance; it passes no priority.").optional(), group: text("Project for a top item; otherwise owner's project.").optional(), links: links.optional(), data: text("Key numbers.").optional(), order: z.number().describe("Top-item ordering; owned order comes from the plan.").optional(), tags: tagList.optional(), difficulty: Difficulty.describe("1–5, or \"architect\" for an item the architect does itself; logged as the first rating. Refused for a record.").optional(),
  }, a => result(ops.createItem(a)), true);
  register("journal_entry", "Add one timed entry to today's architect journal (local date) and create that day's record under the architect notes if it does not exist yet. Only author Architect with session 架构师 may call it; the entry goes to the end of the record's text and marks it new for the owner.", { author, session, text: text("The entry text, possibly several lines; kept as written after the time stamp.") }, a => result(ops.journalEntry(a)), true);
  register("append_log", "Append historical detail without reading a revision. Appends are retried on concurrent writes and stamped by the server. Logs never mark an item new for the owner; use set_plan to keep progress current.", { author, session, id, text: text("Evidence, detail or stop reason to append; nonempty.") }, a => result(ops.appendLog(a)), true);
  register("dispatch_start", "Record an agent session you started on an item, and log the start on the item. author is the item's project, session your own session; agent is the started session's name and agentId its full id, which names one dispatch on the whole board. role is 工程师 or 审查. effort is omitted when the model has none (Haiku). startedAt is UTC (2026-10-16T09:02Z or in full), now when omitted. did names, in one line, which rows of the item the session does. Call dispatch_finish when the session ends.", {
    author, session, id: id.describe("The subtree root item you gave the session; the tag tally counts the dispatch under this item's tags."), role: z.enum(DISPATCH_ROLES), level: z.number().int().min(1).max(5).describe("The level the session was started at."), model: text("Model name as the level table writes it, e.g. Sonnet."), effort: text("Reasoning effort, e.g. xhigh; omit when the model has none.").optional(), agent: text("The started session's name."), agentId: Key.describe("The started session's full id."), worktree: text("The session's worktree path.").optional(), startedAt: dispatchTime("UTC start time; now when omitted.").optional(), did: text("Which rows of the item the session does, one line.").optional(),
  }, a => result(ops.dispatchStart(a)), true);
  register("dispatch_finish", "Complete a dispatch when its session ends: result, counts, usage, cost, failure signals and a note; logs the end on the item. result is 一次通过, 返工后通过, 换人 or 放弃. An engineer dispatch carries reports (how often it stopped to report) and kickbacks (how often you sent it back: a review's findings handed back to fix, or a rejected approach); a review dispatch carries rounds (how many review rounds it took: the first review and each re-review count one). A wrong-role count is refused. usage is the session's tokens summed from its transcript; cost is in US dollars, rounded to three decimals. signals lists the failure signals that occurred, none when omitted. waited is minutes spent waiting for the owner, the 14900K or a dependency. endedAt is UTC, now when omitted. An ended dispatch is changed only with replace: true.", {
    author, session, id: id.describe("The item the dispatch was recorded on by dispatch_start."), agentId: Key.describe("The session's full id, as given to dispatch_start."), result: z.enum(DISPATCH_RESULTS), usage: DispatchUsage.describe("Tokens, summed over the session's transcript with duplicate messages removed: input, cacheWrite, cacheRead, output."), cost: z.number().nonnegative().describe("US dollars; more than three decimals are rounded."), reports: count("Engineer only: how often it stopped to report.").optional(), kickbacks: count("Engineer only: how often it was sent back.").optional(), rounds: count("Review only: how many review rounds it took; the first review and each re-review count one.").optional(), waited: count("Minutes spent waiting for the owner, the 14900K or a dependency.").optional(), signals: z.array(z.object({ kind: z.enum(DISPATCH_SIGNALS), note: text("One sentence on this occurrence.").optional() }).strict()).describe("The failure signals that occurred, each at most once; none when omitted.").optional(), note: text("One sentence: a sign the level was set too high or too low.").optional(), endedAt: dispatchTime("UTC end time; now when omitted.").optional(), replace: z.boolean().describe("Explicitly replace an ended dispatch's record.").optional(),
  }, a => result(ops.dispatchFinish(a)), true);
  register("set_plan", "Edit the item's plan. Exactly one mode: rows replaces the whole plan, row upserts by stable id (new rows before the first acceptance step, or at the end when there is none), remove deletes an existing row. Dates are server-owned. A blocking card's row joins the plan only through write_card and cannot be removed here (withdraw_card closes the card); here it may only change its after or its position. Whole writes clear provisional and log the rewrite. Status, blocking and priority derive from the plan; open owned rows require move_item before removal for every author. Project writes cannot indirectly resume paused open work. after names earlier rows. Work plans require at least one acceptance step anywhere; records take none. Acceptance uses ordinary step after, waits and state rules. Identical results are no-ops; concurrent writes retry atomically.", {
    author, session, id, rows: PlanInput.describe("Whole ordered plan replacement; clears provisional and logs its rewrite.").optional(), row: PlanRowInput.describe("Complete row upsert; keeps an existing id in place or inserts before the first acceptance step (appends when there is none). Use rows to choose another position.").optional(), remove: Key.describe("Existing row id; later after users must be rewritten first.").optional(),
  }, a => result(ops.setPlan(a)), true);
  register("set_targets", "Keep your item's goal numbers current, including on records. Provide exactly one: targets replaces the ordered list, target upserts a complete goal by stable id, or remove deletes that id. Existing upserts keep their position; new ids append. Each row describes a goal, its target value, current value and comparison baseline. The server stamps the measurement date when the current value changes and preserves it otherwise; callers provide no date. New values overwrite old ones, with no measurement history list. No revision is required; changes are one atomic commit with concurrent writes retried; an identical result writes no commit. Target changes are owner unread progress.", {
    author, session, id,
    targets: ItemTargetsInput.describe("Full replacement list; unique stable ids. Caller provides no dates. Empty list clears targets.").optional(),
    target: ItemTargetInput.describe("Complete goal to add or replace: id (1–40 key characters), goal, target, current and baseline; all text is nonempty. Caller provides no date.").optional(),
    remove: StepId.describe("Existing stable target id to remove; supply no target or targets.").optional(),
  }, a => result(ops.setTargets(a)), true);
  register("update_item", "Edit stable fields using rev from context. A changed head requires reason. Priority is written only on a root, never backlog work. order is for top items. Changing to a record removes all acceptance steps and logs their texts; project authors must have an explicit pause cleared by the owner or Architect before converting to a record (a cancelled item only by Architect with session 架构师); an inherited pause alone does not prevent record conversion, provided no open descendant resumes; changing to work requires accept. Only author Architect with session 架构师 may change the title, and turn a cancelled item into a record. Edit progress with set_plan and ownership with move_item.", {
    author, session, id, rev: z.number().int().positive().describe("Revision read from context; stale writes are refused."), title: text("Replacement title.").optional(), head: text("Replacement context.").optional(), reason: text("Why head changed.").optional(), record: z.boolean().describe("A record has no work status or acceptance; it passes no priority.").optional(), accept: text("Acceptance for a record becoming work.").optional(), links: links.optional(), priority: Priority.describe("Only root priority: P0 urgent, P1 soon, P2 later; refused for owned or backlog work.").optional(), data: clearableText("Replacement numbers; null clears."), order: z.number().describe("Top-item ordering; owned order comes from the plan.").optional(),
  }, a => result(ops.updateItem(a)), true);
  register("set_tags", "Set your item's whole tag list: every tag must be in the vocabulary (tags) and apply to the item's project, at least one, no repeats. Identical lists are no-ops. No revision is required. Use it to backfill items the 缺标签 check lists.", { author, session, id, tags: tagList }, a => result(ops.setTags(a)), true);
  register("set_tags_many", "Set the whole tag lists of many of your items in one commit, for backfilling the 缺标签 check: each entry is checked as set_tags checks it, and one refused entry refuses the whole write. Entries whose list is unchanged write nothing; when none changes, no commit is made.", {
    author, session, items: z.array(z.object({ id, tags: tagList }).strict()).min(1).describe("Each item once, with its whole tag list."),
  }, a => result(ops.setTagsMany(a)), true);
  register("set_difficulty", "Only author Architect with session 架构师, for an item of any project: set the item's difficulty, 1–5, which decides the agent that does it, or \"architect\" (shown as 「架构师做」) for an item the architect does itself, such as a discussion, a walkthrough or a design. Work items only; a record has none. reason is required, also for the first rating, and is logged with the change as 「难度：2 → 3，理由：…」 (the first rating from 未评). An unchanged value is a no-op. No revision is required. Open work without a difficulty shows the 缺难度 check and is not startable; 「架构师做」 is rated, so it shows no check, and it is not listed as startable either.", { author, session, id, difficulty: Difficulty.describe("1–5, or \"architect\" for an item the architect does itself."), reason: text("Why the difficulty is this; logged with the change.") }, a => result(ops.setDifficulty(a)), true);
  register("set_difficulty_many", "Set the difficulty of many items in one commit, for rating a backlog of items without one: each entry is checked and logged as set_difficulty checks and logs it, and one refused entry refuses the whole write. Only author Architect with session 架构师. reason is the default for entries that give none; an entry with neither is refused. Entries whose difficulty is unchanged write nothing; when none changes, no commit is made.", {
    author, session, reason: text("Default reason for entries without their own.").optional(),
    items: z.array(z.object({ id, difficulty: Difficulty.describe("1–5, or \"architect\" for an item the architect does itself."), reason: text("This item's reason; overrides the default.").optional() }).strict()).min(1).describe("Each item once, with its difficulty."),
  }, a => result(ops.setDifficultyMany(a)), true);
  register("set_tag", "Vocabulary change, only author Architect with session 架构师 and only after the owner approved it on a decision card: add a tag or change an existing tag's meaning or projects. meaning is one sentence telling agents when to apply the tag. projects limits the tag to those projects; null makes it apply to every project; omitted keeps the current setting (a new tag then applies to every project). Narrowing projects is refused while an item of another project carries the tag.", { author, session, name: TagName.describe("Short Chinese label, 1–12 characters without whitespace or commas; unique."), meaning: text("One sentence telling agents when to apply the tag."), projects: z.array(text("Configured project name.")).min(1).nullable().optional().describe("Projects that may use the tag; null for every project.") }, a => result(ops.setTag(a)), true);
  register("rename_tag", "Vocabulary change, only author Architect with session 架构师 and only after the owner approved it on a decision card: rename a tag and every item carrying it in one commit, logging the rename on each item.", { author, session, name: TagName.describe("Existing tag."), to: TagName.describe("Unused new name.") }, a => result(ops.renameTag(a)), true);
  register("remove_tag", "Vocabulary change, only author Architect with session 架构师 and only after the owner approved it on a decision card: remove a tag. Refused while any item carries it, unless replace names another tag that applies to all those items' projects; every carrying item then gets the replacement, in the same commit.", { author, session, name: TagName.describe("Existing tag."), replace: TagName.describe("Existing other tag every carrying item receives instead.").optional() }, a => result(ops.removeTag(a)), true);
  register("set_pause", "Owner-directed pause or resume without changing any plan row. Only author Architect with session 架构师 may write it, in any project. Records refuse this tool. Pausing requires reason and refuses done and cancelled items; those closed items may only have an existing explicit pause cleared. Descendants inherit pause; resume clears only this item's own marker, so an ancestor's pause remains. Times and the 暂停/恢复 log entry are server-owned; identical requests are no-ops.", { author, session, id, paused: z.boolean().describe("true pauses the item and its owned subtree; false clears this item's explicit pause."), reason: text("Owner's reason for pausing; required when paused is true.").optional() }, a => result(ops.setPause(a)), true);
  register("set_status", "Only author Architect with session 架构师 may use it. Cancel with a reason, or reopen a cancelled item. Plan rows, including acceptance states and dates, and owner pause markers stay unchanged. Reopening restores any effective pause. All other statuses derive from plan. Refuses records and cancellation with open owned parts; dispose of each part first. Cancelling paused work keeps the pause marker.", { author, session, id, status: z.enum(["cancelled", "open"]).describe("cancelled cancels; open removes cancellation, with status derived again."), log: text("Cancellation or reopening reason.") }, a => result(ops.setStatus(a)), true);
  register("move_item", "Deliberately change ownership in one commit, logging on the item and both owners. Ownership stays within the same project, with no cycles. Project authors may move into a paused chain but cannot move open work out of one until the owner or Architect with session 架构师 resumes it. Architect with session 架构师 may move any project's items. Without owner it becomes top-level; a new root requires priority, otherwise priority is refused. after belongs to the destination row and requires owner. Later after edges naming a removed row must be rewritten first.", { author, session, id, owner: Key.describe("Existing same-project owner; omit to keep or make a top item.").optional(), after: z.array(Key).describe("Earlier destination plan row ids; [] starts at once, omitted follows the preceding row.").optional(), priority: Priority.describe("Only root priority: P0 urgent, P1 soon, P2 later; refused for owned or backlog work.").optional() }, a => result(ops.moveItem(a)), true);
  register("move_item_project", "Only author Architect with session 架构师 may use it. Move an item to another project, together with everything it owns, in one commit. Key, number, history, notes and cards stay with it; each moved item logs the move. An owner left behind keeps its row as a shared dependency. The item arrives as a top item of the new project; place it under an owner there afterwards with move_item. priority: an item that lands as an open root keeps a stored priority and needs one given when it has none; a given priority replaces the stored one (logged) and is refused when the item does not land as a root. Refused when the move would leave an open waiter and no owner in the new project: an open item there waits on it through a shared row (it would arrive owned by no item), or its own plan holds a shared row to a top item there that nothing owns; the error names them and says what to do first, and only what this move newly causes is refused, not a violation that was already there. Also refused when a moved item's tags do not apply to the new project, or when open work would leave a paused chain without the owner or Architect with session 架构师 resuming it.", { author, session, id, project: text("Existing configured project to move the item into."), priority: Priority.describe("Root priority: P0 urgent, P1 soon, P2 later. Required when the item lands as an open root with none stored; optional replacement when one is stored; refused when the item does not land as a root.").optional() }, a => result(ops.moveItemProject(a)), true);
  register("clear_ask", "Remove a legacy ask after the project has replaced it with a decision card or settled it; log the outcome in the same commit.", { author, session, id, log: text("Which decision card replaced the legacy ask or what settled it, and why it can be removed.") }, a => result(ops.clearAsk(a)), true);
  register("write_card", "Create a decision card, or revise an open card using its rev from context. A card is one question with at least three workable options, each with a short name and a detail (what it does, its cost and risks, why it is or is not recommended), and the confidence in the recommended one (score and reason, with what would overturn it). The head places the card on a line holding only [[q:key]], where the design reaches the decision, and does not repeat what the card says. Only a card with blocks is a row of the item's plan, put there in the same commit: before names the row that also waits for the card (default: the first acceptance step) and after the earlier rows the card waits for (as in set_plan). A card without blocks has no row. A revision cannot change the item; setting blocks on a revision adds the row, clearing it removes the row.", {
    author, session, key: Key.describe("Unused new decision key, or an existing open card key with rev."), rev: z.number().int().positive().describe("Required to revise an open card; omit only for creation.").optional(), item: Key.describe("Existing item this decision belongs to."), question: text("The choice the owner needs to settle, one line."),
    options: z.array(z.object({ text: text("The option's name, a short phrase of at most 20 characters (spaces not counted) on one line."), detail: text("What the option does, its cost and risks, and why it is or is not recommended. No length limit."), recommended: z.boolean().describe("Mark at most one option.").optional() }).strict()).min(1).max(26).describe("The options in order; the board keys them A, B, C…"),
    confidence: z.object({ score: z.number().int().min(1).max(5).describe("Confidence from 1 (judgment) to 5 (settled by evidence).").optional(), reason: text("Evidence for the confidence and what could overturn it.") }).strict().describe("Confidence in the recommended option; required when creating.").optional(),
    blocks: clearableText("One sentence naming the work that cannot proceed until the owner rules. Set it only when named work is stopped by this card (something hard to undo or that the owner must do); leave it out when sessions proceed on the recommendation. A card with blocks is blocking: it is a row of the item's plan, the page shows it purple and the owner is told on the Mac. When revising, text sets it, null clears it, omitted keeps it."),
    before: Key.describe("Only for a card with blocks, when its row is created: the plan row that also waits for this card; the card's row goes just before it. Default: the first acceptance step.").optional(), after: z.array(Key).describe("Only for a card with blocks, when its row is created: earlier plan row ids this card waits for; [] starts at once, omitted follows the preceding row.").optional(),
  }, a => result(ops.writeCard(a)), true);
  register("rule_card", "Record the owner's ruling on an open decision card made outside the page, for example in chat: the option they chose, and their own words in ruling (the design tree's approval line quotes them). A pick the owner sends on the page is recorded by the board itself when it is sent, so do not call this for it. A choice must be one of the card's option keys; a ruling in words may omit choice. Rulings may complete paused work; the retained pause marker stays unchanged, and author ownership checks apply.", { author, session, key: Key.describe("Existing open decision card key."), choice: text("The chosen option's key, A, B, C…; omit when the owner chose none and answered in words.").optional(), ruling: text("The owner's words and reasons, quoted.").optional() }, a => result(ops.ruleCard(a)), true);
  register("withdraw_card", "Withdraw an open decision card nobody needs any more. The reason is written in the item's log and the card's plan row, if it has one, counts as done. A card the owner has answered is not withdrawn.", { author, session, key: Key.describe("Existing open decision card key."), log: text("Why the card is no longer needed; written in the item's log.") }, a => result(ops.withdrawCard(a)), true);
  register("reply_note", "Answer an owner's note and mark it done. The server stamps repliedAt and records your project as repliedBy.", { author, session, id: text("Existing owner note id found with notes or context."), reply: text("Answer to the owner's note."), replace: z.boolean().describe("Explicitly replace an existing reply; otherwise an already answered note is refused.").optional() }, a => result(ops.replyNote(a)), true);
  register("create_project", "Configure a new project with its optional repository; accepts any author string when appending last. Only Architect with session 架构师 may supply after to place it immediately after an existing project in page order. Creation and placement are one commit.", { author, session, name: text("New unique project name, used by area group fields."), repo: text("Optional repository identifier, e.g. Ming-Research/Halo-wf.").optional(), after: text("Existing project name this new project should immediately follow; only Architect with session 架构师. Omit to append last.").optional() }, a => result(ops.createProject(a)), true);
  register("update_project", "Update the project's repository or mainline; Architect with session 架构师 may update any project and reorder it with after. All projects derive priority from plans.", { author, session, name: text("Configured project name."), repo: text("Repository identifier.").optional(), mainline: clearableText("The branch merges land on, when it is not the repository's default branch; the GitHub watch reads its checks. null clears it."), after: text("Project immediately before it; Architect with session 架构师 only.").optional() }, a => result(ops.updateProject(a)), true);
  register("create_request", "File work in another project's inbox with acceptance and filing reason in its first log. from adds a shared row to your item's plan in the same commit and gives the request priority; without from a root priority is required.", { author, session, project: text("Receiving project."), key: Key.describe("Unused key for the new item or request."), title: text("What this delivers."), head: text("Context and witness."), accept: text("Acceptance check or number."), why: text("Filing reason, kept in the first log."), from: Key.describe("Filing item of your project; gains the request as a shared row.").optional(), after: z.array(Key).describe("Earlier destination plan row ids; [] starts at once, omitted follows the preceding row.").optional(), priority: Priority.describe("Only root priority: P0 urgent, P1 soon, P2 later; refused for owned or backlog work.").optional(), tags: tagList.optional() }, a => result(ops.createRequest(a)), true);
  register("triage_request", "Accept your project's inbox request into an owner's plan or as a top item. Clear its inbox marker and log disposition. Priority only if it stays a root; after requires owner.", { author, session, id, owner: Key.describe("Existing same-project owner; omit to keep or make a top item.").optional(), after: z.array(Key).describe("Earlier destination plan row ids; [] starts at once, omitted follows the preceding row.").optional(), priority: Priority.describe("Only root priority: P0 urgent, P1 soon, P2 later; refused for owned or backlog work.").optional(), log: text("Disposition and reason.") }, a => result(ops.triageRequest(a)), true);
  register("close_note", "Close a sent owner note without reply text and record what handled it in its item's log, in one commit.", { author, session, id: text("Owner note id on your project's item or card."), log: text("What handled this note; appended to the item's historical log.") }, a => result(ops.closeNote(a)), true);
  // A glossary write answers with its commit; there is no item row to show.
  const glossaryResult = async (operation: Promise<import("./ops.ts").Result>) => { const res = await operation; return `${res.summary} · commit ${res.commit}`; };
  register("set_term", "Add or replace a term in your own project's glossary. The board page links the first occurrence of each term in an item, card or note to its definition. Add a term only for a word your project coined and uses repeatedly; industry-standard terms (CoreMark, PUC Lua, WPT, dispatch) are not added. A term is no substitute for describing the phenomenon in plain words where you write about it.", {
    author, session, term: text("The coined word exactly as board text writes it, on one line; occurrences are matched as plain substrings."), definition: text("What the word means, in plain Chinese that a reader outside the project understands."),
  }, a => glossaryResult(ops.setTerm(a)), true);
  register("delete_term", "Remove a term from your own project's glossary, such as a word no longer used or an industry-standard term added by mistake.", { author, session, term: text("Existing term in your project's glossary.") }, a => glossaryResult(ops.deleteTerm(a)), true);
  return server;
}
