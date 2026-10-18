// The agent list's data: the store's per-session index of the last two items written, and the rows the page draws from
// it (src/agents.ts). The index is checked against the commits in derived.test.ts too; here are the cases the random
// sequence does not name: who counts, the cap, no session, restarts. The rows are checked on hand-built snapshots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import type { Change } from "../src/store.ts";
import { agentRows, touchAgent, liveDispatches } from "../src/agents.ts";
import { applyActivityDelta } from "../src/rules.ts";
import type { AgentTouch, Dispatch, Item, Snapshot } from "../src/model.ts";
import { board, author } from "./helpers.ts";

test("the index keeps a session's last two distinct items, newest first, and counts cards and notes for their item", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  const agents = () => store.snapshot().activity?.agents;
  const touched = () => (agents()?.S ?? []).map(x => x.item);
  await op.appendLog({ author, session: "S", id: "a", text: "one" });
  await op.appendLog({ author, session: "S", id: "b", text: "two" });
  assert.deepEqual(touched(), ["b", "a"]);
  await op.appendLog({ author, session: "S", id: "a", text: "again" });
  assert.deepEqual(touched(), ["a", "b"], "a repeat moves the item to the front and does not take a second place");
  await op.appendLog({ author, session: "S", id: "other", text: "third item" });
  assert.deepEqual(touched(), ["other", "a"], "only two are kept");
  await op.appendLog({ author, id: "b", text: "no session" });
  assert.deepEqual(touched(), ["other", "a"], "a write without a session is nobody's");
  await op.writeCard({ author, session: "S", key: "k1", item: "area", question: "Which?", confidence: { reason: "guess" }, options: [{ text: "a", detail: "does a", recommended: true }, { text: "b", detail: "does b" }] });
  assert.deepEqual(touched(), ["area", "other"], "a card counts for its item");
  await op.appendLog({ author, session: "S", id: "area", text: "twice in a row" });
  assert.deepEqual(touched(), ["area", "other"], "the item at the front is not listed twice");
  await op.appendLog({ author, session: "S2", id: "area", text: "another session" });
  assert.deepEqual((agents()?.S2 ?? []).map(x => x.item), ["area"]);
  assert.deepEqual(touched(), ["area", "other"], "another session's write does not take the item from this one");
  assert.deepEqual(Object.keys(agents()!).sort(), ["S", "S2"]);
});

test("the index is rebuilt from history after a restart and travels as deltas that rebuild it on the page", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const changes: Change[] = [];
  store.onChange(change => changes.push(change));
  let page = store.snapshot().activity, head = store.snapshot().head;
  await op.appendLog({ author, session: "S1", id: "a", text: "one" });
  await op.setPlan({ author, session: "S2", id: "b", row: { id: "w", text: "work", state: "doing" } });
  await op.appendLog({ author, session: "S1", id: "b", text: "two" });
  await op.appendLog({ author, id: "other", text: "no session: the delta carries no agent" });
  for (const change of changes) { assert.equal(change.activity.from, head); page = applyActivityDelta(page, change.activity); head = change.commit; }
  const live = store.snapshot().activity!;
  assert.deepEqual(changes.map(c => Object.keys(c.activity.agents ?? {})), [["S1"], ["S2"], ["S1"], []], "a delta names only the sessions whose list changed");
  assert.deepEqual(live.agents, { S1: live.agents!.S1, S2: live.agents!.S2 });
  assert.deepEqual(live.agents!.S1!.map(x => x.item), ["b", "a"]);
  assert.deepEqual(page?.agents, live.agents, "deltas applied in order give the store's index");
  assert.deepEqual((await Store.open(dir)).snapshot().activity?.agents, live.agents, "rebuilt from the commit trailers");
});

