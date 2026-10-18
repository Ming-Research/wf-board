// The PM is retired (item board-retire-pm-stream): its pushes go to the architect or are not made, there is no PM stream and no
// receipt for one, and the author PM is refused like the retired coordinator. docs/design.md (the wake streams, section 9) gives
// the reasons; these tests state the rules the other test files no longer have a PM to check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { agentSocket, asArchitect, board, server } from "./helpers.ts";
import { ARCHITECT_SESSION, LONG_LIVED_ROLES } from "../src/model.ts";
import { CredentialsFile } from "../src/credentials.ts";
import { Wake, WAKE_KINDS } from "../src/wake.ts";
import type { WakeKind } from "../src/wake.ts";
import { BackupPush } from "../src/backup-push.ts";
import { SlowOps } from "../src/slow-ops.ts";
import { decide } from "../src/watch.ts";
import { STALLED_LABEL } from "../src/rules.ts";
import type { PullState, RepoState } from "../src/github.ts";

const T0 = Date.parse("2026-10-16T00:00:00Z"), MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** Every push the wake makes through `push`, by kind, whichever stream the kind then goes to. */
function pushes(wake: Wake): string[] {
  const events: string[] = [], push = wake.push.bind(wake);
  wake.push = ((event: WakeKind, fields: Record<string, unknown>) => { events.push(event); return push(event, fields); }) as typeof wake.push;
  return events;
}
const architectEvents = (wake: Wake) => wake.agent(ARCHITECT_SESSION).pending().frames.map(f => f.event);
const RETIRED = ["stalled", "timed", "review", "finished", "pr-red", "pr-orphan", "no-answer"];

test("the board pushes twelve kinds and none goes to a PM stream", () => {
  assert.deepEqual(Object.keys(WAKE_KINDS).sort(), [
    "ask-alive", "backup-behind", "card-ruled", "dep-merged", "deployFailed", "deployed", "item-done", "main-red", "message", "note", "slow-op", "timed-architect",
  ]);
  for (const [kind, spec] of Object.entries(WAKE_KINDS)) assert.notEqual(spec.to, "pm", kind);
});

test("the kinds the PM acted on go to the architect, or to the session holding the item with the architect when nobody does", () => {
  const to = (kind: WakeKind): unknown => WAKE_KINDS[kind].to;
  assert.equal(to("backup-behind"), "architect");
  assert.equal(to("slow-op"), "architect");
  assert.deepEqual(to("main-red"), { holder: "item", otherwise: "architect" });
  assert.deepEqual(to("deployFailed"), { holder: "item", otherwise: "architect" });
  // The ask goes to the session that holds the item it names; the liveness round only asks sessions that hold one.
  assert.deepEqual(to("ask-alive"), { holder: "item", only: true });
});

test("backup-behind and slow-op reach the architect's stream, and so do main-red and deployFailed that no session holds", () => {
  const wake = new Wake({ now: () => T0 });
  const red = { repo: "Ming-Research/Whitefoot", project: "Whitefoot", branch: "main", commit: "a".repeat(40), failed: ["test"], url: "https://example.invalid", item: null, pr: null };
  const failed = { version: null, running: null, reason: "the remote could not be fetched", item: null, project: null, title: null, pr: null };
  wake.push("backup-behind", { commits: 3, lastSuccess: null, reason: null });
  wake.push("slow-op", { op: "tool context", ms: 5000, limitMs: 1000, params: "" });
  wake.push("main-red", red);
  wake.push("deployFailed", failed);
  assert.deepEqual(architectEvents(wake), ["backup-behind", "slow-op", "main-red", "deployFailed"]);
  // Held by a session, both go to it and not to the architect.
  wake.routeBy(() => "eng");
  wake.push("main-red", { ...red, item: "it1", pr: 7 });
  wake.push("deployFailed", { ...failed, item: "it1", pr: 7 });
  assert.deepEqual(wake.agent("eng").pending().frames.map(f => f.event), ["main-red", "deployFailed"]);
  assert.equal(wake.agent(ARCHITECT_SESSION).pending().frames.length, 4);
});

test("a backup that stays behind for an hour and a slow operation are told to the architect through their senders", async t => {
  let clock = T0;
  const wake = new Wake({ now: () => clock });
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {}); t.mock.method(console, "warn", () => {});
  const backup = new BackupPush({ store: { push: async () => { throw new Error("remote refused"); }, unpushed: async () => 2 }, wake, now: () => clock });
  clock += 61 * MIN;
  await assert.rejects(backup.round(), /remote refused/);
  new SlowOps({ wake, now: () => clock }).record({ name: "tool context", cls: "read", ms: 5000, result: "ok" });
  assert.deepEqual(architectEvents(wake), ["backup-behind", "slow-op"]);
});

