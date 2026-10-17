// The sessions watch (docs/design.md, The wake streams, Sessions watch): which sessions it looks after, when it wakes one and how,
// what it tells the PM, and what a restart keeps. The sessions are a fake `claude`; the board is a real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asArchitect, author, board, later } from "./helpers.ts";
import { holderOf } from "../src/dispatch.ts";
import { parseSessions, realClaude } from "../src/sessions.ts";
import type { Claude, SessionRow } from "../src/sessions.ts";
import {
  BLOCKED_AFTER_MS, CHAIN_AFTER_MS, QUIET_MS, RETRY_AFTER_MS, ROUND_MS, SessionWatch, UNREAD_AFTER_MS, WAKE_FAILURES, WORK_AFTER_MS, awaitsElsewhere, hasWorkLeft, phaseOf, watched,
} from "../src/session-watch.ts";
import { FOOTER_HEAD, FOOTER_LINES, STUCK_WHY, Wake, lineOf } from "../src/wake.ts";
import type { Told } from "../src/wake.ts";

const T0 = Date.parse(later), SEC = 1000, MIN = 60_000;

/** A background session as `claude agents --json --all` lists it; the defaults are a session parked at its prompt. */
const row = (name: string, extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id: `${name}-id`, sessionId: `sid-${name}`, name, kind: "background", cwd: "/work", pid: 100, status: "idle", state: "done", waitingFor: undefined, ...extra });

/** A stand-in for `claude`: it lists `rows`, and stop and resume change them the way Claude Code does. `calls` records what was run. */
class FakeClaude implements Claude {
  rows: SessionRow[] = [];
  calls: string[] = [];
  prompts: string[] = [];
  needsText = new Map<string, string>();
  /** Resume starts a copy under another session id, as `claude --bg --resume` does when it cannot continue in place. */
  copyOnResume = false;
  failResume = false;
  unreadable = false;
  /** Runs at the n-th listing (1 is the round's own), to move a session between the round's look and the wake's second look. */
  onRead?: { at: number; run: () => void };
  private reads = 0;
  async sessions(): Promise<SessionRow[]> {
    if (this.unreadable) throw new Error("claude agents: not found");
    this.reads += 1;
    if (this.onRead?.at === this.reads) this.onRead.run();
    return this.rows.map(r => ({ ...r }));
  }
  async needs(r: SessionRow) { return this.needsText.get(r.name); }
  async stop(r: SessionRow) {
    this.calls.push(`stop ${r.id}`);
    const own = this.rows.find(x => x.id === r.id)!;
    own.pid = undefined; own.status = undefined; own.state = "stopped";
  }
  async resume(r: SessionRow, prompt: string) {
    this.calls.push(`resume ${r.name}`); this.prompts.push(prompt);
    if (this.failResume) throw new Error("claude --bg --resume: exited 1");
    const own = this.rows.find(x => x.id === r.id)!;
    if (this.copyOnResume) {
      const copy = row(r.name, { id: `${r.name}-copy`, sessionId: `copy-${r.name}`, pid: 300, status: "busy", state: "working" });
      this.rows.push(copy);
      return { ...copy };
    }
    own.pid = 200; own.status = "busy"; own.state = "working";
    return { ...own };
  }
  /** Reset what was run, to count only the next rounds. */
  clear() { this.calls = []; this.prompts = []; }
  park(name: string, extra: Partial<SessionRow> = {}) { Object.assign(this.rows.find(r => r.name === name)!, { pid: 100, status: "idle", state: "done" }, extra); }
  set(name: string, extra: Partial<SessionRow>) { Object.assign(this.rows.find(r => r.name === name)!, extra); }
}

/** The plan of an item that rests on a CI run: its engineer, parked, has nothing to be woken for but the pushes owed it. */
const RESTING = [{ id: "ci", text: "等完整 CI", state: "doing", waits: "等完整 CI（链接），约 40 分钟" }];