test("touchAgent puts the touched items first by id, drops repeats and keeps two", () => {
  const at = "2026-10-16T10:00:00Z";
  assert.deepEqual(touchAgent(undefined, ["z", "a", "a"], at), [{ item: "a", at }, { item: "z", at }]);
  const old = [{ item: "a", at: "2026-10-16T09:00:00Z" }, { item: "b", at: "2026-10-16T08:00:00Z" }];
  assert.deepEqual(touchAgent(old, ["b"], at), [{ item: "b", at }, { item: "a", at: "2026-10-16T09:00:00Z" }]);
  assert.deepEqual(touchAgent(old, ["c", "d", "e"], at), [{ item: "c", at }, { item: "d", at }], "a write touching more than two keeps the first two by id");
  assert.deepEqual(touchAgent(old, [], at), old, "nothing touched changes nothing");
});

// --- the rows -------------------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-10-16T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
type Plan = Array<{ id: string; text: string; state: string; waits?: string }>;
const item = (plan: Plan = [], fields: Partial<Item> = {}) => ({ title: "t", group: "p", plan, dispatches: [], ...fields }) as unknown as Item;
const dispatch = (agent: string, started: string, fields: Partial<Dispatch> = {}) => ({ agentId: `${agent}-${started}`, agent, role: "工程师", level: 2, model: "Sonnet", started, ...fields }) as unknown as Dispatch;
const snap = (items: Record<string, Item>, agents: Record<string, AgentTouch[]> = {}) => ({ items, activity: { writes: [], items: {}, agents } }) as unknown as Pick<Snapshot, "items" | "activity">;
const wrote = (...touches: Array<[string, number]>) => touches.map(([item, m]) => ({ item, at: minutesAgo(m) }));
const row = (s: ReturnType<typeof snap>, name: string) => agentRows(s, NOW).find(r => r.name === name);

test("a session is listed for six hours after its last write, and the architect's and the PM's own never are", () => {
  const items = { a: item() };
  const s = snap(items, { fresh: wrote(["a", 5]), edge: wrote(["a", 359]), old: wrote(["a", 361]), "架构师": wrote(["a", 1]), PM: wrote(["a", 2]) });
  assert.deepEqual(agentRows(s, NOW).map(r => r.name), ["fresh", "edge"], "newest first; past the window and the architect's and the PM's sessions are out");
});

test("the programs' own session names are no agents: the runner, the architect's turns it starts and the board itself, however they are spaced", () => {
  const items = { a: item() };
  const s = snap(items, { fresh: wrote(["a", 5]), "执行程序": wrote(["a", 1]), "架构师轮次": wrote(["a", 1]), "看板": wrote(["a", 1]), " 看板 ": wrote(["a", 1]), "  执行程序": wrote(["a", 1]) });
  assert.deepEqual(agentRows(s, NOW).map(r => r.name), ["fresh"], "a name that reads like a program's but is another word stays a session");
  assert.deepEqual(agentRows(snap(items, { "看板2": wrote(["a", 1]), "执行程序x": wrote(["a", 1]) }), NOW).map(r => r.name), ["执行程序x", "看板2"]);
});

test("a step in progress decides the state word: waiting with its text, working, maybe stopped, or none", () => {
  const doing = (waits?: string) => item([{ id: "w", text: "work", state: "doing", ...(waits ? { waits } : {}) }, { id: "accept", text: "ok", state: "todo" }]);
  const s = snap({ idle: item([{ id: "w", text: "work", state: "done" }]), run: doing(), wait: doing("PR 草稿 CI") }, {
    fresh: wrote(["run", 29]), stale: wrote(["run", 31]), nothing: wrote(["idle", 3]),
    quick: wrote(["wait", 5]), long: wrote(["wait", 59]), longer: wrote(["wait", 61]),
  });
  assert.equal(row(s, "fresh")!.state, "working");
  assert.equal(row(s, "stale")!.state, "maybe-stopped", "over 30 minutes without a write");
  assert.equal(row(s, "nothing")!.state, "none", "no step in progress: no state word, only the time");
  assert.deepEqual([row(s, "quick")!.state, row(s, "quick")!.waits, row(s, "quick")!.amber], ["waiting", "PR 草稿 CI", false]);
  assert.equal(row(s, "long")!.amber, false);
  assert.equal(row(s, "longer")!.amber, true, "waiting for over an hour is marked");
  assert.equal(row(s, "longer")!.state, "waiting", "a waiting row is never 'maybe stopped'");
});

