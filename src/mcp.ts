import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Key, Time, Status, Priority, Dep, Link, Option, NOTE_KINDS } from "./model.ts";
import type { Decision, Note, Snapshot } from "./model.ts";
import type { Store } from "./store.ts";
import type { Ops } from "./ops.ts";
import { rules } from "./rules.ts";
import * as q from "./query.ts";

export const STATUS: Record<string, string> = { wip: "WIP", done: "DONE", todo: "TODO", blocked: "BLOCK", cancelled: "DROP" };
const label = (s: string) => STATUS[s] ?? s.toUpperCase();
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
export function formatRow(it: Pick<q.Row, "id" | "status" | "title"> & Partial<q.Row>): string {
  return `${it.id} · ${label(it.status)}${it.priority ? ` ${it.priority}` : ""} · ${oneLine(it.title)}${it.group || it.areaId ? ` · ${[it.group, it.areaId].filter(Boolean).join(" › ")}` : ""}`;
}
function formatNote(n: Note & { id: string; title?: string }): string {
  return `${n.id} · ${n.state.toUpperCase()} ${n.kind} · ${n.target} · ${n.sentAt ?? n.at}: ${n.text}${n.choice ? ` (choice ${n.choice})` : ""}${n.reply ? `\n  reply ${n.repliedAt ?? ""} ${n.repliedBy ?? ""}: ${n.reply}` : ""}`;
}
function formatCard(key: string, card: Partial<Decision> & Pick<Decision, "question" | "status">): string {
  const lines = [`${key} · ${label(card.status)} · ${card.question}${card.rev ? ` · rev ${card.rev}` : ""}`];
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
  if (result.children.length) lines.push(`status and priority derived from ${result.children.length} sub-item${result.children.length > 1 ? "s" : ""}: ${result.children.map(c => `${c.id} ${label(c.status)}`).join(", ")}`);
  if (result.agent) lines.push(`agent: ${result.agent}${it.agent ? "" : " (inherited from an ancestor)"}`);
  if (it.short) lines.push(`short: ${it.short}`);
  if (it.order !== undefined) lines.push(`order: ${it.order}`);
  if (it.priority && it.priority !== result.priority) lines.push(`priority: ${it.priority} · effective ${result.priority}${result.raisedBy ? ` · raised by ${result.raisedBy}` : ""}`);
  if (it.head !== undefined) lines.push(`head: ${it.head}`);
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

const author = z.string().describe("Your session's name as the session list prints it; used as the commit and log author.");
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

export function createMcpServer({ store, ops, now: _now }: { store: Store; ops: Ops; now?: () => string }): McpServer {
  const server = new McpServer({ name: "wf-board", version: "0.1.0" }, { instructions: "Find the item with search and read context before writing. Use append_log for progress; use set_status with a log line explaining the change. Every dependency carries a why explaining what it is needed for. Use your session-list name as author; the server stamps times. update_item and revisions of write_card need the rev read from context; redo on a stale revision. Parent status is derived from children. Qualify PR references as Repo#N." });
  // Owner reading state may change without HEAD moving, so cache by the actual
  // snapshot content as well as its commit. This never reuses stale Rules.
  let cachedHead: string | undefined, cachedOwner = "", cachedRules: ReturnType<typeof rules>;
  function read() {
    const snapshot = store.snapshot(), owner = JSON.stringify(snapshot.owner);
    if (cachedHead !== snapshot.head || cachedOwner !== owner) { cachedHead = snapshot.head; cachedOwner = owner; cachedRules = rules(snapshot); }
    return { snapshot, rules: cachedRules };
  }
  function register<S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.output<z.ZodObject<S>>) => string | Promise<string>, write = false) {
    const schema: z.ZodObject = z.object(shape).strict();
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: !write, destructiveHint: write } }, async a => {
      try { return { content: [{ type: "text" as const, text: await fn(z.object(shape).strict().parse(a)) }] }; }
      catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }
    });
  }
  register("search", "Where is this text mentioned? Search Chinese or other substrings across titles, heads, logs, decisions and owner notes. Read context for a hit before editing it.", {
    query: text("Case-insensitive substring to find, including Chinese text."), filters: z.object({ ...scope, status: statuses, kind: z.array(z.enum(["item", "card", "note"])).describe("Search only these document kinds.").optional(), since: Time.describe("Only fields with timestamps at or after this ISO time; logs and notes use their own times.").optional(), limit: limit(20) }).strict().describe("Narrow the matches to relevant board context.").optional(),
  }, a => { const x = read(); return formatSearch(q.search(x.snapshot, x.rules, a.query, a.filters)); });
  register("context", "What is this item or decision, what does it wait on, and what happened recently? Returns its context with the latest five log entries; request all only when needed.", {
    id, log: z.union([z.number().int().min(0), z.literal("all")]).describe("Recent item log entries to include; default 5, 0 omits them, all returns the full log.").optional(),
  }, a => { const x = read(); return formatContext(q.context(x.snapshot, x.rules, a.id, { log: a.log })); });
  register("graph", "What does this wait on, and what waits on it? Follow dependencies with their whys, marking open blocked chains and cycles; parent dependencies are included.", {
    id, direction: z.enum(["up", "down", "both"]).describe("up follows blockers; down follows dependents; both shows each separately."), depth: z.number().int().min(0).max(20).describe("Maximum dependency edges from the root; default 3.").optional(),
  }, a => { const x = read(); return formatGraph(q.graph(x.snapshot, x.rules, a.id, a)); });
  register("overview", "Which areas need attention? Shows leaf status counts, owner actions, blocked leaves and checks, optionally in one project group.", {
    group: scope.group,
  }, a => { const x = read(); return q.overview(x.snapshot, x.rules, a).map(area => [formatRow(area) + ` · agent ${area.agent}`, Object.entries(area.counts).map(([st, n]) => `${label(st)} ${n}`).join(" · "), ...area.ownerActions.map(it => `  owner: ${formatRow(it)}`), ...area.blocked.map(it => `  blocked: ${formatRow(it)}`), ...area.checks.map(it => `  check: ${formatRow(it)} · ${it.checks.map(c => c.text).join("; ")}`)].join("\n")).join("\n") || "No areas."; });
  register("list", "Which items match structured filters? Browse compact rows in page sibling order, then use context on the relevant ids.", {
    filters: z.object({ ...scope, status: statuses, priority: z.array(Priority).describe("Match effective priority, including priority raised by blocked dependents.").optional(), agent: text("Exact responsible session name, inherited from ancestors.").optional(), needsOwner: z.boolean().describe("Filter by whether owner action is waiting.").optional(), hasChecks: z.boolean().describe("Filter by whether board-rule checks need attention.").optional(), updatedSince: Time.describe("Only items updated at or after this ISO time.").optional(), limit: limit(50) }).strict().describe("Structured item filters; omitted means the first 50 rows.").optional(),
  }, a => { const x = read(); return q.list(x.snapshot, x.rules, a.filters).map(it => `${formatRow(it)}${it.needsOwner ? " · owner waiting" : ""}${it.checks.length ? ` · ${it.checks.length} checks` : ""}`).join("\n") || "No items."; });
  register("notes", "What did the owner say? Find notes by state, kind, subtree or time, with session replies, before handling or replying to them.", {
    filters: z.object({ under: scope.under, state: z.array(z.enum(["draft", "sent", "done"])).describe("Include these note states; sent finds unhandled owner messages.").optional(), kind: z.array(z.enum(NOTE_KINDS)).describe("Include these kinds of owner note.").optional(), since: Time.describe("Notes sent, created or replied to at or after this ISO time.").optional(), limit: limit(50) }).strict().describe("Narrow owner notes to relevant messages.").optional(),
  }, a => q.notes(read().snapshot, a.filters).map(formatNote).join("\n") || "No notes.");
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
    const after = read(), lines = [`${res.summary} · rev ${res.rev} · commit ${res.commit}`];
    const kind = Object.hasOwn(after.snapshot.items, res.id) ? "item" : Object.hasOwn(after.snapshot.decisions, res.id) ? "card" : "note";
    if (kind !== "note") lines.push(formatRow(q.row(after.snapshot, after.rules, kind, res.id)));
    if (kind === "item") for (const a of after.rules.ancestors(res.id)) {
      const was = Object.hasOwn(before.snapshot.items, a) ? `${label(before.rules.statusOf(a))} ${before.rules.effectivePriorityOf(a)}` : "";
      const now = `${label(after.rules.statusOf(a))} ${after.rules.effectivePriorityOf(a)}`;
      if (was !== now) lines.push(`ancestor ${a} now ${now}${was ? ` (was ${was})` : ""}`);
    }
    return lines.join("\n");
  };
  register("create_item", "Add a leaf and list it in the parent's dependencies in one commit. Omit parent only for a new area, which requires agent and group.", {
    author, key: Key.describe("New key unused by any item or decision."), parent: Key.describe("Existing parent item; omit to create an area.").optional(), title: text("Plain title naming what this delivers."), head: text("Stable task context and completion criteria.").optional(), priority: Priority.describe("Required leaf priority: P0 urgent, P1 soon, P2 can wait."), status: Status.describe("Initial leaf status; default todo.").optional(), deps: depsSchema.optional(), parent_why: text("Required with parent: explain what the parent needs this child for.").optional(), parent_own_work: z.object({ key: Key.describe("New key for the sub-item that takes over the parent's own work."), title: text("Title of that own-work sub-item.") }).strict().describe("Required when the parent is still a leaf: its status and priority move to this new sub-item in the same commit, since a parent's status is derived.").optional(), links: links.optional(), data: text("One line of key numbers.").optional(), agent: text("Responsible session; required for an area, optional handover on a child.").optional(), group: text("Project group heading; required for an area.").optional(), short: text("Optional short display title.").optional(), order: z.number().describe("Optional sibling ordering number.").optional(),
  }, a => { const { parent_why, parent_own_work, ...fields } = a; return result(ops.createItem({ ...fields, parentWhy: parent_why, parentOwnWork: parent_own_work })); }, true);
  register("append_log", "Record progress without reading a revision. Appends are retried on concurrent writes and stamped by the server; use for each meaningful result.", { author, id, text: text("Progress, evidence or stop reason to append; nonempty.") }, a => result(ops.appendLog(a)), true);
  register("update_item", "Change an item's stable fields using the rev from context. A changed head requires reason, recorded in its log. Use set_status or move_item for status or parent.", {
    author, id, rev: z.number().int().positive().describe("Item revision read from context; stale writes return current revision and changes."), title: text("Replacement title.").optional(), head: text("Replacement stable context; requires reason when changed.").optional(), reason: text("Why head changed; appended as a server-stamped log entry.").optional(), deps: depsSchema.optional(), links: links.optional(), priority: Priority.describe("Replacement leaf priority.").optional(), data: clearableText("Replacement key numbers; null clears."), order: z.number().describe("Replacement sibling order.").optional(), agent: clearableText("Replacement responsible session; null clears the handover field."), short: clearableText("Replacement short display title; null clears."),
  }, a => result(ops.updateItem(a)), true);
  register("set_status", "Change a leaf's status with a progress/reason log in one commit. Parent status is derived; blocked needs an open dependency or an owner ask.", { author, id, status: Status.describe("New leaf status."), log: text("Why this status is now correct, including evidence or blocker.") }, a => result(ops.setStatus(a)), true);
  register("move_item", "Move an item under another parent without a cycle; atomically removes the old parent's dependency and adds the new parent's, and logs the move.", { author, id, new_parent: Key.describe("Existing new parent, other than this item or a descendant."), parent_why: text("What the new parent needs this item for."), parent_own_work: z.object({ key: Key, title: text("Title for the destination leaf’s own work.") }).strict().describe("Required when the destination is a leaf; receives its status and priority in the same commit.").optional(), source_status: Status.describe("Required when the source loses its last child: its new leaf status.").optional(), source_priority: Priority.describe("Required when the source loses its last child: its new leaf priority.").optional() }, a => result(ops.moveItem({ author: a.author, id: a.id, parent: a.new_parent, parentWhy: a.parent_why, parentOwnWork: a.parent_own_work, sourceStatus: a.source_status, sourcePriority: a.source_priority })), true);
  register("set_ask", "Record a yes/no owner action on an item. Use write_card for a real choice between options.", { author, id, text: text("Owner action and your recommendation in one line."), url: z.url().describe("Where the owner acts, such as a PR merge page.").optional(), chat: z.boolean().describe("True when only the owner's word in chat counts.").optional() }, a => result(ops.setAsk(a)), true);
  register("clear_ask", "Remove an item's owner action once settled and log the outcome in the same commit.", { author, id, log: text("What settled the ask and why it can be removed.") }, a => result(ops.clearAsk(a)), true);
  register("write_card", "Create a decision card, or revise an open card using its rev from context. State the evidence and options; recommend at most one.", {
    author, key: Key.describe("Unused new decision key, or an existing open card key with rev."), rev: z.number().int().positive().describe("Required to revise an open card; omit only for creation.").optional(), item: Key.describe("Existing item this decision belongs to."), question: text("The choice the owner needs to settle."), background: text("Problem, evidence and context the choice turns on."), options: z.array(Option).describe("Options with unique key, text (action, costs and risks), and optional recommended boolean."), confidence: z.object({ score: z.number().int().min(1).max(5).describe("Confidence from 1 (judgment) to 5 (settled by evidence).").optional(), reason: text("Evidence for confidence and what could overturn it.") }).strict().describe("Confidence and its grounds.").optional(),
  }, a => result(ops.writeCard(a)), true);
  register("rule_card", "Record the owner's ruling on an open decision card. A choice must name one of its option keys; a prose ruling may omit choice.", { author, key: Key.describe("Existing open decision card key."), choice: text("Chosen option key, if the owner selected an option.").optional(), ruling: text("Owner's ruling and its reasons.") }, a => result(ops.ruleCard(a)), true);
  register("reply_note", "Answer an owner's note and mark it done. The server stamps repliedAt and records your session as repliedBy.", { author, id: text("Existing owner note id found with notes or context."), reply: text("Answer to the owner's note."), replace: z.boolean().describe("Explicitly replace an existing reply; otherwise an already answered note is refused.").optional() }, a => result(ops.replyNote(a)), true);
  return server;
}
