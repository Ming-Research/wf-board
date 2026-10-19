// The runner's block of the agent list: one row for each piece of work the runner holds, read from the runner's report on the item
// (what the work is doing and since when), the engineer's dispatch record (its level) and, for a turn running now, the runner's last
// beat (src/live.ts), and the words the list's columns say. Imported by the page and by tests, like src/agents.ts.
// docs/design.md, section 7, "Agent list", gives the reasons for each rule.

import { openDispatchesOf } from "./dispatch.ts";
import { runnerHolds } from "./agents.ts";
import type { ListedItem } from "./agents.ts";
import { LIVE_FRESH_MS } from "./live.ts";
import type { LiveEntry } from "./live.ts";
import type { Dispatch, Item, RunnerReport, RunnerState } from "./model.ts";
import type { Rules } from "./rules.ts";
import { limitOf, spanText, untilText } from "./whole-view.ts";

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
  /** The engineer session's name, and the id of its dispatch record (what the agent's line is read from, src/timeline.ts). */
  agent: string;
  agentId: string;
  level: number;
  model: string;
  effort?: string;
  state: RunnerState;
  /** The state in a word or two, for the list's state column (`stateWord`). */
  label: string;
  /** The report's one-line note as the list shows it, without commit ids and local paths (`listText`); empty when it has none. */
  note: string;
  /** What the report waits on: the items of the state `items`, the cards of an ask to the owner. The page turns the keys into titles and questions. */
  waitItems?: readonly string[];
  waitCards?: readonly string[];
  /** The event a `wait` is for, with its wake time (`untilText`) when it has one, cleaned like a note (`listText`). */
  waitFor?: string;
  /** Since when the work has been in this state, when it began, and the rounds and dollars it has taken so far. */
  since: number;
  started: number;
  turns?: number;
  cost?: number;
  /** Past the time its state may last (the whole view's limits), or reported as an exception. */
  overdue: boolean;
  /** Waiting for the owner, or reported as an exception: the work that a person has to look at first. */
  needsPerson: boolean;
  /** When the turn in progress began: from its beat, else from the report that said a turn began. Only for the state `running`. */
  turnStartedAt?: number;
  /** The beat of the engineer's turn, when the runner sends them and the report says a turn is running. */
  live?: RunnerTurn;
  /** The architect's turn that answers this work's question, when the report says it asks the architect and the runner says it runs one. */
  architect?: RunnerTurn;
  /** The review round of this work's pull request, when the report says the work waits and the runner says a review runs (the round began after the wait did). */
  review?: RunnerTurn;
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

const STATE_WORDS: Record<Exclude<RunnerState, "ask">, string> = { running: "在跑", ci: "等 CI", items: "等条目", run: "等 14900K", wait: "等事件", ready: "等合入", exception: "要人看", done: "待收尾" };
/** The state column's word: what the work does or whom it waits for, in a word or two. */
export function stateWord(report: Pick<RunnerReport, "state" | "to">): string {
  return report.state === "ask" ? report.to === "owner" ? "等主人" : "等架构师" : STATE_WORDS[report.state];
}