test("waits wins over the clock, and a step in progress on the older of the two items counts", () => {
  const s = snap({
    a: item([{ id: "w", text: "work", state: "doing", waits: "等审查" }]),
    b: item([{ id: "w", text: "work", state: "doing" }]),
    c: item([{ id: "w", text: "work", state: "todo" }]),
  }, { both: wrote(["c", 1], ["a", 2]), mixed: wrote(["b", 2], ["a", 3]), third: wrote(["c", 1], ["b", 2]) });
  assert.deepEqual([row(s, "both")!.state, row(s, "both")!.waits], ["waiting", "等审查"]);
  assert.equal(row(s, "mixed")!.state, "waiting", "any of its steps waiting makes it waiting");
  assert.equal(row(s, "third")!.state, "working");
});

test("the level comes from the newest dispatch record naming it, else from the newest item it touched that has a step in progress", () => {
  const doing = [{ id: "w", text: "work", state: "doing" }];
  const s = snap({
    easy: item(doing, { difficulty: 1 } as Partial<Item>), hard: item(doing, { difficulty: 4 } as Partial<Item>), mine: item(doing),
    plain: item([], { difficulty: 3 } as Partial<Item>),
    rec: item(doing, { dispatches: [dispatch("both", minutesAgo(300), { level: 5 }), dispatch("both", minutesAgo(100), { level: 2 })] } as Partial<Item>),
  }, { derived: wrote(["plain", 1], ["hard", 2], ["easy", 3]), both: wrote(["rec", 4]), unratedOwn: wrote(["mine", 4]), idle: wrote(["plain", 4]),
    // The newest item is unrated and the older one is rated 4: the older one gives the level.
    passedOver: wrote(["mine", 1], ["hard", 2]) });
  assert.equal(row(s, "derived")!.level, 4, "the difficulty of the newest touched item with a step in progress");
  assert.equal(row(s, "both")!.level, 2, "the newest dispatch record, not an older one");
  assert.equal(row(s, "unratedOwn")!.level, undefined, "an unrated item gives no level");
  assert.equal(row(s, "idle")!.level, undefined, "no step in progress, no dispatch: no level");
  assert.equal(row(s, "passedOver")!.level, 4, "an unrated item is passed over for an older one that has a difficulty");
});

test("a dispatch record adds its item and its start time to the session's activity", () => {
  const started = minutesAgo(20);
  const s = snap({ r: item([{ id: "w", text: "work", state: "doing", waits: "engineer's wait" }], { dispatches: [dispatch("r-review", started, { role: "审查", level: 3 })] } as Partial<Item>) });
  const review = row(s, "r-review")!;
  assert.deepEqual([review.lastKind, review.lastAt, review.level, review.role], ["started", started, 3, "审查"], "listed with no write at all");
  assert.deepEqual(review.touched, [{ item: "r", at: started }]);
  assert.deepEqual([review.state, review.amber], ["none", false], "a reviewer holds no step: the engineer's wait on the item is not its own");
  // The same item written by the session later: its time and kind follow the write.
  const later = snap({ r: s.items.r! }, { "r-review": wrote(["r", 2]) });
  assert.deepEqual([row(later, "r-review")!.lastKind, row(later, "r-review")!.touched], ["wrote", wrote(["r", 2])]);
  // An engineer's start counts as activity: a fresh engineer with a step in progress is working before its first write.
  const engineer = snap({ e: item([{ id: "w", text: "work", state: "doing" }], { dispatches: [dispatch("e", minutesAgo(5))] } as Partial<Item>) });
  assert.deepEqual([row(engineer, "e")!.state, row(engineer, "e")!.lastKind], ["working", "started"]);
});

