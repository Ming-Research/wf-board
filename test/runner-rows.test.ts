// The runner's block of the agent list (src/runner-rows.ts): which work it holds, what each row says, and how the beats of src/live.ts
// join a row. The rows are checked on hand-built snapshots; test/dom/runner-block.test.ts draws them on the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentRows, runnerHolds } from "../src/agents.ts";
import { runnerRows } from "../src/runner-rows.ts";
import type { HeldItem } from "../src/runner-rows.ts";
import { reportText, limitOf, WAIT_LIMITS_MS } from "../src/whole-view.ts";
import { LIVE_FRESH_MS } from "../src/live.ts";
import type { LiveEntry } from "../src/live.ts";
import type { Dispatch, Item, RunnerReport, Snapshot } from "../src/model.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const agoSeconds = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const dispatch = (agent: string, started: string, fields: Partial<Dispatch> = {}) => ({ agentId: `${agent}-${started}`, agent, role: "工程师", level: 2, model: "Sonnet", effort: "xhigh", started, ...fields }) as unknown as Dispatch;
// A job as the runner leaves it: the dispatch and the report begin together.
const job = (key: string, report: Partial<RunnerReport> & Pick<RunnerReport, "state">, started = ago(60), fields: Partial<Item> = {}) =>
  [key, { title: `title of ${key}`, group: "p", plan: [], dispatches: [dispatch(key, started)], runner: { since: started, at: started, started, ...report }, ...fields } as unknown as Item] as const;
const snap = (...items: Array<readonly [string, Item]>) => ({ items: Object.fromEntries(items) }) as unknown as Pick<Snapshot, "items">;
// The page hands the rows its list of items, each with its key.
const listed = (s: Pick<Snapshot, "items">): HeldItem[] => Object.entries(s.items).map(([id, it]) => ({ ...it, id }));
const rowsOf = (s: Pick<Snapshot, "items">, ...rest: [Parameters<typeof runnerRows>[1], Parameters<typeof runnerRows>[2], number]) => runnerRows(listed(s), ...rest);
const open = (closed: string[] = [], paused: string[] = []) => ({ isOpenWork: (id: string) => !closed.includes(id), isPaused: (id: string) => paused.includes(id) });
const beat = (item: string, fields: Partial<LiveEntry> = {}): LiveEntry => ({ role: "工程师", item, turn: 2, turnStartedAt: ago(12), at: agoSeconds(10), ...fields });

test("every piece of work the runner holds is a row with the words and the limits of the whole view, and the sessions come from the dispatch records", () => {
  const s = snap(
    job("run", { state: "running", note: "第 2 轮", turns: 2, cost: 1.25, since: ago(12), at: ago(12) }, ago(40)),
    job("ci", { state: "ci", note: "Ming-Research/wf-board#9 提交 abc1234 的 CI", since: ago(8) }),
    job("owner", { state: "ask", to: "owner", cards: ["c1", "c2"], since: ago(30) }),
    job("late", { state: "ci", since: ago(100) }),
    job("bad", { state: "exception", note: "两轮没有交回状态", since: ago(1) }),
  );
  const rows = rowsOf(s, open(), [], NOW);
  // Overdue first (the longest in the state first), then the turn running, then the waiting ones.
  assert.deepEqual(rows.map(r => r.item), ["late", "bad", "run", "owner", "ci"]);
  const by = Object.fromEntries(rows.map(r => [r.item, r]));
  assert.equal(by.run!.what, reportText(s.items.run!.runner!), "the words are the whole view's");
  assert.equal(by.owner!.what, "问主人（卡 c1、c2）");
  assert.deepEqual([by.run!.agent, by.run!.level, by.run!.model, by.run!.effort], ["run", 2, "Sonnet", "xhigh"]);
  assert.deepEqual([by.run!.turns, by.run!.cost, by.run!.since, by.run!.started], [2, 1.25, NOW - 12 * 60_000, NOW - 40 * 60_000]);
  // The limits are the whole view's: 90 minutes for CI, none for an exception.
  assert.equal(limitOf(s.items.late!.runner!), WAIT_LIMITS_MS.ci);
  assert.deepEqual(rows.map(r => [r.item, r.overdue]), [["late", true], ["bad", true], ["run", false], ["owner", false], ["ci", false]]);
});

test("a report counts only with the job's own open engineer dispatch, on open and unpaused work", () => {
  const started = ago(60);
  const items = [
    job("held", { state: "ci" }, started),
    // No dispatch at all, or one that has ended: a report left from a finished job.
    job("nodispatch", { state: "ci" }, started, { dispatches: [] }),
    job("finished", { state: "ci" }, started, { dispatches: [dispatch("finished", started, { finish: { ended: ago(5) } as Dispatch["finish"] })] }),
    // A review is not the runner's engineer.
    job("review", { state: "ci" }, started, { dispatches: [dispatch("review", started, { role: "审查" })] }),
    // A session started on the item hours after the report began is not the job the report speaks of.
    job("later", { state: "ci" }, ago(600), { dispatches: [dispatch("later", ago(30))] }),
    job("closed", { state: "ci" }, started),
    job("paused", { state: "ci" }, started),
    job("record", { state: "ci" }, started, { record: true }),
    ["noreport", { title: "n", group: "p", plan: [], dispatches: [dispatch("noreport", started)] } as unknown as Item] as const,
  ];
  assert.deepEqual(rowsOf(snap(...items), open(["closed"], ["paused"]), [], NOW).map(r => r.item), ["held"]);
  const [, later] = job("later", { state: "ci" }, ago(600), { dispatches: [dispatch("later", ago(30))] });
  assert.equal(runnerHolds(later, later.dispatches![0]!), false);
  assert.equal(runnerHolds(later, dispatch("later", ago(598))), true, "a dispatch recorded within minutes of the report's start is the same job");
});