/** A board with the watch over it, on a clock the test moves. `eng` is an engineer holding the item `eng-item`, resting on a CI run. */
async function rig(t: Parameters<typeof board>[0], options: { file?: string; engineer?: boolean } = {}) {
  const fixture = await board(t), { store, op } = fixture;
  const clock = { now: T0 };
  const wake = new Wake({ now: () => clock.now });
  wake.routeBy(item => holderOf(store.snapshot(), item));
  const claude = new FakeClaude();
  const watch = new SessionWatch({ store, wake, claude, now: () => clock.now, file: options.file });
  const told: Told[] = [];
  wake.onTell(x => told.push(x));
  const items = { count: 0 };
  /** An item in progress (or with the plan given) and the engineer holding it, listed as parked. */
  async function engineer(name: string, plan: Array<Record<string, unknown>> = [{ id: "impl", text: "实现", state: "doing" }]) {
    const key = `${name}-item`;
    await op.createItem({ ...asArchitect, group: author, key, title: `条目 ${name}`, plan: plan as never, accept: "验收通过", difficulty: 2 });
    await op.dispatchStart({ author, session: "架构师", id: key, role: "工程师", level: 2, model: "Sonnet", agent: name, agentId: `agent-${name}` });
    claude.rows.push(row(name));
    items.count += 1;
    return key;
  }
  async function reviewer(item: string) {
    const name = `${item}-review`;
    await op.dispatchStart({ author, session: "架构师", id: item, role: "审查", level: 2, model: "Sonnet", agent: name, agentId: `agent-${name}` });
    claude.rows.push(row(name));
    return name;
  }
  const message = (to: string, text = "看一下 eng-item 的日志", n = 1) => wake.push("message", { message: `m${n}`, from: "架构师", project: "Architect", to, item: null, text });
  const stuck = () => wake.since(0).frames.filter(f => f.event === "stuck");
  const at = (ms: number) => { clock.now = T0 + ms; };
  const round = async (ms: number) => { at(ms); await watch.round(); };
  if (options.engineer !== false) await engineer("eng", RESTING);
  return { ...fixture, clock, wake, claude, watch, told, engineer, reviewer, message, stuck, at, round };
}

test("a row is gone, busy, idle, blocked or unknown by its process and status, and a status this code has no word for is left alone", () => {
  const phase = (extra: Partial<SessionRow>) => phaseOf(row("s", extra));
  assert.equal(phase({ pid: undefined, status: undefined, state: "stopped" }), "gone");
  assert.equal(phase({ pid: undefined, status: undefined, state: "blocked" }), "gone", "a blocked session without a process is not running; it is woken, not reported");
  assert.equal(phase({ status: "busy", state: "working" }), "busy");
  assert.equal(phase({ status: "idle", state: "done" }), "idle");
  assert.equal(phase({ status: "idle", state: "working" }), "idle", "a turn that ended with work left is parked");
  assert.equal(phase({ status: "idle", state: "blocked" }), "blocked");
  assert.equal(phase({ status: "waiting", state: "blocked", waitingFor: "permission prompt" }), "blocked");
  assert.equal(phase({ status: "sleeping" }), "unknown");
  assert.equal(phase({ status: undefined }), "unknown");
});

test("claude's list is read into rows, and a row without a name or a session id is left out", () => {
  const rows = parseSessions(JSON.stringify([
    { pid: 1, cwd: "/a", kind: "interactive", sessionId: "s1", name: "架构师", status: "busy" },
    { id: "ab12cd34", pid: 2, cwd: "/b", kind: "background", sessionId: "s2", name: "eng", status: "waiting", state: "blocked", waitingFor: "permission prompt" },
    { id: "ee", cwd: "/c", kind: "background", sessionId: "s3", state: "done" },
    { id: "ff", cwd: "/c", kind: "background", name: "no-session-id" },
    "not a row",
  ]));
  assert.deepEqual(rows.map(r => [r.name, r.kind, r.id, r.pid, r.status, r.state, r.waitingFor]), [["架构师", "interactive", "", 1, "busy", undefined, undefined], ["eng", "background", "ab12cd34", 2, "waiting", "blocked", "permission prompt"]]);
  assert.throws(() => parseSessions("{}"), /did not print a list/);
});

