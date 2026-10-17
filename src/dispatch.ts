// Dispatch records: the agent sessions the PM (or the architect) started on items. A dispatch lives on its item (`Item.dispatches`);
// this module reads them across the board, tallies them and words the log lines the two write tools append. The
// columns and fixed options are the dispatch format's (schemas in model.ts); docs/design.md section 5 gives the reasons.

import { DISPATCH_RESULTS, DISPATCH_ROLES, DISPATCH_SIGNALS, milliDollars } from "./model.ts";
import type { Dispatch, Snapshot } from "./model.ts";

type Role = (typeof DISPATCH_ROLES)[number];
type Result = (typeof DISPATCH_RESULTS)[number];
type Signal = (typeof DISPATCH_SIGNALS)[number];

/** A dispatch with the item it belongs to. */
export interface DispatchRow { item: string; project: string; tags: string[]; dispatch: Dispatch }
/** `since` and `until` bound the start time: since inclusive, until exclusive. */
export interface DispatchFilters { id?: string; role?: Role; level?: number; since?: string; until?: string }

/** A UTC time written to the minute (2026-10-16T09:02Z) or in full, as the full form; undefined for any other text. */
export function normalizeTime(text: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2}(?:\.\d{1,3})?)?Z$/.exec(text);
  if (!m) return undefined;
  const full = `${m[1]}${m[2] ?? ":00"}Z`;
  return Number.isNaN(Date.parse(full)) ? undefined : full;
}
const minute = (time: string) => `${time.slice(0, 16)}Z`;
const dollars = (milli: number) => `$${(milli / 1000).toFixed(3)}`;

/** The dispatches that match the filters, oldest start first. */
export function dispatchRows(s: Snapshot, f: DispatchFilters = {}): DispatchRow[] {
  const since = f.since === undefined ? undefined : Date.parse(f.since), until = f.until === undefined ? undefined : Date.parse(f.until);
  const rows: DispatchRow[] = [];
  for (const [item, it] of Object.entries(s.items)) {
    if (f.id !== undefined && item !== f.id) continue;
    for (const dispatch of it.dispatches ?? []) {
      const started = Date.parse(dispatch.started);
      if ((f.role !== undefined && dispatch.role !== f.role) || (f.level !== undefined && dispatch.level !== f.level)
        || (since !== undefined && started < since) || (until !== undefined && started >= until)) continue;
      rows.push({ item, project: it.group, tags: it.tags ?? [], dispatch });
    }
  }
  return rows.sort((a, b) => Date.parse(a.dispatch.started) - Date.parse(b.dispatch.started) || a.item.localeCompare(b.item) || a.dispatch.agentId.localeCompare(b.dispatch.agentId));
}

/** One table row: the rows of one level, role or tag. Costs are whole thousandths of a dollar so sums are exact. */
export interface Tally {
  label: string;
  /** Every dispatch; `open` of them have not ended, and `results` counts the rest. */
  n: number;
  open: number;
  results: Record<Result, number>;
  /** (返工后通过 + 换人) over the ended dispatches. */
  rework: { count: number; ended: number };
  /** Mean kickbacks over ended engineer dispatches, mean rounds over ended review dispatches. */
  kickbacks: { sum: number; n: number };
  rounds: { sum: number; n: number };
  costMilli: number;
}
export function tally(label: string, rows: readonly DispatchRow[]): Tally {
  const t: Tally = { label, n: rows.length, open: 0, results: Object.fromEntries(DISPATCH_RESULTS.map(r => [r, 0])) as Record<Result, number>, rework: { count: 0, ended: 0 }, kickbacks: { sum: 0, n: 0 }, rounds: { sum: 0, n: 0 }, costMilli: 0 };
  for (const { dispatch: d } of rows) {
    const f = d.finish;
    if (!f) { t.open++; continue; }
    t.results[f.result]++;
    t.rework.ended++;
    if (f.result === "返工后通过" || f.result === "换人") t.rework.count++;
    if (d.role === "工程师") { t.kickbacks.sum += f.kickbacks!; t.kickbacks.n++; } else { t.rounds.sum += f.rounds!; t.rounds.n++; }
    t.costMilli += milliDollars(f.cost);
  }
  return t;
}

export interface Summary {
  total: Tally;
  byLevel: Tally[];
  byRole: Tally[];
  /** An item with several tags counts once under each, so these tallies can add up to more than the total. */
  byTag: Tally[];
  /** Ended dispatches carrying each failure signal. */
  signals: Record<Signal, number>;
}
const NO_TAG = "（无标签）";
export function summarize(rows: readonly DispatchRow[]): Summary {
  const levels = [...new Set(rows.map(r => r.dispatch.level))].sort((a, b) => a - b);
  const tags = [...new Set(rows.flatMap(r => r.tags))].sort();
  const signals = Object.fromEntries(DISPATCH_SIGNALS.map(s => [s, 0])) as Record<Signal, number>;
  for (const { dispatch: d } of rows) for (const sig of d.finish?.signals ?? []) signals[sig.kind]++;
  return {
    total: tally("合计", rows),
    byLevel: levels.map(l => tally(`${l} 级`, rows.filter(r => r.dispatch.level === l))),
    byRole: DISPATCH_ROLES.filter(role => rows.some(r => r.dispatch.role === role)).map(role => tally(role, rows.filter(r => r.dispatch.role === role))),
    byTag: [...tags.map(tag => tally(tag, rows.filter(r => r.tags.includes(tag)))), ...(rows.some(r => !r.tags.length) ? [tally(NO_TAG, rows.filter(r => !r.tags.length))] : [])],
    signals,
  };
}

