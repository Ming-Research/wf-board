// The runner's block of the agent list (src/runner-rows.ts): which work it holds, what each row says, and how the beats of src/live.ts
// join a row. The rows are checked on hand-built snapshots; test/dom/runner-block.test.ts draws them on the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentRows, runnerHolds } from "../src/agents.ts";
import { runnerRows, runnerLine, stateWord, listText } from "../src/runner-rows.ts";
import type { HeldItem, RunnerRow } from "../src/runner-rows.ts";
import { limitOf, WAIT_LIMITS_MS } from "../src/whole-view.ts";
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

test("every piece of work the runner holds is a row, those a person has to look at first, and the sessions come from the dispatch records", () => {
  const s = snap(
    job("run", { state: "running", note: "第 2 轮", turns: 2, cost: 1.25, since: ago(12), at: ago(12) }, ago(40)),
    job("ci", { state: "ci", note: "Ming-Research/wf-board#9 提交 abc1234 的 CI", since: ago(8) }),
    job("owner", { state: "ask", to: "owner", cards: ["c1", "c2"], since: ago(30) }),
    job("late", { state: "ci", since: ago(100) }),
    job("bad", { state: "exception", note: "两轮没有交回状态", since: ago(1) }),
  );
  const rows = rowsOf(s, open(), [], NOW);
  // First what a person has to look at (an ask to the owner, an exception; the longest in the state first), then the rest past their
  // limit, then the turn running, then the waiting ones.
  assert.deepEqual(rows.map(r => r.item), ["owner", "bad", "late", "run", "ci"]);
  const by = Object.fromEntries(rows.map(r => [r.item, r]));
  assert.deepEqual([by.run!.label, by.run!.note], ["在跑", "第 2 轮"]);
  assert.deepEqual([by.owner!.label, by.owner!.note, by.owner!.waitCards], ["等主人", "", ["c1", "c2"]]);
  assert.equal(by.ci!.note, "Ming-Research/wf-board#9 的 CI", "the commit id of the note is left out");
  assert.deepEqual([by.run!.agent, by.run!.level, by.run!.model, by.run!.effort], ["run", 2, "Sonnet", "xhigh"]);
  assert.deepEqual([by.run!.turns, by.run!.cost, by.run!.since, by.run!.started], [2, 1.25, NOW - 12 * 60_000, NOW - 40 * 60_000]);
  // The limits are the whole view's: 90 minutes for CI, none for an exception, 12 hours for an ask to the owner.
  assert.equal(limitOf(s.items.late!.runner!), WAIT_LIMITS_MS.ci);
  assert.deepEqual(rows.map(r => [r.item, r.overdue, r.needsPerson]), [["owner", false, true], ["bad", true, true], ["late", true, false], ["run", false, false], ["ci", false, false]]);
});

test("the state column says each state in a word or two", () => {
  const word = (state: RunnerReport["state"], to?: RunnerReport["to"]) => stateWord({ state, ...(to ? { to } : {}) });
  assert.deepEqual(
    [word("running"), word("ci"), word("ask", "owner"), word("ask", "architect"), word("items"), word("run"), word("wait"), word("ready"), word("exception"), word("done")],
    ["在跑", "等 CI", "等主人", "等架构师", "等条目", "等 14900K", "等事件", "等合入", "要人看", "待收尾"],
  );
  // A beat adds the turn's number to 「在跑」, and only that state has a beat.
  const rows = rowsOf(snap(job("run", { state: "running" }), job("waits", { state: "ci" })), open(), [beat("run", { turn: 3 }), beat("waits", { turn: 9 })], NOW);
  assert.deepEqual(rows.map(r => [r.item, r.label]).sort(), [["run", "在跑 第 3 轮"], ["waits", "等 CI"]]);
});