test("the watch looks after engineers and reviewers of open items that are not paused, and the PM", async t => {
  const r = await rig(t);
  await r.engineer("busy-eng");
  const pm = { author: "PM", session: "PM" };
  const cancelled = await r.engineer("cancelled-eng");
  await r.op.setStatus({ ...pm, id: cancelled, status: "cancelled", log: "取消" });
  const paused = await r.engineer("paused-eng");
  await r.op.setPause({ ...pm, id: paused, paused: true, reason: "暂停" });
  await r.reviewer("eng-item");
  const s = r.store.snapshot();
  const list = watched(s, r.store.derived.rules(s, T0));
  const names = list.map(w => `${w.role}:${w.name}`).sort();
  assert.ok(names.includes("engineer:eng") && names.includes("engineer:busy-eng") && names.includes("reviewer:eng-item-review") && names.includes("pm:PM"), names.join(" "));
  assert.ok(!names.includes("engineer:paused-eng"), "a paused item's session is the PM's to resume");
  assert.ok(!names.includes("engineer:cancelled-eng"), "and a cancelled item's, to stop");
  assert.deepEqual(list.find(w => w.name === "eng-item-review")?.items, ["eng-item"]);
});

test("a parked session with a push undelivered is woken within a minute: stopped, continued with the push in its prompt, and the push counts as delivered", async t => {
  const r = await rig(t);
  r.message("eng");
  await r.round(0);
  assert.deepEqual(r.claude.calls, [], "the first look only starts the count: a session that just parked may be about to move");
  await r.round(ROUND_MS);
  assert.deepEqual(r.claude.calls, ["stop eng-id", "resume eng"]);
  const prompt = r.claude.prompts[0]!;
  assert.ok(prompt.includes(FOOTER_HEAD) && prompt.includes("看一下 eng-item 的日志"), prompt);
  assert.match(prompt, /看板工具在续上后几秒内可能还连不上/, "the prompt warns that the board's tools may not be connected yet");
  assert.equal(r.wake.mail("eng"), undefined, "what the prompt carried is delivered");
  await r.round(2 * ROUND_MS);
  assert.deepEqual(r.claude.calls, ["stop eng-id", "resume eng"], "it runs now (busy) and is left alone");
});

test("a session that has been parked a while is woken at the first round after a push", async t => {
  const r = await rig(t);
  await r.round(0);
  await r.round(10 * MIN);
  assert.deepEqual(r.claude.calls, []);
  r.at(10 * MIN + 5 * SEC); r.message("eng");
  await r.round(10 * MIN + ROUND_MS);
  assert.deepEqual(r.claude.calls, ["stop eng-id", "resume eng"]);
});

test("a session whose process is gone is continued without a stop, however long ago it ended", async t => {
  const r = await rig(t);
  r.claude.set("eng", { pid: undefined, status: undefined, state: "stopped" });
  r.message("eng");
  await r.round(0); await r.round(ROUND_MS);
  assert.deepEqual(r.claude.calls, ["resume eng"]);
  assert.equal(r.wake.mail("eng"), undefined);
});

test("pushes that come together make one wake, at most five lines of them, and the rest wait for the next", async t => {
  const r = await rig(t);
  for (let i = 1; i <= FOOTER_LINES + 2; i++) r.message("eng", `第 ${i} 条`, i);
  await r.round(0); await r.round(ROUND_MS);
  assert.equal(r.claude.prompts.length, 1);
  const lines = r.claude.prompts[0]!.split("\n");
  assert.equal(lines.filter(l => l.startsWith("#")).length, FOOTER_LINES);
  assert.match(r.claude.prompts[0]!, /另有 2 条没送到（消息 2）/);
  assert.equal(r.wake.mail("eng")?.count, 2, "the two counted ones are still owed");
  // It parks again, and the two are carried by the next wake.
  r.claude.park("eng");
  await r.round(2 * ROUND_MS); await r.round(3 * ROUND_MS);
  assert.equal(r.claude.prompts.length, 2);
  assert.equal(r.wake.mail("eng"), undefined);
});

test("a busy session is never stopped or continued, whatever is owed it; a push unread for 20 minutes is told once", async t => {
  const r = await rig(t);
  r.claude.set("eng", { status: "busy", state: "working" });
  r.message("eng");
  for (let ms = 0; ms < UNREAD_AFTER_MS; ms += ROUND_MS) await r.round(ms);
  assert.deepEqual(r.claude.calls, []);
  assert.equal(r.stuck().length, 0, "told only once it has waited UNREAD_AFTER_MS");
  await r.round(UNREAD_AFTER_MS); await r.round(UNREAD_AFTER_MS + ROUND_MS);
  assert.deepEqual(r.claude.calls, []);
  assert.deepEqual(r.stuck().map(f => [f.session, f.why]), [["eng", "unread"]], "once");
  assert.equal(r.wake.mail("eng")?.count, 1, "and the push is still owed: a tool result will carry it");
});

