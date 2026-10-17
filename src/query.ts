import { isDeepStrictEqual } from "node:util";
import type { Difficulty, PlanRow, PlanStep, Project, ItemTarget, Note, Priority, Snapshot, Status } from "./model.ts";
import { STATUSES, numRef, tagApplies, boardTags } from "./model.ts";
import type { Rules } from "./rules.ts";
import { rules as makeRules, planChanged, targetLine, targetsChanged, changesSection, countedPulls, isOpenMergeStep } from "./rules.ts";
import type { CommitInfo, DocKind, Store } from "./store.ts";
import { allowRange } from "./budget.ts";

export type Kind = "item" | "card" | "note";
export interface Row { kind: Kind; id: string; num?: number; title: string; status: string | undefined; record?: boolean; priority?: Priority | ""; area: string; areaId: string; group: string; tags?: string[]; difficulty?: Difficulty; plan?: string[]; targets?: string[] }
/** `<session> · <time to the minute>`: the one form `context` and `brief` print for an item's last writer. */
export const pushLine = (last: { name: string; at: string }): string => `${last.name} · ${last.at.slice(0, 16)}Z`;
export interface Scope { group?: string; under?: string }
export interface SearchFilters extends Scope { status?: Status[]; kind?: Kind[]; since?: string; limit?: number }
/** One hit per matching field; `more` counts further matches in the same field. */
export interface Hit extends Row { field: string; time?: string; snippet: string; more?: number }
/** An exact key first, then a short-number reference ("#812" or "812") to the item or card holding that number. */
export function resolveId(s: Snapshot, id: string): { kind: "item" | "card"; id: string } | undefined {
  if (Object.hasOwn(s.items, id)) return { kind: "item", id };
  if (Object.hasOwn(s.decisions, id)) return { kind: "card", id };
  const num = numRef(id);
  if (num === undefined) return undefined;
  const item = Object.keys(s.items).find(key => s.items[key]!.num === num);
  if (item !== undefined) return { kind: "item", id: item };
  const card = Object.keys(s.decisions).find(key => s.decisions[key]!.num === num);
  return card === undefined ? undefined : { kind: "card", id: card };
}
function requireId(s: Snapshot, id: string): { kind: "item" | "card"; id: string } {
  const found = resolveId(s, id);
  if (found) return found;
  throw new Error(`Unknown id ${id}; use search or list to find an item or card`);
}
function noteItem(s: Snapshot, n: Note | undefined): string { if (!n) return ""; return n.target.startsWith("it:") ? n.target.slice(3) : s.decisions[n.target.slice(2)]?.item ?? ""; }
function itemId(s: Snapshot, kind: Kind, id: string): string {
  return kind === "item" ? id : kind === "card" ? s.decisions[id]?.item ?? "" : noteItem(s, s.notes[id]);
}
/** `owner` is the item the document is on, when the caller knows it better than `s` does (a card that `s` no longer holds). */
export function row(s: Snapshot, r: Rules, kind: Kind, id: string, owner = itemId(s, kind, id)): Row {
  const areaId = r.lineOf(owner);
  const card = kind === "card" ? s.decisions[id] : kind === "note" && s.notes[id]?.target.startsWith("q:") ? s.decisions[s.notes[id]!.target.slice(2)] : undefined;
  const num = kind === "item" ? s.items[id]?.num : kind === "card" ? s.decisions[id]?.num : undefined;
  return { kind, id, ...(num === undefined ? {} : { num }), title: card?.question ?? s.items[owner]?.title ?? s.notes[id]?.target ?? id,
    status: kind === "item" ? r.statusOf(id) : kind === "card" ? s.decisions[id]!.status : s.notes[id]!.state,
    ...(kind === "item" ? { ...(s.items[id]?.record ? { record: true } : {}), ...(s.items[id]?.tags?.length ? { tags: s.items[id]!.tags } : {}), ...difficultyOf(s.items[id]), priority: r.priorityOf(id) } : {}), area: s.items[areaId]?.title ?? areaId, areaId,
    group: r.groupOf(owner) };
}
function validateScope(s: Snapshot, scope: Scope): void {
  if (scope.under !== undefined && !Object.hasOwn(s.items, scope.under)) throw new Error(`under ${scope.under}: choose an existing item subtree`);
}
function inScope(r: Rules, id: string, scope: Scope): boolean {
  return (scope.group === undefined || r.groupOf(id) === scope.group) && (scope.under === undefined || id === scope.under || r.ancestors(id).includes(scope.under));
}
interface Field { field: string; text: string; rank: number; time?: string; index?: number }
function fields(s: Snapshot, kind: Kind, id: string): Field[] {
  if (kind === "item") {
    const it = s.items[id]!;
    return [{ field: "id", text: id, rank: 0 }, { field: "title", text: it.title, rank: 0 }, ...["head", "data"] .map(field => ({ field, text: it[field as "head" | "data"] ?? "", rank: 1 })),
      { field: "ask", text: it.ask?.text ?? "", rank: 1 }, ...(it.plan ?? []).filter(step => "text" in step).map(step => ({ field: `plan.${step.id}`, text: "text" in step ? [step.text, step.waits, step.reason].filter(Boolean).join(" ") : "", rank: 1 })),
      ...(it.targets ?? []).map(target => ({ field: `target.${target.id}`, text: [target.goal, target.target, target.current, target.baseline].join(" "), rank: 1 })),
      ...it.log.map((l, i) => ({ field: `log[${i}]`, text: `${l.at} ${l.by ?? ""} ${l.text}`, rank: 2, time: l.at, index: i }))];
  }
  if (kind === "card") {
    const card = s.decisions[id]!;
    return [{ field: "id", text: id, rank: 0 }, ...["question", "background", "ruling"].map(field => ({ field, text: card[field as "question" | "background" | "ruling"] ?? "", rank: 1 }))]
      .concat(card.options.map(o => ({ field: `option.${o.key}`, text: o.text, rank: 1 })));
  }
  const n = s.notes[id]!;
  return [{ field: "text", text: n.text, rank: 3, time: n.sentAt ?? n.at }, { field: "reply", text: n.reply ?? "", rank: 3, time: n.repliedAt ?? n.at }];
}
function snippet(text: string, start: number, length: number): string {
  const left = Math.max(0, start - Math.max(0, Math.floor((80 - length) / 2)));
  const right = Math.min(text.length, Math.max(start + length, left + 80));
  return (left ? "…" : "") + text.slice(left, start).replace(/\s+/g, " ") + "«" + text.slice(start, start + length) + "»" + text.slice(start + length, right).replace(/\s+/g, " ") + (right < text.length ? "…" : "");
}
export function search(s: Snapshot, r: Rules, query: string, f: SearchFilters = {}): Hit[] {
  validateScope(s, f);
  if (!query.trim()) throw new Error("query: provide nonempty substring text");
  const hits: Array<Hit & { rank: number; index: number }> = [], needle = query.toLowerCase();
  // A PR-shaped query ("Whitefoot#343", "Whitefoot #343", "Whitefoot PR #343") also finds the
  // documents the PR index attributes to it, however their text spells the reference.
  const pr = /^\s*([A-Za-z0-9_.-]+)\s*(?:PR\s*)?#(\d+)\s*$/i.exec(query);
  if (pr) {
    const found = prs(s, r, pr[1]!, Number(pr[2]));
    for (const [list, rank, label] of [[found.qualified, 0, `${pr[1]}#${pr[2]}`], [found.unknown, 2, `#${pr[2]}（未写仓库，可能是别的仓库）`]] as const)
      for (const h of list) {
        if (f.kind && !f.kind.includes(h.kind)) continue;
        const owner = itemId(s, h.kind, h.id);
        if (!inScope(r, owner, f) || f.status && !f.status.some(st => st === r.statusOf(owner))) continue;
        hits.push({ ...h, field: "pr", snippet: `«${label}»`, rank, index: 0 });
      }
  }
  for (const kind of f.kind ?? ["item", "card", "note"]) {
    const docs = kind === "item" ? s.items : kind === "card" ? s.decisions : s.notes;
    for (const id of Object.keys(docs)) {
      const owner = itemId(s, kind, id);
      if (!inScope(r, owner, f) || f.status && !f.status.some(st => st === r.statusOf(owner))) continue;
      for (const field of fields(s, kind, id)) {
        const doc = docs[id]!;
        const time = field.time ?? ("updated" in doc ? doc.updated : doc.at);
        if (f.since && Date.parse(time) < Date.parse(f.since)) continue;
        const lower = field.text.toLowerCase();
        const first = lower.indexOf(needle);
        if (first === -1) continue;
        let more = 0;
        for (let pos = lower.indexOf(needle, first + needle.length); pos !== -1; pos = lower.indexOf(needle, pos + needle.length)) more++;
        hits.push({ ...row(s, r, kind, id), field: field.field, ...(field.time ? { time: field.time } : {}), snippet: snippet(field.text, first, query.length), ...(more ? { more } : {}), rank: field.rank, index: field.index ?? 0 });
      }
    }
  }
  return hits.sort((a, b) => a.rank - b.rank || Date.parse(b.time ?? "1970-01-01T00:00:00Z") - Date.parse(a.time ?? "1970-01-01T00:00:00Z") || a.id.localeCompare(b.id) || b.index - a.index).slice(0, f.limit ?? 20).map(({ rank: _rank, index: _index, ...hit }) => hit);
}

