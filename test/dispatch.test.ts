import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ops, OpError } from "../src/ops.ts";
import { createMcpServer } from "../src/mcp.ts";
import { unreadSteps } from "../src/history.ts";
import { dispatchRows, dispatchReport, summarize } from "../src/dispatch.ts";
import type { Tally } from "../src/dispatch.ts";
import { Item, Dispatch, DISPATCH_RESULTS, DISPATCH_SIGNALS } from "../src/model.ts";
import { hashToken } from "../src/credentials.ts";
import { board, author, asArchitect, asPM } from "./helpers.ts";

const architect = "架构师";
const start = { author, session: architect, id: "a", role: "工程师" as const, level: 2, model: "Sonnet", effort: "xhigh", agent: "a-worker", agentId: "agent-0001", worktree: "~/dev/wf/worktrees/a", startedAt: "2026-10-16T09:02Z", did: "实现一行" };
const usage = { input: 120, cacheWrite: 90000, cacheRead: 5000000, output: 20000 };
const finish = { author, session: architect, id: "a", agentId: "agent-0001", result: "返工后通过" as const, usage, cost: 0.3654, reports: 3, kickbacks: 1, waited: 15, endedAt: "2026-10-16T09:50Z", signals: [{ kind: "架构师打回" as const, note: "审查要求补一条用例" }, { kind: "做法被否" as const }], note: "等级合适" };

// A board whose clock the test sets; the helper's fixed clock cannot place a start and an end apart.
async function clocked(t: Parameters<typeof board>[0], now = "2026-10-16T10:00:00Z") {
  const fixture = await board(t);
  let clock = now;
  return { ...fixture, op: ops(fixture.store, () => clock), setClock: (value: string) => { clock = value; } };
}
const refused = (pattern: RegExp) => (error: unknown) => error instanceof OpError && pattern.test(error.message);

test("dispatch_start records every column on the item and appends the start line to its log", async t => {
  const { store, op } = await clocked(t);
  const { credential } = await op.dispatchStart(start);

  const it = store.snapshot().items.a!;
  // The record keeps the hash of the credential the start issued, never the credential.
  assert.match(credential!, /^wfb_/);
  assert.deepEqual(it.dispatches, [{ agentId: "agent-0001", agent: "a-worker", role: "工程师", level: 2, model: "Sonnet", effort: "xhigh", worktree: "~/dev/wf/worktrees/a", started: "2026-10-16T09:02:00Z", did: "实现一行", credential: hashToken(credential!) }]);
  assert.ok(!JSON.stringify(store.snapshot()).includes(credential!), "the credential itself is stored nowhere");
  assert.deepEqual(it.log.at(-1), { at: "2026-10-16T10:00:00Z", by: author, text: "起：会话 a-worker（号 agent-0001），工程师，2 级 Sonnet，推理强度 xhigh，工作树 ~/dev/wf/worktrees/a，2026-10-16T09:02Z，做：实现一行" });
  // What the file holds is what the snapshot holds: the committed YAML parses back to the same dispatches.
  const committed = await store.show("item", "a", store.snapshot().head) as Item;
  assert.deepEqual(committed.dispatches, it.dispatches);
});

test("dispatch_start without the optional columns stores none of them and takes the server's clock", async t => {
  const { store, op } = await clocked(t);
  const { credential } = await op.dispatchStart({ author, id: "b", role: "审查", level: 1, model: "Haiku", agent: "b-review", agentId: "r-1" });
  const it = store.snapshot().items.b!;
  assert.deepEqual(it.dispatches, [{ agentId: "r-1", agent: "b-review", role: "审查", level: 1, model: "Haiku", started: "2026-10-16T10:00:00Z", credential: hashToken(credential!) }]);
  assert.equal(it.log.at(-1)!.text, "起：会话 b-review（号 r-1），审查，1 级 Haiku，2026-10-16T10:00Z");
});

