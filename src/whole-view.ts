// The whole view: every open work item of the board sorted by what is being done about it, in one pass over the items. The
// architect reads it with the `whole_view` tool and the owner on the page, and both get this function's result: it is imported
// by the server and bundled into the page, like src/agents.ts. docs/design.md, section 6, "The whole view", gives the reasons
// for each rule.

import { liveDispatches } from "./agents.ts";
import type { RunnerReport, Snapshot } from "./model.ts";
import type { Rules } from "./rules.ts";

/** The five kinds an open work item falls into, in the order the answer lists them: what needs the reader most comes first. */
export const BUCKETS = ["overdue", "unattended", "working", "waiting", "parked"] as const;
export type Bucket = (typeof BUCKETS)[number];
export const BUCKET_TEXT: Readonly<Record<Bucket, string>> = { overdue: "等太久", unattended: "没人管", working: "在做", waiting: "在等", parked: "搁着" };

const MINUTE = 60_000, HOUR = 60 * MINUTE;
/**
 * How long an item may stay in a state before it is overdue. These are starting values, the one place to change them; real data
 * will tell which are wrong. `plan` is for a wait the runner did not report, read only from the plan (an item that waits on
 * another item, a card or the owner), where the time counts from the item's last change.
 */
export const WAIT_LIMITS_MS = {
  running: 5 * HOUR, ci: 90 * MINUTE, ownerAsk: 12 * HOUR, architectAsk: HOUR, items: 24 * HOUR, run: 4 * HOUR, ready: HOUR, done: 30 * MINUTE,
  exception: 0, plan: 72 * HOUR,
} as const;
/** How long the state of a runner report may last. */
export function limitOf(report: Pick<RunnerReport, "state" | "to">): number {
  return report.state === "ask" ? report.to === "owner" ? WAIT_LIMITS_MS.ownerAsk : WAIT_LIMITS_MS.architectAsk : WAIT_LIMITS_MS[report.state];
}

/** The most rows the default answer lists for each kind; `bucket` lists one kind with EXPANDED_ROWS. The rest are counted. */
export const BUCKET_ROWS: Readonly<Record<Bucket, number>> = { overdue: 8, unattended: 8, working: 8, waiting: 8, parked: 4 };
export const EXPANDED_ROWS = 40;

export interface WholeRow {
  id: string;
  num?: number;
  project: string;
  title: string;
  bucket: Exclude<Bucket, "parked">;
  /** What the work is doing or waits on, in a few words. */
  what: string;
  /** Since when `what` has held, in ms; absent when the board cannot tell. */
  since?: number;
  /** For an overdue row: how long its state may last. */
  limit?: number;
  /** Where the row was read from: the runner's report, a live session's dispatch record, or the plan alone. */
  from: "runner" | "session" | "plan";
  /** An unattended item nothing was done on yet, as against one left half done. */
  fresh?: true;
  /** When the work began, and what the runner says it has taken so far. */
  started?: number;
  turns?: number;
  cost?: number;
}
/** A pause that holds work back: the item that carries the marker, and how many open work items stand paused because of it. */
export interface ParkedRow { id: string; num?: number; project: string; title: string; reason: string; at: number; count: number }
export interface ProjectCount {
  project: string;
  /** The open work items listed under the five kinds, parked ones included. */
  remaining: number;
  byBucket: Record<Bucket, number>;
  /** Open work items in a backlog (owned by a record): not started on purpose, so not one of the five kinds. */
  backlog: number;
}
export interface WholeView {
  now: number;
  /** In the order of BUCKETS and, within a kind, in the order the answer lists them. */
  rows: WholeRow[];
  /** The pauses, the ones holding back the most work first. */
  parked: ParkedRow[];
  /** In the configured project order, projects with nothing open left out. */
  projects: ProjectCount[];
}

type Input = Pick<Snapshot, "items" | "board"> & { activity?: Snapshot["activity"] };

/** What a runner report says in a few words. */
export function reportText(report: RunnerReport): string {
  const what = report.state === "running" ? "跑一轮"
    : report.state === "ci" ? "等 CI"
    : report.state === "ask" ? report.to === "owner" ? `问主人（卡 ${report.cards!.join("、")}）` : "问架构师"
    : report.state === "items" ? `等条目 ${report.items!.join("、")}`
    : report.state === "run" ? "要 14900K"
    : report.state === "ready" ? "合入核对"
    : report.state === "exception" ? "例外，要人看"
    : "做完，待收尾";
  return report.note ? `${what}：${report.note}` : what;
}

/** A length of time as a reader says it: 「12 分钟」, 「3 小时 20 分」, 「4 天」. */
export function spanText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE));
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 48) return `${hours} 小时${rest ? ` ${rest} 分` : ""}`;
  return `${Math.floor(hours / 24)} 天`;
}

