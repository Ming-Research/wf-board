import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Key, Time, Status, Priority, Dep, Link, Option, NOTE_KINDS, ItemStepInput, ItemStepsInput, StepId, ItemTargetInput, ItemTargetsInput } from "./model.ts";
import type { Decision, Note, Snapshot } from "./model.ts";
import type { Store } from "./store.ts";
import type { Ops } from "./ops.ts";
import { rules } from "./rules.ts";
import * as q from "./query.ts";

export const STATUS: Record<string, string> = { wip: "WIP", done: "DONE", todo: "TODO", blocked: "BLOCK", cancelled: "DROP" };
const label = (s: string | undefined) => s === undefined ? "记录" : STATUS[s] ?? s.toUpperCase();
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
export function formatRow(it: Pick<q.Row, "id" | "status" | "title"> & Partial<q.Row>): string {
  return `${it.id} · ${label(it.status)}${it.priority ? ` ${it.priority}` : ""} · ${oneLine(it.title)}${it.group || it.areaId ? ` · ${[it.group, it.areaId].filter(Boolean).join(" › ")}` : ""}`;
}
function formatNote(n: Note & { id: string; title?: string }): string {
  return `${n.id} · ${n.state.toUpperCase()} ${n.kind} · ${n.target} · ${n.sentAt ?? n.at}: ${n.text}${n.choice ? ` (choice ${n.choice})` : ""}${n.answerText !== undefined ? `\n  original action: ${n.answerText}` : ""}${n.reply ? `\n  reply ${n.repliedAt ?? ""} ${n.repliedBy ?? ""}: ${n.reply}` : ""}`;
}
function formatCard(key: string, card: Partial<Decision> & Pick<Decision, "question" | "status">): string {
  const lines = [`${key} · ${label(card.status)} · ${card.question}${card.rev ? ` · rev ${card.rev}` : ""}`];
  if (card.blocks) lines.push(`blocks: ${card.blocks}`);
  if (card.background !== undefined) lines.push(`background: ${card.background}`);
  for (const o of card.options ?? []) lines.push(`  ${o.key}${o.recommended ? " (recommended)" : ""}: ${o.text}`);
  if (card.confidence) lines.push(`confidence ${card.confidence.score === undefined ? "" : card.confidence.score + "/5："}${card.confidence.reason}`);
  if (card.ruling) lines.push(`ruling${card.choice ? ` (${card.choice})` : ""} ${card.ruledAt ?? ""}: ${card.ruling}`);
  return lines.join("\n");
}
export function formatContext(result: ReturnType<typeof q.context>): string {
  if (result.kind === "card") return [formatCard(result.id, result.card!), `item: ${formatRow(result.item as q.Row)}`, ...result.notes.map(formatNote)].join("\n");
  if (!("ancestors" in result)) throw new Error("Invalid item context");
  const it = result.item as Snapshot["items"][string];
  const lines = [formatRow(result as q.Row), `rev ${it.rev} · updated ${it.updated}${it.created ? ` · created ${it.created}` : ""}`];
  const workChildren = result.children.filter(c => !c.record);
  if (!it.record && workChildren.length) lines.push(`status derived from ${workChildren.length} sub-item${workChildren.length > 1 ? "s" : ""}: ${workChildren.map(c => `${c.id} ${label(c.status)}`).join(", ")}`);
  if (!result.migrated && result.children.length) lines.push("priority derived from sub-items, including records");
  if (it.order !== undefined) lines.push(`order: ${it.order}`);
  if (!result.migrated && it.priority && it.priority !== result.priority) lines.push(`priority: ${it.priority} · effective ${result.priority}${result.raisedBy ? ` · raised by ${result.raisedBy}` : ""}`); // LEGACY PRIORITY
  if (it.head !== undefined) lines.push(`head: ${it.head}`);
  if (result.steps.length) lines.push("steps:", ...result.steps.map(line => `  ${line}`));
  if (result.targets.length) lines.push("targets:", ...result.targets.map(line => `  ${line}`));
  if (it.data) lines.push(`data: ${it.data}`);
  if (it.ask) lines.push(`ask: ${it.ask.text}${it.ask.url ? ` · ${it.ask.url}` : ""}${it.ask.chat ? " · askChat" : ""}`);
  for (const name of ["ancestors", "children", "deps", "dependents"] as const) {
    const rows = result[name];
    if (rows.length) lines.push(`${name}:`, ...rows.map(v => `  ${formatRow(v)}${"why" in v ? ` · ${v.why}` : ""}`));
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
    lines.push(`${"  ".repeat(depth)}${n.kind}:${n.id} · ${label(n.status)} · ${oneLine(n.title)}${n.why ? ` · ${n.why}` : ""}${n.blockedChain ? " [open blocked chain]" : ""}${n.cycle ? " [cycle]" : ""}${n.truncated ? " [depth limit]" : ""}`);
    for (const child of n.next) walk(child, depth + 1);
  }
  if (graph.up) { lines.push("waits on:"); walk(graph.up, 0); }
  if (graph.down) { lines.push("waited on by:"); walk(graph.down, 0); }
  return lines.join("\n");
}