test("a session that starts working between the round's look and the wake is left alone", async t => {
  const r = await rig(t);
  r.message("eng");
  await r.round(0);
  r.claude.onRead = { at: 3, run: () => r.claude.set("eng", { status: "busy", state: "working" }) };
  await r.round(ROUND_MS);
  assert.deepEqual(r.claude.calls, [], "the second look saw it busy: no stop, so no copy and no lost turn");
  assert.equal(r.wake.mail("eng")?.count, 1);
});

test("a resume that starts a copy is stopped and told, the original is not woken again, and the push is still owed", async t => {
  const r = await rig(t);
  r.claude.copyOnResume = true;
  r.message("eng");
  await r.round(0); await r.round(ROUND_MS);
  assert.deepEqual(r.claude.calls, ["stop eng-id", "resume eng", "stop eng-copy"]);
  assert.deepEqual(r.stuck().map(f => [f.session, f.why]), [["eng", "copy"]]);
  assert.equal(r.wake.mail("eng")?.count, 1, "not delivered: the original did not get it");
  await r.round(2 * ROUND_MS); await r.round(10 * MIN);
  assert.equal(r.claude.calls.filter(c => c.startsWith("resume")).length, 1, "no second try, which would copy again");
  assert.equal(r.stuck().length, 1);
});

test("a wake that fails is tried again, the PM is told at the third failure, and the next try waits ten minutes", async t => {
  const r = await rig(t);
  r.claude.failResume = true;
  r.message("eng");
  await r.round(0);
  for (let i = 1; i <= WAKE_FAILURES; i++) await r.round(i * ROUND_MS);
  assert.equal(r.claude.prompts.length, WAKE_FAILURES);
  assert.deepEqual(r.stuck().map(f => [f.session, f.why]), [["eng", "no-resume"]]);
  assert.match(String(r.stuck()[0]!.text), /exited 1/);
  assert.equal(r.wake.mail("eng")?.count, 1, "nothing was delivered");
  await r.round((WAKE_FAILURES + 1) * ROUND_MS);
  assert.equal(r.claude.prompts.length, WAKE_FAILURES, "no try within ten minutes of the last");
  r.claude.failResume = false;
  await r.round(WAKE_FAILURES * ROUND_MS + RETRY_AFTER_MS);
  assert.equal(r.claude.prompts.length, WAKE_FAILURES + 1);
  assert.equal(r.wake.mail("eng"), undefined, "and it worked");
  await r.round(WAKE_FAILURES * ROUND_MS + RETRY_AFTER_MS + ROUND_MS);
  r.claude.park("eng"); r.message("eng", "again", 2);
  await r.round(WAKE_FAILURES * ROUND_MS + RETRY_AFTER_MS + 2 * ROUND_MS);
  assert.equal(r.stuck().length, 1, "the report was made once");
});

test("a session blocked for two minutes is told to the PM with what it wrote it needs, once; one that rests on a card or another item is not", async t => {
  const r = await rig(t);
  r.claude.set("eng", { state: "blocked" });
  r.claude.needsText.set("eng", "放行命令：node wait-wake.mjs（后台运行）");
  await r.round(0);
  await r.round(BLOCKED_AFTER_MS - ROUND_MS);
  assert.equal(r.stuck().length, 0);
  await r.round(BLOCKED_AFTER_MS); await r.round(BLOCKED_AFTER_MS + 10 * MIN);
  const [frame, ...more] = r.stuck();
  assert.equal(more.length, 0);
  assert.deepEqual([frame!.session, frame!.item, frame!.why], ["eng", "eng-item", "blocked"]);
  assert.match(String(frame!.text), /放行命令：node wait-wake\.mjs/);
  assert.match(lineOf(frame!), new RegExp(`卡住了 · it:eng-item.*${STUCK_WHY.blocked}`));
  // Waiting on another item is a rest.
  const waiting = await r.engineer("wait-eng", [{ item: "other", own: false }]);
  assert.equal(r.store.derived.rules(r.store.snapshot(), T0).statusOf(waiting), "blocked");
  r.claude.set("wait-eng", { state: "blocked" });
  await r.round(20 * MIN); await r.round(30 * MIN);
  assert.deepEqual(r.stuck().map(f => f.session), ["eng"]);
});