export interface ListFilters extends Scope { status?: Status[]; priority?: Priority[]; needsOwner?: boolean; hasChecks?: boolean; updatedSince?: string; limit?: number }
export function list(s: Snapshot, r: Rules, f: ListFilters = {}) {
  validateScope(s, f);
  const out: Array<Row & { updated: string; needsOwner: boolean; checks: ReturnType<Rules["checks"]> }> = [];
  const seen = new Set<string>();
  function walk(id: string): void {
    if (seen.has(id) || !s.items[id]) return;
    seen.add(id);
    const it = s.items[id]!, checks = r.checks(id), needsOwner = r.needsOwner(id);
    if (inScope(r, id, f) && (f.status ? f.status.some(st => st === r.statusOf(id)) : !["done", "cancelled"].includes(r.statusOf(id) ?? "")) && (!f.priority || f.priority.some(p => p === r.priorityOf(id))) &&
      (f.needsOwner === undefined || needsOwner === f.needsOwner) &&
      (f.hasChecks === undefined || !!checks.length === f.hasChecks) && (!f.updatedSince || Date.parse(it.updated) >= Date.parse(f.updatedSince))) out.push({ ...row(s, r, "item", id), updated: it.updated, needsOwner, checks });
    for (const child of r.children(id).sort(r.compareSiblings)) walk(child);
  }
  for (const area of r.areas()) walk(area);
  for (const id of Object.keys(s.items)) walk(id); // retain inspectability of malformed imported trees
  return out.slice(0, f.limit ?? 50);
}
export interface NoteFilters { state?: Note["state"][]; under?: string; kind?: Note["kind"][]; since?: string; limit?: number }
export function notes(s: Snapshot, f: NoteFilters = {}) {
  validateScope(s, f);
  const r = makeRules(s);
  return Object.entries(s.notes).filter(([, n]) => (!f.state || f.state.includes(n.state)) && (!f.kind || f.kind.includes(n.kind)) &&
    (!f.since || Date.parse(n.repliedAt ?? n.sentAt ?? n.at) >= Date.parse(f.since)) && inScope(r, noteItem(s, n), f))
    .sort((a, b) => Date.parse(b[1].repliedAt ?? b[1].sentAt ?? b[1].at) - Date.parse(a[1].repliedAt ?? a[1].sentAt ?? a[1].at) || a[0].localeCompare(b[0]))
    .slice(0, f.limit ?? 50).map(([id, note]) => ({ ...row(s, r, "note", id), ...note }));
}
function relevantNotes(s: Snapshot, targets: string[], limit?: number) {
  return notes(s, { limit: Object.keys(s.notes).length }).filter(n => targets.includes(n.target)).slice(0, limit);
}
function dependency(s: Snapshot, r: Rules, kind: "item" | "card", id: string) {
  const exists = Object.hasOwn(kind === "item" ? s.items : s.decisions, id);
  return { ...(exists ? row(s, r, kind, id) : { kind, id, title: "(missing)", status: "missing" }) };
}
/** Stored order is kept; levels expose parallelism without silently sorting the plan. */
export function planLines(s: Snapshot, r: Rules, id: string, fold = false): string[] {
  const rows = r.planRows(id), groups = r.planGroups(id), lines: string[] = [];
  const resolved = rows.filter(p => p.state === "resolved");
  const done = resolved.filter(p => !p.dropped).length, dropped = resolved.filter(p => p.dropped).length;
  if (fold && done) lines.push(`✓ ${done} 项已完成`);
  if (fold && dropped) lines.push(`✗ ${dropped} 项已放弃`);
  for (const [i, p] of rows.entries()) {
    if (fold && (p.state === "resolved" || p.excluded)) continue;
    const row = p.row, parallel = groups.some(g => g.start <= i && i < g.end);
    const prefix = `L${p.level} ${parallel ? "‖ " : ""}${p.glyph} ${row.id} `;
    if ("text" in row) { lines.push(prefix + (row.accept ? "[验收] " : "") + r.stepLine(row).slice(2)); continue; }
    if ("card" in row) { lines.push(`${prefix}${s.decisions[row.card]?.question ?? "(missing card)"} · ${s.decisions[row.card]?.status ?? "missing"}`); continue; }
    const owner = r.parentOf(row.item), current = r.planRows(row.item).filter(p => p.state === "progress" && "text" in p.row);
    const activity = current.map(p => "text" in p.row ? r.stepLine(p.row) : "").join("; ");
    lines.push(`${prefix}${row.own ? "[own]" : `[shared @${owner ?? "top"}]`} ${s.items[row.item]?.title ?? "(missing item)"} · ${r.statusOf(row.item) ?? "记录"}${row.own && activity ? ` · ${activity}` : ""}`);
  }
  return lines;
}
export function context(s: Snapshot, r: Rules, ref: string, options: { log?: number | "all" } = {}) {
  const { kind, id } = requireId(s, ref);
  if (kind === "card") {
    const card = s.decisions[id]!;
    return { kind, id, card, item: row(s, r, "item", card.item), notes: relevantNotes(s, [`q:${id}`]) };
  }
  const it = s.items[id]!, count = options.log === "all" ? it.log.length : options.log ?? 5;
  const log = count === 0 ? [] : it.log.slice(-count), cardIds = r.cardsOf(id);
  const levels = r.planRows(id).map(p => p.level), seen = new Set<number>(), repeated = new Set<number>();
  for (let i = 0; i < levels.length; i++) if (levels[i] !== levels[i - 1]) { if (seen.has(levels[i]!)) repeated.add(levels[i]!); seen.add(levels[i]!); }
  const lastPush = s.activity?.sessions?.[id];
  const pauseOwner = r.pausedBy(id), pause = pauseOwner ? s.items[pauseOwner]?.paused : undefined;
  return { ...row(s, r, "item", id), ...(lastPush ? { lastPush } : {}), ...(pause && r.isPaused(id) ? { pausedBy: { id: pauseOwner!, title: s.items[pauseOwner!]!.title, ...pause } } : {}), plan: planLines(s, r, id), groups: r.planGroups(id), planWarnings: [...repeated].map(level => `level ${level}: non-adjacent parallel rows are shown in stored order`), targets: (it.targets ?? []).map(targetLine), item: { ...it, log }, earlierLogs: it.log.length - log.length,
    ancestors: r.ancestors(id).map(a => row(s, r, "item", a)),
    dependents: r.dependents(id).filter(d => !d.own).map(d => ({ ...dependency(s, r, "item", d.id), own: d.own })),
    cards: cardIds.map(key => {
      const card = s.decisions[key]!;
      return card.status === "open" ? { key, ...card } : { key, ...(card.num === undefined ? {} : { num: card.num }), status: card.status, question: card.question, ruling: card.ruling, ruledAt: card.ruledAt };
    }), notes: relevantNotes(s, [`it:${id}`, ...cardIds.map(c => `q:${c}`)], 5), checks: r.checks(id), links: it.links, prs: references(documentText(s, "item", id), knownRepos(s)) };
}