const author = z.string().describe("the name of the project you work for (from `projects`)");
const id = Key.describe("Exact item id or card key found with search or list.");
const text = (description: string) => z.string().describe(description);
const clearableText = (description: string) => z.string().nullable().optional().describe(description);
const limit = (n: number) => z.number().int().min(0).describe(`Maximum rows to return; default ${n}. Increase only when you need more context.`).optional();
const scope = {
  group: text("Restrict to this exact project group heading.").optional(),
  under: Key.describe("Restrict to this item and its descendants, including their cards and notes.").optional(),
};
const statuses = z.array(Status).describe("Include items with these derived statuses; for cards/notes this filters their owning item's status.").optional();
const depsSchema = z.array(Dep).describe("Direct dependencies: {id, why} for items or {card, why} for decisions. Each why explains what this needs that dependency for.");
const links = z.array(Link).describe("Relevant links as {label, url}; use qualified PR labels such as Whitefoot#341.");

export function createMcpServer({ store, ops, now }: { store: Store; ops: Ops; now?: () => string }): McpServer {
  const server = new McpServer({ name: "wf-board", version: "0.1.0" }, { instructions: "On starting at a project's repository root, call projects, pick the project whose repo matches your repository's GitHub remote (the coordinator uses 总管), use that project's name as author in every write, then call brief. Only your project's items, cards and replies are yours to change; ask other projects through create_request, with from to record the dependency. Reply to or close every owner note with reply_note or close_note; sent notes and inbox requests remain pending until handled. The coordinator forwards wake-ups and follows up with followups, so an agent need not listen to the wake stream. Find the item with search and read context before writing. Use set_targets for each goal's target, current value and comparison baseline after measuring. Use set_steps for current progress and append_log for historical detail, which never marks owner unread; use set_status with a log line explaining the change. Every dependency carries a why explaining what it is needed for. The server stamps times. update_item and revisions of write_card need the rev read from context; redo on a stale revision. Parent status is derived from non-record children. record:true items have a head, optional steps, targets and log but no status; set_status refuses them. Checks include WIP leaves quiet for 2 hours of board-active time, the union of 30-minute windows after any board content write. Qualify PR references as Repo#N. Explain a word your project coined and keeps using with set_term; the page links each term to its definition, and glossary lists them." });
  // Checks depend on elapsed active time, including when no new commit arrived.
  function read() {
    const snapshot = store.snapshot();
    return { snapshot, rules: rules(snapshot, now ? Date.parse(now()) : Date.now()) };
  }
  function register<S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.output<z.ZodObject<S>>) => string | Promise<string>, write = false) {
    const schema: z.ZodObject = z.object(shape).strict();
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: !write, destructiveHint: write } }, async a => {
      try { return { content: [{ type: "text" as const, text: await fn(z.object(shape).strict().parse(a)) }] }; }
      catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }
    });
  }
  register("projects", "Find the project matching your repository: its name, repo, area and open work counts and inbox size.", {}, () => JSON.stringify(q.projects(read().snapshot)));
  register("brief", "Start or resume a project: inbox, unhandled owner notes, checks, owner cards, current work, next tasks, outgoing requests and glossary terms. Relevant item rows include compact steps with dates, doing days and waits, and target numbers with comparison baselines and measurement dates; progress also covers records and active work omitted from those rows.", { project: text("Exact configured project name from projects.") }, a => { const x = read(); return JSON.stringify(q.brief(x.snapshot,x.rules,a.project)); });
  register("followups", "Coordinator follow-up: sent owner notes and inbox requests older than the given age, with their projects.", { minutes: z.number().nonnegative().describe("Age threshold in minutes, exclusive; zero returns all older pending work.") }, a => { const x = read(); return JSON.stringify(q.followups(x.snapshot,x.rules,a,now?.())); });
  register("search", "Where is this text mentioned? Search Chinese or other substrings across titles, heads, steps, logs, decisions and owner notes. Read context for a hit before editing it.", {
    query: text("Case-insensitive substring to find, including Chinese text."), filters: z.object({ ...scope, status: statuses, kind: z.array(z.enum(["item", "card", "note"])).describe("Search only these document kinds.").optional(), since: Time.describe("Only fields with timestamps at or after this ISO time; logs and notes use their own times.").optional(), limit: limit(20) }).strict().describe("Narrow the matches to relevant board context.").optional(),
  }, a => { const x = read(); return formatSearch(q.search(x.snapshot, x.rules, a.query, a.filters)); });
  register("context", "What is this item or decision, what does it wait on, and what happened recently? Returns compact progress steps, target numbers with comparison baselines and measurement dates, and the latest five log entries; logs are historical detail and never owner unread content. Request all only when needed.", {
    id, log: z.union([z.number().int().min(0), z.literal("all")]).describe("Recent item log entries to include; default 5, 0 omits them, all returns the full log.").optional(),
  }, a => { const x = read(); return formatContext(q.context(x.snapshot, x.rules, a.id, { log: a.log })); });
  register("graph", "What does this wait on, and what waits on it? Follow dependencies with their whys, marking open blocked chains and cycles; parent dependencies are included.", {
    id, direction: z.enum(["up", "down", "both"]).describe("up follows blockers; down follows dependents; both shows each separately."), depth: z.number().int().min(0).max(20).describe("Maximum dependency edges from the root; default 3.").optional(),
  }, a => { const x = read(); return formatGraph(q.graph(x.snapshot, x.rules, a.id, a)); });
  register("overview", "Which areas need attention? Shows leaf status counts, owner actions, blocked leaves and checks, optionally in one project group.", {
    group: scope.group,
  }, a => { const x = read(); return q.overview(x.snapshot, x.rules, a).map(project => [ `${project.project} · inbox ${project.inbox}`, ...project.areas.map(area => [formatRow(area), Object.entries(area.counts).map(([st, n]) => `${label(st)} ${n}`).join(" · "), ...area.ownerActions.map(it => `  owner: ${formatRow(it)}`), ...area.blocked.map(it => `  blocked: ${formatRow(it)}`), ...area.checks.map(it => `  check: ${formatRow(it)} · ${it.checks.map(c => c.text).join("; ")}`)].join("\n"))].join("\n")).join("\n") || "No projects."; });
  register("list", "Which items match structured filters? Browse compact rows in page sibling order, then use context on the relevant ids.", {
    filters: z.object({ ...scope, status: statuses, priority: z.array(Priority).describe("Match the shown priority: in a migrated project a root's own, otherwise the highest among the open items depending on it; elsewhere the effective priority, including priority raised by blocked dependents.").optional(), needsOwner: z.boolean().describe("Filter by whether owner action is waiting.").optional(), hasChecks: z.boolean().describe("Filter by whether board-rule checks need attention, including WIP leaves with 2 hours of active time without changes.").optional(), updatedSince: Time.describe("Only items updated at or after this ISO time.").optional(), limit: limit(50) }).strict().describe("Structured item filters; omitted means the first 50 rows.").optional(),
  }, a => { const x = read(); return q.list(x.snapshot, x.rules, a.filters).map(it => `${formatRow(it)}${it.needsOwner ? " · owner waiting" : ""}${it.checks.length ? ` · ${it.checks.length} checks` : ""}`).join("\n") || "No items."; });
  register("notes", "What did the owner say? Find notes by state, kind, subtree or time, with project replies, before handling or replying to them.", {
    filters: z.object({ under: scope.under, state: z.array(z.enum(["draft", "sent", "done"])).describe("Include these note states; sent finds unhandled owner messages.").optional(), kind: z.array(z.enum(NOTE_KINDS)).describe("Include these kinds of owner note.").optional(), since: Time.describe("Notes sent, created or replied to at or after this ISO time.").optional(), limit: limit(50) }).strict().describe("Narrow owner notes to relevant messages.").optional(),
  }, a => q.notes(read().snapshot, a.filters).map(formatNote).join("\n") || "No notes.");
  register("glossary", "What does a word a project coined mean? Lists glossary terms with their definitions: one project's, or every project's that has terms.", {
    project: text("Exact configured project name; omit for every project.").optional(),
  }, a => q.glossary(read().snapshot, a.project).map(g => [`${g.project}:${g.terms.length ? "" : " no terms"}`, ...g.terms.map(t => `  ${t.term}: ${oneLine(t.definition)}`)].join("\n")).join("\n") || "No terms.");
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
    if (kind === "item") for (const a of after.rules.ancestors(res.id)) {
      const was = Object.hasOwn(before.snapshot.items, a) ? `${label(before.rules.statusOf(a))} ${before.rules.priorityOf(a)}` : "";
      const now = `${label(after.rules.statusOf(a))} ${after.rules.priorityOf(a)}`;
      if (was !== now) lines.push(`ancestor ${a} now ${now}${was ? ` (was ${was})` : ""}`);
    }
    return lines.join("\n");
  };
  register("create_item", "Add a leaf and list it in the parent's dependencies in one commit. Omit parent only for a new area, which requires a configured group matching your author project. In a migrated project an area requires a priority and a sub-item takes its priority from the items depending on it; elsewhere every new leaf requires one. In a migrated project, children moves existing items of your project under the new item in the same commit, so it is a parent from birth.", {
    author, key: Key.describe("New key unused by any item or decision."), parent: Key.describe("Existing parent item; omit to create an area.").optional(), title: text("Plain title naming what this delivers."), head: text("Stable task context and completion criteria.").optional(), priority: Priority.describe("P0 urgent, P1 soon, P2 can wait. In a migrated project: required for an area, a root no open item depends on, and refused with parent, since a sub-item's priority comes from the items depending on it. Elsewhere: required leaf priority.").optional(), status: Status.describe("Initial work leaf status; default todo. Omit for a record.").optional(), record: z.boolean().describe("true creates a record: head and log, no status; parent and priority follow ordinary rules.").optional(), deps: depsSchema.optional(), parent_why: text("Required with parent: explain what the parent needs this child for.").optional(), parent_own_work: z.object({ key: Key.describe("New key for the sub-item that takes over the parent's own work."), title: text("Title of that own-work sub-item.") }).strict().describe("Required when adding work to a work-status leaf (not a record parent or record child): its status moves to this new sub-item in the same commit, since a parent's status is derived. In a migrated project the sub-item takes no priority; elsewhere it takes the parent's priority too.").optional(), links: links.optional(), data: text("One line of key numbers.").optional(), group: text("Project group heading; required for an area.").optional(), order: z.number().describe("Optional sibling ordering number.").optional(),
      children: z.array(z.object({ id: Key.describe("Existing item of your project to move under the new item."), why: text("What the new item needs this child for; its dependency reason.") }).strict()).describe("Migrated projects only: existing items that become the new item's sub-items, listed in its deps; the new item takes its status from non-record children, so omit status when adopting work children. Adopting only records preserves the new work item’s initial status.").optional(), source_status: Status.describe("With children: the leaf status of each old parent left without sub-items.").optional(), source_priority: Priority.describe("With children: an old parent's new priority when it is left without sub-items and is a root.").optional(),
  }, a => { const { parent_why, parent_own_work, source_status, source_priority, ...fields } = a; return result(ops.createItem({ ...fields, parentWhy: parent_why, parentOwnWork: parent_own_work, sourceStatus: source_status, sourcePriority: source_priority })); }, true);
  register("append_log", "Append historical detail without reading a revision. Appends are retried on concurrent writes and stamped by the server. Logs never mark an item new for the owner; use set_steps to keep progress current.", { author, id, text: text("Evidence, detail or stop reason to append; nonempty.") }, a => result(ops.appendLog(a)), true);
  register("set_steps", "Keep your item's own progress current, including on records. Provide exactly one: steps replaces the ordered list, step upserts a complete step by stable id, or remove deletes that id. Existing upserts keep their position; new ids append. The server stamps dates on state transitions and preserves dates on same-state edits. No revision is required; a change is one atomic commit with concurrent writes retried; a call that leaves the steps identical changes nothing and writes no commit. Step changes are owner unread progress; item status is independent.", {
    author, id,
    steps: ItemStepsInput.describe("Full replacement ordered list; unique stable ids. Caller provides no dates. Empty list clears steps.").optional(),
    step: ItemStepInput.describe("Complete step to add or replace: id (1–40 key characters), text, state done|doing|todo|dropped, optional waits; dropped requires a reason. Caller provides no dates.").optional(),
    remove: StepId.describe("Existing stable step id to remove; supply no step or steps.").optional(),
  }, a => result(ops.setSteps(a)), true);
  register("set_targets", "Keep your item's goal numbers current, including on records. Provide exactly one: targets replaces the ordered list, target upserts a complete goal by stable id, or remove deletes that id. Existing upserts keep their position; new ids append. Each row describes a goal, its target value, current value and comparison baseline. The server stamps the measurement date when the current value changes and preserves it otherwise; callers provide no date. New values overwrite old ones, with no measurement history list. No revision is required; changes are one atomic commit with concurrent writes retried; an identical result writes no commit. Target changes are owner unread progress.", {
    author, id,
    targets: ItemTargetsInput.describe("Full replacement list; unique stable ids. Caller provides no dates. Empty list clears targets.").optional(),
    target: ItemTargetInput.describe("Complete goal to add or replace: id (1–40 key characters), goal, target, current and baseline; all text is nonempty. Caller provides no date.").optional(),
    remove: StepId.describe("Existing stable target id to remove; supply no target or targets.").optional(),
  }, a => result(ops.setTargets(a)), true);
  register("update_item", "Change an item's stable fields using the rev from context. A changed head requires reason, recorded in its log. Use set_steps for progress, set_status for status, or move_item for parent.", {
    author, id, rev: z.number().int().positive().describe("Item revision read from context; stale writes return current revision and changes."), title: text("Replacement title.").optional(), record: z.boolean().describe("true turns a work leaf of your project into a record and drops its status (refused with work sub-items); false gives it status todo (a parent derives status). Preserves head and log and appends a server-stamped log line on a real change.").optional(), parent_own_work: z.object({key: Key, title: text("Title for the parent’s own work.")}).strict().describe("Required only when record:false introduces the first work child of a normal work-status leaf parent; preserves its existing status in this new child.").optional(), head: text("Replacement stable context; requires reason when changed.").optional(), reason: text("Why head changed; appended as a server-stamped log entry.").optional(), deps: depsSchema.optional(), links: links.optional(), priority: Priority.describe("Replacement priority. In a migrated project only for a root, an item no open item depends on; refused on any other item, whose priority comes from the items depending on it. Elsewhere: replacement leaf priority.").optional(), data: clearableText("Replacement key numbers; null clears."), order: z.number().describe("Replacement sibling order.").optional(),
  }, a => { const {parent_own_work, ...fields} = a; return result(ops.updateItem({...fields, parentOwnWork: parent_own_work})); }, true);
  register("set_status", "Change a leaf's status with a reason log in one commit. Records refuse status; parent status is derived from non-record children; blocked needs an open dependency or an owner ask.", { author, id, status: Status.describe("New leaf status."), log: text("Why this status is now correct, including evidence or blocker.") }, a => result(ops.setStatus(a)), true);
  register("move_item", "Move an item under another parent without a cycle; atomically removes the old parent's dependency and adds the new parent's, and logs the move. In a migrated project, omit new_parent to make the item a root area of its project, with a priority, when no other open item depends on it.", { author, id, new_parent: Key.describe("Existing new parent, other than this item or a descendant; omit only to make a migrated item a root.").optional(), parent_why: text("What the new parent needs this item for; required with new_parent.").optional(), parent_own_work: z.object({ key: Key, title: text("Title for the destination leaf’s own work.") }).strict().describe("Required when moving work into a work-status leaf (not a record parent or record child); receives its status in the same commit, and its priority too unless the project is migrated. In a migrated project omit it when the destination leaf has no work of its own (todo, no steps or targets, no log entry beyond its creation entry).").optional(), priority: Priority.describe("Required without new_parent: the new root's priority; refused with new_parent.").optional(), source_status: Status.describe("Required when a work source loses its last non-record child: its new leaf status. Records take no source status.").optional(), source_priority: Priority.describe("When the source loses its last child: in a migrated project, optionally its new priority if it is a root, refused when open items depend on it; elsewhere required, its new leaf priority.").optional() }, a => result(ops.moveItem({ author: a.author, id: a.id, parent: a.new_parent, parentWhy: a.parent_why, parentOwnWork: a.parent_own_work, sourceStatus: a.source_status, sourcePriority: a.source_priority, priority: a.priority })), true);
  register("clear_ask", "Remove a legacy ask after the project has replaced it with a decision card or settled it; log the outcome in the same commit.", { author, id, log: text("Which decision card replaced the legacy ask or what settled it, and why it can be removed.") }, a => result(ops.clearAsk(a)), true);
  register("write_card", "Create a decision card, or revise an open card using its rev from context. State the evidence and options; recommend at most one.", {
    author, key: Key.describe("Unused new decision key, or an existing open card key with rev."), rev: z.number().int().positive().describe("Required to revise an open card; omit only for creation.").optional(), item: Key.describe("Existing item this decision belongs to."), question: text("The choice the owner needs to settle."), background: text("Problem, evidence and context the choice turns on."), options: z.array(Option).describe("Options with unique key, text (action, costs and risks), and optional recommended boolean."), confidence: z.object({ score: z.number().int().min(1).max(5).describe("Confidence from 1 (judgment) to 5 (settled by evidence).").optional(), reason: text("Evidence for confidence and what could overturn it.") }).strict().describe("Confidence and its grounds.").optional(),
    blocks: clearableText("One sentence naming the work that cannot proceed until the owner rules. Set it only when named work is stopped by this card; leave it out when sessions proceed on the recommendation. A card with blocks is blocking: the page shows it purple and the coordinator is woken. When revising, text sets it, null clears it, omitted keeps it."),
  }, a => result(ops.writeCard(a)), true);
  register("post_notice", "Tell the owner an important change that is not blocking, on the page's 要你知道 list: one or two sentences, inline markdown and [[it:key]] item references allowed. Use it only for a change the owner should know; a matter that blocks work goes on a decision card with blocks instead, and routine progress stays current with set_steps. Any project may post.", { author, text: text("One or two sentences saying what changed and what it means for the owner."), item: Key.describe("Optional related item key.").optional() }, a => result(ops.postNotice(a)), true);
  register("rule_card", "Record the owner's ruling on an open decision card. A choice must name one of its option keys; a prose ruling may omit choice.", { author, key: Key.describe("Existing open decision card key."), choice: text("Chosen option key, if the owner selected an option.").optional(), ruling: text("Owner's ruling and its reasons.") }, a => result(ops.ruleCard(a)), true);
  register("reply_note", "Answer an owner's note and mark it done. The server stamps repliedAt and records your project as repliedBy.", { author, id: text("Existing owner note id found with notes or context."), reply: text("Answer to the owner's note."), replace: z.boolean().describe("Explicitly replace an existing reply; otherwise an already answered note is refused.").optional() }, a => result(ops.replyNote(a)), true);
  register("create_project", "Configure a new project with its optional repository; accepts any author string when appending last. Only 总管 may supply after to place it immediately after an existing project in page order. Creation and placement are one commit.", { author, name: text("New unique project name, used by area group fields."), repo: text("Optional repository identifier, e.g. Ming-Research/Halo-wf.").optional(), after: text("Existing project name this new project should immediately follow; only 总管. Omit to append last.").optional() }, a => result(ops.createProject(a)), true);
  register("update_project", "Set or change your project's repository; the coordinator project 总管 may change any project's repository. Only 总管 may supply after to reorder a project immediately after an existing project in page order, or migrate it to dependency-derived priority (migrated: true, which cannot be undone). Repo, order and migration changes share one commit; migration drops each non-root item's stored priority and logs it there.", { author, name: text("Existing configured project name."), repo: text("Repository identifier, e.g. Ming-Research/Halo-wf.").optional(), after: text("Existing project name this project should immediately follow; only 总管; cannot be itself. Omit to preserve order; may be used without repo or migrated.").optional(), migrated: z.boolean().describe("true migrates the project; only 总管, only once, never back to false.").optional() }, a => result(ops.updateProject(a)), true);
  register("create_request", "File work into any project's inbox; optionally add a dependency from your own item in the same commit, which in a migrated receiving project then gives the request its priority.", { author, project: text("Receiving configured project name."), key: Key.describe("Unused request item key."), title: text("What the request delivers."), head: text("Context, witness and acceptance test."), priority: Priority.describe("P0 urgent, P1 soon, P2 later. When the receiving project is migrated: required without from, when the request is a root, and refused with from, since the request's priority comes from the filing item. Elsewhere: required.").optional(), why: text("Why the work is needed; also the filing item's dependency reason."), from: Key.describe("Optional filing item in your own project.").optional() }, a => result(ops.createRequest(a)), true);
  register("triage_request", "Accept your project's inbox request under a parent or as its own area; clear its inbox marker and log the disposition.", { author, id, parent: Key.describe("Parent in the same project; omit to make an area.").optional(), parent_why: text("What the parent needs the request for; required with parent.").optional(), parent_own_work: z.object({key:Key,title:z.string().min(1)}).strict().describe("Required for a work-status leaf parent (not a record): child key and title receiving its own work.").optional(), priority: Priority.describe("Optional triaged priority; in a migrated project only when the request stays a root (no parent and no open item depending on it), refused otherwise.").optional(), log: text("Triage outcome and reasons.") }, a => { const {parent_why,parent_own_work,...fields}=a; return result(ops.triageRequest({...fields,parentWhy:parent_why,parentOwnWork:parent_own_work})); }, true);
  register("close_note", "Close a sent owner note without reply text and record what handled it in its item's log, in one commit.", { author, id: text("Owner note id on your project's item or card."), log: text("What handled this note; appended to the item's historical log.") }, a => result(ops.closeNote(a)), true);
  // A glossary write answers with its commit; there is no item row to show.
  const glossaryResult = async (operation: Promise<import("./ops.ts").Result>) => { const res = await operation; return `${res.summary} · commit ${res.commit}`; };
  register("set_term", "Add or replace a term in your own project's glossary. The board page links the first occurrence of each term in an item, card or note to its definition. Add a term only for a word your project coined and uses repeatedly; industry-standard terms (CoreMark, PUC Lua, WPT, dispatch) are not added. A term is no substitute for describing the phenomenon in plain words where you write about it.", {
    author, term: text("The coined word exactly as board text writes it, on one line; occurrences are matched as plain substrings."), definition: text("What the word means, in plain Chinese that a reader outside the project understands."),
  }, a => glossaryResult(ops.setTerm(a)), true);
  register("delete_term", "Remove a term from your own project's glossary, such as a word no longer used or an industry-standard term added by mistake.", { author, term: text("Existing term in your project's glossary.") }, a => glossaryResult(ops.deleteTerm(a)), true);
  return server;
}