// A commit id (seven to forty hexadecimal digits, with a digit and a letter among them, after 「提交」 or alone) and a path on the
// machine the runner runs on (under `~`, an environment variable, or a root directory of the system).
const COMMIT = /(?:提交\s*)?(?<![0-9A-Za-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![0-9A-Za-z])/g;
const LOCAL_PATH = /(?<![\w.\-/])(?:~|\$[A-Z_][A-Z0-9_]*|\/(?:Users|home|opt|tmp|var|private|Library|usr|etc|mnt|root))(?:\/[^\s，。；：、（）()"'`]+)+/g;
/** A report's or a beat's text as the list shows it: a commit id leaves, and a local path shrinks to its last name, so the sentence still reads. */
export function listText(text: string): string {
  return text
    .replace(LOCAL_PATH, path => path.replace(/\/+$/, "").split("/").at(-1)!)
    .replace(COMMIT, "")
    .replace(/（\s*）|\(\s*\)/g, "")
    .replace(/\s+/g, " ").trim();
}

/** A turn as the cell's hover says it: its number, how long it has run, and when and what its last action was. A turn the runner has
 * not mentioned for a while is silent: the hover keeps what it last said and says how long nothing was heard. */
function turnLine(t: RunnerTurn, now: number): string {
  const at = t.silent ? t.heardAt : now, action = t.action === undefined ? "" : listText(t.action);
  const bits = ["这一轮 " + spanText(at - t.startedAt)];
  if (t.lastActionAt !== undefined) bits.push("最后动作 " + spanText(at - t.lastActionAt) + "前" + (action ? "：" + action : ""));
  else if (action) bits.push(action);
  return t.silent ? "没有动静：执行程序 " + spanText(now - t.heardAt) + "没报这一轮；上次报的是第 " + t.turn + " 轮，" + bits.join("，") : "第 " + t.turn + " 轮 · " + bits.join(" · ");
}

/** What a row says in the list's wide column: `text` is its one line, `full` the same in full for the hover (item keys may appear there). */
export interface RunnerLine { text: string; full: string; silent: boolean }
/** The title of an item or the question of a card, by its key; undefined when the page holds none. */
export type NameOf = (kind: "item" | "card", key: string) => string | undefined;

/**
 * What the work is doing or waits on, in one line: the last action of the turn running now (the engineer's, or the architect's for an
 * ask the architect answers, or the review round of a work that waits for it), else the report's note; the items it waits for by their titles and the cards by their questions, so no
 * key stands in the line, and the event a `wait` is for with its wake time. A turn not heard from for LIVE_FRESH_MS reads as silent.
 */
export function runnerLine(x: RunnerRow, now: number, nameOf: NameOf = () => undefined): RunnerLine {
  const turn = x.state === "running" ? x.live : x.review ?? x.architect, who = x.state === "running" ? "" : x.review ? "审查" : "架构师", doing = x.review ? "审查中" : "架构师在答";
  if (turn) {
    const action = turn.action === undefined ? "" : listText(turn.action);
    const text = turn.silent ? `${who}没有动静 ${spanText(now - turn.heardAt)}`
      : action ? (who ? `${doing}：` : "") + action : `${who ? doing + "，" : ""}这一轮 ${spanText(now - turn.startedAt)}`;
    return { text, full: who + turnLine(turn, now), silent: turn.silent };
  }
  if (x.state === "running") {
    return { text: `${x.note ? x.note + "，" : ""}还没报这一轮的动作`, full: `这一轮从 ${spanText(now - x.turnStartedAt!)}前起；执行程序还没报这一轮之内的动作`, silent: false };
  }
  const items = (x.waitItems ?? []).map(key => [nameOf("item", key) ?? key, key] as const), cards = (x.waitCards ?? []).map(key => [nameOf("card", key) ?? key, key] as const);
  const join = (parts: Array<string | undefined>) => parts.filter(Boolean).join("：");
  return {
    text: join([items.map(([name]) => name).join("、") || cards.map(([name]) => name).join("；") || x.waitFor, x.note]),
    full: join([items.map(([name, key]) => `${name}（${key}）`).join("、") || cards.map(([name, key]) => `${key}：${name}`).join("\n") || x.waitFor, x.note]),
    silent: false,
  };
}

/** An item with its key, as the page holds the board's items, with what the runner's block reads of it. */
export type HeldItem = ListedItem & Pick<Item, "runner" | "record">;

/**
 * The rows at `now`: every open, unpaused piece of work the runner holds, first those a person has to look at (waiting for the owner,
 * an exception), then the others past the time their state may last, then those with a turn running, then the waiting ones, the
 * longest in their state first. A report with no engineer dispatch of the runner's job open
 * is a leftover and not listed. The beats count only while they agree with the report: an engineer's while the report says a turn
 * runs, the architect's while it says the work asks the architect, a review's while it says the work waits and the beat is not older
 * than the wait (the runner reports a review round as a wait, so a beat from before it is an earlier round's). The items come as a list, not as the snapshot's keyed object: the
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
      item, agent: dispatch.agent, agentId: dispatch.agentId, level: dispatch.level, model: dispatch.model, ...(dispatch.effort === undefined ? {} : { effort: dispatch.effort }),
      state: report.state, label: stateWord(report), note: listText(report.note ?? ""), since, started: Date.parse(report.started),
      ...(report.items === undefined ? {} : { waitItems: report.items }), ...(report.cards === undefined ? {} : { waitCards: report.cards }),
      ...(report.what === undefined ? {} : { waitFor: listText(report.what) + (report.until === undefined ? "" : untilText(report.until)) }),
      ...(report.turns === undefined ? {} : { turns: report.turns }), ...(report.cost === undefined ? {} : { cost: report.cost }),
      overdue: report.state === "exception" || now - since > limitOf(report),
      needsPerson: report.state === "exception" || (report.state === "ask" && report.to === "owner"),
    };
    if (report.state === "running") {
      const beat = byKey.get(`工程师:${item}`);
      if (beat) { row.live = turnOf(beat, now); row.label += ` 第 ${row.live.turn} 轮`; }
      row.turnStartedAt = row.live?.startedAt ?? Date.parse(report.at);
    }
    if (report.state === "ask" && report.to === "architect") {
      const beat = byKey.get(`架构师:${item}`);
      if (beat) row.architect = turnOf(beat, now);
    }
    if (report.state === "wait") {
      const beat = byKey.get(`审查:${item}`);
      if (beat && Date.parse(beat.at) >= since) { row.review = turnOf(beat, now); row.label = `审查 第 ${row.review.turn} 轮`; }
    }
    rows.push(row);
  }
  const rank = (x: RunnerRow) => x.needsPerson ? 0 : x.overdue ? 1 : x.state === "running" || x.review ? 2 : 3;
  return rows.sort((a, b) => rank(a) - rank(b) || a.since - b.since || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
}