test("dispatch_start refuses what the format does not allow, naming the reason, and writes nothing", async t => {
  const { store, op } = await clocked(t);
  await op.dispatchStart(start);
  const before = store.snapshot();
  const cases: Array<[string, Parameters<typeof op.dispatchStart>[0], RegExp]> = [
    ["an agentId already on this item", { ...start, agent: "other" }, /agentId agent-0001: already recorded on a for session a-worker/],
    ["an agentId already on another item", { ...start, id: "b" }, /agentId agent-0001: already recorded on a/],
    ["a role the format lacks", { ...start, agentId: "x1", role: "架构师" as never }, /role: fix/],
    ["a level beyond 5", { ...start, agentId: "x2", level: 6 }, /level: fix/],
    ["a fractional level", { ...start, agentId: "x3", level: 2.5 }, /level: fix/],
    ["a blank model", { ...start, agentId: "x4", model: "  " }, /provide nonempty text after trimming/],
    ["an agentId with a space", { ...start, agentId: "has space" }, /agentId: fix/],
    ["a start time that is not a UTC time", { ...start, agentId: "x5", startedAt: "yesterday" }, /startedAt: give a UTC time such as 2026-10-16T09:02Z/],
    ["a start time that is no date", { ...start, agentId: "x6", startedAt: "2026-13-45T25:61Z" }, /startedAt: give a UTC time/],
    ["an item of another project", { ...start, agentId: "x7", id: "other" }, /item other belongs to project Firn/],
    ["an item that does not exist", { ...start, agentId: "x8", id: "nope" }, /id nope: choose an existing item/],
  ];
  for (const [what, args, pattern] of cases) await assert.rejects(() => op.dispatchStart(args), refused(pattern), what);
  assert.equal(store.snapshot(), before, "no refused call wrote");
});

test("dispatch_finish completes an engineer dispatch, rounds the cost to thousandths and logs every column", async t => {
  const { store, op } = await clocked(t);
  await op.dispatchStart(start);
  await op.dispatchFinish(finish);

  const [d] = store.snapshot().items.a!.dispatches!;
  assert.deepEqual(d!.finish, { ended: "2026-10-16T09:50:00Z", result: "返工后通过", reports: 3, kickbacks: 1, waited: 15, signals: [{ kind: "架构师打回", note: "审查要求补一条用例" }, { kind: "做法被否" }], usage, cost: 0.365, note: "等级合适" });
  assert.deepEqual(store.snapshot().items.a!.log.at(-1)!.text, "收：会话 a-worker（工程师），返工后通过，报告 3 次，打回 1 次，2026-10-16T09:02Z–2026-10-16T09:50Z，等待 15 分钟，用量 输入 120，写缓存 90000，读缓存 5000000，输出 20000，花费 $0.365，失败信号：架构师打回（审查要求补一条用例）、做法被否，备注：等级合适");
  const committed = await store.show("item", "a", store.snapshot().head) as Item;
  assert.deepEqual(committed.dispatches, store.snapshot().items.a!.dispatches);
});

test("dispatch_finish of a review carries rounds, no signals by default, and takes the server's clock for the end", async t => {
  const { store, op, setClock } = await clocked(t);
  await op.dispatchStart({ ...start, role: "审查", level: 3, model: "Opus", effort: "high", agentId: "rv-1", agent: "a-review", startedAt: "2026-10-16T10:00:00Z" });
  setClock("2026-10-16T10:20:30Z");
  await op.dispatchFinish({ author, id: "a", agentId: "rv-1", result: "一次通过", usage, cost: 3.53, rounds: 1 });
  const d = store.snapshot().items.a!.dispatches![0]!;
  assert.deepEqual(d.finish, { ended: "2026-10-16T10:20:30Z", result: "一次通过", rounds: 1, signals: [], usage, cost: 3.53 });
  assert.equal(store.snapshot().items.a!.log.at(-1)!.text, "收：会话 a-review（审查），一次通过，审查 1 轮，2026-10-16T10:00Z–2026-10-16T10:20Z，用量 输入 120，写缓存 90000，读缓存 5000000，输出 20000，花费 $3.530，失败信号：无");
});