test("a text shows without commit ids and local paths, and a sentence still reads", () => {
  assert.equal(listText("Ming-Research/wf-board 提交 0578e89 的 CI"), "Ming-Research/wf-board 的 CI");
  assert.equal(listText("合入了，看主线 0578e89abcdef0123456789abcdef0123456789a"), "合入了，看主线");
  assert.equal(listText("等它做：看 ~/Library/Logs/wf-board.log 的最后几行"), "等它做：看 wf-board.log 的最后几行");
  assert.equal(listText("改 /Users/user/dev/wf/worktrees/agents-list-tidy/web/app.ts"), "改 app.ts");
  assert.equal(listText("跑 ls $WF_HOME/worktrees/ci-split-big-tests）"), "跑 ls ci-split-big-tests）");
  // What is not a commit id or a path of the machine stays: a path inside the repository, a pull request, a run number, a word of hex letters, a number with no letter.
  const keep = ["改 web/app.ts", "Ming-Research/wf-board#117 合入核对", "run 39180350102 的 CI", "defaced decade 1234567", "src/var/x.ts 和 web/tmp/y", "约 ~5 分钟"];
  for (const text of keep) assert.equal(listText(text), text);
});

test("the wide column says the last action of the turn running, else what the work waits for with titles for keys; a turn not heard from is silent", () => {
  const s = snap(
    job("run", { state: "running", note: "第 2 轮", at: ago(3) }),
    job("ci", { state: "ci", note: "Ming-Research/wf-board#9 提交 abc1234 的 CI" }),
    job("owner", { state: "ask", to: "owner", cards: ["c1", "c2"] }),
    job("items", { state: "items", items: ["dep-a", "dep-b"] }),
    job("asks", { state: "ask", to: "architect", note: "架构师轮次在答" }),
    job("wait", { state: "ask", to: "architect", note: "等它做：重启 ~/Library/Logs/x.log 里说的程序" }),
  );
  const names: Record<string, string> = { "item:dep-a": "第一个依赖", "card:c1": "问题一" };
  const nameOf = (kind: "item" | "card", key: string) => names[`${kind}:${key}`];
  const row = (item: string, beats: LiveEntry[] = []): RunnerRow => rowsOf(s, open(), beats, NOW).find(r => r.item === item)!;
  // A turn running: the action on the line, the whole turn line on the hover; the action is cleaned like a note.
  const live = runnerLine(row("run", [beat("run", { turn: 3, turnStartedAt: ago(5), lastActionAt: agoSeconds(20), action: "改 /Users/user/x/web/app.ts" })]), NOW, nameOf);
  assert.deepEqual(live, { text: "改 app.ts", full: "第 3 轮 · 这一轮 5 分钟 · 最后动作 不到 1 分钟前：改 app.ts", silent: false });
  assert.equal(runnerLine(row("run", [beat("run", { turnStartedAt: ago(5) })]), NOW, nameOf).text, "这一轮 5 分钟", "a beat with no action");
  const bare = runnerLine(row("run"), NOW, nameOf);
  assert.deepEqual([bare.text, bare.full], ["第 2 轮，还没报这一轮的动作", "这一轮从 3 分钟前起；执行程序还没报这一轮之内的动作"]);
  const quiet = runnerLine(row("run", [beat("run", { turn: 2, turnStartedAt: ago(10), lastActionAt: ago(7), action: "跑 git push", at: ago(3) })]), NOW, nameOf);
  assert.deepEqual(quiet, { text: "没有动静 3 分钟", full: "没有动静：执行程序 3 分钟没报这一轮；上次报的是第 2 轮，这一轮 7 分钟，最后动作 4 分钟前：跑 git push", silent: true });
  // Waiting: the note; titles and questions for keys (a key with no title stays as it is), the keys on the hover.
  assert.deepEqual(runnerLine(row("ci"), NOW, nameOf), { text: "Ming-Research/wf-board#9 的 CI", full: "Ming-Research/wf-board#9 的 CI", silent: false });
  assert.deepEqual(runnerLine(row("items"), NOW, nameOf), { text: "第一个依赖、dep-b", full: "第一个依赖（dep-a）、dep-b（dep-b）", silent: false });
  assert.deepEqual(runnerLine(row("owner"), NOW, nameOf), { text: "问题一；c2", full: "c1：问题一\nc2：c2", silent: false });
  assert.equal(runnerLine(row("wait"), NOW, nameOf).text, "等它做：重启 x.log 里说的程序");
  // The architect's turn answers an ask to the architect, and says so; silent the same way.
  const arch = runnerLine(row("asks", [beat("asks", { role: "架构师", turn: 4, turnStartedAt: ago(2), action: "读 条目 asks" })]), NOW, nameOf);
  assert.deepEqual([arch.text, arch.full, arch.silent], ["架构师在答：读 条目 asks", "架构师第 4 轮 · 这一轮 2 分钟 · 读 条目 asks", false]);
  assert.equal(runnerLine(row("asks", [beat("asks", { role: "架构师", at: ago(5) })]), NOW, nameOf).text, "架构师没有动静 5 分钟");
  assert.equal(runnerLine(row("asks"), NOW, nameOf).text, "架构师轮次在答", "no beat: the note");
});