test("two items merge from writes and dispatch records, the later time of an item wins, the newest two stay", () => {
  const s = snap({ a: item(), b: item(), c: item([], { dispatches: [dispatch("m", minutesAgo(1))] } as Partial<Item>), d: item() }, { m: wrote(["a", 10], ["b", 20]) });
  assert.deepEqual(row(s, "m")!.touched.map(t => t.item), ["c", "a"]);
});

test("a session whose newest dispatch has ended is out until it writes again; a reused name is judged by its newest record", () => {
  const ended = (agent: string, startedAgo: number, endedAgo: number) => dispatch(agent, minutesAgo(startedAgo), { finish: { ended: minutesAgo(endedAgo), result: "一次通过" } } as unknown as Partial<Dispatch>);
  const s = snap({
    a: item([], { dispatches: [ended("done", 120, 30)] } as Partial<Item>),
    b: item([], { dispatches: [ended("again", 120, 30)] } as Partial<Item>),
    c: item([], { dispatches: [ended("grace", 120, 30)] } as Partial<Item>),
    d: item([], { dispatches: [ended("reused", 300, 200), dispatch("reused", minutesAgo(10))] } as Partial<Item>),
    e: item([], { dispatches: [dispatch("open", minutesAgo(40))] } as Partial<Item>),
  }, { done: wrote(["a", 31]), again: wrote(["b", 5]), grace: wrote(["c", 29.5]) });
  assert.deepEqual(agentRows(s, NOW).map(r => r.name).sort(), ["again", "open", "reused"]);
  assert.equal(row(s, "again")!.lastKind, "wrote", "wrote after it ended: listed as usual");
  assert.equal(row(s, "done"), undefined, "its own last write was before the end");
  assert.equal(row(s, "grace"), undefined, "a write within a minute of the recorded end is still the session's last: the end may be recorded to the minute");
});

test("a dispatch is live while its session started or wrote within the window, and only until it ends", () => {
  const ended = (agent: string, startedAgo: number) => dispatch(agent, minutesAgo(startedAgo), { finish: { ended: minutesAgo(startedAgo - 10), result: "一次通过" } } as unknown as Partial<Dispatch>);
  const s = snap({
    a: item([], { dispatches: [dispatch("recent", minutesAgo(60)), dispatch("stale", minutesAgo(7 * 60)), dispatch("quiet-then-wrote", minutesAgo(9 * 60)), ended("over", 60)] } as Partial<Item>),
  }, { "quiet-then-wrote": wrote(["elsewhere", 30]), stale: wrote(["a", 6.5 * 60]) });
  assert.deepEqual(liveDispatches(s, "a", NOW).map(d => d.agent).sort(), ["quiet-then-wrote", "recent"], "started or wrote within six hours; the ended one and the long quiet one are out");
  assert.deepEqual(liveDispatches(s, "missing", NOW), []);
});

// --- which rows are running ------------------------------------------------------------------------------------------

// The oracle is this table, written from the rule in docs/design.md ("Who is expanded"), not computed by the code under test.
// A finish ten minutes after the dispatch started `startedAgo` minutes ago.
const endedAfter = (startedAgo: number) => ({ finish: { ended: minutesAgo(startedAgo - 10), result: "一次通过" } }) as unknown as Partial<Dispatch>;
const doing = (waits?: string) => item([{ id: "w", text: "work", state: "doing", ...(waits ? { waits } : {}) }]);