test("a blocked session is also woken by a push, which may be what unblocks it", async t => {
  const r = await rig(t);
  r.claude.set("eng", { state: "blocked" });
  await r.round(0);
  r.message("eng");
  await r.round(ROUND_MS);
  assert.deepEqual(r.claude.calls, ["stop eng-id", "resume eng"]);
});

test("an engineer waiting for a review whose reviewer is blocked: the PM is told of the reviewer, not the engineer", async t => {
  const r = await rig(t, { engineer: false });
  const item = await r.engineer("eng", [{ id: "review", text: "审查（2 级）", state: "doing" }]);
  const reviewer = await r.reviewer(item);
  r.claude.set(reviewer, { state: "blocked" });
  r.claude.needsText.set(reviewer, "等待脚本被权限拒绝");
  for (let ms = 0; ms <= 2 * BLOCKED_AFTER_MS; ms += ROUND_MS) await r.round(ms);
  assert.deepEqual(r.stuck().map(f => [f.session, f.item, f.why]), [[reviewer, item, "blocked"]]);
  assert.deepEqual(r.claude.calls, [], "nothing to wake: the engineer rests on its review, and the reviewer has nothing owed");
});

test("a blocked reviewer is not told while no review waits for it", async t => {
  const r = await rig(t);
  const reviewer = await r.reviewer("eng-item");
  r.claude.set(reviewer, { state: "blocked" });
  for (let ms = 0; ms <= 2 * BLOCKED_AFTER_MS; ms += ROUND_MS) await r.round(ms);
  assert.equal(r.stuck().length, 0);
});

test("a review in progress with the reviewer and the engineer both parked and no push on the way is told after 15 minutes, as the reviewer's", async t => {
  const r = await rig(t, { engineer: false });
  const item = await r.engineer("eng", [{ id: "review", text: "审查（2 级）", state: "doing" }]);
  const reviewer = await r.reviewer(item);
  for (let ms = 0; ms < CHAIN_AFTER_MS; ms += ROUND_MS) await r.round(ms);
  assert.equal(r.stuck().length, 0, "the engineer rests on its review: it is not stopped, and 15 minutes have not passed");
  await r.round(CHAIN_AFTER_MS); await r.round(CHAIN_AFTER_MS + 5 * MIN);
  assert.deepEqual(r.stuck().map(f => [f.session, f.item, f.why]), [[reviewer, item, "chain"]]);
  assert.match(String(r.stuck()[0]!.text), /工程师 eng 都停了 15 分钟/);
  assert.deepEqual(r.claude.calls, []);
});

test("a reviewer's wait is not a stuck link while the engineer works or the review is not asked for", async t => {
  const r = await rig(t, { engineer: false });
  const item = await r.engineer("eng", [{ id: "review", text: "审查（2 级）", state: "doing" }]);
  await r.reviewer(item);
  r.claude.set("eng", { status: "busy", state: "working" });
  for (let ms = 0; ms <= CHAIN_AFTER_MS + 5 * MIN; ms += ROUND_MS) await r.round(ms);
  assert.equal(r.stuck().length, 0, "the engineer is working");
});