test("a failed deploy that concerns no held item is told to the architect, and a deploy that happened is told to nobody", async t => {
  const wake = new Wake({ now: () => T0 });
  const { api } = await server(t, { wake });
  const failed = { event: "deployFailed", version: "a".repeat(40), running: null, reason: "the daemon was not healthy", changes: ["abc1234 Merge pull request #99 from Ming-Research/thing"], repo: "Ming-Research/Whitefoot" };
  const deployed = { event: "deployed", version: "a".repeat(40), previous: "b".repeat(40), changes: failed.changes, restarted: true, repo: failed.repo };
  assert.deepEqual(await api("/api/wake", failed), { status: 200, data: { pushed: 1 } });
  assert.deepEqual(await api("/api/wake", deployed), { status: 200, data: { pushed: 0 } });
  assert.deepEqual(architectEvents(wake), ["deployFailed"]);
});

test("there is no stream at /wake: the upgrade is refused, and PM is an ordinary session's stream name", async t => {
  const { url } = await server(t);
  const status = (path: string) => new Promise<number>(resolve => {
    const socket = new WebSocket(url.replace("http:", "ws:") + path);
    socket.on("error", () => {});
    socket.on("unexpected-response", (request, response) => { response.resume(); request.destroy(); resolve(response.statusCode!); });
    socket.on("open", () => { resolve(101); socket.terminate(); });
    t.after(() => socket.terminate());
  });
  assert.equal(await status("/wake"), 404);
  assert.equal(await status("/wake?after=0"), 404);
  assert.equal(await status("/wake/PM"), 101, "the name PM has no stream of its own; it is a name like any other");
  const star = await agentSocket(t, url, ARCHITECT_SESSION);
  assert.deepEqual(star.frames, [{ event: "connected", latest: 0 }], "the architect's stream is as before");
});

test("stalled work is not pushed, though the check stays", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const start = Date.parse("2026-10-11T03:00:00Z");
  // Half an hour of active time at the start: not stalled yet, so the first scan does not take it for standing.
  let clock = start + 30 * MIN;
  const wake = new Wake({ now: () => clock }), events = pushes(wake);
  const { store } = await server(t, { wake, now: () => clock, checkIntervalMs: 1000, architectTimedWakeMs: 1e12, prepare: ({ store }) => {
    const s = structuredClone(store.snapshot());
    s.items.w = { ...s.items.other!, title: "没人推进的叶子", group: "Whitefoot", created: iso(start), updated: iso(start), log: [], plan: [{ id: "work", text: "当前工作", state: "doing", since: iso(start) }, { id: "accept", text: "某项检查通过", state: "todo", accept: true }] };
    s.activity = { writes: Array.from({ length: 2 }, (_, i) => iso(start + i * 30 * MIN)), items: {} };
    store.snapshot = () => structuredClone(s);
  } });
  const stalled = () => store.derived.rules(store.snapshot(), clock).checks("w").some(c => c.label === STALLED_LABEL);
  assert.equal(stalled(), false, "control: not stalled at the start");
  // A step in progress for an hour of active time: the board used to push it as stalled work.
  clock = start + 61 * MIN; t.mock.timers.tick(1000);
  assert.equal(stalled(), true, "control: the check is raised");
  assert.deepEqual(events.filter(e => RETIRED.includes(e)), []);
});

test("a review step, a finished item and the timed wake push nothing", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = T0;
  const wake = new Wake({ now: () => clock }), events = pushes(wake);
  const { op } = await server(t, { wake, now: () => clock, checkIntervalMs: 1000, architectTimedWakeMs: 1e12 });
  await op.dispatchStart({ ...asArchitect, id: "other", role: "工程师", level: 2, model: "Sonnet", agent: "other-worker", agentId: "agent-o" });
  // The review step goes in progress, and the item becomes done while a session holds it.
  await op.setPlan({ ...asArchitect, id: "other", row: { id: "review", text: "审查（3 级）", state: "doing" } });
  await op.setPlan({ ...asArchitect, id: "other", row: { id: "review", text: "审查（3 级）", state: "done" } });
  await op.setPlan({ ...asArchitect, id: "other", row: { id: "accept", accept: true, text: "独立验收通过", state: "done" } });
  assert.equal(wake.holds("other"), "other-worker", "control: the session holds the item that became done");
  // More than the half hour of the PM's timed wake passes on the timer.
  clock += 31 * MIN; t.mock.timers.tick(1000);
  assert.deepEqual(events.filter(e => RETIRED.includes(e)), []);
});