test("dispatch_finish refuses wrong-role counts, missing counts and values outside the fixed options, and writes nothing", async t => {
  const { store, op } = await clocked(t);
  await op.dispatchStart(start);
  await op.dispatchStart({ ...start, role: "审查", agentId: "rv-1", agent: "a-review" });
  const before = store.snapshot();
  const review = { ...finish, agentId: "rv-1", reports: undefined, kickbacks: undefined, rounds: 2 };
  const cases: Array<[string, Parameters<typeof op.dispatchFinish>[0], RegExp]> = [
    ["an agentId the item lacks", { ...finish, agentId: "ghost" }, /agentId ghost: not dispatched on a; recorded here: agent-0001 \(a-worker\), rv-1 \(a-review\)/],
    ["an engineer without reports", { ...finish, reports: undefined }, /reports: an engineer dispatch ends with reports and kickbacks/],
    ["an engineer without kickbacks", { ...finish, kickbacks: undefined }, /kickbacks: an engineer dispatch ends with reports and kickbacks/],
    ["an engineer with rounds", { ...finish, rounds: 2 }, /rounds: only a review dispatch carries rounds/],
    ["a review without rounds", { ...review, rounds: undefined }, /rounds: a review dispatch ends with rounds/],
    ["a review with reports", { ...review, reports: 1 }, /reports: only an engineer dispatch carries reports and kickbacks/],
    ["a review with kickbacks", { ...review, kickbacks: 1 }, /kickbacks: only an engineer dispatch carries reports and kickbacks/],
    ["a result the format lacks", { ...finish, result: "差不多" as never }, /result: fix/],
    ["a signal the format lacks", { ...finish, signals: [{ kind: "进展慢" as never }] }, /signals\.0\.kind: fix/],
    ["the same signal twice", { ...finish, signals: [{ kind: "做法被否" }, { kind: "做法被否", note: "又一次" }] }, /Name each signal once/],
    ["a negative token count", { ...finish, usage: { ...usage, output: -1 } }, /usage\.output: fix/],
    ["a fractional token count", { ...finish, usage: { ...usage, input: 1.5 } }, /usage\.input: fix/],
    ["a usage that lacks a column", { ...finish, usage: { input: 1, cacheWrite: 1, cacheRead: 1 } as never }, /usage\.output: fix/],
    ["a negative cost", { ...finish, cost: -0.01 }, /cost: give the cost in US dollars, zero or more/],
    ["an end before the start", { ...finish, endedAt: "2026-10-16T09:01Z" }, /endedAt 2026-10-16T09:01:00Z: earlier than the start 2026-10-16T09:02:00Z/],
    ["an end that is not a UTC time", { ...finish, endedAt: "soon" }, /endedAt: give a UTC time/],
  ];
  for (const [what, args, pattern] of cases) await assert.rejects(() => op.dispatchFinish(args), refused(pattern), what);
  assert.equal(store.snapshot(), before, "no refused call wrote");
});

test("an ended dispatch is changed only with replace, which replaces the whole record and says so in the log", async t => {
  const { store, op } = await clocked(t);
  await op.dispatchStart(start);
  await op.dispatchFinish(finish);
  await assert.rejects(() => op.dispatchFinish({ ...finish, result: "一次通过" }), refused(/already ended at 2026-10-16T09:50:00Z as 返工后通过; pass replace: true/));

  await op.dispatchFinish({ author, id: "a", agentId: "agent-0001", result: "一次通过", usage, cost: 1, reports: 2, kickbacks: 0, replace: true });
  const d = store.snapshot().items.a!.dispatches![0]!;
  // The signals, note and wait of the first record are gone: a correction states the whole record again.
  assert.deepEqual(d.finish, { ended: "2026-10-16T10:00:00Z", result: "一次通过", reports: 2, kickbacks: 0, signals: [], usage, cost: 1 });
  assert.match(store.snapshot().items.a!.log.at(-1)!.text, /^收（更正）：会话 a-worker（工程师），一次通过，报告 2 次，打回 0 次/);
  assert.equal(store.snapshot().items.a!.dispatches!.length, 1);
});

test("only the item's own project writes its dispatches", async t => {
  const { store, op } = await clocked(t);
  await assert.rejects(() => op.dispatchStart({ ...start, author: "Firn" }), refused(/item a belongs to project Whitefoot/));
  await op.dispatchStart(start);
  await assert.rejects(() => op.dispatchFinish({ ...finish, author: "Firn" }), refused(/item a belongs to project Whitefoot/));
  assert.equal(store.snapshot().items.a!.dispatches![0]!.finish, undefined);
});

test("the architect, with its session, records on any project's item; without the session it is refused like any other project", async t => {
  const { store, op } = await clocked(t);
  await op.dispatchStart({ ...start, ...asArchitect, id: "other" });
  assert.equal(store.snapshot().items.other!.dispatches![0]!.agentId, "agent-0001");
  await op.dispatchFinish({ ...finish, ...asArchitect, id: "other" });
  assert.equal(store.snapshot().items.other!.dispatches![0]!.finish!.result, "返工后通过");
  await assert.rejects(() => op.dispatchStart({ ...start, agentId: "agent-0002", id: "other", author: "Architect", session: undefined }), refused(/item other belongs to project Firn/));
});