test("an engineer parked with work left and nothing awaited is woken once after 5 minutes, and told to the PM if it parks again as long", async t => {
  const r = await rig(t);
  await r.engineer("worker");
  await r.round(0);
  await r.round(WORK_AFTER_MS - ROUND_MS);
  assert.deepEqual(r.claude.calls, []);
  await r.round(WORK_AFTER_MS);
  assert.deepEqual(r.claude.calls, ["stop worker-id", "resume worker"], "the engineer resting on its CI run is not touched");
  assert.match(r.claude.prompts[0]!, /条目 worker-item 还有活，计划里没写你在等什么/);
  assert.match(r.claude.prompts[0]!, /不要在会话里提问/);
  const woken = WORK_AFTER_MS;
  await r.round(woken + ROUND_MS);
  r.claude.park("worker");
  await r.round(woken + 2 * ROUND_MS);
  await r.round(woken + 2 * ROUND_MS + WORK_AFTER_MS - ROUND_MS);
  assert.equal(r.stuck().length, 0);
  await r.round(woken + 2 * ROUND_MS + WORK_AFTER_MS); await r.round(woken + 2 * ROUND_MS + WORK_AFTER_MS + 10 * MIN);
  assert.deepEqual(r.stuck().map(f => [f.session, f.why]), [["worker", "stopped"]]);
  assert.equal(r.claude.prompts.length, 1, "woken once");
});

test("an engineer that writes what it waits for after being woken is left alone, and is woken again if work is left later", async t => {
  const r = await rig(t);
  const item = await r.engineer("worker");
  await r.round(0); await r.round(WORK_AFTER_MS);
  assert.equal(r.claude.prompts.length, 1);
  // It answered the wake by marking its step as waiting on a run.
  await r.op.setPlan({ author, session: "架构师", id: item, row: { id: "impl", text: "实现", state: "doing", waits: "等 14900K" } });
  await r.round(WORK_AFTER_MS + ROUND_MS);
  r.claude.park("worker");
  await r.round(WORK_AFTER_MS + 2 * ROUND_MS); await r.round(WORK_AFTER_MS + 2 * ROUND_MS + 2 * WORK_AFTER_MS);
  assert.equal(r.stuck().length, 0, "it rests on what it wrote");
  // The wait ends, work is left again: a new episode, woken once more.
  await r.op.setPlan({ author, session: "架构师", id: item, row: { id: "impl", text: "实现", state: "doing" } });
  await r.round(5 * WORK_AFTER_MS); await r.round(6 * WORK_AFTER_MS + ROUND_MS);
  assert.equal(r.claude.prompts.length, 2);
});

test("a step in progress that names its wait, a review, a CI step, or a merge done with the live check not done: the engineer rests and is neither woken nor told", async t => {
  const r = await rig(t, { engineer: false });
  const cases: Array<[string, Array<Record<string, unknown>>]> = [
    ["waits", [{ id: "ci", text: "等完整 CI", state: "doing", waits: "等完整 CI（链接），约 40 分钟" }]],
    ["review", [{ id: "review", text: "审查（2 级）", state: "doing" }]],
    ["ci", [{ id: "ci", text: "完整 CI", state: "doing" }]],
    ["deploy", [{ id: "merge", text: "合入 Whitefoot#1", state: "done" }, { id: "verify", text: "线上验证", state: "todo" }]],
  ];
  for (const [name, plan] of cases) {
    const item = await r.engineer(name, plan);
    const s = r.store.snapshot();
    assert.ok(awaitsElsewhere(s, r.store.derived.rules(s, T0), item), name);
  }
  for (let ms = 0; ms <= 2 * WORK_AFTER_MS; ms += ROUND_MS) await r.round(ms);
  assert.deepEqual(r.claude.calls, []);
  assert.equal(r.stuck().length, 0);
  // An item with work and none of those is not at rest.
  await r.engineer("plain");
  const rules = r.store.derived.rules(r.store.snapshot(), T0);
  assert.ok(hasWorkLeft(rules, "plain-item") && !awaitsElsewhere(r.store.snapshot(), rules, "plain-item"));
});

test("a session with no listing at all is told after 5 minutes, and the PM's missing session is not", async t => {
  const r = await rig(t);
  r.claude.rows = [];
  await r.round(0); await r.round(WORK_AFTER_MS - ROUND_MS);
  assert.equal(r.stuck().length, 0);
  await r.round(WORK_AFTER_MS);
  assert.deepEqual(r.stuck().map(f => [f.session, f.why]), [["eng", "missing"]]);
  assert.equal(r.told.length, 0, "the PM has no session of this kind to find");
});

test("two sessions with one name are told and neither is touched", async t => {
  const r = await rig(t);
  r.claude.rows.push(row("eng", { id: "eng-other", sessionId: "sid-other" }));
  r.message("eng");
  await r.round(0); await r.round(ROUND_MS);
  assert.deepEqual(r.claude.calls, []);
  assert.deepEqual(r.stuck().map(f => [f.session, f.why]), [["eng", "duplicate"]]);
});

