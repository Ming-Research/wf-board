// The runner's block of the agent list: one row for each piece of work the runner holds, read from the runner's report on the item
// (what the work is doing and since when), the engineer's dispatch record (its level) and, for a turn running now, the runner's last
// beat (src/live.ts). Imported by the page and by tests, like src/agents.ts. docs/design.md, section 7, "Agent list", gives the
// reasons for each rule.

import { openDispatchesOf } from "./dispatch.ts";
import { runnerHolds } from "./agents.ts";
import { LIVE_FRESH_MS } from "./live.ts";
import type { LiveEntry } from "./live.ts";
import type { Dispatch, Item, RunnerState } from "./model.ts";
import type { Rules } from "./rules.ts";
import { limitOf, reportText } from "./whole-view.ts";

/** A turn running now, as the runner's last beat describes it. */
export interface RunnerTurn {
  turn: number;
  startedAt: number;
  lastActionAt?: number;
  action?: string;
  /** When the board last heard the runner say so. */
  heardAt: number;
  /** The runner said nothing about it for LIVE_FRESH_MS: the runner or the turn may have stopped. */
  silent: boolean;
}
export interface RunnerRow {
  /** The item the runner holds; also the engineer session's name. */
  item: string;
  agent: string;
  level: number;
  model: string;
  effort?: string;
  state: RunnerState;
  /** What the report says in a few words: the words of the whole view. */
  what: string;
  /** Since when the work has been in this state, when it began, and the rounds and dollars it has taken so far. */
  since: number;
  started: number;
  turns?: number;
  cost?: number;
  /** Past the time its state may last (the whole view's limits), or reported as an exception. */
  overdue: boolean;
  /** When the turn in progress began: from its beat, else from the report that said a turn began. Only for the state `running`. */
  turnStartedAt?: number;
  /** The beat of the engineer's turn, when the runner sends them and the report says a turn is running. */
  live?: RunnerTurn;
  /** The architect's turn that answers this work's question, when the report says it asks the architect and the runner says it runs one. */
  architect?: RunnerTurn;
}

function turnOf(entry: LiveEntry, now: number): RunnerTurn {
  const heardAt = Date.parse(entry.at);
  return {
    turn: entry.turn, startedAt: Date.parse(entry.turnStartedAt),
    ...(entry.lastActionAt === undefined ? {} : { lastActionAt: Date.parse(entry.lastActionAt) }),
    ...(entry.action === undefined ? {} : { action: entry.action }),
    heardAt, silent: now - heardAt > LIVE_FRESH_MS,
  };
}

/** An item with its key: the page already holds the board's items so (`ViewItem` in web/app.ts). */
export type HeldItem = Pick<Item, "runner" | "record" | "dispatches"> & { id: string };

/**
 * The rows at `now`: every open, unpaused piece of work the runner holds, the ones needing a look first (overdue), then those with a
 * turn running, then the waiting ones, the longest in their state first. A report with no engineer dispatch of the runner's job open
 * is a leftover and not listed. The beats count only while they agree with the report: an engineer's while the report says a turn
 * runs, the architect's while it says the work asks the architect. The items come as a list, not as the snapshot's keyed object: the
 * page redraws the list on every write, and listing the keys of a board this size again costs more than the whole pass over the items.
 */
export function runnerRows(items: Iterable<HeldItem>, r: Pick<Rules, "isOpenWork" | "isPaused">, beats: readonly LiveEntry[], now: number): RunnerRow[] {
  const byKey = new Map(beats.map(b => [`${b.role}:${b.item}`, b]));
  const rows: RunnerRow[] = [];
  for (const it of items) {
    const report = it.runner, item = it.id;
    if (!report || it.record || !r.isOpenWork(item) || r.isPaused(item)) continue;
    const dispatch: Dispatch | undefined = openDispatchesOf(it).find(d => runnerHolds(it, d));
    if (!dispatch) continue;
    const since = Date.parse(report.since);
    const row: RunnerRow = {
      item, agent: dispatch.agent, level: dispatch.level, model: dispatch.model, ...(dispatch.effort === undefined ? {} : { effort: dispatch.effort }),
      state: report.state, what: reportText(report), since, started: Date.parse(report.started),
      ...(report.turns === undefined ? {} : { turns: report.turns }), ...(report.cost === undefined ? {} : { cost: report.cost }),
      overdue: report.state === "exception" || now - since > limitOf(report),
    };
    if (report.state === "running") {
      const beat = byKey.get(`工程师:${item}`);
      if (beat) row.live = turnOf(beat, now);
      row.turnStartedAt = row.live?.startedAt ?? Date.parse(report.at);
    }
    if (report.state === "ask" && report.to === "architect") {
      const beat = byKey.get(`架构师:${item}`);
      if (beat) row.architect = turnOf(beat, now);
    }
    rows.push(row);
  }
  const rank = (x: RunnerRow) => x.overdue ? 0 : x.state === "running" ? 1 : 2;
  return rows.sort((a, b) => rank(a) - rank(b) || a.since - b.since || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
}