test("the PM, by its session or by a credential of its role, starts and ends dispatches on any project's item; a near miss of the session is refused", async t => {
  const { store, op } = await clocked(t);
  await op.dispatchStart({ ...start, ...asPM, id: "other" });
  assert.equal(store.snapshot().items.other!.dispatches![0]!.agentId, "agent-0001");
  await op.dispatchFinish({ ...finish, ...asPM, id: "other" });
  assert.equal(store.snapshot().items.other!.dispatches![0]!.finish!.result, "返工后通过");
  // Over a credential the role decides, whatever session the call carries.
  const pm = { ...asPM, access: { role: "PM" as const, project: "Architect", roots: [] } };
  await op.dispatchStart({ ...start, ...pm, id: "other", agentId: "agent-0002", agent: "other-worker" });
  await op.dispatchFinish({ ...finish, ...pm, id: "other", agentId: "agent-0002" });
  assert.equal(store.snapshot().items.other!.dispatches!.length, 2);
  for (const session of ["PMx", "pm", undefined]) {
    await assert.rejects(() => op.dispatchStart({ ...start, agentId: "agent-0003", id: "other", author: "Architect", session }), refused(/item other belongs to project Firn/), String(session));
    await assert.rejects(() => op.dispatchFinish({ ...finish, id: "other", author: "Architect", session }), refused(/item other belongs to project Firn/), String(session));
  }
});

test("the schema itself refuses a finished record carrying the other role's counts, in the rule's own words", async t => {
  const { store, op } = await clocked(t);
  await op.dispatchStart(start);
  await op.dispatchStart({ ...start, role: "审查", agentId: "rv-1", agent: "a-review" });
  await op.dispatchFinish(finish);
  await op.dispatchFinish({ ...finish, agentId: "rv-1", reports: undefined, kickbacks: undefined, rounds: 2 });
  const [engineer, review] = store.snapshot().items.a!.dispatches!;
  // Records as a hand edit of the YAML could leave them: each one breaks the rule differently.
  const { kickbacks: _k, ...engineerFinish } = engineer!.finish!, { rounds: _r, ...reviewFinish } = review!.finish!;
  const broken: Array<[string, unknown, RegExp]> = [
    ["an engineer without kickbacks", { ...engineer!, finish: engineerFinish }, /kickbacks: an engineer dispatch ends with reports and kickbacks/],
    ["an engineer with rounds", { ...engineer!, finish: { ...engineer!.finish!, rounds: 2 } }, /rounds: only a review dispatch carries rounds/],
    ["a review without rounds", { ...review!, finish: reviewFinish }, /rounds: a review dispatch ends with rounds/],
    ["a review with reports", { ...review!, finish: { ...review!.finish!, reports: 1 } }, /reports: only an engineer dispatch carries reports and kickbacks/],
  ];
  assert.equal(Dispatch.safeParse(engineer).success, true);
  assert.equal(Dispatch.safeParse(review).success, true);
  for (const [what, record, pattern] of broken) {
    const parsed = Dispatch.safeParse(record);
    assert.ok(!parsed.success, what);
    assert.match(parsed.error.issues.map(issue => issue.message).join("; "), pattern, what);
  }
});

test("an item's dispatches must have unique agentIds in the schema as well", async t => {
  const { store, op } = await clocked(t);
  await op.dispatchStart(start);
  const it = store.snapshot().items.a!;
  assert.equal(Item.safeParse({ ...it, dispatches: [it.dispatches![0], it.dispatches![0]] }).success, false);
});

test("dispatch records and their log lines are never news to the owner, while a head change on the same item is", async t => {
  const { store, op } = await clocked(t);
  const before = store.snapshot().head;
  await op.dispatchStart(start);
  await op.dispatchFinish(finish);
  const touched = async (cursor: string) => (await unreadSteps(store, cursor)).some(step => step.docs.some(doc => doc.id === "a"));
  assert.equal(await touched(before), false);

  const it = store.snapshot().items.a!;
  await op.updateItem({ author, id: "a", rev: it.rev, head: "新的 head", reason: "对照" });
  assert.equal(await touched(before), true);
});