test("the PM, a background session, is woken with the pushes it has not answered, and they are receipted up to what the prompt carried", async t => {
  const r = await rig(t);
  r.claude.rows.push(row("PM"));
  const frame = r.wake.push("stalled", { item: "eng-item", project: "Whitefoot", title: "t", text: "x" });
  assert.ok(frame.line, "the PM's pushes carry their one line, like any agent's");
  await r.round(0); await r.round(ROUND_MS);
  assert.deepEqual(r.claude.calls, ["stop PM-id", "resume PM"]);
  assert.ok(r.claude.prompts[0]!.includes(String(frame.line)));
  assert.equal(r.wake.receiptedUpTo(), frame.n);
  r.claude.clear();
  r.claude.set("PM", { status: "busy", state: "working" });
  r.wake.push("stalled", { item: "eng-item", project: "Whitefoot", title: "t", text: "y" });
  await r.round(2 * ROUND_MS); await r.round(3 * ROUND_MS);
  assert.deepEqual(r.claude.calls, [], "a PM that is working (its Monitor armed) is left alone");
});

test("a blocked PM is told to the owner, not to the PM", async t => {
  const r = await rig(t);
  r.claude.rows.push(row("PM", { state: "blocked" }));
  r.claude.needsText.set("PM", "批准 gh 命令");
  await r.round(0); await r.round(BLOCKED_AFTER_MS);
  assert.equal(r.stuck().length, 0);
  assert.equal(r.told.length, 1);
  assert.match(r.told[0]!.title, /PM 被拦住/);
  assert.match(r.told[0]!.message, /批准 gh 命令/);
});

test("what the watch told and how long a session has been parked are kept across a restart", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-session-watch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "state", "session-watch.json");
  const r = await rig(t, { file });
  r.claude.set("eng", { state: "blocked" });
  await r.round(0); await r.round(BLOCKED_AFTER_MS);
  assert.equal(r.stuck().length, 1);
  const again = new SessionWatch({ store: r.store, wake: r.wake, claude: r.claude, now: () => r.clock.now, file });
  r.at(BLOCKED_AFTER_MS + MIN);
  await again.round();
  assert.equal(r.stuck().length, 1, "a restart does not tell it again");
  // Parked time survives too: a session parked before the restart is woken at the first round after it.
  r.claude.set("eng", { status: "idle", state: "done" });
  await again.round();
  r.message("eng");
  const third = new SessionWatch({ store: r.store, wake: r.wake, claude: r.claude, now: () => r.clock.now, file });
  r.at(BLOCKED_AFTER_MS + 2 * MIN);
  await third.round();
  assert.deepEqual(r.claude.calls, ["stop eng-id", "resume eng"]);
  assert.match(await readFile(file, "utf8"), /"sessions"/);
});

test("a round when claude cannot be read does nothing, and the next round goes on", async t => {
  const r = await rig(t);
  r.message("eng");
  r.claude.unreadable = true;
  await r.round(0); await r.round(ROUND_MS);
  assert.deepEqual(r.claude.calls, []);
  r.claude.unreadable = false;
  await r.round(2 * ROUND_MS);
  assert.deepEqual(r.claude.calls, [], "the first look at a session only starts the count");
  await r.round(3 * ROUND_MS);
  assert.deepEqual(r.claude.calls, ["stop eng-id", "resume eng"]);
});

test("a round that finds the previous one still running does nothing", async t => {
  const r = await rig(t);
  r.message("eng");
  await r.round(0);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = r.claude.sessions.bind(r.claude);
  r.claude.sessions = async () => { await held; return original(); };
  r.at(ROUND_MS);
  const first = r.watch.round(), second = r.watch.round();
  await second;
  release();
  await first;
  assert.deepEqual(r.claude.calls, ["stop eng-id", "resume eng"], "one wake, not two");
});

test("an interactive session is never looked at, even under a watched name", async t => {
  const r = await rig(t);
  r.claude.rows = [row("eng", { kind: "interactive", id: "" })];
  r.message("eng");
  await r.round(0); await r.round(ROUND_MS); await r.round(WORK_AFTER_MS + ROUND_MS);
  assert.deepEqual(r.claude.calls, []);
});