test("a session that stays silent is asked once and nobody is told when it does not answer", () => {
  let clock = T0;
  const wake = new Wake({ now: () => clock }), events = pushes(wake);
  wake.routeBy(() => "eng");
  const held = new Map([["eng", ["it1"]]]), about = () => ({ project: "Whitefoot", title: "t" });
  wake.liveness.check(held, about);
  for (const minutes of [31, 62, 125, 600]) { clock = T0 + minutes * MIN; wake.liveness.check(held, about); }
  assert.deepEqual(events, ["ask-alive"]);
});

test("the look at GitHub tells only a red main line: not a red pull request, not a pull request no item names", async t => {
  const { store } = await board(t);
  const a = store.snapshot().items.a!;
  await store.commit({ author: "Whitefoot", message: "name a pull request", puts: [{ kind: "item", id: "a", expectRev: a.rev, doc: { ...a, head: `${a.head}\n\n**改动**\n\nMing-Research/Whitefoot#5` } }] });
  const s = store.snapshot();
  const pull = (number: number, fields: Partial<PullState> = {}): PullState => ({ number, title: `PR ${number}`, url: `https://github.com/Ming-Research/Whitefoot/pull/${number}`, draft: false, createdAt: "2026-01-01T00:00:00Z", base: "main", commit: `c${number}`, mergeable: "MERGEABLE", checks: { state: "success", failed: [] }, ...fields });
  const state: RepoState = {
    repo: "Ming-Research/Whitefoot", truncated: false, named: [],
    main: { branch: "main", commit: "m0", subject: "Merge pull request #5 from x", checks: { state: "failure", failed: ["test"] } },
    // PR 5 is named by item a and red; PR 6 is named by no item and old.
    pulls: [pull(5, { checks: { state: "failure", failed: ["test"] } }), pull(6)],
  };
  assert.deepEqual(decide(s, [state]).map(p => p.event), ["main-red"]);
});

test("the owner is told once that the architect's oldest push has waited too long, and never of a PM", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = T0;
  const told: string[] = [];
  // The limit of the architect's stream.
  const wake = new Wake({ now: () => clock, overdueMs: 10 * MIN });
  wake.onTell(notice => told.push(notice.title));
  await server(t, { now: () => clock, checkIntervalMs: 1000, wake, architectTimedWakeMs: 1e12 });
  wake.push("backup-behind", { commits: 1, lastSuccess: null, reason: null });
  clock += 10 * MIN; t.mock.timers.tick(1000);
  assert.deepEqual(told, ["架构师 10 分钟没响应"]);
  clock += 10 * MIN; t.mock.timers.tick(1000);
  assert.equal(told.length, 1, "once for a silence");
});

test("a call as the session PM is no receipt and carries no pushes", async t => {
  const wake = new Wake({ now: () => T0 });
  const { url } = await server(t, { wake });
  const client = new Client({ name: "Retired PM", version: "1" }), transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"));
  await client.connect(transport); t.after(() => client.close());
  wake.push("backup-behind", { commits: 1, lastSuccess: null, reason: null });
  const result = await client.callTool({ name: "projects", arguments: { session: "PM" } });
  assert.doesNotMatch((result.content as Array<{ text: string }>).map(c => c.text).join("\n"), /【看板推送】/);
  assert.deepEqual(architectEvents(wake), ["backup-behind"], "the architect's push waits for the architect's own call");
  assert.equal("receiptedUpTo" in wake, false, "there is no receipt to give");
});

test("a message to the PM is refused: the name is no session the board can reach", async t => {
  const { op } = await board(t);
  await assert.rejects(op.sendMessage({ ...asArchitect, to: "PM", text: "看 a" }), /to PM: no session the board can reach/);
  await op.sendMessage({ ...asArchitect, to: ARCHITECT_SESSION, text: "看 a" });
});

test("the PM's role is no long-lived credential: a file that holds one is refused", () => {
  assert.equal((LONG_LIVED_ROLES as readonly string[]).includes("PM"), false);
  const entry = { session: "PM", role: "PM", project: "PM", roots: [], hash: "a".repeat(64) };
  assert.equal(CredentialsFile.safeParse({ credentials: [entry] }).success, false);
  assert.equal(CredentialsFile.safeParse({ credentials: [{ ...entry, session: "观察者", role: "观察者", project: "Whitefoot" }] }).success, true, "the control: another role's entry is read");
});

test("the author PM is refused before a write reads anything, and the project PM stays readable", async t => {
  const { store, op } = await board(t);
  const before = store.snapshot();
  assert.ok(before.board.projects.some(p => p.name === "PM"), "the project stays configured so its history is read");
  await assert.rejects(op.appendLog({ author: "PM", session: "PM", id: "a", text: "x" }), /author PM: this identity is retired/);
  await assert.rejects(op.createItem({ author: "PM", session: "PM", key: "x", group: "PM", title: "X", accept: "Pass" }), /author PM: this identity is retired/);
  assert.deepEqual(store.snapshot(), before);
});