// ---- the tallies: every figure must equal the rows added up independently ----

interface Plain { item: string; level: number; role: "工程师" | "审查"; ended: boolean; result: (typeof DISPATCH_RESULTS)[number]; counts: number; signals: string[]; milli: number; startedMin: number }

// A fixed generator so a failure replays; the sequence is irrelevant to the properties checked.
function prng(seed: number): () => number { let x = seed; return () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296; }

async function manyDispatches(t: Parameters<typeof board>[0], count = 60) {
  const fixture = await clocked(t), { op, store } = fixture, rnd = prng(7);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)]!;
  await op.setTag({ ...asArchitect, name: "看板", meaning: "m" });
  await op.setTag({ ...asArchitect, name: "协作流程", meaning: "m" });
  const owners: Record<string, string> = { a: "Whitefoot", b: "Whitefoot", area: "Whitefoot", other: "Firn" };
  await op.setTags({ author: "Whitefoot", id: "a", tags: ["看板", "协作流程"] });
  await op.setTags({ author: "Whitefoot", id: "b", tags: ["看板"] });
  await op.setTags({ author: "Firn", id: "other", tags: ["协作流程"] });
  const plain: Plain[] = [];
  for (let i = 0; i < count; i++) {
    const item = pick(Object.keys(owners)), role = pick(["工程师", "审查"] as const), level = 1 + Math.floor(rnd() * 5), startedMin = i;
    const started = new Date(Date.UTC(2026, 9, 16, 8, 0) + startedMin * 60000).toISOString().slice(0, 16) + "Z";
    await op.dispatchStart({ author: owners[item]!, id: item, role, level, model: "M", agent: `s${i}`, agentId: `g${i}`, startedAt: started });
    const ended = rnd() < 0.75, milli = Math.floor(rnd() * 20000), counts = Math.floor(rnd() * 5);
    const signals = DISPATCH_SIGNALS.filter(() => rnd() < 0.3), result = pick(DISPATCH_RESULTS);
    if (ended) await op.dispatchFinish({ author: owners[item]!, id: item, agentId: `g${i}`, result, usage, cost: milli / 1000, ...(role === "工程师" ? { reports: counts + 1, kickbacks: counts } : { rounds: counts }), signals: signals.map(kind => ({ kind })), endedAt: new Date(Date.parse(started) + 5 * 60000).toISOString() });
    plain.push({ item, level, role, ended, result, counts, signals: ended ? signals : [], milli: ended ? milli : 0, startedMin });
  }
  return { ...fixture, plain, tagsOf: (item: string) => store.snapshot().items[item]!.tags ?? [] };
}

// What a group's figures must be, added up by plain loops over the generated records.
function expected(rows: Plain[]) {
  const ended = rows.filter(r => r.ended), count = (r: (typeof DISPATCH_RESULTS)[number]) => ended.filter(e => e.result === r).length;
  const eng = ended.filter(e => e.role === "工程师"), rev = ended.filter(e => e.role === "审查");
  return { n: rows.length, open: rows.length - ended.length, results: DISPATCH_RESULTS.map(count), rework: count("返工后通过") + count("换人"), ended: ended.length, kick: eng.reduce((n, e) => n + e.counts, 0), engN: eng.length, rnd: rev.reduce((n, e) => n + e.counts, 0), revN: rev.length, milli: ended.reduce((n, e) => n + e.milli, 0) };
}
const LINE = /^(.+?)：派活 (\d+)（进行中 (\d+)） · 一次通过 (\d+) · 返工后通过 (\d+) · 换人 (\d+) · 放弃 (\d+) · 返工比例 (.+?) · 平均打回 (\S+) · 平均轮数 (\S+) · 花费 \$(\d+\.\d{3})$/;
function parsed(report: string, label: string) {
  const line = report.split("\n").find(l => l.startsWith(`${label}：派活`));
  assert.ok(line, `a line for ${label}`);
  const m = LINE.exec(line)!;
  assert.ok(m, `the line for ${label} has the expected shape: ${line}`);
  return { n: Number(m[2]), open: Number(m[3]), results: [4, 5, 6, 7].map(i => Number(m[i])), ratio: m[8]!, kick: m[9]!, rounds: m[10]!, milli: Math.round(Number(m[11]) * 1000) };
}
const section = (report: string, title: string) => {
  const lines = report.split("\n"), from = lines.findIndex(l => l.startsWith(title)), to = lines.findIndex((l, i) => i > from && l === "");
  return lines.slice(from + 1, to < 0 ? undefined : to).join("\n");
};

