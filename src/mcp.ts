import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Key, Time, Status, Link, NOTE_KINDS, CARD_KINDS, CARD_KIND_WHAT, CARD_KIND_HOW, cardKind, MESSAGE_TEXT_LIMIT, PlanRowInput, PlanInput, StepId, ItemTargetInput, ItemTargetsInput, TagName, Difficulty, difficultyText, ARCHITECT_WRITER, PROCESS_WRITERS, DISPATCH_ROLES, DISPATCH_RESULTS, DISPATCH_SIGNALS, DispatchUsage, RUNNER_STATES, RUNNER_ASKS, RUNNER_NOTE_MAX, RUNNER_SESSION } from "./model.ts";
import type { Decision, Note, Snapshot } from "./model.ts";
import type { Store } from "./store.ts";
import type { Ops } from "./ops.ts";
import * as q from "./query.ts";
import { dispatchRows, dispatchReport, normalizeTime } from "./dispatch.ts";
import { candidates, candidatesText, candidatesUnder, candidatesUnderText } from "./candidates.ts";
import { BUCKETS, BUCKET_TEXT, wholeView, wholeViewText } from "./whole-view.ts";
import { DEFAULT_ROWS, LookMemory, MAX_ROWS, MIN_ROWS, look, lookText } from "./look.ts";
import { LONGEST_DEFAULT, LONGEST_MAX, RECENT_MAX, RECENT_MS, SEGMENT_TEXT, SEGMENT_KINDS, TIMELINE_AGENTS, TIMELINE_CHARS, agentsText, linesOfItem, listedAgents, longestWaits, timelineText } from "./timeline.ts";
import type { DispatchFilters } from "./dispatch.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import type { Wake } from "./wake.ts";
import type { Resolved } from "./credentials.ts";
import { summarize, toolClass } from "./slow-ops.ts";
import type { SlowOps } from "./slow-ops.ts";
import { WriteTrace, withTrace } from "./write-trace.ts";
import { Budget, REQUEST_LIMITS, withBudget } from "./budget.ts";
import type { BudgetLimits } from "./budget.ts";
import { PREAMBLE, selectSections, splitHead, summarizeHead } from "./head-sections.ts";
import { isRecord, jsonSchemaOf, readNames, refusal } from "./tool-errors.ts";
import { checkLabel } from "./rules.ts";
import { LIVE_ACTION_MAX, LIVE_ROLES } from "./live.ts";

export const STATUS: Record<string, string> = { wip: "WIP", done: "DONE", todo: "TODO", idle: "IDLE", blocked: "BLOCK", paused: "PAUSE", cancelled: "DROP" };
const label = (s: string | undefined) => s === undefined ? "记录" : STATUS[s] ?? s.toUpperCase();
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
export function formatRow(it: Pick<q.Row, "id" | "status" | "title"> & Partial<q.Row>): string {
  return `${it.id} · ${label(it.status)}${it.standing ? " · 常设" : ""} · ${oneLine(it.title)}${it.tags?.length ? ` · [${it.tags.join(" ")}]` : ""}${it.difficulty === undefined ? "" : ` · ${difficultyText(it.difficulty)}`}${it.group || it.areaId ? ` · ${[it.group, it.areaId].filter(Boolean).join(" › ")}` : ""}${it.num === undefined ? "" : ` · #${it.num}`}`;
}
const { cut } = q;
/** What the default answer of `context` cuts to (docs/design.md, section 6, Lean replies). */
const LOG_CUT = 240, NOTE_CUT = 160, REASON_CUT = 160, PR_REFS = 5;
/** `limit` cuts the text and the reply and leaves out the original action: a note that is handled, in a list that is not about it. */
function formatNote(n: Note & { id: string; title?: string; follows?: q.Follows }, limit?: number): string {
  const part = (text: string) => limit === undefined ? text : cut(text, limit);
  // The note it follows is shown already cut (q.notes), whatever the limit: the note itself is read with its id.
  const follows = n.follows ? `\n  follows note ${n.follows.id}: ${n.follows.text}${n.follows.reply === undefined ? "" : `\n  its reply: ${n.follows.reply}`}` : "";
  return `${n.id} · ${n.state.toUpperCase()} ${n.kind} · ${n.target} · ${n.sentAt ?? n.at}: ${part(n.text)}${n.choice ? ` (choice ${n.choice})` : ""}${n.answerText !== undefined && limit === undefined ? `\n  original action: ${n.answerText}` : ""}${follows}${n.reply ? `\n  reply ${n.repliedAt ?? ""} ${n.repliedBy ?? ""}: ${part(n.reply)}` : ""}`;
}
function formatCard(key: string, card: Partial<Decision> & Pick<Decision, "question" | "status"> & { choiceText?: string }, lean = false): string {
  const lines = [`${key} · ${label(card.status)} · ${card.question}${card.rev ? ` · rev ${card.rev}` : ""}${card.num === undefined ? "" : ` · #${card.num}`}`];
  lines.push(`kind: ${cardKind(card)}`);
  if (card.blocks) lines.push(`blocks: ${card.blocks}`);
  if (lean && card.status === "open") {
    // An open card in a list: the question, the option names and the recommendation; the grounds are read from the card itself.
    for (const o of card.options ?? []) lines.push(`  ${o.key}${o.recommended ? " (recommended)" : ""}: ${q.optionName(o) ?? ""}`);
    const left = [...(card.options ?? []).some(o => o.detail) ? ["grounds"] : [], ...card.legacy?.background !== undefined ? ["legacy background"] : []];
    if (left.length) lines.push(`  (${left.join(" and ")} left out; context ${key} has them)`);
    if (card.confidence) lines.push(`confidence ${card.confidence.score === undefined ? "" : card.confidence.score + "/5："}${cut(card.confidence.reason, REASON_CUT)}`);
    return lines.join("\n");
  }
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
/**
 * What a `context` answer leaves out. With no view it is whole. `lean`: each head section's first paragraph, open cards without
 * their options' grounds, handled notes cut to a line; `cutLog`: log entries cut; `section`: only the head, or the one section
 * of it (docs/design.md, section 6, Lean replies).
 */
export interface ContextView { lean?: boolean; cutLog?: boolean; section?: string }
export function formatContext(result: ReturnType<typeof q.context>, view: ContextView = {}): string {
  const noteLine = (n: Parameters<typeof formatNote>[0]) => formatNote(n, view.lean && n.state === "done" ? NOTE_CUT : undefined);
  if (result.kind === "card") {
    if (view.section !== undefined) throw new Error(`section ${view.section}: only an item has sections; a card is read whole`);
    // A card read on its own is the detail view: its notes are whole.
    return [formatCard(result.id, result.card!), `item: ${formatRow(result.item as q.Row)}`, ...result.notes.map(n => formatNote(n))].join("\n");
  }
  if (!("ancestors" in result)) throw new Error("Invalid item context");
  const it = result.item as Snapshot["items"][string];
  const lines = [formatRow(result as q.Row), `rev ${it.rev} · updated ${it.updated}${it.created ? ` · created ${it.created}` : ""}`];
  if (view.section !== undefined) {
    const head = it.head ?? "";
    if (view.section === "all") return [...lines, `head: ${head}`].join("\n");
    const chosen = selectSections(head, view.section);
    if (!chosen) throw new Error(`section ${view.section}: this head has ${splitHead(head).map(s => `"${s.title || PREAMBLE}"`).join(", ") || "no text"}; "all" is the whole head`);
    return [...lines, ...chosen.map(s => `section: ${s.text.trimEnd()}`)].join("\n");
  }
  lines.push("status derived from plan and owner pause");
  if (result.lastPush) lines.push(`last push: ${q.pushLine(result.lastPush)}`);
  const pausedBy = result.pausedBy;
  if (pausedBy) lines.push(`pause: ${pausedBy.title} · ${pausedBy.reason} · ${pausedBy.at}`);
  if (it.order !== undefined) lines.push(`order: ${it.order}`);
  if (it.head !== undefined) {
    const summary = view.lean ? summarizeHead(it.head) : undefined;
    if (summary?.omitted) lines.push(`head (cut: ${summary.omitted} characters left out; sections: ${summary.titles.join(" · ")}; section: "<title>" or "all" gets them whole):`, summary.text);
    else lines.push(`head: ${it.head}`);
  }
  if (result.plan.length) lines.push("plan:", ...result.plan.map(line => `  ${line}`));
  if (view.lean && result.plan.some(line => /^[✓✗] \d+ 项/.test(line))) lines.push("  (finished rows are folded into a count; full: true lists them)");
  for (const warning of result.planWarnings) lines.push(`plan warning: ${warning}`);
  if (result.targets.length) lines.push("targets:", ...result.targets.map(line => `  ${line}`));
  if (it.data) lines.push(`data: ${it.data}`);
  if (it.ask) lines.push(`ask: ${it.ask.text}${it.ask.url ? ` · ${it.ask.url}` : ""}${it.ask.chat ? " · askChat" : ""}`);
  for (const name of ["ancestors", "dependents"] as const) {
    const rows = result[name];
    if (rows.length) lines.push(`${name}:`, ...rows.map(v => `  ${formatRow(v)}${"own" in v && v.own ? " · 拥有" : ""}`));
  }
  for (const card of result.cards) lines.push(formatCard(card.key, card, view.lean));
  for (const note of result.notes) lines.push(noteLine(note));
  if (view.lean && result.notes.some(n => noteLine(n) !== formatNote(n))) lines.push(`  (handled notes are cut to ${NOTE_CUT} characters; full: true or the notes tool has them whole)`);
  for (const check of result.checks) lines.push(`check: ${check.text}${check.target ? ` ${check.target.kind}:${check.target.id}` : ""}`);
  for (const link of result.links) lines.push(`link: ${link.label} · ${link.url}`);
  const refs = [...result.prs.qualified.map(p => `${p.repo}#${p.number}`), ...result.prs.unknown.map(n => `#${n} (repository unknown)`)];
  if (refs.length) lines.push(`PRs: ${(view.lean ? refs.slice(0, PR_REFS) : refs).join(", ")}${view.lean && refs.length > PR_REFS ? `, … ${refs.length - PR_REFS} more (prs tool)` : ""}`);
  lines.push(`log (${it.log.length} shown; ${result.earlierLogs} earlier):`, ...it.log.map(l => `  ${l.at} ${l.by ?? ""}: ${view.cutLog ? cut(l.text, LOG_CUT) : l.text}`));
  if (view.cutLog && it.log.some(l => [...l.text].length > LOG_CUT)) lines.push(`  (entries over ${LOG_CUT} characters are cut; log: N gets the last N whole)`);
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
    out.push(`${g.areaId} · ${g.area}`, ...docs.map(d => `  ${d.kind}:${d.id} · ${oneLine(d.title)} · ${d.summary}\n${d.commits.map(c => `    ${c.commit.slice(0, 12)} ${c.at} ${c.session ?? c.author}: ${oneLine(c.message)}`).join("\n")}`));
  }
  if (total > shown) out.push(`… ${total - shown} more changed documents; narrow with since, filters.group or filters.under, or raise limit.`);
  return out.join("\n");
}
/** The patrol read, as `changes` answers it by default: the rows to handle (new flags, new items, notes and cards others wrote),
 * each at most `limit` rows with the rest counted, then the other changes as counts; with `detail` the documents behind those
 * counts follow. Every thing appears once (docs/design.md, section 6, Finding things). */
export function formatReport(report: q.ChangesReport, o: { limit?: number; detail?: boolean } = {}): string {
  const limit = o.limit ?? 30, { total, dropped } = report.commits;
  const since = /^[0-9a-f]{40}$/.test(report.since) ? report.since.slice(0, 12) : report.since;
  const { items, cards, notes, bySession } = report.others, rows = report.flags.length + report.created.length + report.replies.length;
  if (!total && !rows && !items && !cards && !notes) return `自 ${since} 起没有改动。`;
  const out = [`自 ${since} 起 ${total} 个提交${report.except.length ? `，去掉 ${report.except.join("、")} 的 ${dropped} 个` : ""}${report.unreadable ? `；${report.unreadable} 个旧版本读不出，按没有算` : ""}${rows ? "" : "，没有要处理的行"}`];
  const group = <T>(title: string, list: readonly T[], line: (x: T) => string) => {
    if (!list.length) return;
    out.push(title, ...list.slice(0, limit).map(line));
    if (list.length > limit) out.push(`  … 还有 ${list.length - limit} 行；缩小 filters.group 或 filters.under，或加大 limit。`);
  };
  const flagCount = Object.values(report.flagCounts).reduce((n, c) => n + c, 0);
  group(`新标记 ${flagCount} 条（${Object.entries(report.flagCounts).map(([kind, n]) => `${kind} ×${n}`).join("，")}）`, report.flags,
    x => `  ${x.item} · ${x.project} · ${x.flags.join("、")} · 改的人：${x.by.length ? x.by.join("、") : "范围内没人改它"}`);
  group(`新建条目 ${report.created.length} 个`, report.created,
    x => `  ${x.id} · ${x.project} · ${oneLine(x.title)} · 建的人：${x.by}${x.flags.length ? ` · 标记：${x.flags.join("、")}` : ""}`);
  group(`留言和卡 ${report.replies.length} 个`, report.replies,
    x => `  ${x.kind === "note" ? "留言" : "卡"} ${x.id} · ${x.item} · ${x.summary} · ${x.by.join("、")}`);
  const kinds = [["条目", items], ["卡", cards], ["留言", notes]].filter(([, n]) => n).map(([name, n]) => `${name} ${n} 个`);
  if (kinds.length) {
    const sessions = Object.entries(bySession).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => `${name} ${n}`).join("，");
    out.push(`其它改动：${kinds.join("、")}（${sessions}）${o.detail ? "：" : "。逐个看加 detail。"}`);
    if (o.detail) out.push(formatChanges(report.others.groups, limit));
  }
  return out.join("\n");
}
/** The most owner and check rows listed under one area in the default overview. */
const OVERVIEW_ROWS = 5;
/**
 * The board at a glance. By default one line of counts for each project and, under it, only the areas with something to handle
 * (the owner waiting, a check flagged), each with at most OVERVIEW_ROWS rows of each, a row being the item's key, status and
 * title and, for a check, the check's short label; the blocked items are counted, not listed. `detail` lists every area with
 * all its rows (docs/design.md, section 6, Lean replies).
 */