test("a turn running gets its start from the runner's beat, else from the report; a beat counts only while the report agrees and goes silent after 90 seconds", () => {
  const s = snap(
    job("run", { state: "running", at: ago(7), since: ago(30) }),
    job("waits", { state: "ci" }),
  );
  // Without a beat: the report's own time, and nothing said about the turn's inside.
  const bare = rowsOf(s, open(), [], NOW).find(r => r.item === "run")!;
  assert.deepEqual([bare.turnStartedAt, bare.live], [NOW - 7 * 60_000, undefined]);
  // With one: the beat's start, last action and action; the beat of another role or of work not running is not read.
  const rows = rowsOf(s, open(), [
    beat("run", { turn: 3, turnStartedAt: ago(5), lastActionAt: agoSeconds(20), action: "改 web/app.ts" }),
    beat("run", { role: "架构师", action: "not the engineer's" }),
    beat("waits", { action: "report says CI, not a turn" }),
  ], NOW);
  const run = rows.find(r => r.item === "run")!, waits = rows.find(r => r.item === "waits")!;
  assert.deepEqual(run.live, { turn: 3, startedAt: NOW - 5 * 60_000, lastActionAt: NOW - 20_000, action: "改 web/app.ts", heardAt: NOW - 10_000, silent: false });
  assert.equal(run.turnStartedAt, NOW - 5 * 60_000);
  assert.deepEqual([waits.live, waits.turnStartedAt], [undefined, undefined]);
  // Silence: the beat is older than LIVE_FRESH_MS; the row keeps what it last said and says it was not heard from.
  const quiet = rowsOf(s, open(), [beat("run", { at: new Date(NOW - LIVE_FRESH_MS - 1000).toISOString() })], NOW).find(r => r.item === "run")!;
  assert.equal(quiet.live!.silent, true);
  const edge = rowsOf(s, open(), [beat("run", { at: new Date(NOW - LIVE_FRESH_MS).toISOString() })], NOW).find(r => r.item === "run")!;
  assert.equal(edge.live!.silent, false, "exactly 90 seconds is still fresh");
});

test("the architect's turn joins the row of the work that asks the architect, and only while the report says so", () => {
  const s = snap(
    job("asks", { state: "ask", to: "architect", note: "架构师轮次在答" }),
    job("owner", { state: "ask", to: "owner", cards: ["c"] }),
    job("back", { state: "running" }),
  );
  const architect = (item: string, fields: Partial<LiveEntry> = {}) => beat(item, { role: "架构师", turn: 4, turnStartedAt: ago(2), action: "读 条目 asks", ...fields });
  const rows = rowsOf(s, open(), [architect("asks"), architect("owner"), architect("back")], NOW);
  const by = Object.fromEntries(rows.map(r => [r.item, r]));
  assert.deepEqual(by.asks!.architect, { turn: 4, startedAt: NOW - 2 * 60_000, action: "读 条目 asks", heardAt: NOW - 10_000, silent: false });
  assert.equal(by.owner!.architect, undefined, "an ask to the owner is not an architect's turn");
  assert.equal(by.back!.architect, undefined, "the engineer is back at work: the architect's turn is over");
  assert.equal(by.asks!.what, "问架构师：架构师轮次在答", "without a beat the row still says it asks the architect");
  assert.equal(rowsOf(s, open(), [], NOW).find(r => r.item === "asks")!.architect, undefined);
  assert.equal(rowsOf(s, open(), [architect("asks", { at: ago(5) })], NOW).find(r => r.item === "asks")!.architect!.silent, true);
});

test("the older list leaves out a session the runner holds, and keeps one a report merely sits on", () => {
  const [heldKey, held] = job("held", { state: "ci" }, ago(60));
  const [pmKey, pm] = job("pm", { state: "ci" }, ago(600), { dispatches: [dispatch("pm-session", ago(30))] });
  const s = { items: { [heldKey]: held, [pmKey]: pm }, activity: { writes: [], items: {}, agents: { held: [{ item: "held", at: ago(2) }], "pm-session": [{ item: "pm", at: ago(2) }] } } } as unknown as Pick<Snapshot, "items" | "activity">;
  assert.deepEqual(agentRows(s, NOW, listed(s)).map(r => r.name), ["pm-session"], "the runner's session is drawn in the runner's block, not twice");
  // The runner's own writes (its reports, its dispatch lines), the architect's turns it starts and the board's own marks name no dispatch record, so the older list has no row for them.
  const own = { ...s, activity: { writes: [], items: {}, agents: { ...s.activity!.agents, "执行程序": [{ item: "held", at: ago(1) }], "架构师轮次": [{ item: "held", at: ago(1) }], "看板": [{ item: "held", at: ago(1) }], "  执行程序 ": [{ item: "held", at: ago(1) }] } } } as unknown as Pick<Snapshot, "items" | "activity">;
  assert.deepEqual(agentRows(own, NOW, listed(own)).map(r => r.name), ["pm-session"]);
});