// One generated board serves all the tally tests below; its temporary directory goes when the suite ends.
describe("the tallies", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  let fx: Awaited<ReturnType<typeof manyDispatches>>;
  before(async () => { fx = await manyDispatches({ after: fn => { cleanups.push(fn); } }); });
  after(async () => { for (const fn of cleanups) await fn(); });

  test("the tallies by level, role and tag equal the rows added up one by one", async () => {
    const { store, plain, tagsOf } = fx;
    const rows = dispatchRows(store.snapshot()), report = dispatchReport(rows);
    assert.equal(rows.length, plain.length);

    const check = (label: string, group: Plain[], shown: string) => {
      const want = expected(group), got = parsed(shown, label);
      assert.deepEqual({ n: got.n, open: got.open, results: got.results, milli: got.milli }, { n: want.n, open: want.open, results: want.results, milli: want.milli }, label);
      assert.equal(got.ratio, want.ended ? `${Math.round(want.rework / want.ended * 100)}%（${want.rework}/${want.ended}）` : "-", `${label} rework share`);
      assert.equal(got.kick, want.engN ? (want.kick / want.engN).toFixed(2) : "-", `${label} mean kickbacks`);
      assert.equal(got.rounds, want.revN ? (want.rnd / want.revN).toFixed(2) : "-", `${label} mean rounds`);
    };
    check("合计", plain, report);
    for (const level of [1, 2, 3, 4, 5]) check(`${level} 级`, plain.filter(r => r.level === level), section(report, "按等级"));
    for (const role of ["工程师", "审查"]) check(role, plain.filter(r => r.role === role), section(report, "按角色"));
    const byTag = section(report, "按条目的标签");
    for (const tag of ["看板", "协作流程"]) check(tag, plain.filter(r => tagsOf(r.item).includes(tag)), byTag);
    check("（无标签）", plain.filter(r => !tagsOf(r.item).length), byTag);

    // The failure signals are counted over ended dispatches.
    const signalLine = report.split("\n").find(l => l.startsWith("失败信号"))!;
    for (const sig of DISPATCH_SIGNALS) assert.match(signalLine, new RegExp(`${sig} ${plain.filter(r => r.signals.includes(sig)).length}(?: ·|$)`), sig);
  });

  test("the level tallies add up to the total and a multi-tag item makes the tag tallies add up to more", async () => {
    const { store, plain, tagsOf } = fx;
    const s = summarize(dispatchRows(store.snapshot()));
    const sum = (tallies: Tally[], pick: (t: Tally) => number) => tallies.reduce((n, x) => n + pick(x), 0);
    const picks: Array<(x: Tally) => number> = [x => x.n, x => x.open, x => x.costMilli, x => x.results["放弃"], x => x.rework.count, x => x.rework.ended];
    for (const pick of picks) {
      assert.equal(sum(s.byLevel, pick), pick(s.total));
      assert.equal(sum(s.byRole, pick), pick(s.total));
    }
    const tagged = plain.reduce((n, r) => n + Math.max(1, tagsOf(r.item).length), 0);
    assert.equal(sum(s.byTag, x => x.n), tagged);
    assert.ok(tagged > plain.length, "the generated board has dispatches on a two-tag item");
  });

  test("the printed total equals the printed rows added up, to the thousandth", async () => {
    const { store } = fx;
    const report = dispatchReport(dispatchRows(store.snapshot()), true);
    const rowLines = section(report, "逐行").split("\n");
    // An ended row prints its cost as the last "$x.xxx" field of its line; a running row prints none.
    const costs = rowLines.map(line => / · \$(\d+\.\d{3})(?: · |$)/.exec(line)).filter(m => m).map(m => Math.round(Number(m![1]) * 1000));
    assert.equal(rowLines.length, 60);
    assert.equal(costs.reduce((a, b) => a + b, 0), parsed(report, "合计").milli);
    assert.equal(rowLines.filter(l => l.includes("起，进行中")).length, parsed(report, "合计").open);
  });

  test("filters narrow the rows by item, role, level and start time, since inclusive and until exclusive", async () => {
    const { store, plain } = fx;
    const s = store.snapshot(), want = (f: (r: Plain) => boolean) => plain.filter(f).length;
    assert.equal(dispatchRows(s, { id: "a" }).length, want(r => r.item === "a"));
    assert.equal(dispatchRows(s, { role: "审查" }).length, want(r => r.role === "审查"));
    assert.equal(dispatchRows(s, { level: 3 }).length, want(r => r.level === 3));
    assert.equal(dispatchRows(s, { role: "工程师", level: 1, id: "b" }).length, want(r => r.role === "工程师" && r.level === 1 && r.item === "b"));
    // Dispatch i starts at 08:00 + i minutes.
    assert.equal(dispatchRows(s, { since: "2026-10-16T08:10:00Z", until: "2026-10-16T08:20:00Z" }).length, 10);
    assert.deepEqual(dispatchRows(s, { since: "2026-10-16T08:10:00Z", until: "2026-10-16T08:20:00Z" }).map(r => r.dispatch.agentId), Array.from({ length: 10 }, (_, i) => `g${10 + i}`));
    assert.equal(dispatchRows(s, { until: "2026-10-16T08:00:00Z" }).length, 0);
    const starts = dispatchRows(s).map(r => r.dispatch.started);
    assert.deepEqual(starts, starts.slice().sort(), "oldest start first");
  });
});

