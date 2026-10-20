// The agent list as one value: the runner's rows, the other sessions that are running, the number the heading shows, and the line
// about the runner's free slots. The page draws it and the `look` tool prints it, so the two cannot count differently. Imported by
// the server and bundled into the page, like src/agents.ts. docs/design.md, section 7, "Agent list", gives the reasons for each rule.

import { agentRows } from "./agents.ts";
import type { AgentRow } from "./agents.ts";
import type { LiveEntry } from "./live.ts";
import type { Snapshot } from "./model.ts";
import type { Rules } from "./rules.ts";
import { IDLE_TELL_MS, POOLS_FRESH_MS, dryMs, freeSlots } from "./runner-pools.ts";
import type { PoolsEntry } from "./runner-pools.ts";
import { runnerLine, runnerRows } from "./runner-rows.ts";
import type { HeldItem, NameOf, RunnerRow } from "./runner-rows.ts";
import { spanText } from "./whole-view.ts";

export interface AgentList {
  /** The work the runner holds, a row each (its review session is drawn with the row, not as another). */
  runner: RunnerRow[];
  /** The other sessions with an unfinished dispatch that is alive, and the rest, which sit behind one line. */
  running: AgentRow[];
  others: AgentRow[];
  /** The heading's number: the rows the list draws open, which is `runner` and `running`. */
  count: number;
}

/**
 * The list at `now`. The items come as an array with their keys, as the page holds them (see `agentRows`); `beats` are the runner's
 * beats for the turns running now.
 */
export function agentList(s: Pick<Snapshot, "items"> & { activity?: Snapshot["activity"] }, r: Pick<Rules, "isOpenWork" | "isPaused">, items: readonly HeldItem[], beats: readonly LiveEntry[], now: number): AgentList {
  const rows = agentRows(s, now, items), runner = runnerRows(items, r, beats, now);
  const running = rows.filter(row => row.running);
  return { runner, running, others: rows.filter(row => !row.running), count: runner.length + running.length };
}

/** What the line about the runner's slots says. `stale`: the report is older than POOLS_FRESH_MS; `idle`: some pool has had a free slot and nothing to start for IDLE_TELL_MS. */
export interface PoolsLine { text: string; stale: boolean; idle: boolean }

/**
 * The runner's free slots and how long the queue has had nothing for them, from its last heartbeat that carried the pools; none when
 * it has sent none. The runner reports durations and the board counts forward from the arrival, so the figures are those of `now`. A report the runner
 * has not repeated for POOLS_FRESH_MS is shown as the last one it made and says how long ago.
 */
export function poolsLine(entry: PoolsEntry | undefined, now: number): PoolsLine | undefined {
  if (!entry || !entry.pools.length) return undefined;
  const age = now - Date.parse(entry.at), stale = age > POOLS_FRESH_MS;
  let idle = false;
  const parts = entry.pools.map(p => {
    const free = freeSlots(p), dry = dryMs(entry, p, now);
    if (dry !== undefined && dry >= IDLE_TELL_MS) idle = true;
    if (free === 0) return `${p.label} 满 ${p.running}/${p.slots}`;
    return `${p.label} 空着 ${free} 个（共 ${p.slots}）${dry === undefined ? "" : `，派活队列里没有能开工的活已 ${spanText(dry)}`}`;
  });
  return { text: `${stale ? `名额（执行程序 ${spanText(age)}没报，下面是它上次报的）` : "名额"}：${parts.join("；")}`, stale, idle };
}

const cut = (text: string, max: number): string => { const chars = [...text.replace(/\s+/g, " ").trim()]; return chars.length <= max ? chars.join("") : `${chars.slice(0, max).join("")}…`; };
const TITLE_CHARS = 30;

/**
 * The list as the `look` tool prints it: the heading and its number, the line about the slots, a line for each piece of work the runner
 * holds and for each other session running, and how many sessions sit behind the page's fold. `titleOf` gives an item's title.
 */
export function agentListLines(list: AgentList, pools: PoolsEntry | undefined, now: number, titleOf: (id: string) => string | undefined, nameOf: NameOf): string[] {
  const out = [`代理 ${list.count}（执行程序手上 ${list.runner.length} 件，其他在跑的会话 ${list.running.length} 个${list.others.length ? `；没在跑的 ${list.others.length} 个页面上折着，这里不列` : ""}）`];
  const slots = poolsLine(pools, now);
  if (slots) out.push(slots.text + (slots.idle ? "（空过 1 小时）" : ""));
  for (const x of list.runner) {
    const line = runnerLine(x, now, nameOf);
    out.push(`  ${x.item} · ${cut(titleOf(x.item) ?? "", TITLE_CHARS)} · ${x.level} 级 · ${x.label} · ${spanText(now - (x.state === "running" ? x.turnStartedAt ?? x.since : x.since))}${line.text ? ` · ${cut(line.text, 80)}` : ""}`);
  }
  for (const row of list.running) {
    const touched = row.touched.map(t => t.item).join("、");
    const state = row.state === "waiting" ? `在等：${cut(row.waits ?? "", 60)}` : row.state === "working" ? "干活" : row.state === "maybe-stopped" ? "可能停了" : "";
    out.push(`  ${row.name} · ${row.role === "审查" ? "审查 " : ""}${row.level} 级${state ? ` · ${state}` : ""} · ${spanText(now - Date.parse(row.lastAt))}前${row.lastKind === "started" ? "起" : "写过"}${touched ? ` · ${touched}` : ""}`);
  }
  return out;
}