test("a wait for an event is a row in its words, amber an hour after its wake time and, with none, after a day", () => {
  const started = ago(30 * 60);
  const s = snap(
    // Began an hour ago, to be woken in two hours: on time for another three hours.
    job("dated", { state: "wait", what: "上线后 24 小时的日志", until: ago(-120), since: ago(60) }, started),
    // Woken 61 minutes ago by its time, and still here: the hour of room is used up.
    job("not-woken", { state: "wait", what: "到点叫醒", until: ago(61), since: ago(300) }, started),
    job("undated", { state: "wait", what: "执行程序重启", since: ago(23 * 60) }, started),
    job("undated-late", { state: "wait", what: "主线下一次合入", since: ago(25 * 60) }, started),
  );
  const rows = rowsOf(s, open(), [], NOW), by = Object.fromEntries(rows.map(r => [r.item, r]));
  assert.deepEqual(rows.map(r => [r.item, r.overdue]), [["undated-late", true], ["not-woken", true], ["undated", false], ["dated", false]], "overdue first, then the longest in the state first");
  // The state column says 「等事件」; the wide column says the event, and the wake time when there is one.
  assert.deepEqual(rows.map(r => r.label), ["等事件", "等事件", "等事件", "等事件"]);
  assert.equal(by.dated!.waitFor, "上线后 24 小时的日志（到 10-18 14:00Z）", "NOW is 12:00, the wake time two hours later");
  assert.equal(by["undated-late"]!.waitFor, "主线下一次合入");
  assert.equal(runnerLine(by.dated!, NOW).text, "上线后 24 小时的日志（到 10-18 14:00Z）");
  assert.equal(runnerLine(by["undated-late"]!, NOW).full, "主线下一次合入");
  assert.deepEqual([by.dated!.state, by.dated!.live, by.dated!.architect, by.dated!.turnStartedAt], ["wait", undefined, undefined, undefined], "a wait has no turn running and no architect's turn");
  assert.equal(limitOf(s.items.dated!.runner!), 4 * 60 * 60_000, "from the start of the wait to an hour after the wake time");
  // The event and the note are cleaned like a note: a path of the runner's machine shrinks, and the note follows the event after a colon.
  const noted = snap(job("noted", { state: "wait", what: "看 ~/Library/Logs/wf-board.log 的最后几行", until: "2026-10-18T14:00:00Z", note: "第 3 轮", since: ago(5) }));
  assert.equal(runnerLine(rowsOf(noted, open(), [], NOW)[0]!, NOW).text, "看 wf-board.log 的最后几行（到 10-18 14:00Z）：第 3 轮");
  // A beat for the engineer or the architect is not read for a wait: only a running turn and an ask to the architect have one.
  const withBeats = rowsOf(s, open(), [beat("dated"), beat("dated", { role: "架构师" })], NOW).find(r => r.item === "dated")!;
  assert.deepEqual([withBeats.live, withBeats.architect], [undefined, undefined]);
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
  assert.deepEqual([by.asks!.label, by.asks!.note], ["等架构师", "架构师轮次在答"], "without a beat the row still says it waits for the architect");
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