const mean = (m: { sum: number; n: number }) => m.n ? (m.sum / m.n).toFixed(2) : "-";
function tallyLine(t: Tally): string {
  const ratio = t.rework.ended ? `${Math.round(t.rework.count / t.rework.ended * 100)}%（${t.rework.count}/${t.rework.ended}）` : "-";
  return [`${t.label}：派活 ${t.n}（进行中 ${t.open}）`, ...DISPATCH_RESULTS.map(r => `${r} ${t.results[r]}`), `返工比例 ${ratio}`, `平均打回 ${mean(t.kickbacks)}`, `平均轮数 ${mean(t.rounds)}`, `花费 ${dollars(t.costMilli)}`].join(" · ");
}
function usageText(d: NonNullable<Dispatch["finish"]>): string {
  return `输入 ${d.usage.input}，写缓存 ${d.usage.cacheWrite}，读缓存 ${d.usage.cacheRead}，输出 ${d.usage.output}`;
}
const signalsText = (f: NonNullable<Dispatch["finish"]>) => f.signals.length ? f.signals.map(s => s.note ? `${s.kind}（${s.note}）` : s.kind).join("、") : "无";
const countsText = (d: Dispatch) => d.role === "工程师" ? `报告 ${d.finish!.reports} 次，打回 ${d.finish!.kickbacks} 次` : `审查 ${d.finish!.rounds} 轮`;

/** The text of `dispatches`: the tallies, and with `rows` one line per dispatch. */
export function dispatchReport(rows: readonly DispatchRow[], withRows = false): string {
  if (!rows.length) return "No dispatches.";
  const s = summarize(rows);
  const out = [tallyLine(s.total), `失败信号（已结束的派活里各有几次）：${DISPATCH_SIGNALS.map(sig => `${sig} ${s.signals[sig]}`).join(" · ")}`];
  out.push("", "按等级", ...s.byLevel.map(tallyLine), "", "按角色", ...s.byRole.map(tallyLine));
  out.push("", "按条目的标签（条目有几个标签就每个标签各算一次，所以这张表加起来可能比合计多）", ...s.byTag.map(tallyLine));
  if (withRows) out.push("", "逐行", ...rows.map(dispatchLine));
  return out.join("\n");
}
export function dispatchLine({ item, dispatch: d }: DispatchRow): string {
  const f = d.finish, head = `${minute(d.started)}${f ? `–${minute(f.ended)}` : "起，进行中"} · ${item} · 会话 ${d.agent}（号 ${d.agentId}） · ${d.role} · ${d.level} 级 ${d.model}${d.effort ? ` ${d.effort}` : ""}`;
  return f ? `${head} · ${countsText(d)} · ${f.result} · 失败信号：${signalsText(f)} · 用量 ${usageText(f)} · ${dollars(milliDollars(f.cost))}${f.waited === undefined ? "" : ` · 等待 ${f.waited} 分钟`}${f.note ? ` · 备注：${f.note}` : ""}${d.did ? ` · 做：${d.did}` : ""}` : `${head}${d.did ? ` · 做：${d.did}` : ""}`;
}

/** The log line `dispatch_start` appends to the item. */
export function startLogLine(d: Dispatch): string {
  return `起：会话 ${d.agent}（号 ${d.agentId}），${d.role}，${d.level} 级 ${d.model}${d.effort ? `，推理强度 ${d.effort}` : ""}${d.worktree ? `，工作树 ${d.worktree}` : ""}，${minute(d.started)}${d.did ? `，做：${d.did}` : ""}`;
}
/** The log line `dispatch_finish` appends: every column of the ended dispatch. */
export function finishLogLine(d: Dispatch, corrected: boolean): string {
  const f = d.finish!;
  return `收${corrected ? "（更正）" : ""}：会话 ${d.agent}（${d.role}），${f.result}，${countsText(d)}，${minute(d.started)}–${minute(f.ended)}${f.waited === undefined ? "" : `，等待 ${f.waited} 分钟`}，用量 ${usageText(f)}，花费 ${dollars(milliDollars(f.cost))}，失败信号：${signalsText(f)}${f.note ? `，备注：${f.note}` : ""}`;
}

/** The dispatches on an item that have not ended, newest start first: the one reading of "who is on an item", which holderOf
 * reads for the pushes (docs/design.md, The wake streams). */
export function openDispatches(s: Pick<Snapshot, "items">, item: string): Dispatch[] {
  return (s.items[item]?.dispatches ?? []).filter(d => !d.finish).sort((a, b) => Date.parse(b.started) - Date.parse(a.started));
}
/** The session holding an item: the agent of the newest open engineer dispatch on it, or none. A takeover's dispatch is newer
 * than the one it replaces, so it holds the item from its start; a review holds nothing. */
export function holderOf(s: Pick<Snapshot, "items">, item: string): string | undefined {
  return openDispatches(s, item).find(d => d.role === "工程师")?.agent;
}
/** Every session holding an item. */
export function holders(s: Pick<Snapshot, "items">): Set<string> {
  const out = new Set<string>();
  for (const id of Object.keys(s.items)) { const h = holderOf(s, id); if (h !== undefined) out.add(h); }
  return out;
}