test("an empty selection says so instead of printing zero tables", () => {
  assert.equal(dispatchReport([]), "No dispatches.");
});

// ---- over MCP ----

async function mcp(t: Parameters<typeof board>[0]) {
  const fixture = await clocked(t), server = createMcpServer({ store: fixture.store, ops: fixture.op });
  const client = new Client({ name: "Dispatch test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  return { ...fixture, client, text, call: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) };
}

test("the three tools round-trip over MCP, with the refusal text reaching the caller as an error", async t => {
  const { store, client, text, call } = await mcp(t);
  const tools = (await client.listTools()).tools;
  for (const name of ["dispatch_start", "dispatch_finish", "dispatches"]) assert.ok(tools.some(tool => tool.name === name), name);
  assert.deepEqual(tools.find(tool => tool.name === "dispatch_finish")!.inputSchema.required!.slice().sort(), ["agentId", "cost", "id", "result", "usage"]);

  const started = await call("dispatch_start", start);
  assert.equal(started.isError, undefined, text(started));
  assert.match(text(started), /dispatch_start a a-worker · rev \d+ · commit [0-9a-f]{40}/);

  const wrong = await call("dispatch_finish", { ...finish, rounds: 2 });
  assert.equal(wrong.isError, true);
  assert.match(text(wrong), /rounds: only a review dispatch carries rounds/);
  const badResult = await call("dispatch_finish", { ...finish, result: "差不多" });
  assert.equal(badResult.isError, true);
  assert.equal(store.snapshot().items.a!.dispatches![0]!.finish, undefined);

  const ended = await call("dispatch_finish", finish);
  assert.equal(ended.isError, undefined, text(ended));
  const report = text(await call("dispatches", { rows: true }));
  assert.match(report, /^合计：派活 1（进行中 0） · 一次通过 0 · 返工后通过 1 · 换人 0 · 放弃 0 · 返工比例 100%（1\/1） · 平均打回 1\.00 · 平均轮数 - · 花费 \$0\.365/);
  assert.match(report, /2026-10-16T09:02Z–2026-10-16T09:50Z · a · 会话 a-worker（号 agent-0001） · 工程师 · 2 级 Sonnet xhigh · 报告 3 次，打回 1 次 · 返工后通过/);
  assert.match(text(await call("dispatches", { filters: { id: "b" } })), /No dispatches\./);
  const unknown = await call("dispatches", { filters: { id: "nope" } });
  assert.equal(unknown.isError, true);
  assert.match(text(unknown), /id nope: choose an existing item/);
  const minuteForm = text(await call("dispatches", { filters: { since: "2026-10-16T09:02Z", until: "2026-10-16T09:03Z" } }));
  assert.match(minuteForm, /派活 1/);
  assert.match(text(await call("dispatches", { filters: { until: "2026-10-16T09:02Z" } })), /No dispatches\./);
  const noDate = await call("dispatches", { filters: { since: "2026-13-45T25:61Z" } });
  assert.equal(noDate.isError, true);
  assert.match(text(noDate), /since 2026-13-45T25:61Z: give a UTC time/);
});
