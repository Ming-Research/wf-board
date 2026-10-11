import { isDeepStrictEqual } from "node:util";
import type { Decision, Item, Note, Priority, Snapshot, Status } from "./model.ts";
import { STATUSES } from "./model.ts";
import type { Rules } from "./rules.ts";
import { rules as makeRules } from "./rules.ts";
import type { CommitInfo, DocKind, Store } from "./store.ts";

export type Kind = "item" | "card" | "note";
export interface Row { kind: Kind; id: string; title: string; status: string; priority?: Priority | ""; area: string; areaId: string; group: string; agents: string[] }
export interface Scope { group?: string; under?: string }
export interface SearchFilters extends Scope { status?: Status[]; kind?: Kind[]; since?: string; limit?: number }
/** One hit per matching field; `more` counts further matches in the same field. */
export interface Hit extends Row { field: string; time?: string; snippet: string; more?: number }
function requireId(s: Snapshot, id: string): Kind {
  if (Object.hasOwn(s.items, id)) return "item";
  if (Object.hasOwn(s.decisions, id)) return "card";
  throw new Error(`Unknown id ${id}; use search or list to find an item or card`);
}
function noteItem(s: Snapshot, n: Note): string { return n.target.startsWith("it:") ? n.target.slice(3) : s.decisions[n.target.slice(2)]?.item ?? ""; }
function itemId(s: Snapshot, kind: Kind, id: string): string {
  return kind === "item" ? id : kind === "card" ? s.decisions[id]?.item ?? "" : noteItem(s, s.notes[id]!);
}
export function row(s: Snapshot, r: Rules, kind: Kind, id: string): Row {
  const owner = itemId(s, kind, id), areaId = r.lineOf(owner);
  const card = kind === "card" ? s.decisions[id] : kind === "note" && s.notes[id]?.target.startsWith("q:") ? s.decisions[s.notes[id]!.target.slice(2)] : undefined;
  return { kind, id, title: card?.question ?? s.items[owner]?.title ?? s.notes[id]?.target ?? id,
    status: kind === "item" ? r.statusOf(id) : kind === "card" ? s.decisions[id]!.status : s.notes[id]!.state,
    ...(kind === "item" ? { priority: r.effectivePriorityOf(id) } : {}), area: s.items[areaId]?.title ?? areaId, areaId,
    group: r.groupOf(owner), agents: r.agentsFor(owner) };
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
      { field: "ask", text: it.ask?.text ?? "", rank: 1 }, ...it.log.map((l, i) => ({ field: `log[${i}]`, text: `${l.at} ${l.by ?? ""} ${l.text}`, rank: 2, time: l.at, index: i }))];
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
        if (!inScope(r, owner, f) || f.status && !f.status.includes(r.statusOf(owner))) continue;
        hits.push({ ...h, field: "pr", snippet: `«${label}»`, rank, index: 0 });
      }
  }
  for (const kind of f.kind ?? ["item", "card", "note"]) {
    const docs = kind === "item" ? s.items : kind === "card" ? s.decisions : s.notes;
    for (const id of Object.keys(docs)) {
      const owner = itemId(s, kind, id);
      if (!inScope(r, owner, f) || f.status && !f.status.includes(r.statusOf(owner))) continue;
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

export interface ListFilters extends Scope { status?: Status[]; priority?: Priority[]; agent?: string; needsOwner?: boolean; hasChecks?: boolean; updatedSince?: string; limit?: number }
export function list(s: Snapshot, r: Rules, f: ListFilters = {}) {
  validateScope(s, f);
  const out: Array<Row & { updated: string; needsOwner: boolean; checks: ReturnType<Rules["checks"]> }> = [];
  const seen = new Set<string>();
  function walk(id: string): void {
    // An untriaged request is not work yet: it shows in its project's inbox (brief, projects), not in lists.
    if (seen.has(id) || !s.items[id] || r.isRequest(id)) return;
    seen.add(id);
    const it = s.items[id]!, checks = r.checks(id), needsOwner = r.needsOwner(id);
    if (inScope(r, id, f) && (!f.status || f.status.includes(r.statusOf(id))) && (!f.priority || f.priority.some(p => p === r.effectivePriorityOf(id))) &&
      (f.agent === undefined || r.agentsFor(id).includes(f.agent)) && (f.needsOwner === undefined || needsOwner === f.needsOwner) &&
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
function dependency(s: Snapshot, r: Rules, kind: "item" | "card", id: string, why: string) {
  const exists = Object.hasOwn(kind === "item" ? s.items : s.decisions, id);
  return { ...(exists ? row(s, r, kind, id) : { kind, id, title: "(missing)", status: "missing" }), why };
}
export function context(s: Snapshot, r: Rules, id: string, options: { log?: number | "all" } = {}) {
  const kind = requireId(s, id);
  if (kind === "card") {
    const card = s.decisions[id]!;
    return { kind, id, card, item: row(s, r, "item", card.item), notes: relevantNotes(s, [`q:${id}`]) };
  }
  const it = s.items[id]!, count = options.log === "all" ? it.log.length : options.log ?? 5;
  const log = count === 0 ? [] : it.log.slice(-count), cardIds = r.cardsOf(id);
  return { ...row(s, r, "item", id), item: { ...it, log }, raisedBy: r.raisedBy(id), earlierLogs: it.log.length - log.length,
    ancestors: r.ancestors(id).map(a => row(s, r, "item", a)), children: r.children(id).sort(r.compareSiblings).map(c => row(s, r, "item", c)),
    deps: r.depsOf(id).map(d => ({ ...dependency(s, r, d.kind, d.id, d.why), open: d.open, missing: d.missing })),
    dependents: r.dependents(id).map(d => dependency(s, r, "item", d.id, d.why)),
    cards: cardIds.map(key => {
      const card = s.decisions[key]!;
      return card.status === "open" ? { key, ...card } : { key, status: card.status, question: card.question, ruling: card.ruling, ruledAt: card.ruledAt };
    }), notes: relevantNotes(s, [`it:${id}`, ...cardIds.map(c => `q:${c}`)], 5), checks: r.checks(id), links: it.links, prs: references(documentText(s, "item", id), knownRepos(s)) };
}

export interface GraphNode { kind: "item" | "card"; id: string; title: string; status: string; why?: string; open: boolean; cycle: boolean; blockedChain: boolean; truncated: boolean; next: GraphNode[] }
export function graph(s: Snapshot, r: Rules, id: string, options: { direction: "up" | "down" | "both"; depth?: number }) {
  const rootKind = requireId(s, id) as "item" | "card", depth = options.depth ?? 3;
  function walk(kind: "item" | "card", key: string, direction: "up" | "down", remaining: number, path: Set<string>, why?: string, blockedAncestor = false): GraphNode {
    const token = `${kind}:${key}`, cycle = path.has(token), d = dependency(s, r, kind, key, why ?? "");
    const open = kind === "item" ? !!s.items[key] && !["done", "cancelled"].includes(r.statusOf(key)) : s.decisions[key]?.status === "open";
    const edges = direction === "up" ? kind === "item" ? r.depsOf(key) : [] : (kind === "item" ? r.dependents(key) : r.cardDependents(key)).map(e => ({ ...e, kind: "item" as const }));
    const nextPath = new Set([...path, token]);
    const onBlockedChain = open && (blockedAncestor || d.status === "blocked");
    const next = cycle || remaining <= 0 ? [] : edges.map(e => walk(e.kind, e.id, direction, remaining - 1, nextPath, e.why, onBlockedChain));
    return { kind, id: key, title: d.title, status: d.status, ...(why === undefined ? {} : { why }), open, cycle,
      blockedChain: open && (onBlockedChain || next.some(n => n.open && n.blockedChain)), truncated: !cycle && remaining <= 0 && edges.length > 0, next };
  }
  return { id, ...(options.direction !== "down" ? { up: walk(rootKind, id, "up", depth, new Set()) } : {}), ...(options.direction !== "up" ? { down: walk(rootKind, id, "down", depth, new Set()) } : {}) };
}
export function overview(s: Snapshot, r: Rules, f: { group?: string } = {}) {
  const areas = r.areas().filter(id => f.group === undefined || r.groupOf(id) === f.group).map(id => {
    const rows = list(s, r, { under: id, limit: Object.keys(s.items).length }), leaves = rows.filter(it => r.isLeaf(it.id));
    const counts = Object.fromEntries(STATUSES.map(st => [st, leaves.filter(it => it.status === st).length])) as Record<Status, number>;
    const { agents: _agents, ...area } = row(s, r, "item", id);
    return { ...area, counts, ownerActions: rows.filter(it => it.needsOwner), blocked: leaves.filter(it => it.status === "blocked"), checks: rows.filter(it => it.checks.length) };
  });
  const names = [...new Set([...s.board.projects.map(p => p.name), ...areas.map(a => a.group)])];
  return names.filter(name => f.group === undefined || name === f.group).map(name => ({ project: name, agents: s.board.projects.find(p => p.name === name)?.agents ?? [], inbox: r.inbox(name).length, areas: areas.filter(a => a.group === name) }));
}

export function projects(s: Snapshot, r: Rules = makeRules(s)) {
  return s.board.projects.map(project => {
    const leaves = Object.keys(s.items).filter(id => r.projectOf(id) === project.name && r.isLeaf(id) && !r.isRequest(id));
    return { ...project, agents: project.agents.slice(), areas: r.areas().filter(id => r.projectOf(id) === project.name).length,
      openLeaves: Object.fromEntries((["todo", "wip", "blocked"] as const).map(st => [st, leaves.filter(id => r.statusOf(id) === st).length])), inbox: r.inbox(project.name).length };
  });
}
function requestRow(s: Snapshot, r: Rules, id: string) {
  const it = s.items[id]!, request = it.request!;
  const prefix = `${request.by} 提出：`;
  const first = it.log[0]?.text ?? "";
  return { id, title: it.title, project: r.projectOf(id), agents: r.agentsFor(id), by: request.by, at: request.at, why: first.startsWith(prefix) ? first.slice(prefix.length) : first };
}
function sentNotes(s: Snapshot, r: Rules) {
  return Object.entries(s.notes).filter(([,n]) => n.state === "sent").map(([id,n]) => ({ id, target: n.target, title: row(s,r,"note",id).title, kind: n.kind, text: n.text, sentAt: n.sentAt ?? n.at,
    project: r.projectOf(noteItem(s,n)), agents: r.agentsFor(noteItem(s,n)) })).sort((a,b) => Date.parse(a.sentAt)-Date.parse(b.sentAt) || a.id.localeCompare(b.id));
}
export function brief(s: Snapshot, r: Rules, project: string) {
  const config = s.board.projects.find(p => p.name === project);
  if (!config) throw new Error(`project ${project}: choose a configured project with projects`);
  const ids = Object.keys(s.items).filter(id => r.projectOf(id) === project), leaves = ids.filter(id => r.isLeaf(id) && !r.isRequest(id) && !r.inArchive(id));
  const outgoing = new Set(Object.keys(s.items).filter(id => r.projectOf(id) !== project && r.isRequest(id) && config.agents.includes(s.items[id]!.request!.by)));
  for (const id of ids) for (const dep of r.depsOf(id)) if (dep.kind === "item" && dep.open && r.projectOf(dep.id) !== project) outgoing.add(dep.id);
  return { project, agents: config.agents.slice(), inbox: r.inbox(project).map(id => requestRow(s,r,id)),
    notes: sentNotes(s,r).filter(n => n.project === project),
    checks: ids.map(id => ({ id, title: s.items[id]!.title, checks: r.checks(id) })).filter(it => it.checks.length),
    cards: Object.keys(s.decisions).filter(id => r.projectOf(s.decisions[id]!.item) === project && r.cardWaiting(id)).map(id => ({id,item:s.decisions[id]!.item,question:s.decisions[id]!.question})),
    wip: leaves.filter(id => r.statusOf(id) === "wip").sort(r.compareSiblings).map(id => row(s,r,"item",id)),
    todo: leaves.filter(id => r.statusOf(id) === "todo").sort(r.compareSiblings).slice(0,10).map(id => row(s,r,"item",id)),
    outgoing: [...outgoing].map(id => ({...row(s,r,"item",id), ...(r.isRequest(id) ? requestRow(s,r,id) : {})})),
  };
}
export function followups(s: Snapshot, r: Rules, { minutes }: { minutes: number }, now = new Date().toISOString()) {
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("minutes: provide a nonnegative age");
  const cutoff = Date.parse(now) - minutes * 60000;
  return { notes: sentNotes(s,r).filter(n => Date.parse(n.sentAt) < cutoff),
    requests: s.board.projects.flatMap(p => r.inbox(p.name).map(id => requestRow(s,r,id))).filter(it => Date.parse(it.at) < cutoff).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at) || a.id.localeCompare(b.id)) };
}

function documentText(s: Snapshot, kind: Kind, id: string): string {
  const text = fields(s, kind, id).map(f => f.text);
  if (kind === "item") {
    const it = s.items[id]!;
    text.push(...it.links.map(l => `${l.label} ${l.url}`), ...it.deps.map(d => d.why), it.ask?.url ?? "");
  }
  return text.join("\n");
}
/** Repositories the board links to (github.com/Ming-Research/<repo>), lowercased: the names a `Repo#N` or `Repo #N` reference may use. */
export function knownRepos(s: Snapshot): Set<string> {
  const out = new Set<string>(), urls: string[] = [];
  for (const it of Object.values(s.items)) urls.push(...it.links.map(l => l.url), it.ask?.url ?? "");
  for (const url of urls) { const m = /github\.com\/Ming-Research\/([A-Za-z0-9_.-]+)/i.exec(url); if (m) out.add(m[1]!.toLowerCase()); }
  return out;
}
/** PR references in prose. A name before `#N` counts as a repository only when the board links to that repository, so "see #341" stays unknown. */
export function references(text: string, repos: Set<string>) {
  const qualified: Array<{ repo: string; number: number }> = [], unknown: number[] = [], ranges: Array<[number, number]> = [];
  const patterns = [/https?:\/\/github\.com\/Ming-Research\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\b/gi, /(?<![A-Za-z0-9_.\/#-])([A-Za-z0-9_.-]+)(?: PR)? ?#(\d+)\b/gi];
  for (const [i, pattern] of patterns.entries()) for (const match of text.matchAll(pattern)) {
    const repo = match[1]!, number = Number(match[2]);
    if (i === 1 && !repos.has(repo.toLowerCase())) continue;
    ranges.push([match.index, match.index + match[0].length]);
    if (!qualified.some(p => p.repo.toLowerCase() === repo.toLowerCase() && p.number === number)) qualified.push({ repo, number });
  }
  for (const match of text.matchAll(/#(\d+)\b/g)) if (!ranges.some(([a, b]) => match.index >= a && match.index < b) && !unknown.includes(Number(match[1]))) unknown.push(Number(match[1]));
  return { qualified, unknown };
}
export function prs(s: Snapshot, r: Rules, repo: string, number: number) {
  const qualified: Row[] = [], unknown: Row[] = [], repos = knownRepos(s);
  for (const kind of ["item", "card", "note"] as const) for (const id of Object.keys(kind === "item" ? s.items : kind === "card" ? s.decisions : s.notes)) {
    const refs = references(documentText(s, kind, id), repos);
    if (refs.qualified.some(p => p.repo.toLowerCase() === repo.toLowerCase() && p.number === number)) qualified.push(row(s, r, kind, id));
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
    if (["rev", "updated"].includes(key) || isDeepStrictEqual(a[key], b[key])) continue;
    // An item that gained sub-items loses its own status and priority, now derived from them; its log records the split.
    if (kind === "item" && (key === "status" || key === "priority") && b[key] === undefined) continue;
    if (key === "log") {
      const oldLog = a.log as unknown[] ?? [], newLog = b.log as unknown[] ?? [];
      if (newLog.length > oldLog.length && isDeepStrictEqual(oldLog, newLog.slice(0, oldLog.length))) changes.push(`+${newLog.length - oldLog.length} log`);
      else changes.push("log changed");
    } else if (key === "status") changes.push(`status ${a.status ?? "unset"}→${b.status ?? "unset"}`);
    else if (key === "reply" && !a.reply && b.reply) changes.push("new reply");
    else if (["at", "repliedAt", "repliedBy", "ruledAt"].includes(key)) continue;
    else changes.push(`${key} ${b[key] === undefined ? "cleared" : "changed"}`);
  }
  return changes.join(", ") || "metadata changed";
}
export interface DocumentChange { kind: Kind; id: string; title: string; summary: string; commits: CommitInfo[] }
export async function changes(store: Store, s: Snapshot, since: string, f: Scope = {}) {
  if (f.under !== undefined && !Object.hasOwn(s.items, f.under) && !(await store.log({ kind: "item", id: f.under, limit: 1 })).length) throw new Error(`under ${f.under}: choose an existing or historical item subtree`);
  const all = await store.log(), headIndex = all.findIndex(c => c.commit === s.head);
  if (headIndex === -1) throw new Error("snapshot head: not found in store history");
  const selected = new Set((await store.log({ since })).map(c => c.commit));
  const commits = all.slice(headIndex).filter(c => selected.has(c.commit) && (!/^\d{4}-\d{2}-\d{2}T/.test(since) || Date.parse(c.at) > Date.parse(since))).reverse();
  const docs = new Map<string, { kind: DocKind; id: string; commits: CommitInfo[] }>();
  for (const commit of commits) for (const file of commit.files) {
    const match = /^(items|decisions|notes)\/(.+)\.yaml$/.exec(file);
    if (!match) continue;
    const kind = ({ items: "item", decisions: "decision", notes: "note" } as const)[match[1] as "items" | "decisions" | "notes"], id = match[2]!;
    const key = `${kind}:${id}`, doc = docs.get(key) ?? { kind, id, commits: [] };
    doc.commits.push(commit); docs.set(key, doc);
  }
  const r = makeRules(s), grouped = new Map<string, { areaId: string; area: string; documents: DocumentChange[] }>();
  const historicalCache = new Map<string, unknown | null>();
  for (const doc of docs.values()) {
    const before = await store.show(doc.kind, doc.id, `${doc.commits[0]!.commit}^`), after = await store.show(doc.kind, doc.id, doc.commits.at(-1)!.commit);
    const kind: Kind = doc.kind === "decision" ? "card" : doc.kind;
    // Historical deletions remain visible; their last content supplies ownership.
    const lastBefore = `${doc.commits.at(-1)!.commit}^`;
    const lastIndex = all.findIndex(c => c.commit === doc.commits.at(-1)!.commit);
    async function historicalDocument(kind: DocKind, id: string): Promise<unknown | null> {
      const cacheKey = `${lastBefore}:${kind}:${id}`;
      if (historicalCache.has(cacheKey)) return historicalCache.get(cacheKey)!;
      let found = await store.show(kind, id, lastBefore);
      if (found === null) {
        const path = `${kind === "item" ? "items" : kind === "decision" ? "decisions" : "notes"}/${id}.yaml`;
        // Recover the last known ownership, even if that owner was deleted in
        // an earlier commit. Never consult a revision after the document.
        for (const commit of all.slice(lastIndex + 1)) {
          if (!commit.files.includes(path)) continue;
          found = await store.show(kind, id, commit.commit);
          if (found !== null) break;
        }
      }
      historicalCache.set(cacheKey, found);
      return found;
    }
    const historical = after ?? await store.show(doc.kind, doc.id, lastBefore) ?? before;
    let view = s;
    const collection = kind === "item" ? "items" : kind === "card" ? "decisions" : "notes";
    if (!Object.hasOwn(s[collection], doc.id)) view = { ...s, [collection]: { ...s[collection], [doc.id]: historical } };
    // A deleted note/card can also have a deleted target. Recover only the
    // missing ownership chain at its last revision, without reading the board.
    async function recoverItem(id: string, seen = new Set<string>()): Promise<void> {
      if (!id || seen.has(id)) return;
      seen.add(id);
      if (!Object.hasOwn(view.items, id)) {
        const item = await historicalDocument("item", id) as Item | null;
        if (!item) return;
        view = { ...view, items: { ...view.items, [id]: item } };
      }
      if (view.items[id]?.parent) await recoverItem(view.items[id]!.parent!, seen);
    }
    if (kind === "note") {
      const target = view.notes[doc.id]!.target;
      if (target.startsWith("q:") && !Object.hasOwn(view.decisions, target.slice(2))) {
        const card = await historicalDocument("decision", target.slice(2)) as Decision | null;
        if (card) view = { ...view, decisions: { ...view.decisions, [target.slice(2)]: card } };
      }
    }
    await recoverItem(itemId(view, kind, doc.id));
    const vr = view === s ? r : makeRules(view), owner = itemId(view, kind, doc.id);
    if (!inScope(vr, owner, f)) continue;
    const meta = row(view, vr, kind, doc.id), group = grouped.get(meta.areaId) ?? { areaId: meta.areaId, area: meta.area, documents: [] };
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
  const commit = (await store.log()).find(c => Date.parse(c.at) <= at);
  if (!commit) throw new Error(`time ${ref}: no board revision existed yet; choose a later time or a commit`);
  return commit.commit;
}
export async function diff(store: Store, kind: DocKind, id: string, from: string, to?: string): Promise<string> {
  await history(store, kind, id, 1);
  return store.diff(kind, id, await resolveTime(store, from), to === undefined ? undefined : await resolveTime(store, to));
}