test("the constants the design states are these", () => {
  assert.equal(ROUND_MS, 30 * SEC);
  assert.ok(QUIET_MS < ROUND_MS, "a session seen parked in one round is quiet enough by the next");
  assert.equal(BLOCKED_AFTER_MS, 2 * MIN);
  assert.equal(WORK_AFTER_MS, 5 * MIN);
  assert.equal(CHAIN_AFTER_MS, 15 * MIN);
  assert.equal(UNREAD_AFTER_MS, 20 * MIN);
  assert.equal(RETRY_AFTER_MS, 10 * MIN);
  assert.equal(WAKE_FAILURES, 3);
});

// The real `claude` adapter, against a script standing in for the command: what it runs, in which directory, with which environment.
test("the real adapter lists sessions, stops one by its short id, and continues it by its session id in its directory with WF_HOME", async t => {
  // realpath: on macOS tmpdir() goes through /var, which is /private/var, and a shell reports the second.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "wf-board-fake-claude-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "claude"), log = join(dir, "log");
  await writeFile(join(dir, "agents.json"), JSON.stringify([{ id: "abcd1234", pid: 777, cwd: dir, kind: "background", sessionId: "s-1", name: "eng", status: "busy", state: "working" }]));
  await mkdir(join(dir, "jobs", "ab12cd34"), { recursive: true });
  await writeFile(join(dir, "jobs", "ab12cd34", "state.json"), JSON.stringify({ needs: "n".repeat(300), detail: "d" }));
  await writeFile(script, `#!/bin/sh
echo "$PWD WF_HOME=$WF_HOME $*" >> "${log}"
case "$1" in
  agents) cat "${dir}/agents.json" ;;
  stop) ;;
  --bg) echo "backgrounded · abcd1234 · eng" ;;
esac
`);
  await chmod(script, 0o755);
  const awake: number[] = [];
  const claude = realClaude({ command: script, home: "/srv/wf", claudeHome: dir, lookMs: 1, looks: 3, keepAwake: pid => awake.push(pid) });
  const [listed] = await claude.sessions();
  assert.equal(listed!.name, "eng");
  await claude.stop({ ...listed!, id: "ab12cd34" });
  const started = await claude.resume(listed!, "【看板叫醒】你好");
  assert.equal(started?.sessionId, "s-1");
  assert.deepEqual(awake, [777], "the Mac is kept awake while the continued session runs");
  const lines = (await readFile(log, "utf8")).trim().split("\n");
  assert.ok(lines[0]!.endsWith(" agents --json --all"), lines[0]);
  assert.ok(lines[1]!.endsWith(" stop ab12cd34"), lines[1]);
  assert.equal(lines[2], `${dir} WF_HOME=/srv/wf --bg --resume s-1 -- 【看板叫醒】你好`, "in the session's directory, with the workspace in its environment");
  assert.equal([...(await claude.needs({ ...listed!, id: "ab12cd34" }))!].length, 160, "what it wrote it needs, cut to 160 characters");
  assert.equal(await claude.needs({ ...listed!, id: "missing0" }), undefined, "a session without a job file has none");
  await assert.rejects(realClaude({ command: join(dir, "no-such-command"), home: "/srv/wf" }).sessions(), /no-such-command/);
});

test("the PM's unanswered pushes are what a wake carries, and a receipt up to a number answers only those", () => {
  const wake = new Wake({ now: () => T0 });
  const frames = Array.from({ length: FOOTER_LINES + 1 }, (_, i) => wake.push("stalled", { item: `i${i}`, project: "Whitefoot", title: "t", text: "x" }));
  const mail = wake.pmMail()!;
  assert.equal(mail.count, FOOTER_LINES + 1);
  assert.ok(mail.text.startsWith(FOOTER_HEAD));
  assert.equal(mail.upto, frames[FOOTER_LINES - 1]!.n, "up to the last line shown");
  wake.receipt(mail.upto);
  assert.equal(wake.receiptedUpTo(), mail.upto);
  assert.equal(wake.pmMail()!.count, 1);
  wake.receipt();
  assert.equal(wake.pmMail(), undefined);
});