export interface GraphNode { kind: "item" | "card"; id: string; num?: number; title: string; status: string | undefined; record?: boolean; own?: boolean; open: boolean; cycle: boolean; blockedChain: boolean; truncated: boolean; next: GraphNode[] }
export function graph(s: Snapshot, r: Rules, ref: string, options: { direction: "up" | "down" | "both"; depth?: number }) {
  const { kind: rootKind, id } = requireId(s, ref), depth = options.depth ?? 3;
  function walk(kind: "item" | "card", key: string, direction: "up" | "down", remaining: number, path: Set<string>, own?: boolean, blockedAncestor = false): GraphNode {
    const token = `${kind}:${key}`, cycle = path.has(token), d = dependency(s, r, kind, key);
    const open = kind === "item" ? r.isOpenWork(key) : s.decisions[key]?.status === "open";
    const edges = direction === "up" ? kind === "item" ? r.depsOf(key) : [] : (kind === "item" ? r.dependents(key) : r.cardDependents(key)).map(e => ({ ...e, kind: "item" as const }));
    const nextPath = new Set([...path, token]);
    const onBlockedChain = open && (blockedAncestor || d.status === "blocked");
    const next = cycle || remaining <= 0 ? [] : edges.map(e => walk(e.kind, e.id, direction, remaining - 1, nextPath, e.own, onBlockedChain));
    return { kind, id: key, ...("num" in d && d.num !== undefined ? { num: d.num } : {}), title: d.title, status: d.status, ...(own === undefined ? {} : { own }), open, cycle,
      blockedChain: open && (onBlockedChain || next.some(n => n.open && n.blockedChain)), truncated: !cycle && remaining <= 0 && edges.length > 0, next };
  }
  return { id, ...(options.direction !== "down" ? { up: walk(rootKind, id, "up", depth, new Set()) } : {}), ...(options.direction !== "up" ? { down: walk(rootKind, id, "down", depth, new Set()) } : {}) };
}
export function overview(s: Snapshot, r: Rules, f: { group?: string; status?: Status[] } = {}) {
  const areas = r.areas().filter(id => (f.group === undefined || r.groupOf(id) === f.group) && !["done", "cancelled"].includes(r.statusOf(id) ?? "")).map(id => {
    const rows = list(s, r, { under: id, status: f.status, limit: Object.keys(s.items).length });
    const leaves = list(s, r, { under: id, status: f.status ?? [...STATUSES], limit: Object.keys(s.items).length }).filter(it => r.isStatusLeaf(it.id));
    const counts = Object.fromEntries(STATUSES.map(st => [st, leaves.filter(it => it.status === st).length])) as Record<Status, number>;
    const area = row(s, r, "item", id);
    return { ...area, counts, ownerActions: rows.filter(it => it.needsOwner), blocked: leaves.filter(it => it.status === "blocked"), checks: rows.filter(it => it.checks.length) };
  });
  const names = [...new Set([...s.board.projects.map(p => p.name), ...areas.map(a => a.group)])];
  return names.filter(name => f.group === undefined || name === f.group).map(name => ({ project: name, areas: areas.filter(a => a.group === name) }));
}

