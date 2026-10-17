// The agents' streams (docs/design.md, The wake streams): where a push goes, how far it was delivered, what one line of it
// holds, and how a tool result carries it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { board, server, wakeSocket, asArchitect } from "./helpers.ts";
import { ARCHITECT_SESSION } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { AGENT_STREAM_IDLE_MS, AgentStream, FOOTER_HEAD, FOOTER_LINES, LINE_LIMIT, WAKE_KINDS, Wake, agentFileName, lineOf } from "../src/wake.ts";
import type { WakeKind } from "../src/wake.ts";
import { holderOf, openDispatches } from "../src/dispatch.ts";
import { createMcpServer } from "../src/mcp.ts";
import type { Resolved } from "../src/credentials.ts";

const T0 = Date.parse("2026-10-17T00:00:00Z");
const done = (item: string, parent: string) => ({ item, project: "Whitefoot", title: "子条目", parent });
async function scratch(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-agent-wake-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const chars = (text: string) => [...text].length;
/** Poll for what the server does after a write; its listeners run after the write's promise settles. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(done(), `timed out waiting for ${what}`);
}

test("every kind says where it goes, and a holder route names one of the kind's own fields", () => {
  for (const [kind, spec] of Object.entries(WAKE_KINDS)) {
    const to = (spec as { to?: unknown }).to;
    assert.ok(to === "pm" || (typeof to === "object" && to !== null && (spec.fields as readonly string[]).includes((to as { holder: string }).holder)), `${kind} must name its recipient`);
  }
  assert.deepEqual(WAKE_KINDS["item-done"].to, { holder: "parent" });
});

// Every field at a length no real push reaches: the line must stay within its limit whatever the fields hold.
const L = "长".repeat(1000), many = Array.from({ length: 500 }, (_, i) => `x${i}`);
const LONGEST: { [K in WakeKind]: Record<string, unknown> } = {
  note: { note: L, target: "it:" + L, kind: "comment", title: L, project: L },
  stalled: { item: L, project: L, title: L, text: L },
  timed: { since: L, changed: [...many.map(item => ({ item })), { more: 99 }], working: many, architect: many, actions: L },
  "main-red": { repo: L, project: L, branch: L, commit: L, failed: many, url: L },
  "pr-red": { repo: L, number: 123456, project: L, title: L, commit: L, failed: many, url: L, items: many },
  "pr-ready": { repo: L, number: 123456, project: L, title: L, base: L, commit: L, url: L, items: many },
  "pr-orphan": { repo: L, number: 123456, project: L, title: L, url: L, draft: true },
  "slow-op": { op: L, ms: 123456789, limitMs: 1000, params: L },
  "backup-behind": { commits: 123456, lastSuccess: L, reason: L },
  "actions-usage": { org: L, reason: "month", level: 90, month: L, day: L, used: 1, included: 1, today: 1, budget: null, text: L },
  deployed: { version: L, previous: L, changes: many, restarted: true },
  deployFailed: { version: null, running: null, reason: L },
  "item-done": { item: L, project: L, title: L, parent: L },
};

test("one line of any push holds at most LINE_LIMIT characters, starts with its number and label, and is what the frame carries", () => {
  assert.deepEqual(Object.keys(LONGEST).sort(), Object.keys(WAKE_KINDS).sort(), "a new kind needs its longest sample here");
  const stream = new AgentStream("eng", { now: () => T0 });
  for (const [kind, fields] of Object.entries(LONGEST) as Array<[WakeKind, Record<string, unknown>]>) {
    const frame = stream.push(kind, fields), line = String(frame.line);
    assert.ok(chars(line) <= LINE_LIMIT, `${kind}: ${chars(line)} characters`);
    assert.ok(line.startsWith(`#${frame.n} ${WAKE_KINDS[kind].label} · `), `${kind}: ${line.slice(0, 40)}`);
    assert.equal(line, lineOf(frame));
  }
  // A short push is shown whole, so nothing is cut that fits.
  assert.equal(new AgentStream("eng").push("item-done", done("c1", "p1")).line, "#1 子条目做完 · it:c1（Whitefoot） · 子条目 · 等它的：it:p1");
});

test("each agent's stream numbers, keeps and replays on its own, a holder route reaches the holder's stream, and with no holder the PM's", async t => {
  const dir = await scratch(t), file = join(dir, "pm.jsonl");
  const wake = new Wake({ file, dir, now: () => T0 });
  const held: Record<string, string> = { p1: "工程师甲", p2: "eng-b" };
  wake.routeBy(item => held[item]);
  const pushed = [wake.push("item-done", done("c1", "p1")), wake.push("item-done", done("c2", "p2")), wake.push("item-done", done("c3", "p1")), wake.push("item-done", done("c4", "nobody"))];
  assert.deepEqual(pushed.map(f => f.n), [1, 1, 2, 1], "each stream numbers from 1");
  assert.deepEqual(wake.since(0).frames.map(f => f.item), ["c4"], "only the unheld item's push is the PM's");
  assert.deepEqual(wake.agent("工程师甲").pending().frames.map(f => f.item), ["c1", "c3"]);
  assert.deepEqual(wake.agent("eng-b").pending().frames.map(f => f.item), ["c2"]);
  assert.deepEqual((await readdir(dir)).sort(), ["pm.jsonl", agentFileName("eng-b"), agentFileName("工程师甲")].sort(), "one file per agent, named by a hash of its name");
  const again = new Wake({ file, dir, now: () => T0 });
  assert.ok(again.hasAgent("工程师甲") && again.hasAgent("eng-b"), "a restart reads every agent's stream");
  assert.deepEqual(again.agent("工程师甲").pending().frames.map(f => f.n), [1, 2]);
  assert.equal(again.agent("工程师甲").push("item-done", done("c5", "p1")).n, 3, "numbering goes on after a restart");
  assert.equal(again.latest(), 1, "the PM's numbers are its own");
});

test("a delivered push is never given again: after an ack, across a restart, and once a tool result carried it", async t => {
  const dir = await scratch(t), wake = new Wake({ dir, now: () => T0 }), stream = wake.agent("eng");
  for (const c of ["c1", "c2", "c3"]) stream.push("item-done", done(c, "p"));
  stream.deliver(1);
  assert.deepEqual(stream.pending(), { frames: stream.since(1).frames, gap: false });
  stream.deliver(1); stream.deliver(0); stream.deliver(99); stream.deliver(1.5);
  assert.equal(stream.deliveredUpTo(), 1, "a number at or below the delivered one, above the newest, or not whole changes nothing");
  assert.equal(new Wake({ dir, now: () => T0 }).agent("eng").deliveredUpTo(), 1, "a restart keeps how far it was delivered");
  const shown = wake.footer("eng");
  assert.equal(shown, [FOOTER_HEAD, lineOf(stream.since(1).frames[0]!), lineOf(stream.since(2).frames[0]!)].join("\n"));
  assert.equal(stream.deliveredUpTo(), 3);
  assert.equal(wake.footer("eng"), "", "what a tool result carried is not carried again");
  assert.equal(new Wake({ dir, now: () => T0 }).footer("eng"), "", "nor after a restart");
  assert.equal(wake.footer("nobody"), "");
  assert.equal(wake.hasAgent("nobody"), false, "asking for a footer makes no stream");
});

test("a tool result carries at most FOOTER_LINES pushes and counts the rest by kind, which the next call carries", () => {
  const wake = new Wake({ now: () => T0 }), stream = wake.agent("eng");
  for (let i = 1; i <= FOOTER_LINES + 2; i++) stream.push("item-done", done("c" + i, "p"));
  const first = wake.footer("eng").split("\n");
  assert.equal(first.length, 1 + FOOTER_LINES + 1);
  assert.equal(first.at(-1), "另有 2 条没送到（子条目做完 2）：再调一次看板，或挂等待脚本取");
  assert.equal(stream.deliveredUpTo(), FOOTER_LINES, "the counted ones are not delivered");
  assert.deepEqual(wake.footer("eng").split("\n").slice(1).map(l => l.split(" ")[0]), ["#6", "#7"]);
});

test("an agent's stream keeps its newest events, and says when undelivered ones were dropped", () => {
  const stream = new AgentStream("eng", { now: () => T0, retain: 3 });
  for (let i = 1; i <= 5; i++) stream.push("item-done", done("c" + i, "p"));
  assert.equal(stream.oldest(), 3);
  assert.deepEqual(stream.pending().frames.map(f => f.n), [3, 4, 5]);
  assert.equal(stream.pending().gap, true, "events 1 and 2 were never delivered");
  stream.deliver(2);
  assert.equal(stream.pending().gap, false, "what is missing was delivered");
  stream.deliver(5);
  assert.deepEqual(stream.pending(), { frames: [], gap: false });
});

test("a stream nobody uses goes after a week; one with undelivered pushes, a holder's or a recent one stays", async t => {
  const dir = await scratch(t);
  let clock = T0;
  const wake = new Wake({ dir, now: () => clock });
  for (const name of ["gone", "undelivered", "holder", "recent"]) wake.agent(name).push("item-done", done("c", "p"));
  for (const name of ["gone", "holder", "recent"]) wake.agent(name).deliver(1);
  clock += AGENT_STREAM_IDLE_MS + 1;
  wake.agent("recent").push("item-done", done("c2", "p")); wake.agent("recent").deliver(2);
  wake.prune(name => name === "holder");
  assert.deepEqual(["gone", "undelivered", "holder", "recent"].filter(name => wake.hasAgent(name)), ["undelivered", "holder", "recent"]);
  assert.deepEqual((await readdir(dir)).sort(), ["holder", "recent", "undelivered"].map(agentFileName).sort());
});

test("the holder of an item is the agent of its newest engineer dispatch that has not ended", () => {
  const d = (agent: string, started: string, extra: object = {}) => ({ role: "工程师", agent, agentId: agent, level: 2, model: "m", started, ...extra });
  const items = (dispatches: object[]) => ({ items: { x: { dispatches } } } as unknown as Pick<Snapshot, "items">);
  assert.equal(holderOf(items([d("old", "2026-10-16T01:00:00Z"), d("new", "2026-10-16T02:00:00Z")]), "x"), "new", "a takeover holds the item");
  assert.equal(holderOf(items([d("old", "2026-10-16T01:00:00Z"), d("new", "2026-10-16T02:00:00Z", { finish: {} })]), "x"), "old", "an ended dispatch holds nothing");
  assert.equal(holderOf(items([{ ...d("rev", "2026-10-16T03:00:00Z"), role: "审查" }]), "x"), undefined, "a reviewer holds nothing");
  assert.equal(holderOf(items([]), "x"), undefined);
  assert.equal(holderOf(items([]), "missing"), undefined);
  assert.deepEqual(openDispatches(items([d("a", "2026-10-16T01:00:00Z"), d("b", "2026-10-16T03:00:00Z", { finish: {} }), { ...d("c", "2026-10-16T02:00:00Z"), role: "审查" }]), "x").map(x => x.agent), ["c", "a"], "the open ones, newest first, of any role");
});

/** A socket on an agent's stream, with what it received. */
async function agentSocket(t: { after(fn: () => void): void }, url: string, name: string) {
  const socket = new WebSocket(url.replace("http:", "ws:") + "/wake/" + encodeURIComponent(name));
  t.after(() => socket.terminate());
  const frames: Array<Record<string, unknown>> = [];
  socket.on("message", data => frames.push(JSON.parse(data.toString())));
  await once(socket, "open");
  const sync = async () => { const pong = once(socket, "pong"); socket.ping(); await pong; };
  await sync();
  return { frames, sync, socket, events: () => frames.filter(f => typeof f.n === "number") };
}
async function refused(t: { after(fn: () => void): void }, url: string, path: string) {
  const socket = new WebSocket(url.replace("http:", "ws:") + path);
  socket.on("error", () => {}); t.after(() => socket.terminate());
  const [, response] = await once(socket, "unexpected-response");
  response.resume();
  return response.statusCode as number;
}

test("an agent's socket gets what was not delivered, then its own live pushes only; after its ack they are not sent again", async t => {
  const wake = new Wake({ now: () => T0 });
  const { url } = await server(t, { wake });
  const first = wake.agent("eng").push("item-done", done("c1", "p"));
  const pm = await wakeSocket(t, url), eng = await agentSocket(t, url, "eng"), other = await agentSocket(t, url, "other");
  assert.deepEqual(eng.frames, [{ event: "connected", latest: 1 }, first]);
  assert.deepEqual(other.frames, [{ event: "connected", latest: 0 }]);
  eng.socket.send(JSON.stringify({ ack: 1 })); await eng.sync();
  assert.equal(wake.agent("eng").deliveredUpTo(), 1);
  const back = await agentSocket(t, url, "eng");
  assert.deepEqual(back.frames, [{ event: "connected", latest: 1 }], "a delivered push is not replayed");
  const live = wake.agent("eng").push("item-done", done("c2", "p"));
  wake.push("note", { note: "n1", target: "it:a", kind: "comment", title: "中文检查", project: "Whitefoot" });
  for (const s of [pm, eng, other, back]) await s.sync();
  assert.deepEqual(eng.events().map(f => f.n), [1, 2]); assert.deepEqual(back.events(), [live]);
  assert.deepEqual(other.events(), [], "another agent's push does not reach this stream");
  assert.deepEqual(pm.events().map(f => f.event), ["note"], "an agent's push does not reach the PM's stream, nor the PM's an agent's");
  eng.socket.send("not json"); eng.socket.send(JSON.stringify({ ack: "2" })); await eng.sync();
  assert.equal(wake.agent("eng").deliveredUpTo(), 1, "anything but a numeric ack is ignored");
  for (const path of ["/wake/", "/wake/" + encodeURIComponent(ARCHITECT_SESSION), "/wake/eng?after=1", "/wake/a%2Fb", "/wake/" + "x".repeat(81), "/wake/%E0%A4%A"]) assert.equal(await refused(t, url, path), 400, path);
});

test("another agent's tool call carries its undelivered pushes once, by its credential's session when it has one; the PM's never does", async t => {
  const wake = new Wake({ now: () => T0 }), { store, op } = await board(t);
  const call = async (args: Record<string, unknown>, credential?: Resolved) => {
    const mcp = createMcpServer({ store, ops: op, wake, credential }), client = new Client({ name: "Footer", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
    await mcp.connect(st); await client.connect(ct);
    t.after(async () => { await client.close(); await mcp.close(); });
    const result = await client.callTool({ name: "projects", arguments: args });
    return (result.content as Array<{ text: string }>).map(c => c.text).join("\n");
  };
  const plain = await call({ session: "eng" });
  const frame = wake.agent("eng").push("item-done", done("c1", "p"));
  assert.equal(await call({ session: "eng" }), `${plain}\n\n${FOOTER_HEAD}\n${lineOf(frame)}`);
  assert.equal(await call({ session: "eng" }), plain, "carried once");
  wake.agent("eng").push("item-done", done("c2", "p"));
  assert.equal(await call({}), plain, "a call naming no session carries nothing");
  // Nothing routes to a stream under the PM's name; one made by hand still never reaches the PM's calls.
  wake.agent(ARCHITECT_SESSION).push("item-done", done("pm", "p"));
  assert.equal(await call({ session: ARCHITECT_SESSION }), plain);
  assert.equal(await call({ session: " eng " }), `${plain}\n\n${FOOTER_HEAD}\n${lineOf(wake.agent("eng").since(1).frames[0]!)}`, "spaces around the name are ignored");
  const credential: Resolved = { ok: true, who: { author: "Whitefoot", session: "cred-eng", access: { role: "工程师", project: "Whitefoot", roots: ["a"] } } };
  const mine = wake.agent("cred-eng").push("item-done", done("c3", "p"));
  wake.agent("eng").push("item-done", done("c4", "p"));
  assert.equal(await call({ session: "eng" }, credential), `${plain}\n\n${FOOTER_HEAD}\n${lineOf(mine)}`, "the credential's session, not the one the call names");
  assert.equal(wake.agent("eng").deliveredUpTo(), 2);
  const architect: Resolved = { ok: true, who: { author: "Architect", session: ARCHITECT_SESSION, access: { role: "架构师", project: "Architect", roots: [] } } };
  assert.equal(await call({ session: "eng" }, architect), plain, "the PM's calls are receipts for its own stream and carry nothing");
  assert.equal(wake.agent(ARCHITECT_SESSION).deliveredUpTo(), 0);
});

test("an item becoming done tells the session holding each open item that waits on it, once, and nobody else", async t => {
  const wake = new Wake({ now: () => T0 });
  const { url, op } = await server(t, { wake });
  // Item a is owned by area, which nobody holds, and shared by b, which an engineer holds.
  await op.dispatchStart({ ...asArchitect, id: "b", role: "工程师", level: 2, model: "Sonnet", agent: "b-worker", agentId: "agent-1" });
  const pm = await wakeSocket(t, url);
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "accept", accept: true, text: "独立验收通过", state: "done" } });
  await until(() => wake.hasAgent("b-worker") && wake.agent("b-worker").latest() === 1, "the item-done push");
  const [frame] = wake.agent("b-worker").pending().frames;
  assert.deepEqual({ ...frame, at: undefined, line: undefined }, { n: 1, at: undefined, event: "item-done", item: "a", project: "Whitefoot", title: "中文检查", parent: "b", line: undefined });
  await op.appendLog({ ...asArchitect, id: "a", text: "a later write to the done item" });
  await pm.sync();
  assert.equal(wake.agent("b-worker").latest(), 1, "a done item is announced once");
  assert.deepEqual(pm.events().filter(f => f.event === "item-done").map(f => [f.item, f.parent]), [["a", "area"]], "nobody holds area, so its push goes to the PM, once");
});