export function formatOverview(projects: ReturnType<typeof q.overview>, detail = false): string {
  if (detail) return projects.map(project => [`${project.project}`, ...project.areas.map(area => [formatRow(area), Object.entries(area.counts).map(([st, n]) => `${label(st)} ${n}`).join(" · "), ...area.ownerActions.map(it => `  owner: ${formatRow(it)}`), ...area.blocked.map(it => `  blocked: ${formatRow(it)}`), ...area.checks.map(it => `  check: ${formatRow(it)} · ${it.checks.map(c => c.text).join("; ")}`)].join("\n"))].join("\n")).join("\n") || "No projects.";
  const counts = (by: Record<string, number>) => Object.entries(by).filter(([, n]) => n).map(([st, n]) => `${label(st)} ${n}`);
  const handle = (area: { ownerActions: unknown[]; blocked: unknown[]; checks: unknown[] }) => [`owner waiting ${area.ownerActions.length}`, `blocked ${area.blocked.length}`, `checks ${area.checks.length}`];
  const short = (it: Pick<q.Row, "id" | "status" | "title">) => `${it.id} · ${label(it.status)} · ${cut(oneLine(it.title), 36)}`;
  const out: string[] = [];
  for (const project of projects) {
    const total: Record<string, number> = {};
    for (const area of project.areas) for (const [st, n] of Object.entries(area.counts)) total[st] = (total[st] ?? 0) + n;
    const sum = (key: "ownerActions" | "blocked" | "checks") => project.areas.reduce((n, area) => n + area[key].length, 0);
    out.push([project.project, `${project.areas.length} areas`, ...counts(total), `owner waiting ${sum("ownerActions")}`, `blocked ${sum("blocked")}`, `checks ${sum("checks")}`].join(" · "));
    const needing = project.areas.filter(area => area.ownerActions.length || area.checks.length);
    for (const area of needing) {
      out.push(`  ${formatRow(area)}`, `    ${[...counts(area.counts), ...handle(area)].join(" · ")}`);
      out.push(...area.ownerActions.slice(0, OVERVIEW_ROWS).map(it => `    owner: ${short(it)}`));
      if (area.ownerActions.length > OVERVIEW_ROWS) out.push(`    … ${area.ownerActions.length - OVERVIEW_ROWS} more owner rows (detail: true)`);
      out.push(...area.checks.slice(0, OVERVIEW_ROWS).map(it => `    check: ${short(it)} · ${[...new Set(it.checks.map(checkLabel))].join("、")}`));
      if (area.checks.length > OVERVIEW_ROWS) out.push(`    … ${area.checks.length - OVERVIEW_ROWS} more check rows (detail: true)`);
    }
    if (project.areas.length > needing.length) out.push(`  ${project.areas.length - needing.length} other areas have no owner waiting and no checks`);
  }
  return out.length ? `${out.join("\n")}\n(detail: true lists every area with all its rows)` : "No projects.";
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
/** What a write tool advertises: with a credential on the connection the author is the credential's and is left out (docs/design.md, section 9). */
const optionalAuthor = z.string().optional().describe("the name of the project you work for (from `projects`); give it, with session, unless this connection carries a credential, which names both");
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

/**
 * The tools of one request (the endpoint keeps no session, so a server object serves one request). `credential` is what the
 * request's credential said about the writer (src/credentials.ts): none when it carried none, which leaves reads and the old
 * self-reported writes; a refusal when it carried one that is not valid, which refuses every call.
 * `budget`: what one tool call may read of the history (src/budget.ts); tests give a small one.
 * `looks`: what each session saw at its last `look` (src/look.ts); the daemon's one memory for all its requests, since a server object serves one request.
 */
export function createMcpServer({ store, ops, now, wake, slow, credential, budget = REQUEST_LIMITS, looks = new LookMemory() }: { store: Store; ops: Ops; now?: () => string; wake?: Wake; slow?: SlowOps; credential?: Resolved; budget?: BudgetLimits; looks?: LookMemory }): McpServer {
  const server = new McpServer({ name: "wf-board", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  // The SDK checks a call's arguments before the handler runs and answers a mistake with the bare check text, which names no
  // parameter that would have worked. Each tool's handler checks them itself (`register`) and answers with the tool's parameters,
  // so the SDK's check passes the arguments on as they came. The method is private in the SDK's types; the SDK is pinned, and
  // test/lean.test.ts fails if its text ever comes back. A looser schema given to the SDK would not do: it would drop the
  // `required` list the client is shown, and the SDK would still check what is nested in it (docs/design.md, section 6, Lean replies).
  (server as unknown as { validateToolInput: (tool: unknown, args: unknown) => Promise<unknown> }).validateToolInput = async (_tool, args) => args ?? {};
  // Checks depend on elapsed active time, including when no new commit arrived.
  function read() {
    const snapshot = store.snapshot();
    // One shared Rules object per snapshot and minute (store.derived), not one per read.
    return { snapshot, rules: store.derived.rules(snapshot, now ? Date.parse(now()) : Date.now()) };
  }
  /** The arguments of a write with the writer filled in from the credential; without one, the call must name its author (the old way, until the old tools are removed). */
  function identified(args: Record<string, unknown>): { args: Record<string, unknown>; note?: string } {
    if (credential?.ok) {
      const { author, session, access } = credential.who;
      const differs = (["author", "session"] as const).filter(key => args[key] !== undefined && args[key] !== (key === "author" ? author : session));
      return { args: { ...args, author, session, access }, ...(differs.length ? { note: `${differs.join(" and ")} ignored: this connection's credential writes as author ${author}, session ${session}` } : {}) };
    }
    if (typeof args.author !== "string" || !args.author.trim()) throw new Error("author: this call names no author, and this connection carries no credential to name it. Add author=<your project's name, from `projects`> and session=<your session's name> to the call; nothing else is needed");
    return { args };
  }
  function register<S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.output<z.ZodObject<S>>) => string | Promise<string>, write = false) {
    // Every tool takes the session, reads too: a call is a sign of life for the session and carries the pushes it has not been given
    // (docs/design.md, The wake streams). A write tool's author may be left out when the connection has a credential.
    const named = "author" in shape ? { ...shape, author: optionalAuthor } : shape;
    const full = "session" in named ? named : { ...named, session };
    const schema: z.ZodObject = z.object(full).strict();
    const json = jsonSchemaOf(schema);
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: !write, destructiveHint: write } }, async a => {
      // Every tool call is timed here, the one entry all tools pass through (docs/design.md, section 4, Time limits).
      const timed = slow?.start({ name: `tool ${name}`, cls: toolClass(name, write) });
      // A write's log line says where its time went (src/write-trace.ts).
      const trace = write ? new WriteTrace() : undefined;
      let outcome = "ok";
      try {
        if (credential && !credential.ok) throw new Error(credential.problem);
        // Wrong names the tool can place are read as the right ones, then the arguments are checked; a mistake is answered with the tool's parameters.
        const fixed = readNames(name, json, isRecord(a) ? a : {});
        const checked = schema.safeParse(fixed.args);
        if (!checked.success) throw new Error(refusal(name, json, fixed.args, checked.error.issues));
        const parsed = checked.data;
        // With a credential the writer is the credential's, whatever the call says about itself; the call is told when it said otherwise.
        const { args, note } = write ? identified(parsed) : { args: parsed, note: undefined };
        const notes = [...fixed.notes, ...(note ? [note] : [])];
        // The caller's call is a sign of life, and carries what was pushed to it and not yet delivered, once (docs/design.md, The wake streams).
        const caller = credential?.ok ? credential.who.session : typeof args.session === "string" ? args.session.trim() : undefined;
        if (caller) wake?.liveness.see(caller);
        // Each call reads history under a budget of its own, so one that asks for too much fails alone (docs/design.md, section 4, Request budgets).
        const answer = await withBudget(new Budget(`tool ${name}`, budget), () => withTrace(trace, () => fn(args as z.output<z.ZodObject<S>>))) + (notes.length ? `\nnote: ${notes.join("; ")}` : "");
        const pushed = caller && wake ? wake.footer(caller) : "";
        return { content: [{ type: "text" as const, text: pushed ? `${answer}\n\n${pushed}` : answer }] };
      }
      catch (error) { outcome = "error"; return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }
      finally { timed?.(outcome, () => summarize(a), trace && (() => trace.finish())); }
    });
  }
  register("projects", "Find the project matching your repository: its name, repo, area and open work counts.", {}, () => JSON.stringify(q.projects(read().snapshot)));
  register("brief", "Start or resume a project: unhandled owner notes, checks, owner cards, current work, next tasks (only items rated 1–5 that an unpaused root needs; unrated items are not listed), outgoing work (open items of other projects its open items wait on) and glossary terms. Item rows carry the item's difficulty when it has one, and relevant ones include compact plan rows with levels, ownership and dates, doing days and waits, and target numbers with comparison baselines and measurement dates; progress also covers records, standing items and blocked work omitted from those rows, except items blocked only because they wait for their turn in their owner's plan: queued counts those per owner.", { project: text("Exact configured project name from projects.") }, a => { const x = read(); return JSON.stringify(q.brief(x.snapshot,x.rules,a.project)); });
  register("candidates", "Which items could an engineer be started on, and how many engineers are working in each pool? The board lists candidates and does not choose among them: the architect decides which to start. A candidate is an item of any project that nobody holds (no engineer dispatch open on it), that can start (todo or part way, the next step waiting on nothing, an unpaused root needs it) and is rated 1–5. Two pools of engineers: level 1, and level 2 and above; the board holds no limit, so compare the engineers working with the limit the owner gave. An engineer counts as working when it holds an item and is not waiting (the item blocked, paused or done; every step it has in progress is the review step or waits on a 14900K run, while one waiting for CI still counts; or it has none in progress and a sub-item is being worked by another session). Per pool: the engineers working, the number of candidates, and the first rows (at most 10) in a default order (the open items waiting on it with a shared dependency row, then the item number), then the count not listed; more than 3 candidates under one parent are listed as the parent and a count. After a pool's candidates, when there is any, a part \"另有\" lists the work of that pool that cannot be started now, apart from the candidates and not counted in their number: paused work (on the item itself or above it; with who paused it, when, for how long and why) and work in a backlog whose head has a 何时 section (the first sentence of it and how long since the item last changed), each in at most 10 rows of the pool taken a project at a time, more than 3 under one pause marker or one parent as a row with a count; it lists only rated items with no open sub-item that nobody holds. under: the candidates directly under that parent, one row each (at most 10), and the paused items whose pause is on it and the items with a 何时 section directly under it, at most 10 of each.", { under: Key.describe("A parent item from a listed group, or the item that carries a pause marker: its candidates, and the paused and conditioned work under it, one by one.").optional() }, a => { const x = read(), at = now ? Date.parse(now()) : Date.now(); return a.under === undefined ? candidatesText(candidates(x.snapshot, x.rules, at)) : candidatesUnderText(candidatesUnder(x.snapshot, x.rules, a.under, at)); });
  register("whole_view", `Where does every open work item stand? One pass over the board, each open work item in one of five kinds, most pressing first: ${BUCKETS.map(b => `${b} (${BUCKET_TEXT[b]})`).join(", ")}. overdue: working or waiting past the limit for its state, or reported as an exception; unattended: unfinished rows but no session, no pause and nothing the board knows it waits for (half done first, then not started); working: the runner reports a turn in progress, or a live session holds the item; waiting: the runner reports it waits for CI, a card, the architect, items, a 14900K run or a merge, or the plan shows it blocked, with what for and how long; parked: a pause marker holds it, listed once per pause with how many items stand under it. The answer is the totals, up to a few rows per kind with the rest counted, and what each project has left; items in a backlog are counted, not listed. bucket lists one kind in full (up to 40 rows); project narrows to one project.`, {
    bucket: z.enum(BUCKETS).describe("List only this kind, in full.").optional(), project: text("Exact configured project name: only its items.").optional(),
  }, a => { const x = read(); return wholeViewText(wholeView(x.snapshot, x.rules, now ? Date.parse(now()) : Date.now()), a); });
  register("look", `Where does all the open work stand, from the roots down, in one answer? The tree the owner's board shows, each project's top items and the items they own, one line for each item, in a budget of lines (rows, default ${DEFAULT_ROWS}). Each line: the item, its status (进行中, 卡住, 停滞, 未开始, 暂停), what the runner reports it is doing or waiting for with the turn it is on, 没人管 (nobody holds it) or 等太久 (waiting past the limit for its state), how long it has been so, its check flags, and * when it changed or + when it is new since this session's last look. The budget opens the subtrees that need a reader first: those with an item nobody holds or waiting too long, then work being done, then check flags, then a pause; an item that carries a pause marker is one line with its reason and how long (expand opens it). A line not opened ends with 下面 N 件 and the count in each status. Work in a project's backlog (a record's items) is counted apart, as 待选池, and is a line of its own to open. Every open work item is a line or inside a count: done and cancelled items and records are not counted. session is the name the marks are kept under (a connection with a credential has one of its own, and a session you name besides is kept apart from it, so name your own when you share the connection): the answer's first line says what changed, what is new and what finished since this session's last look; without a session or a credential nothing is remembered or marked; the last look is kept in the board's memory only (the 16 newest sessions), so the first look after a restart marks nothing. projects: project names, none for all. expand: item keys (or a pool's or a project's) to open with the nodes above them, in the order given, as many as the budget holds; the answer says which did not fit.`, {
    projects: z.array(text("Exact configured project name.")).describe("Only these projects; omitted or empty means every project.").optional(),
    rows: z.number().int().min(MIN_ROWS).max(MAX_ROWS).describe(`The most lines the answer takes, at least one per project; default ${DEFAULT_ROWS}.`).optional(),
    expand: z.array(Key).describe("Items to open, with the nodes above them: their children are listed, however low they stand in the order of opening.").optional(),
    session,
  }, a => {
    const x = read(), at = now ? Date.parse(now()) : Date.now();
    // The memory is kept under the credential's session and the session the call names, so that a subagent on the architect's connection
    // (which names its own) neither reads nor replaces the conversation's last look; with only one of the two, under that one, and with neither not at all.
    const own = credential?.ok ? credential.who.session : undefined, named = a.session?.trim() || undefined;
    const caller = own === undefined ? named : named === undefined || named === own ? own : `${own} / ${named}`;
    const previous = caller ? looks.get(caller) : undefined;
    const view = look(x.snapshot, x.rules, at, { projects: a.projects, rows: a.rows, expand: a.expand }, previous, caller !== undefined);
    if (caller) looks.set(caller, { at, sigs: view.sigs });
    return lookText(view);
  });
  register("timeline", `Where did the time of an agent go? An agent is one session started on an item (a dispatch record). An engineer's line is what the runner reported while the session lasted; a review's (and an architect's turn's) is one stretch of 干活 from its start to its end, for it waits for nothing. A line has its segments in order, each a kind (${SEGMENT_KINDS.map(k => SEGMENT_TEXT[k]).join("、")}), a start, a length and what it waited for (the cards, the items, the event), and the totals for each kind. 干活 is a turn of the agent running; the other kinds are what it waits for between turns, and 暂停 is a stretch the item was paused. The time before a session began and between two sessions is on no line; a session left open ends where the next of its role on the item began, or when the work was over. With id: the lines of the agents that item went through, oldest first (the newest ${TIMELINE_AGENTS} agents; an answer over ${TIMELINE_CHARS} characters folds the earliest segments into one line of totals for each agent and says how many). Without id: the agents running now, the agents whose line ended in the last ${RECENT_MS / 3600_000} hours, by a finish or otherwise (up to ${RECENT_MAX}), and the longest waits among the running ones (waits for CI, the owner, the architect, items, a 14900K run, an event or a merge, and work stopped for a person), longest first, with how long each has gone on; limit says how many waits (default ${LONGEST_DEFAULT}, up to ${LONGEST_MAX}).`, {
    id: ref.optional(), limit: z.number().int().min(1).max(LONGEST_MAX).describe(`How many of the longest waits to list when no id is given; default ${LONGEST_DEFAULT}.`).optional(),
  }, a => {
    const x = read(), at = now ? Date.parse(now()) : Date.now();
    if (a.id !== undefined) {
      const found = q.resolveId(x.snapshot, a.id), it = found?.kind === "item" ? x.snapshot.items[found.id] : undefined;
      if (!found || !it) throw new Error(`id ${a.id}: choose an existing item (its key, or its number such as #812)`);
      return timelineText(found.id, it.title, linesOfItem(x.snapshot, x.rules, found.id, at));
    }
    const { running, recent } = listedAgents(x.snapshot, x.rules, at);
    return agentsText(running, recent.slice(0, RECENT_MAX), longestWaits(running, a.limit ?? LONGEST_DEFAULT), id => x.snapshot.items[id]!.title, at);
  });
  register("followups", "Coordinator follow-up: sent owner notes older than the given age, with their projects.", { minutes: z.number().nonnegative().describe("Age threshold in minutes, exclusive; zero returns all older pending work.") }, a => { const x = read(); return JSON.stringify(q.followups(x.snapshot,x.rules,a,now?.())); });
  register("search", "Where is this text mentioned? Search Chinese or other substrings across titles, heads, plan text, target goals, target values, current values, comparison baselines, logs, decisions and owner notes. Read context for a hit before editing it.", {
    query: text("Case-insensitive substring to find, including Chinese text."), filters: z.object({ ...scope, status: statuses, kind: z.array(z.enum(["item", "card", "note"])).describe("Search only these document kinds.").optional(), since: Time.describe("Only fields with timestamps at or after this ISO time; logs and notes use their own times.").optional(), limit: limit(20) }).strict().describe("Narrow the matches to relevant board context.").optional(),
  }, a => { const x = read(); return formatSearch(q.search(x.snapshot, x.rules, a.query, a.filters)); });
  register("context", "What is this item or decision, what does it wait on, and what happened recently? Accepts a key or a short number (#812). By default returns the head as the first paragraph of each section, the plan with finished rows folded into a count, target numbers with comparison baselines and measurement dates, open cards without their options' grounds, handled notes cut to a line, five pull request references and the latest five log entries cut to 240 characters; a cut says the full length. section answers with one section of the head whole (all: the whole head) and nothing else, full answers with nothing cut or folded, log gives that many entries whole (all returns the full log), and the key of a card gives the card whole. Logs are historical detail and never owner unread content.", {
    id: ref, log: z.union([z.number().int().min(0), z.literal("all")]).describe("Recent item log entries to include, whole; default the latest 5 cut to 240 characters, 0 omits them, all returns the full log.").optional(),
    section: text("Answer with the head alone: this section of it, by the title the default answer lists (a prefix such as 参考 matches every section that starts so), or all for the whole head. Items only.").optional(),
    full: z.boolean().describe("Answer whole, with nothing cut or folded: the whole head, the whole plan, every card option's grounds, handled notes and log entries in full.").optional(),
  }, a => { const x = read(); return formatContext(q.context(x.snapshot, x.rules, a.id, { log: a.log, foldPlan: !a.full }), a.full ? { section: a.section } : { lean: true, cutLog: a.log === undefined, section: a.section }); });
  register("graph", "What does this wait on, and what waits on it? Accepts a key or a short number (#812). Follow plan dependencies with titles and ownership, marking open blocked chains and cycles; owned and shared item rows are included.", {
    id: ref, direction: z.enum(["up", "down", "both"]).describe("up follows blockers; down follows dependents; both shows each separately."), depth: z.number().int().min(0).max(20).describe("Maximum dependency edges from the root; default 3.").optional(),
  }, a => { const x = read(); return formatGraph(q.graph(x.snapshot, x.rules, a.id, a)); });
  register("overview", "Which areas need attention? By default one line of counts for each project and, under it, the areas with an owner waiting or a check flagged, each with its first five such rows; blocked items are only counted. detail lists every area with all its rows. Optionally in one project group. status narrows leaf counts, owner actions and checks, including paused work.", {
    group: scope.group, status: statuses, detail: z.boolean().describe("List every area with all its owner, blocked and check rows, as the answer once did.").optional(),
  }, a => { const x = read(); return formatOverview(q.overview(x.snapshot, x.rules, a), a.detail); });
  register("list", "Which items match structured filters? Browse compact rows in page sibling order, then use context on the relevant ids. Done and cancelled items require an explicit status filter.", {
    filters: z.object({ ...scope, status: statuses, needsOwner: z.boolean().describe("Filter by whether owner action is waiting.").optional(), hasChecks: z.boolean().describe("Filter by whether board-rule checks need attention, including items with an own doing step and 1 hour of active time without changes.").optional(), updatedSince: Time.describe("Only items updated at or after this ISO time.").optional(), limit: limit(50) }).strict().describe("Structured item filters; omitted means the first 50 open or record rows.").optional(),
  }, a => { const x = read(); return q.list(x.snapshot, x.rules, a.filters).map(it => `${formatRow(it)}${it.needsOwner ? " · owner waiting" : ""}${it.checks.length ? ` · ${it.checks.length} checks` : ""}`).join("\n") || "No items."; });
  register("dispatches", "How have the agent sessions started on items done? Tallies the dispatch records of every project, by level, by role and by the item's tags: dispatches, how many are still running, how many ended in each result, the rework share, the mean kickbacks and rounds, and the cost; then how many ended with each failure signal. Every figure is added up from the rows, so rows: true lists the rows that add up to it. An item with several tags counts under each of them. since and until bound the start time (since inclusive, until exclusive).", {
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
  }, a => q.notes(read().snapshot, a.filters).map(n => formatNote(n)).join("\n") || "No notes.");
  register("messages", "Who told whom what? Lists the messages agents sent each other through the board, newest first, one per line: time, sender (its project) → recipient, the item, the text. A message only says which item to read and what is awaited; the content is on the item. since is inclusive, until exclusive.", {
    filters: z.object({ to: text("Only messages to this session.").optional(), from: text("Only messages from this session.").optional(), item: Key.describe("Only messages about this item.").optional(), since: dispatchTime("Only messages sent at or after this UTC time.").optional(), until: dispatchTime("Only messages sent before this UTC time.").optional(), limit: limit(50) }).strict().describe("Narrow the messages listed.").optional(),
  }, a => {
    const f = a.filters ?? {};
    return q.messages(read().snapshot, { ...f, since: f.since && normalizeTime(f.since), until: f.until && normalizeTime(f.until) })
      .map(m => `${m.at} · ${m.from}（${m.project}）→ ${m.to}${m.item ? ` · it:${m.item}` : ""}：${m.text}`).join("\n") || "No messages.";
  });
  register("glossary", "What does a word a project coined mean? Lists glossary terms with their definitions: one project's, or every project's that has terms.", {
    project: text("Exact configured project name; omit for every project.").optional(),
  }, a => q.glossary(read().snapshot, a.project).map(g => [`${g.project}:${g.terms.length ? "" : " no terms"}`, ...g.terms.map(t => `  ${t.term}: ${oneLine(t.definition)}`)].join("\n")).join("\n") || "No terms.");
  register("tags", "Which tags may I put on an item? Lists the approved tag vocabulary with each tag's meaning and the projects it is limited to: the tags for one project, or all of them.", {
    project: text("Exact configured project name; omit for every tag.").optional(),
  }, a => q.tagVocabulary(read().snapshot, a.project).map(t => `${t.name}: ${t.meaning}${t.projects ? ` (only ${t.projects.join(", ")})` : ""}`).join("\n") || "No tags approved yet.");
  register("prs", "Which board documents concern this PR? Returns qualified repository references separately from bare numbers whose repository is unknown.", {
    repo: text("Repository name under Ming-Research, such as Whitefoot."), number: z.number().int().positive().describe("Pull request number in that repository."),
  }, a => { const x = read(), refs = q.prs(x.snapshot, x.rules, a.repo, a.number); return [`${a.repo}#${a.number}:`, ...refs.qualified.map(it => `  ${it.kind}: ${formatRow(it)}`), "repository unknown:", ...refs.unknown.map(it => `  ${it.kind}: ${formatRow(it)}`)].join("\n"); });
  register("changes", "What needs handling since I last looked? Answers rows with counts: flags that newly appeared (with the sessions that wrote the item), items created, notes and cards others wrote; the other changes only as counts. since is an ISO time or commit. except drops the commits of the named sessions (your own) from the counts, the new items, and the notes and cards, never from the flags. detail also lists the documents behind the counts.", {
    since: text("Exclusive starting point: ISO time or git commit/ref you last read."), filters: z.object(scope).strict().describe("Only changes in this group or item subtree.").optional(), limit: limit(30),
    except: z.array(z.string().trim().min(1).max(80)).max(20).describe("Session names whose commits do not count, such as your own.").optional(), detail: z.boolean().describe("Also list the documents behind the counts of the other changes.").optional(),
  }, async a => { const x = read(); return formatReport(await q.changesReport(store, x.snapshot, a.since, a.filters, { except: a.except, detail: a.detail, rules: x.rules }), { limit: a.limit, detail: a.detail }); });
  const kind = z.enum(["item", "card", "note"]).default("item").describe("Document kind; card means a decision card; default item.");
  register("history", "How did this document change? Lists its commits newest first; use a commit in diff to inspect the exact text change.", {
    kind, id: text("Exact document id; notes use their original note id."), limit: limit(20),
  }, async a => (await q.history(store, a.kind === "card" ? "decision" : a.kind, a.id, a.limit)).map(c => `${c.commit} ${c.at} ${c.author}: ${oneLine(c.message)}`).join("\n") || "No history.");
  register("diff", "What exactly changed in one document? Returns its YAML diff between commits or ISO times; use after history or changes.", {
    kind, id: text("Exact document id; notes use their original note id."), from: text("Starting git commit/ref or ISO time."), to: text("Ending git commit/ref or ISO time; omitted means current HEAD.").optional(),
  }, async a => await q.diff(store, a.kind === "card" ? "decision" : a.kind, a.id, a.from, a.to) || "No differences.");
  // A write answers with the state it produced: the target's row and every ancestor whose
  // derived status it changed, so the writer need not read context again.
  const result = async (operation: Promise<import("./ops.ts").Result>) => {
    const before = read();
    const res = await operation;
    const after = read(), lines = [`${res.summary}${res.rev === undefined ? "" : ` · rev ${res.rev}`} · commit ${res.commit}`];
    if (res.repeated) lines.push("repeated: the same session wrote this same text a moment ago, so nothing was written again; this is the first write's commit");
    if (res.note) lines.push(`note: ${res.note}`);
    if (res.changes) lines.push(res.changes);
    if (res.credential) lines.push(`credential: ${res.credential}`, "shown once, and only its hash is kept: put it in the session's MCP configuration as the Authorization header (Bearer <credential>); it stops working when the dispatch ends");
    if (res.rev === undefined) return lines.join("\n");
    const kind = Object.hasOwn(after.snapshot.items, res.id) ? "item" : Object.hasOwn(after.snapshot.decisions, res.id) ? "card" : "note";
    if (kind !== "note") lines.push(formatRow(q.row(after.snapshot, after.rules, kind, res.id)));
    // The card writer sees its own option check now, not only on the next read.
    if (kind === "card") for (const check of after.rules.cardChecks(res.id)) lines.push(`check: ${check.text}`);
    if (kind === "item") for (const a of after.rules.ancestors(res.id)) {
      const was = Object.hasOwn(before.snapshot.items, a) ? label(before.rules.statusOf(a)) : "";
      const now = label(after.rules.statusOf(a));
      if (was !== now) lines.push(`ancestor ${a} now ${now}${was ? ` (was ${was})` : ""}`);
    }
    return lines.join("\n");
  };
  register("create_item", `Create an item with initial plan rows and one acceptance step appended from accept; use set_plan to add more acceptance steps or move them. owner adds an owned row before its first acceptance step. children deliberately moves existing items into the new plan. Records and standing items require no acceptance. Author ${PROCESS_WRITERS} creates items in any project; the one other writer is an engineer, which creates them only inside its own subtree (owner must be an item of that subtree, and so must any children) and rates and tags them as it makes them.`, {
    author, session, key: Key.describe("Unused key for the new item."), title: text("What completion delivers."), head: text("Stable problem, why and approach.").optional(), accept: text("Completion check or number appended as one acceptance step; required for work, refused for records and standing items.").optional(), owner: Key.describe("Existing same-project owner; omit to keep or make a top item.").optional(), after: z.array(Key).describe("Earlier destination plan row ids; [] starts at once, omitted follows the preceding row.").optional(), plan: PlanInput.describe("Initial ordered rows, which may include acceptance steps; accept appends one more at the end. No caller dates.").optional(), children: z.array(Key).describe("Existing same-project items deliberately moved into this new plan.").optional(), record: z.boolean().describe("A record has no work status or acceptance.").optional(), standing: z.boolean().describe(`A standing item is always in progress and never completes: no acceptance, difficulty or progress share, and nothing but another standing item owns it or waits for it. Only author ${PROCESS_WRITERS}; refused for a record.`).optional(), group: text("Project for a top item; otherwise owner's project.").optional(), links: links.optional(), data: text("Key numbers.").optional(), order: z.number().describe("Top-item ordering; owned order comes from the plan.").optional(), tags: tagList.optional(), difficulty: Difficulty.describe("1–5; logged as the first rating. Refused for a record and a standing item.").optional(),
  }, a => result(ops.createItem(a)), true);
  register("journal_entry", `Add one timed entry to today's architect journal (local date) and create that day's record under the architect notes if it does not exist yet. Only author ${ARCHITECT_WRITER} may call it; the entry goes to the end of the record's text and marks it new for the owner.`, { author, session, text: text("The entry text, possibly several lines; kept as written after the time stamp.") }, a => result(ops.journalEntry(a)), true);
  register("append_log", "Append historical detail without reading a revision. Appends are retried on concurrent writes and stamped by the server. Logs never mark an item new for the owner; use set_plan to keep progress current.", { author, session, id, text: text("Evidence, detail or stop reason to append; nonempty.") }, a => result(ops.appendLog(a)), true);
  register("dispatch_start", "Record an agent session you started on an item, and log the start on the item. author is the item's project, session your own session; agent is the started session's name and agentId its full id, which names one dispatch on the whole board. role is 工程师 or 审查. effort is omitted when the model has none (Haiku). startedAt is UTC (2026-10-16T09:02Z or in full), now when omitted. did names, in one line, which rows of the item the session does. Call dispatch_finish when the session ends.", {
    author, session, id: id.describe("The subtree root item you gave the session; the tag tally counts the dispatch under this item's tags."), role: z.enum(DISPATCH_ROLES), level: z.number().int().min(1).max(5).describe("The level the session was started at."), model: text("Model name as the level table writes it, e.g. Sonnet."), effort: text("Reasoning effort, e.g. xhigh; omit when the model has none.").optional(), agent: text("The started session's name."), agentId: Key.describe("The started session's full id."), worktree: text("The session's worktree path.").optional(), startedAt: dispatchTime("UTC start time; now when omitted.").optional(), did: text("Which rows of the item the session does, one line.").optional(),
  }, a => result(ops.dispatchStart(a)), true);
  register("dispatch_finish", "Complete a dispatch when its session ends: result, counts, usage, cost, failure signals and a note; logs the end on the item. result is 一次通过, 返工后通过, 换人 or 放弃. An engineer dispatch carries reports (how often it stopped to report) and kickbacks (how often you sent it back: a review's findings handed back to fix, or a rejected approach); a review dispatch carries rounds (how many review rounds it took: the first review and each re-review count one). A wrong-role count is refused. usage is the session's tokens summed from its transcript; cost is in US dollars, rounded to three decimals. signals lists the failure signals that occurred, none when omitted. waited is minutes spent waiting for the owner, the 14900K or a dependency. endedAt is UTC, now when omitted. An ended dispatch is changed only with replace: true.", {
    author, session, id: id.describe("The item the dispatch was recorded on by dispatch_start."), agentId: Key.describe("The session's full id, as given to dispatch_start."), result: z.enum(DISPATCH_RESULTS), usage: DispatchUsage.describe("Tokens, summed over the session's transcript with duplicate messages removed: input, cacheWrite, cacheRead, output."), cost: z.number().nonnegative().describe("US dollars; more than three decimals are rounded."), reports: count("Engineer only: how often it stopped to report.").optional(), kickbacks: count("Engineer only: how often it was sent back.").optional(), rounds: count("Review only: how many review rounds it took; the first review and each re-review count one.").optional(), waited: count("Minutes spent waiting for the owner, the 14900K or a dependency.").optional(), signals: z.array(z.object({ kind: z.enum(DISPATCH_SIGNALS), note: text("One sentence on this occurrence.").optional() }).strict()).describe("The failure signals that occurred, each at most once; none when omitted.").optional(), note: text("One sentence: a sign the level was set too high or too low.").optional(), endedAt: dispatchTime("UTC end time; now when omitted.").optional(), replace: z.boolean().describe("Explicitly replace an ended dispatch's record.").optional(),
  }, a => result(ops.dispatchFinish(a)), true);
  register("report_state", `Report the runner's state on an item: the runner is the resident program that runs the engineers' turns, and it reports at the start and the end of every turn. Only author ${PROCESS_WRITERS} may, and the runner itself, which has no credential, from the session ${RUNNER_SESSION}. The report replaces the item's last one; the board stamps since (when the work entered this state; it stays while the state and what it waits for stay) and at (the last report that changed something), and a report that changes nothing writes nothing. state: running (a turn is in progress), ci, ask (needs to: owner with cards, or architect), items (needs items), run (waits for a 14900K run), wait (waits for an event set beforehand and needs no one; needs what, and takes until when the runner wakes it at a time), ready (merge check, merge and main-line watch), exception (stopped and needs a person), done. turns and cost are cumulative and keep their last figure when left out; startedAt keeps the first report's time. whole_view reads these reports.`, {
    author, session, id: id.describe("The item the runner works on."), state: z.enum(RUNNER_STATES).describe("running, or what the turn ended in."),
    to: z.enum(RUNNER_ASKS).describe("Whom an ask waits on; required with state ask, refused otherwise.").optional(), cards: z.array(Key).describe("The open cards an ask to the owner waits for; required with to owner.").optional(),
    items: z.array(Key).describe("The items the work waits for; required with state items.").optional(),
    what: text(`One line of at most ${RUNNER_NOTE_MAX} characters: the event a wait is for; required with state wait, refused otherwise.`).optional(), until: dispatchTime("Only with state wait: the UTC time the runner wakes the work (2026-10-19T23:55Z or in full); the wait is on time until an hour after it.").optional(),
    note: text(`One line of at most ${RUNNER_NOTE_MAX} characters: what the work waits for, in the runner's words.`).optional(),
    turns: count("Rounds run on the work so far.").optional(), cost: z.number().nonnegative().describe("US dollars spent on the work so far; more than three decimals are rounded.").optional(), startedAt: dispatchTime("When the work began, UTC; the first report's time when omitted.").optional(),
  }, a => result(ops.reportState(a)), true);
  register("report_live", `Report the runner's beat for a turn it is running now: which turn it is, how long it has run, how long since its last action and what that action was. Same writers as report_state (author ${PROCESS_WRITERS}, and the runner itself from the session ${RUNNER_SESSION}). The beat is kept in the board's memory only: it makes no commit, is replaced by the next beat for the same role and item, is lost when the board restarts, and is shown on the agent list for as long as the runner keeps sending it (about every 30 seconds). Send durations, never times: the board counts back from the moment the beat arrives. id is the engineer's item, also for the architect's turn that answers its question.`, {
    author, session, id: id.describe("The engineer's item the turn works on, or is answering a question on."), role: z.enum(LIVE_ROLES).describe("工程师 for an engineer's turn, 架构师 for the architect's turn that answers its question."),
    turn: z.number().int().min(1).describe("The turn's number: the item's turn count for an engineer, the architect session's for the architect."), turnSeconds: count("How many seconds this turn has run."),
    idleSeconds: count("How many seconds since the turn's last action; leave it out when unknown.").optional(), action: text(`The last action in one line of at most ${LIVE_ACTION_MAX} characters, such as 改 web/app.ts or 跑 git push; leave it out when unknown.`).optional(),
  }, a => ops.reportLive(a), true);
  register("set_plan", "Edit the item's plan. Exactly one mode: row upserts one row by its id (the way to change one row; new rows before the first acceptance step, or at the end when there is none), rows REPLACES THE WHOLE PLAN, so every row you leave out is deleted, and remove deletes one row. Dates are server-owned. A blocking card's row joins the plan only through write_card and cannot be removed here (withdraw_card closes the card); here it may only change its after or its position. Whole writes clear provisional and log the rewrite. Status and blocking derive from the plan; open owned rows require move_item before removal for every author. Project writes cannot indirectly resume paused open work. after names earlier rows. Work plans require at least one acceptance step anywhere; records and standing items take none. Acceptance uses ordinary step after, waits and state rules. Identical results are no-ops; concurrent writes retry atomically.", {
    author, session, id, rows: PlanInput.describe("Replaces the WHOLE plan: every row not listed here is deleted. To change one row send row instead. Clears provisional and logs its rewrite.").optional(), row: PlanRowInput.describe("Complete row upsert, the way to change one row: keeps an existing id in place or inserts before the first acceptance step (appends when there is none). Another position needs rows, which replaces the whole plan.").optional(), remove: Key.describe("Existing row id; later after users must be rewritten first.").optional(),
  }, a => result(ops.setPlan(a)), true);
  register("set_targets", "Keep your item's goal numbers current, including on records. Provide exactly one: targets replaces the ordered list, target upserts a complete goal by stable id, or remove deletes that id. Existing upserts keep their position; new ids append. Each row describes a goal, its target value, current value and comparison baseline. The server stamps the measurement date when the current value changes and preserves it otherwise; callers provide no date. New values overwrite old ones, with no measurement history list. No revision is required; changes are one atomic commit with concurrent writes retried; an identical result writes no commit. Target changes are owner unread progress.", {
    author, session, id,
    targets: ItemTargetsInput.describe("Full replacement list; unique stable ids. Caller provides no dates. Empty list clears targets.").optional(),
    target: ItemTargetInput.describe("Complete goal to add or replace: id (1–40 key characters), goal, target, current and baseline; all text is nonempty. Caller provides no date.").optional(),
    remove: StepId.describe("Existing stable target id to remove; supply no target or targets.").optional(),
  }, a => result(ops.setTargets(a)), true);
  register("update_item", `Edit stable fields using rev from context. A changed head requires reason. order is for top items. Changing to a record removes all acceptance steps and logs their texts; project authors must have an explicit pause cleared by the owner or Architect before converting to a record (a cancelled item only by ${PROCESS_WRITERS}); an inherited pause alone does not prevent record conversion, provided no open descendant resumes; changing to work requires accept. standing: true makes the item a standing one (always in progress, never completes): its acceptance steps and difficulty are removed and logged, and standing: false makes it ordinary work again, which requires accept; only author ${PROCESS_WRITERS} may set it. Only author ${PROCESS_WRITERS} may change the title, and turn a cancelled item into a record. Edit progress with set_plan and ownership with move_item. To change part of the head, give sections and/or replace instead of head, and read no more of the head than the part you change (context with section: "<title>" gives one section whole): every edit is found in the head as it is before the call, all are made at once or none (the first one that does not fit refuses the call and names it), and the answer shows each change as the lines before and after it. A section title is as context lists it; its new text starts with its title line. Text to replace must occur exactly once in the head. Two edits cannot change the same text. To add a section, give the last sentence of the section before it as the old text of a replace, and that sentence followed by the new section as its new text.`, {
    author, session, id, rev: z.number().int().positive().describe("Revision read from context; stale writes are refused."), title: text("Replacement title.").optional(), head: text("Replacement context.").optional(), 
    sections: z.array(z.object({ title: text("Title of the section to replace, as context lists it (开头 is the text before the first title)."), text: text("The whole new section: its title line first, then its text, and no other title line. The blank lines after the section stay as they were.") }).strict()).min(1).describe("Replace whole sections of the head by title, each from its title line to the next section's. Not with head.").optional(),
    replace: z.array(z.object({ old: text("Text that occurs exactly once in the head; the call is refused when it occurs 0 or 2 or more times."), new: text("What replaces it; empty deletes it.") }).strict()).min(1).describe("Replace short texts in the head where they stand, each old text once. Not with head.").optional(),
    reason: text("Why head changed.").optional(), record: z.boolean().describe("A record has no work status or acceptance.").optional(), standing: z.boolean().describe("true: a standing item, always in progress and never completing, with no acceptance or difficulty; false: ordinary work again, with accept. Only the Architect.").optional(), accept: text("Acceptance for a record or a standing item becoming work.").optional(), links: links.optional(), data: clearableText("Replacement numbers; null clears."), order: z.number().describe("Top-item ordering; owned order comes from the plan.").optional(),
  }, a => result(ops.updateItem(a)), true);
  register("set_tags", "Set your item's whole tag list: every tag must be in the vocabulary (tags) and apply to the item's project, at least one, no repeats. Identical lists are no-ops. No revision is required. Use it to backfill items the 缺标签 check lists.", { author, session, id, tags: tagList }, a => result(ops.setTags(a)), true);
  register("set_tags_many", "Set the whole tag lists of many of your items in one commit, for backfilling the 缺标签 check: each entry is checked as set_tags checks it, and one refused entry refuses the whole write. Entries whose list is unchanged write nothing; when none changes, no commit is made.", {
    author, session, items: z.array(z.object({ id, tags: tagList }).strict()).min(1).describe("Each item once, with its whole tag list."),
  }, a => result(ops.setTagsMany(a)), true);
  register("set_difficulty", `Set the item's difficulty, 1–5, which decides the agent that does it. Author ${PROCESS_WRITERS} rates an item of any project; an engineer rates the items below the one it was started on, in its own subtree, and never that item itself. Work items only; a record and a standing item have none. reason is required, also for the first rating, and is logged with the change as 「难度：2 → 3，理由：…」 (the first rating from 未评). An unchanged value is a no-op. No revision is required. Open work without a difficulty shows the 缺难度 check when only its rating is missing, and is not startable.`, { author, session, id, difficulty: Difficulty.describe("1–5."), reason: text("Why the difficulty is this; logged with the change.") }, a => result(ops.setDifficulty(a)), true);
  register("set_difficulty_many", "Set the difficulty of many items in one commit, for rating a backlog of items without one: each entry is checked and logged as set_difficulty checks and logs it, and one refused entry refuses the whole write. Written by the same writers as set_difficulty, each for its own items. reason is the default for entries that give none; an entry with neither is refused. Entries whose difficulty is unchanged write nothing; when none changes, no commit is made.", {
    author, session, reason: text("Default reason for entries without their own.").optional(),
    items: z.array(z.object({ id, difficulty: Difficulty.describe("1–5."), reason: text("This item's reason; overrides the default.").optional() }).strict()).min(1).describe("Each item once, with its difficulty."),
  }, a => result(ops.setDifficultyMany(a)), true);
  register("set_tag", `Vocabulary change, only author ${ARCHITECT_WRITER} and only after the owner approved it on a decision card: add a tag or change an existing tag's meaning or projects. meaning is one sentence telling agents when to apply the tag. projects limits the tag to those projects; null makes it apply to every project; omitted keeps the current setting (a new tag then applies to every project). Narrowing projects is refused while an item of another project carries the tag.`, { author, session, name: TagName.describe("Short Chinese label, 1–12 characters without whitespace or commas; unique."), meaning: text("One sentence telling agents when to apply the tag."), projects: z.array(text("Configured project name.")).min(1).nullable().optional().describe("Projects that may use the tag; null for every project.") }, a => result(ops.setTag(a)), true);
  register("rename_tag", `Vocabulary change, only author ${ARCHITECT_WRITER} and only after the owner approved it on a decision card: rename a tag and every item carrying it in one commit, logging the rename on each item.`, { author, session, name: TagName.describe("Existing tag."), to: TagName.describe("Unused new name.") }, a => result(ops.renameTag(a)), true);
  register("remove_tag", `Vocabulary change, only author ${ARCHITECT_WRITER} and only after the owner approved it on a decision card: remove a tag. Refused while any item carries it, unless replace names another tag that applies to all those items' projects; every carrying item then gets the replacement, in the same commit.`, { author, session, name: TagName.describe("Existing tag."), replace: TagName.describe("Existing other tag every carrying item receives instead.").optional() }, a => result(ops.removeTag(a)), true);
  register("set_pause", `Owner-directed pause or resume without changing any plan row. Only author ${PROCESS_WRITERS} may write it, in any project. Records refuse this tool. Pausing requires reason and refuses done and cancelled items; those closed items may only have an existing explicit pause cleared. Descendants inherit pause; resume clears only this item's own marker, so an ancestor's pause remains. Times and the 暂停/恢复 log entry are server-owned; identical requests are no-ops.`, { author, session, id, paused: z.boolean().describe("true pauses the item and its owned subtree; false clears this item's explicit pause."), reason: text("Owner's reason for pausing; required when paused is true.").optional() }, a => result(ops.setPause(a)), true);
  register("set_status", `Only author ${PROCESS_WRITERS} may use it. Cancel with a reason, or reopen a cancelled item. Cancelling withdraws the item's open decision cards in the same write; reopening restores those cards (a card withdrawn by hand stays withdrawn). Plan rows, including acceptance states and dates, and owner pause markers stay unchanged. Reopening restores any effective pause. All other statuses derive from plan. Refuses records and cancellation with open owned parts; dispose of each part first. Cancelling paused work keeps the pause marker.`, { author, session, id, status: z.enum(["cancelled", "open"]).describe("cancelled cancels; open removes cancellation, with status derived again."), log: text("Cancellation or reopening reason.") }, a => result(ops.setStatus(a)), true);
  register("move_item", `Deliberately change ownership in one commit, logging on the item and both owners. Ownership stays within the same project, with no cycles. Project authors may move into a paused chain but cannot move open work out of one until the owner or ${PROCESS_WRITERS} resumes it. ${PROCESS_WRITERS} may move any project's items. Without owner it becomes top-level. after belongs to the destination row and requires owner. Later after edges naming a removed row must be rewritten first.`, { author, session, id, owner: Key.describe("Existing same-project owner; omit to keep or make a top item.").optional(), after: z.array(Key).describe("Earlier destination plan row ids; [] starts at once, omitted follows the preceding row.").optional() }, a => result(ops.moveItem(a)), true);
  register("move_item_project", `Only author ${PROCESS_WRITERS} may use it. Move an item to another project, together with everything it owns, in one commit. Key, number, history, notes and cards stay with it; each moved item logs the move. An owner left behind keeps its row as a shared dependency. The item arrives as a top item of the new project; place it under an owner there afterwards with move_item. Refused when the move would leave an open waiter and no owner in the new project: an open item there waits on it through a shared row (it would arrive owned by no item), or its own plan holds a shared row to a top item there that nothing owns; the error names them and says what to do first, and only what this move newly causes is refused, not a violation that was already there. Also refused when a moved item's tags do not apply to the new project, or when open work would leave a paused chain without the owner or ${PROCESS_WRITERS} resuming it.`, { author, session, id, project: text("Existing configured project to move the item into.") }, a => result(ops.moveItemProject(a)), true);
  register("clear_ask", "Remove a legacy ask after the project has replaced it with a decision card or settled it; log the outcome in the same commit.", { author, session, id, log: text("Which decision card replaced the legacy ask or what settled it, and why it can be removed.") }, a => result(ops.clearAsk(a)), true);
  register("write_card", "Create a decision card, or revise an open card using its rev from context. A card is one question with a kind (design, inquiry or rule; see kind) and at least three workable options, each with a short name and a detail (what it does, its cost and risks, why it is or is not recommended), and the confidence in the recommended one (score and reason, with what would overturn it). The head places the card on a line holding only [[q:key]], where the design reaches the decision, and does not repeat what the card says. Only a card with blocks is a row of the item's plan, put there in the same commit: before names the row that also waits for the card (default: the first acceptance step) and after the earlier rows the card waits for (as in set_plan). A card without blocks has no row. A revision cannot change the item; setting blocks on a revision adds the row, clearing it removes the row. options is an array of objects, [{\"text\": \"A\", \"detail\": \"…\"}, {\"text\": \"B\", \"detail\": \"…\", \"recommended\": true}, …]: each object ends with one } and the array with one ]. An extra bracket or brace, or a double quote inside a text that is not written with a backslash, makes the call invalid JSON; the client then refuses it before the board sees it, with no position. Write a double quote inside a text as \\\" and a line break as \\n.", {
    author, session, key: Key.describe("Unused new decision key, or an existing open card key with rev."), rev: z.number().int().positive().describe("Required to revise an open card; omit only for creation.").optional(), item: Key.describe("Existing item this decision belongs to."), question: text("The choice the owner needs to settle, one line."),
    kind: z.enum(CARD_KINDS).describe(`${CARD_KIND_WHAT} ${CARD_KIND_HOW} Required when creating; when revising, omitted keeps the card's kind.`).optional(),
    options: z.array(z.object({ text: text("The option's name, a short phrase of at most 20 characters (spaces not counted) on one line."), detail: text("What the option does, its cost and risks, and why it is or is not recommended. No length limit."), recommended: z.boolean().describe("Mark at most one option.").optional() }).strict()).min(1).max(26).describe("The options in order; the board keys them A, B, C…"),
    confidence: z.object({ score: z.number().int().min(1).max(5).describe("Confidence from 1 (judgment) to 5 (settled by evidence).").optional(), reason: text("Evidence for the confidence and what could overturn it.") }).strict().describe("Confidence in the recommended option; required when creating.").optional(),
    blocks: clearableText("One sentence naming the work that cannot proceed until the owner rules. Set it only when named work is stopped by this card (something hard to undo or that the owner must do); leave it out when sessions proceed on the recommendation. A card with blocks is blocking: it is a row of the item's plan, the page shows it purple and the owner is told in the open board pages. When revising, text sets it, null clears it, omitted keeps it."),
    before: Key.describe("Only for a card with blocks, when its row is created: the plan row that also waits for this card; the card's row goes just before it. Default: the first acceptance step.").optional(), after: z.array(Key).describe("Only for a card with blocks, when its row is created: earlier plan row ids this card waits for; [] starts at once, omitted follows the preceding row.").optional(),
  }, a => result(ops.writeCard(a)), true);
  register("rule_card", "Record the owner's ruling on an open decision card made outside the page, for example in chat: the option they chose, and their own words in ruling (the design tree's approval line quotes them). A pick the owner sends on the page is recorded by the board itself when it is sent, so do not call this for it. A choice must be one of the card's option keys; a ruling in words may omit choice. Rulings may complete paused work; the retained pause marker stays unchanged, and author ownership checks apply.", { author, session, key: Key.describe("Existing open decision card key."), choice: text("The chosen option's key, A, B, C…; omit when the owner chose none and answered in words.").optional(), ruling: text("The owner's words and reasons, quoted.").optional() }, a => result(ops.ruleCard(a)), true);
  register("withdraw_card", "Withdraw an open decision card nobody needs any more. The reason is written in the item's log and the card's plan row, if it has one, counts as done. A card the owner has answered is not withdrawn.", { author, session, key: Key.describe("Existing open decision card key."), log: text("Why the card is no longer needed; written in the item's log.") }, a => result(ops.withdrawCard(a)), true);
  register("reply_note", "Answer an owner's note and mark it done. The server stamps repliedAt and records your project as repliedBy.", { author, session, id: text("Existing owner note id found with notes or context."), reply: text("Answer to the owner's note."), replace: z.boolean().describe(`Explicitly replace an existing reply; otherwise an already answered note is refused. Only author ${PROCESS_WRITERS} replaces a reply it did not write; everyone else replaces only their own.`).optional() }, a => result(ops.replyNote(a)), true);
  register("create_project", `Configure a new project with its optional repository; accepts any author string when appending last. Only ${PROCESS_WRITERS} may supply after to place it immediately after an existing project in page order. Creation and placement are one commit.`, { author, session, name: text("New unique project name, used by area group fields."), repo: text("Optional repository identifier, e.g. Ming-Research/Halo-wf.").optional(), after: text(`Existing project name this new project should immediately follow; only ${PROCESS_WRITERS}. Omit to append last.`).optional() }, a => result(ops.createProject(a)), true);
  register("update_project", `Update the project's repository or mainline (only that project, or ${ARCHITECT_WRITER}, may); ${PROCESS_WRITERS} may reorder it with after.`, { author, session, name: text("Configured project name."), repo: text("Repository identifier.").optional(), mainline: clearableText("The branch merges land on, when it is not the repository's default branch; the GitHub watch reads its checks. null clears it."), after: text(`Project immediately before it; ${PROCESS_WRITERS} only.`).optional() }, a => result(ops.updateProject(a)), true);
  register("close_note", "Close a sent owner note without reply text and record what handled it in its item's log, in one commit.", { author, session, id: text("Owner note id on your project's item or card."), log: text("What handled this note; appended to the item's historical log.") }, a => result(ops.closeNote(a)), true);
  // A glossary write answers with its commit; there is no item row to show.
  const glossaryResult = async (operation: Promise<import("./ops.ts").Result>) => { const res = await operation; return `${res.summary} · commit ${res.commit}`; };
  register("set_term", "Add or replace a term in your own project's glossary. The board page links the first occurrence of each term in an item, card or note to its definition. Add a term only for a word your project coined and uses repeatedly; industry-standard terms (CoreMark, PUC Lua, WPT, dispatch) are not added. A term is no substitute for describing the phenomenon in plain words where you write about it.", {
    author, session, term: text("The coined word exactly as board text writes it, on one line; occurrences are matched as plain substrings."), definition: text("What the word means, in plain Chinese that a reader outside the project understands."),
  }, a => glossaryResult(ops.setTerm(a)), true);
  register("delete_term", "Remove a term from your own project's glossary, such as a word no longer used or an industry-standard term added by mistake.", { author, session, term: text("Existing term in your project's glossary.") }, a => glossaryResult(ops.deleteTerm(a)), true);
  register("send_message", `Ring another agent's doorbell through the board. to: the architect (架构师), a session with an open dispatch, or the session of a long-lived credential; another name is refused with the names that work. text: at most ${MESSAGE_TEXT_LIMIT} characters on one line, saying which item to read and what you wait for; write the content on the item. The recipient gets it as one push line: at once when its wait script is connected, else in the result of its next board call. Every message stays on the board (messages lists them).`, {
    author, session, to: text("The receiving session's name."), text: text(`At most ${MESSAGE_TEXT_LIMIT} characters on one line: which item to read and what you wait for.`), item: Key.describe("The item the message is about, if there is one.").optional(),
  }, async a => { const res = await ops.sendMessage(a); return `${res.summary} · commit ${res.commit}`; }, true);
  return server;
}