export function projects(s: Snapshot, r: Rules = makeRules(s)) {
  return s.board.projects.map(project => {
    const leaves = Object.keys(s.items).filter(id => r.projectOf(id) === project.name);
    return { ...project, areas: r.areas().filter(id => r.projectOf(id) === project.name).length,
      openItems: Object.fromEntries((["todo", "wip", "blocked", "paused"] as const).map(st => [st, leaves.filter(id => r.statusOf(id) === st).length])) };
  });
}
function sentNotes(s: Snapshot, r: Rules) {
  return Object.entries(s.notes).filter(([,n]) => n.state === "sent").map(([id,n]) => ({ id, target: n.target, title: row(s,r,"note",id).title, kind: n.kind, text: n.text, ...(n.answerText !== undefined ? { answerText: n.answerText } : {}), sentAt: n.sentAt ?? n.at,
    project: r.projectOf(noteItem(s,n)) })).sort((a,b) => Date.parse(a.sentAt)-Date.parse(b.sentAt) || a.id.localeCompare(b.id));
}
/** The approved tags, with meanings, that an item of `project` may carry; every tag when no project is given. */
export function tagVocabulary(s: Snapshot, project?: string) {
  return boardTags(s.board).filter(t => project === undefined || tagApplies(t, project)).map(t => ({ name: t.name, meaning: t.meaning, ...(t.projects ? { projects: t.projects } : {}) }));
}
const tagsOf = (doc: { tags?: string[] }) => doc.tags?.length ? { tags: doc.tags } : {};
/** Absent for unrated work and for records; the 缺难度 check says when a rating is the one thing missing. */
function difficultyOf(doc: { difficulty?: Difficulty } | undefined): { difficulty?: Difficulty } { return doc?.difficulty === undefined ? {} : { difficulty: doc.difficulty }; }
const numOf = (doc: { num?: number }) => doc.num === undefined ? {} : { num: doc.num };
export function brief(s: Snapshot, r: Rules, project: string) {
  const config = s.board.projects.find(p => p.name === project);
  if (!config) throw new Error(`project ${project}: choose a configured project with projects`);
  const ids = Object.keys(s.items).filter(id => r.projectOf(id) === project), eligible = ids.filter(id => !r.isBacklog(id));
  const outgoing = new Set<string>();
  for (const id of ids.filter(id => r.isOpenWork(id))) for (const dep of r.depsOf(id)) if (dep.kind === "item" && r.isOpenWork(dep.id) && r.projectOf(dep.id) !== project) outgoing.add(dep.id);
  const progressLines = (id: string) => ({
    ...(s.items[id]?.plan?.length ? { plan: planLines(s, r, id, true) } : {}),
    ...(s.items[id]?.targets?.length ? { targets: s.items[id]!.targets!.map(targetLine) } : {}),
  });
  const workRow = (id: string): Row => ({ ...row(s,r,"item",id), ...progressLines(id) });
  /** Current work also says which session last wrote to it, so the architect sees whether it is being pushed. */
  const wipRow = (id: string): Row & { lastPush?: string } => { const last = s.activity?.sessions?.[id]; return { ...workRow(id), ...(last ? { lastPush: pushLine(last) } : {}) }; };
  const result = { project,
    notes: sentNotes(s,r).filter(n => n.project === project),
    checks: ids.map(id => ({ id, ...numOf(s.items[id]!), ...tagsOf(s.items[id]!), ...difficultyOf(s.items[id]), title: s.items[id]!.title, ...progressLines(id), checks: r.checks(id) })).filter(it => it.checks.length),
    cards: Object.keys(s.decisions).filter(id => r.projectOf(s.decisions[id]!.item) === project && r.cardWaiting(id)).map(id => ({id,...numOf(s.decisions[id]!),item:s.decisions[id]!.item,question:s.decisions[id]!.question,...(s.decisions[id]!.blocks ? {blocks:s.decisions[id]!.blocks} : {})})),
    paused: eligible.filter(id => r.statusOf(id) === "paused").sort(r.compareSiblings).map(workRow),
    wip: eligible.filter(id => r.isOpenWork(id) && r.statusOf(id) !== "paused" && r.planRows(id).some(p => "text" in p.row && p.row.state === "doing")).sort(r.compareSiblings).map(wipRow),
    todo: eligible.filter(id => r.isNeeded(id) && s.items[id]!.difficulty !== undefined && r.statusOf(id) !== "blocked" && r.statusOf(id) !== "paused" && r.planRows(id).some(p => p.ready && "text" in p.row && p.row.state === "todo")).sort(r.compareSiblings).slice(0,10).map(workRow),
    outgoing: [...outgoing].map(workRow),
    glossary: (s.glossaries[project]?.terms ?? []).map(t => t.term),
    tags: tagVocabulary(s, project),
  };
  const shown = new Set([...result.checks, ...result.wip, ...result.todo, ...result.paused, ...result.outgoing].map(item => item.id));
  const progress = ids.filter(id => !shown.has(id) && (s.items[id]!.record || r.statusOf(id) === "blocked"))
    .map(id => ({ id, ...numOf(s.items[id]!), ...tagsOf(s.items[id]!), ...difficultyOf(s.items[id]), title: s.items[id]!.title, ...progressLines(id) }));
  return { ...result, progress };
}
/** Glossaries in board project order: one project's, or every project's that holds a term. */
export function glossary(s: Snapshot, project?: string) {
  if (project !== undefined && !s.board.projects.some(p => p.name === project)) throw new Error(`project ${project}: choose a configured project with projects`);
  return s.board.projects.filter(p => project === undefined ? s.glossaries[p.name]?.terms.length : p.name === project)
    .map(p => ({ project: p.name, terms: s.glossaries[p.name]?.terms ?? [] }));
}
export function followups(s: Snapshot, r: Rules, { minutes }: { minutes: number }, now = new Date().toISOString()) {
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("minutes: provide a nonnegative age");
  const cutoff = Date.parse(now) - minutes * 60000;
  return { notes: sentNotes(s,r).filter(n => Date.parse(n.sentAt) < cutoff) };
}