test("a step in progress on an item a session touched does not make it running; an unfinished live dispatch does, whatever the state word", () => {
  const names = ["working", "stopped", "waiting", "longWait", "nothing"];
  // Finished records: each name wrote later on an item, but works on nothing alive. Open records: the same names, alive.
  const finished = item([], { dispatches: names.map(name => dispatch(`done-${name}`, minutesAgo(400), endedAfter(400))) } as Partial<Item>);
  const open = item([], { dispatches: names.map(name => dispatch(name, minutesAgo(400))) } as Partial<Item>);
  // Each name wrote this many minutes ago on this item.
  const touches: Array<[string, string, number]> = [["working", "run", 5], ["stopped", "run", 31], ["waiting", "wait", 5], ["longWait", "wait", 61], ["nothing", "idle", 3]];
  const writes = (prefix: string) => Object.fromEntries(touches.map(([name, id, minutes]) => [prefix + name, wrote([id, minutes])]));
  const s = snap({ finished, open, run: doing(), wait: doing("PR 草稿 CI"), idle: item([{ id: "w", text: "work", state: "done" }]) }, { ...writes("done-"), ...writes("") });
  const state = (name: string) => [row(s, name)!.state, row(s, name)!.running];
  assert.deepEqual(names.map(name => state(`done-${name}`)), [["working", false], ["maybe-stopped", false], ["waiting", false], ["waiting", false], ["none", false]],
    "its dispatch ended: the steps on the items it wrote to are other sessions', so it is folded although the state word is read from them");
  assert.deepEqual(names.map(name => state(name)), [["working", true], ["maybe-stopped", true], ["waiting", true], ["waiting", true], ["none", true]],
    "alive: running with every state word, 「可能停了」 and a wait over an hour (amber) included, and with none");
});

test("a session with no dispatch record is never running, whatever stands on the items it touched", () => {
  const s = snap({ run: doing(), wait: doing("PR 草稿 CI") }, { observer: wrote(["run", 5]), waiter: wrote(["wait", 5]), stopped: wrote(["run", 45]) });
  assert.deepEqual(["observer", "waiter", "stopped"].map(name => [row(s, name)!.state, row(s, name)!.running]), [["working", false], ["waiting", false], ["maybe-stopped", false]],
    "the state word is still read from the steps, but those steps are other sessions': it is folded");
});

test("a session with an unfinished dispatch that is alive is running, an engineer or a review, with no step in progress", () => {
  const done = [{ id: "w", text: "work", state: "done" }];
  const review = (agent: string, startedAgo: number) => item(done, { dispatches: [dispatch(agent, minutesAgo(startedAgo), { role: "审查", level: 3 })] } as Partial<Item>);
  const s = snap({
    fresh: item([], { dispatches: [dispatch("fresh", minutesAgo(3))] } as Partial<Item>),
    rowsDone: item(done, { dispatches: [dispatch("rowsDone", minutesAgo(300))] } as Partial<Item>),
    over: item(done, { dispatches: [dispatch("over", minutesAgo(120), endedAfter(120))] } as Partial<Item>),
    moved: item(done, { dispatches: [dispatch("moved", minutesAgo(200), endedAfter(200)), dispatch("moved", minutesAgo(100))] } as Partial<Item>),
    r10: review("r10", 10), r40: review("r40", 40), r300: review("r300", 300),
    // One name: an engineer dispatch that ended, and an older review dispatch still unfinished on another item.
    mixedA: item(done, { dispatches: [dispatch("mixed", minutesAgo(100), endedAfter(100))] } as Partial<Item>),
    mixedB: item(done, { dispatches: [dispatch("mixed", minutesAgo(300), { role: "审查" })] } as Partial<Item>),
  }, { over: wrote(["over", 5]), rowsDone: wrote(["rowsDone", 250]), mixed: wrote(["mixedA", 5]), r300: wrote(["r300", 200]) });
  const running = (name: string) => row(s, name)!.running;
  assert.deepEqual([row(s, "fresh")!.state, running("fresh")], ["none", true], "just started, no row marked yet: it works on the item");
  assert.deepEqual([row(s, "rowsDone")!.state, running("rowsDone")], ["none", true], "every row done and waiting for the merge: still works on it, 5 hours after the start");
  assert.deepEqual([row(s, "over")!.state, running("over")], ["none", false], "its dispatch ended: it works on nothing, though it wrote again afterwards");
  assert.equal(running("moved"), true, "a new dispatch under the name of an ended one works on the item");
  assert.equal([running("r10"), running("r40"), running("r300")].join(), "true,true,true", "an unfinished review is running at 10 minutes, at 40 and at 5 hours: no shorter bound than the window");
  assert.equal(row(s, "r10")!.state, "none", "and it gets no state word");
  assert.equal(running("mixed"), true, "an unfinished review record under the name is alive for status too");
});