/** The time of the last change to an item: its last content write, or its own `updated`. */
function lastChange(s: Input, id: string): number {
  const at = s.activity?.items?.[id], own = Date.parse(s.items[id]!.updated);
  return Math.max(own, at === undefined ? -Infinity : Date.parse(at));
}

/** The open work of the board, one pass; `r` is the rules of `s` at `now`. */
export function wholeView(s: Input, r: Rules, now: number): WholeView {
  const rows: WholeRow[] = [], parked = new Map<string, ParkedRow>(), counts = new Map<string, ProjectCount>();
  const countOf = (project: string): ProjectCount => {
    let c = counts.get(project);
    if (!c) { c = { project, remaining: 0, byBucket: { overdue: 0, unattended: 0, working: 0, waiting: 0, parked: 0 }, backlog: 0 }; counts.set(project, c); }
    return c;
  };
  for (const id of Object.keys(s.items)) {
    // Records, done and cancelled items are not open work.
    if (!r.isOpenWork(id)) continue;
    const it = s.items[id]!, project = r.projectOf(id), c = countOf(project);
    if (r.isBacklog(id)) { c.backlog++; continue; }
    const report = it.runner, engineer = liveDispatches(s, id, now).find(d => d.role === "工程师");
    // A parent with open sub-items is its sub-items' business; it is a row of its own only when a session works on it itself.
    if (!report && !engineer && r.children(id).some(child => r.isOpenWork(child))) continue;
    c.remaining++;
    if (r.isPaused(id)) {
      const source = r.pausedBy(id) ?? id, marker = s.items[source]?.paused, src = s.items[source] ?? it;
      const row = parked.get(source) ?? { id: source, ...(src.num === undefined ? {} : { num: src.num }), project: r.projectOf(source), title: src.title, reason: marker?.reason ?? "", at: marker ? Date.parse(marker.at) : lastChange(s, source), count: 0 };
      row.count++;
      parked.set(source, row);
      c.byBucket.parked++;
      continue;
    }
    const base = { id, ...(it.num === undefined ? {} : { num: it.num }), project, title: it.title };
    let row: WholeRow;
    if (report) {
      const since = Date.parse(report.since), limit = limitOf(report);
      const overdue = report.state === "exception" || now - since > limit;
      row = { ...base, bucket: overdue ? "overdue" : report.state === "running" ? "working" : "waiting", what: reportText(report), since, ...(overdue ? { limit } : {}), from: "runner", started: Date.parse(report.started), ...(report.turns === undefined ? {} : { turns: report.turns }), ...(report.cost === undefined ? {} : { cost: report.cost }) };
    } else if (engineer) {
      row = { ...base, bucket: "working", what: `会话 ${engineer.agent}`, since: Date.parse(engineer.started), from: "session", started: Date.parse(engineer.started) };
    } else if (r.statusOf(id) === "blocked") {
      const p = r.progress(id), waits = [...p.waiting.map(w => `${w.kind === "item" ? "条目" : "卡"} ${w.id}`), ...(p.ask ? ["主人批准"] : [])];
      const what = waits.length ? `等${waits.length > 3 ? `${waits.slice(0, 3).join("、")} 等 ${waits.length} 项` : waits.join("、")}` : "排在前面的行之后";
      const since = lastChange(s, id), overdue = now - since > WAIT_LIMITS_MS.plan;
      row = { ...base, bucket: overdue ? "overdue" : "waiting", what, since, ...(overdue ? { limit: WAIT_LIMITS_MS.plan } : {}), from: "plan" };
    } else {
      const begun = r.begun(id), ratio = r.planRatio(id), doing = it.plan.some(step => "text" in step && step.state === "doing");
      row = { ...base, bucket: "unattended", what: begun ? `做了一半：${ratio.done}/${ratio.total} 行${doing ? "，有行标着进行中却没有会话" : ""}` : "没开始", since: lastChange(s, id), from: "plan", ...(begun ? {} : { fresh: true as const }) };
    }
    c.byBucket[row.bucket]++;
    rows.push(row);
  }
  const over = (x: WholeRow) => now - (x.since ?? now) - (x.limit ?? 0);
  const rank = (x: WholeRow) => BUCKETS.indexOf(x.bucket);
  rows.sort((a, b) => rank(a) - rank(b) || (a.bucket === "overdue" ? over(b) - over(a)
    : a.bucket === "unattended" ? Number(a.fresh ?? false) - Number(b.fresh ?? false) || (a.fresh ? r.compareCandidates(a.id, b.id) : (a.since ?? 0) - (b.since ?? 0))
    : (a.since ?? 0) - (b.since ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const order = new Map(s.board.projects.map((p, i) => [p.name, i]));
  const projects = [...counts.values()].filter(c => c.remaining || c.backlog).sort((a, b) => (order.get(a.project) ?? 1e9) - (order.get(b.project) ?? 1e9) || (a.project < b.project ? -1 : 1));
  return { now, rows, parked: [...parked.values()].sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1)), projects };
}

/** The first `max` characters of a text, then an ellipsis. */
const cut = (text: string, max: number): string => { const chars = [...text.replace(/\s+/g, " ").trim()]; return chars.length <= max ? chars.join("") : `${chars.slice(0, max).join("")}…`; };
const numText = (x: { num?: number }): string => x.num === undefined ? "" : ` · #${x.num}`;

/** One row as a line of the answer. */
export function rowLine(x: WholeRow, now: number): string {
  const age = x.since === undefined ? "" : ` · ${spanText(now - x.since)}`;
  const limit = x.limit === undefined || x.limit === 0 ? "" : `（门槛 ${spanText(x.limit)}）`;
  const spent = x.from === "runner" && x.started !== undefined ? ` · 共 ${spanText(now - x.started)}${x.turns === undefined ? "" : `，${x.turns} 轮`}${x.cost === undefined ? "" : ` $${x.cost.toFixed(2)}`}` : "";
  return `${x.id} · ${x.project} · ${cut(x.title, 24)} · ${x.what}${age}${limit}${spent}${numText(x)}`;
}
export function parkedLine(x: ParkedRow, now: number): string {
  return `${x.id} · ${x.project} · ${cut(x.title, 24)} · 下面 ${x.count} 件 · 暂停 ${spanText(now - x.at)}${x.reason ? ` · ${cut(x.reason, 40)}` : ""}${numText(x)}`;
}

export interface WholeViewOptions { bucket?: Bucket | undefined; project?: string | undefined }

/** The view narrowed to one project, its totals counted again from what is left. */
export function inProject(view: WholeView, project: string): WholeView {
  const only = view.projects.filter(p => p.project === project);
  const parked = view.parked.filter(p => p.project === project);
  return { ...view, rows: view.rows.filter(x => x.project === project), parked, projects: only };
}

/**
 * The text a tool answers with: a line of totals, then each kind that has rows, at most BUCKET_ROWS[kind] rows of it (or
 * EXPANDED_ROWS when `bucket` names it) with the rest counted, then what each project has left.
 */
export function wholeViewText(full: WholeView, o: WholeViewOptions = {}): string {
  const view = o.project === undefined ? full : inProject(full, o.project), now = view.now;
  const total = (key: Bucket) => view.projects.reduce((n, p) => n + p.byBucket[key], 0);
  const remaining = view.projects.reduce((n, p) => n + p.remaining, 0), backlog = view.projects.reduce((n, p) => n + p.backlog, 0);
  if (!remaining && !backlog) return o.project === undefined ? "没有没做完的工作。" : `${o.project}：没有没做完的工作。`;
  const out = [`全貌${o.project === undefined ? "" : ` · ${o.project}`} · 没做完的工作 ${remaining} 件：${BUCKETS.map(b => `${BUCKET_TEXT[b]} ${total(b)}`).join(" · ")}${backlog ? `；待选 ${backlog} 件不在内` : ""}`];
  for (const bucket of BUCKETS) {
    if (o.bucket !== undefined && o.bucket !== bucket) continue;
    const limit = o.bucket === undefined ? BUCKET_ROWS[bucket] : EXPANDED_ROWS;
    if (bucket === "parked") {
      if (!view.parked.length) continue;
      out.push(`${BUCKET_TEXT.parked} ${total("parked")} 件，${view.parked.length} 处暂停`, ...view.parked.slice(0, limit).map(x => `  ${parkedLine(x, now)}`));
      if (view.parked.length > limit) out.push(`  … 还有 ${view.parked.length - limit} 处暂停没列出（bucket: parked 列全）`);
      continue;
    }
    const mine = view.rows.filter(x => x.bucket === bucket);
    if (!mine.length) continue;
    const fresh = bucket === "unattended" ? mine.filter(x => x.fresh).length : 0;
    out.push(`${BUCKET_TEXT[bucket]} ${mine.length}${bucket === "unattended" ? `（做了一半 ${mine.length - fresh} · 没开始 ${fresh}）` : ""}`, ...mine.slice(0, limit).map(x => `  ${rowLine(x, now)}`));
    if (mine.length > limit) out.push(`  … 还有 ${mine.length - limit} 件没列出（bucket: ${bucket} 列全${bucket === "unattended" ? "；没开始的也可用 candidates 看" : ""}）`);
  }
  if (o.bucket === undefined && view.projects.length) {
    out.push("各项目还剩：", ...view.projects.map(p => `  ${p.project} ${p.remaining} 件${p.remaining ? `（${BUCKETS.filter(b => p.byBucket[b]).map(b => `${BUCKET_TEXT[b]} ${p.byBucket[b]}`).join(" · ")}）` : ""}${p.backlog ? ` · 待选 ${p.backlog}` : ""}`));
  }
  return out.join("\n");
}