function documentText(s: Snapshot, kind: Kind, id: string): string {
  const text = fields(s, kind, id).map(f => f.text);
  if (kind === "item") {
    const it = s.items[id]!;
    text.push(...it.links.map(l => `${l.label} ${l.url}`), it.ask?.url ?? "");
  }
  return text.join("\n");
}
/** Repositories the board knows, lowercased: the configured projects' and those its items link to (github.com/Ming-Research/<repo>).
 * These are the names a `Repo#N` or `Repo #N` reference may use. */
export function knownRepos(s: Snapshot): Set<string> {
  const out = new Set<string>(), urls: string[] = [];
  for (const project of s.board.projects) if (project.repo) out.add(project.repo.split("/").pop()!.toLowerCase());
  for (const it of Object.values(s.items)) urls.push(...it.links.map(l => l.url), it.ask?.url ?? "");
  for (const url of urls) { const m = /github\.com\/Ming-Research\/([A-Za-z0-9_.-]+)/i.exec(url); if (m) out.add(m[1]!.toLowerCase()); }
  return out;
}
/** A PR a text names. `owner` is set only when the text wrote it: `Owner/Repo#N` or a pull request URL. */
export interface PrRef { repo: string; number: number; owner?: string }
/** PR references in prose. A bare name before `#N` counts as a repository only when the board knows that repository, so "see #341" stays unknown.
 * `Owner/Repo#N` and a pull request URL name the repository themselves. */