test("any session name up to 80 characters has a stream that survives a restart, and names differing only in case are two streams", async t => {
  const dir = await scratch(t), longest = "长".repeat(80);
  const wake = new Wake({ dir, now: () => T0 });
  for (const name of [longest, "Eng", "eng"]) wake.agent(name).push("item-done", done(name.slice(0, 3), "p"));
  wake.agent("Eng").deliver(1);
  assert.equal((await readdir(dir)).length, 3, "three files, whatever the disk does with case");
  const again = new Wake({ dir, now: () => T0 });
  assert.deepEqual([longest, "Eng", "eng"].map(name => [again.hasAgent(name), again.agent(name).latest(), again.agent(name).deliveredUpTo()]), [[true, 1, 0], [true, 1, 1], [true, 1, 0]]);
  assert.ok((await readdir(dir)).every(file => file.length < 64));
});

test("a stream whose wait script is connected is kept however long it goes unused, and its socket keeps getting its pushes", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = T0;
  const wake = new Wake({ now: () => clock });
  const { url } = await server(t, { wake, now: () => clock, checkIntervalMs: 1000 });
  const watcher = await agentSocket(t, url, "观察者");
  wake.agent("观察者").push("item-done", done("c1", "p"));
  watcher.socket.send(JSON.stringify({ ack: 1 })); await watcher.sync();
  wake.agent("idle").push("item-done", done("c1", "p")); wake.agent("idle").deliver(1);
  clock += AGENT_STREAM_IDLE_MS + 1;
  t.mock.timers.tick(1000); await watcher.sync();
  assert.equal(wake.hasAgent("idle"), false, "an unused stream with no socket goes");
  assert.equal(wake.hasAgent("观察者"), true, "a stream with a socket on it stays");
  const live = wake.agent("观察者").push("item-done", done("c2", "p"));
  await watcher.sync();
  assert.deepEqual(watcher.events().map(f => f.n), [1, 2]);
  assert.deepEqual(watcher.events()[1], live);
});