export function references(text: string, repos: Set<string>) {
  const qualified: PrRef[] = [], unknown: number[] = [], ranges: Array<[number, number]> = [];
  const patterns = [
    /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\b/gi,
    /(?<![A-Za-z0-9_.\/#-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?: PR)? ?#(\d+)\b/gi,
    /(?<![A-Za-z0-9_.\/#-])()([A-Za-z0-9_.-]+)(?: PR)? ?#(\d+)\b/gi,
  ];
  for (const [i, pattern] of patterns.entries()) for (const match of text.matchAll(pattern)) {
    const owner = match[1]!, repo = match[2]!, number = Number(match[3]);
    if (i === 2 && !repos.has(repo.toLowerCase())) continue;
    ranges.push([match.index, match.index + match[0].length]);
    if (!qualified.some(p => p.repo.toLowerCase() === repo.toLowerCase() && p.number === number)) qualified.push(owner ? { repo, number, owner } : { repo, number });
  }
  for (const match of text.matchAll(/#(\d+)\b/g)) if (!ranges.some(([a, b]) => match.index >= a && match.index < b) && !unknown.includes(Number(match[1]))) unknown.push(Number(match[1]));
  return { qualified, unknown };
}
/** A PR as the board watches it: `repo` is the `Owner/Name` a project configures. */
export interface PrId { repo: string; number: number }
export const prKey = (p: PrId): string => `${p.repo.toLowerCase()}#${p.number}`;
/** The configured repository a reference names, or none: `Owner/Repo` must match a project's repo, a bare `Repo` exactly one. */
function repoOf(projects: readonly Project[], ref: PrRef): string | undefined {
  const repos = projects.flatMap(p => p.repo ? [p.repo] : []);
  if (ref.owner) return repos.find(repo => repo.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase());
  const named = repos.filter(repo => repo.split("/").pop()!.toLowerCase() === ref.repo.toLowerCase());
  return named.length === 1 ? named[0] : undefined;
}
/** The PRs a text names that belong to a configured repository. */
export function pullsIn(s: Snapshot, text: string, repos: Set<string> = knownRepos(s)): PrId[] {
  const out = new Map<string, PrId>();
  for (const ref of references(text, repos).qualified) {
    const repo = repoOf(s.board.projects, ref);
    if (repo) out.set(prKey({ repo, number: ref.number }), { repo, number: ref.number });
  }
  return [...out.values()];
}
/** The PRs a step of item `id` is the merge row of: none unless it is a merge step (rules isOpenMergeStep) and names PRs its item's 改动 section names too. */
export function mergeRowPulls(s: Snapshot, id: string, step: PlanStep, repos: Set<string> = knownRepos(s)): PrId[] {
  if (!isOpenMergeStep(step)) return [];
  const named = pullsIn(s, step.text, repos), counted = new Set(countedPulls(named.map(prKey), pullsIn(s, changesSection(s.items[id]?.head), repos).map(prKey)));
  return named.filter(p => counted.has(prKey(p)));
}
export function prs(s: Snapshot, r: Rules, repo: string, number: number) {
  const qualified: Row[] = [], unknown: Row[] = [], repos = knownRepos(s);
  for (const kind of ["item", "card", "note"] as const) for (const id of Object.keys(kind === "item" ? s.items : kind === "card" ? s.decisions : s.notes)) {
    const refs = references(documentText(s, kind, id), repos);
    // The tool's repository is a name under Ming-Research: a reference written with another owner is another repository's PR.
    if (refs.qualified.some(p => p.repo.toLowerCase() === repo.toLowerCase() && p.number === number && (p.owner === undefined || p.owner.toLowerCase() === "ming-research"))) qualified.push(row(s, r, kind, id));
    if (refs.unknown.includes(number)) unknown.push(row(s, r, kind, id));
  }
  return { qualified, unknown };
}

export function describeChanges(before: unknown, after: unknown, kind: DocKind): string {
  if (before === null && after === null) return `created and deleted ${kind === "decision" ? "card" : kind}`;
  if (before === null) return `new ${kind === "decision" ? "card" : kind}`;
  if (after === null) return `deleted ${kind === "decision" ? "card" : kind}`;
  const a = before as Record<string, unknown>, b = after as Record<string, unknown>, changes: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    // A short number is issued once and never changes; numbering existing documents is not news.
    if (["rev", "updated", "num"].includes(key) || isDeepStrictEqual(a[key], b[key])) continue;
    if (key === "plan") {
      if (planChanged(a.plan as PlanRow[] | undefined, b.plan as PlanRow[] | undefined)) changes.push("plan changed");
    } else if (key === "targets") {
      if (targetsChanged(a.targets as ItemTarget[] | undefined, b.targets as ItemTarget[] | undefined)) changes.push("targets changed");
    } else if (key === "tags") {
      changes.push(`tags ${((a.tags as string[] | undefined) ?? []).join(" ") || "none"}→${((b.tags as string[] | undefined) ?? []).join(" ") || "none"}`);
    } else if (key === "log") {
      const oldLog = a.log as unknown[] ?? [], newLog = b.log as unknown[] ?? [];
      if (newLog.length > oldLog.length && isDeepStrictEqual(oldLog, newLog.slice(0, oldLog.length))) changes.push(`+${newLog.length - oldLog.length} log`);
      else changes.push("log changed");
    } else if (key === "record") changes.push(b.record ? "changed to record" : "changed to work item");
    else if (key === "status") changes.push(`status ${a.status ?? "unset"}→${b.status ?? "unset"}`);
    else if (key === "reply" && !a.reply && b.reply) changes.push("new reply");
    else if (["at", "repliedAt", "repliedBy", "ruledAt"].includes(key)) continue;
    else changes.push(`${key} ${b[key] === undefined ? "cleared" : "changed"}`);
  }
  return changes.join(", ") || "metadata changed";
}
export interface DocumentChange { kind: Kind; id: string; title: string; summary: string; commits: CommitInfo[] }
export async function changes(store: Store, s: Snapshot, since: string, f: Scope = {}) {
  if (f.under !== undefined && !Object.hasOwn(s.items, f.under) && !(await store.log({ kind: "item", id: f.under, limit: 1 })).length) throw new Error(`under ${f.under}: choose an existing or historical item subtree`);
  // Only the commits of the range are listed and read, so what a call costs follows the range and never the length of the
  // history (docs/design.md, section 4, Request budgets).
  const listed = await store.log({ since, at: s.head });
  allowRange(listed.length);
  const commits = listed.filter(c => !/^\d{4}-\d{2}-\d{2}T/.test(since) || Date.parse(c.at) > Date.parse(since)).reverse();
  const docs = new Map<string, { kind: Exclude<DocKind, "glossary">; id: string; commits: CommitInfo[] }>();
  for (const commit of commits) for (const file of commit.files) {
    const match = /^(items|decisions|notes)\/(.+)\.yaml$/.exec(file);
    if (!match) continue;
    const kind = ({ items: "item", decisions: "decision", notes: "note" } as const)[match[1] as "items" | "decisions" | "notes"], id = match[2]!;
    const key = `${kind}:${id}`, doc = docs.get(key) ?? { kind, id, commits: [] };
    doc.commits.push(commit); docs.set(key, doc);
  }
  // A document the snapshot no longer holds was deleted in the range. Its last version is its file in the commit before the
  // one that deleted it: one file read, never a rebuilt board.
  const gone: { items: Record<string, unknown>; decisions: Record<string, unknown>; notes: Record<string, unknown> } = { items: {}, decisions: {}, notes: {} };
  const changed: Array<{ doc: { kind: Exclude<DocKind, "glossary">; id: string; commits: CommitInfo[] }; before: unknown | null; after: unknown | null }> = [];
  for (const doc of docs.values()) {
    const first = doc.commits[0]!, last = doc.commits.at(-1)!, collection = ({ item: "items", decision: "decisions", note: "notes" } as const)[doc.kind];
    const before = first.parents[0] ? await store.showCompared(doc.kind, doc.id, first.parents[0]) : null;
    const after = await store.showCompared(doc.kind, doc.id, last.commit);
    if (!Object.hasOwn(s[collection], doc.id)) {
      const final = after ?? (last.parents[0] ? await store.showCompared(doc.kind, doc.id, last.parents[0]) : null);
      if (final === null) continue;
      gone[collection][doc.id] = final;
    }
    changed.push({ doc, before, after });
  }
  // The board for the deleted documents: the snapshot with their last versions added, whose rules are worked out once, and
  // only when a document needs them. A document whose item the snapshot holds takes the snapshot's own ownership: a root
  // there stays a root, and a surviving owner that dropped the row stays detached. An item whose owner was deleted before
  // the range has no owner to find here, and is grouped as the top of its own project.
  const r = makeRules(s), grouped = new Map<string, { areaId: string; area: string; documents: DocumentChange[] }>();
  const deleted = Object.values(gone).some(collection => Object.keys(collection).length > 0);
  const view: Snapshot = deleted ? { ...s, items: { ...s.items, ...gone.items } as Snapshot["items"], decisions: { ...s.decisions, ...gone.decisions } as Snapshot["decisions"], notes: { ...s.notes, ...gone.notes } as Snapshot["notes"] } : s;
  let viewRules: Rules | undefined;
  const rulesFor = (owner: string): Rules => !deleted || Object.hasOwn(s.items, owner) ? r : (viewRules ??= makeRules(view));
  /** A card that is gone from the view still has the item the store last saw it on. */
  const cardItem = (card: string): string => view.decisions[card]?.item ?? store.cardItem(card) ?? "";
  const ownerOf = (kind: Kind, id: string): string => {
    if (kind === "item") return id;
    if (kind === "card") return view.decisions[id]?.item ?? "";
    const target = view.notes[id]!.target;
    return target.startsWith("it:") ? target.slice(3) : cardItem(target.slice(2));
  };
  for (const { doc, before, after } of changed) {
    const kind: Kind = doc.kind === "decision" ? "card" : doc.kind, owner = ownerOf(kind, doc.id), vr = rulesFor(owner);
    if (!inScope(vr, owner, f)) continue;
    const meta = row(view, vr, kind, doc.id, owner), group = grouped.get(meta.areaId) ?? { areaId: meta.areaId, area: meta.area, documents: [] };
    group.documents.push({ kind, id: doc.id, title: meta.title, summary: describeChanges(before, after, doc.kind), commits: doc.commits }); grouped.set(meta.areaId, group);
  }
  return [...grouped.values()];
}
export async function history(store: Store, kind: DocKind, id: string, limit = 20): Promise<CommitInfo[]> {
  const commits = await store.log({ kind, id, limit: limit === 0 ? 1 : limit });
  if (!commits.length) throw new Error(`Unknown ${kind} id ${id}; use search or list to find a document`);
  return limit === 0 ? [] : commits;
}
async function resolveTime(store: Store, ref: string): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(ref)) return ref;
  const at = Date.parse(ref);
  if (!Number.isFinite(at)) throw new Error("time: provide a valid ISO timestamp");
  // Git goes back from the head to the first commit at or before the time; it does not list the history to find it.
  const commit = await store.commitAt(at);
  if (!commit) throw new Error(`time ${ref}: no board revision existed yet; choose a later time or a commit`);
  return commit;
}
export async function diff(store: Store, kind: DocKind, id: string, from: string, to?: string): Promise<string> {
  await history(store, kind, id, 1);
  return store.diff(kind, id, await resolveTime(store, from), to === undefined ? undefined : await resolveTime(store, to));
}
