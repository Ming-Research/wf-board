// The agents' streams (docs/design.md, The wake streams): where a push goes, how far it was delivered, what one line of it
// holds, and how a tool result carries it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agentSocket, board, server, asArchitect, author, later } from "./helpers.ts";
import { ARCHITECT_SESSION, MESSAGE_TEXT_LIMIT } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { AGENT_STREAM_IDLE_MS, AgentStream, FOOTER_HEAD, FOOTER_LINES, LINE_LIMIT, WAKE_KINDS, Wake, agentFileName, lineOf } from "../src/wake.ts";
import type { WakeKind } from "../src/wake.ts";
import { holderOf, openDispatches } from "../src/dispatch.ts";
import { candidates } from "../src/candidates.ts";
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

test("every kind says where it goes, and a holder or session route names one of the kind's own fields", () => {
  for (const [kind, spec] of Object.entries(WAKE_KINDS)) {
    const to = (spec as { to?: unknown }).to as { holder?: string; session?: string; only?: true; otherwise?: "architect" } | "architect" | undefined;
    const field = typeof to === "object" && to !== null ? to.holder ?? to.session : undefined;
    const keys = typeof to === "object" && to !== null ? Object.keys(to).filter(k => k !== "only" && k !== "otherwise") : [];
    assert.ok(to === "architect" || (field !== undefined && keys.length === 1 && (spec.fields as readonly string[]).includes(field)), `${kind} must name its recipient`);
  }
  // What needs the content of an item read to judge, or the state of the board kept, goes to the architect: the owner's notes, its own hourly wake, a slow operation, a copy of the data left behind, a runner that stopped.
  for (const kind of ["note", "timed-architect", "slow-op", "backup-behind", "runner-stopped"] as const) assert.equal(WAKE_KINDS[kind].to, "architect", kind);
  assert.deepEqual(WAKE_KINDS["item-done"].to, { holder: "parent", only: true });
  assert.deepEqual(WAKE_KINDS.deployed.to, { holder: "item", only: true });
  assert.deepEqual(WAKE_KINDS.deployFailed.to, { holder: "item", otherwise: "architect" }, "a failed deploy with no session on the item is the architect's");
  assert.deepEqual(WAKE_KINDS["main-red"].to, { holder: "item", otherwise: "architect" });
  assert.deepEqual(WAKE_KINDS.message.to, { session: "to" });
  assert.deepEqual(WAKE_KINDS["card-ruled"].to, { holder: "item", otherwise: "architect" }, "a ruling is for the session holding the card's item, else the architect (the board pushes the latter only for the owner's pick, whose note it closes)");
  assert.deepEqual(WAKE_KINDS["dep-merged"].to, { holder: "waiter", otherwise: "architect" });
  assert.equal("pr-ready" in WAKE_KINDS, false, "a pull request that can merge is the engineer's to merge, not pushed");
  assert.equal("dispatch" in WAKE_KINDS, false, "the board pushes no offers: the architect compares the candidates with the owner's limits");
});

// Every field at a length no real push reaches: the line must stay within its limit whatever the fields hold.
const L = "长".repeat(1000), many = Array.from({ length: 500 }, (_, i) => `x${i}`);
const LONGEST: { [K in WakeKind]: Record<string, unknown> } = {
  note: { note: L, target: "it:" + L, kind: "comment", title: L, project: L },
  "timed-architect": { since: L, changed: [...many.map(item => ({ item })), { more: 99 }], working: 99999 },
  "main-red": { repo: L, project: L, branch: L, commit: L, failed: many, url: L, item: L, pr: 123456 },
  "slow-op": { op: L, ms: 123456789, limitMs: 1000, params: L },
  "backup-behind": { commits: 123456, lastSuccess: L, reason: L },
  "runner-stopped": { lastBeat: L, limitMs: 123456789 },
  deployed: { version: L, restarted: true, item: L, project: L, title: L, pr: 123456 },
  deployFailed: { version: L, running: L, reason: L, item: L, project: L, title: L, pr: 123456 },
  "item-done": { item: L, project: L, title: L, parent: L },
  "ask-alive": { item: L, project: L, title: L, since: L },
  // A message's text is refused above MESSAGE_TEXT_LIMIT when it is sent, so its longest is that; the rest is any length.
  message: { message: L, from: L, project: L, to: L, item: L, text: "长".repeat(MESSAGE_TEXT_LIMIT) },
  "card-ruled": { card: L, item: L, project: L, title: L, choice: L, option: L, ruling: L },
  "dep-merged": { item: L, project: L, title: L, prs: many, waiter: L },
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
  assert.equal(new AgentStream("eng").push("dep-merged", { item: "a", project: "Whitefoot", title: "中文检查", prs: ["Ming-Research/Whitefoot#7", "Ming-Research/Whitefoot#8"], waiter: "b" }).line, "#1 等的活合入了 · it:a（Whitefoot） · Ming-Research/Whitefoot#7、Ming-Research/Whitefoot#8 已合入 · 等它的：it:b · 中文检查");
});

test("a message's line keeps its whole text and cuts only what comes before it", () => {
  const stream = new AgentStream("eng", { now: () => T0 });
  const text = "读".repeat(MESSAGE_TEXT_LIMIT - 1) + "完";
  const short = stream.push("message", { message: "m1", from: "架构师", project: "Architect", to: "eng", item: "a", text: "看 a 的日志" });
  assert.equal(short.line, "#1 消息 · 架构师（Architect） · it:a：看 a 的日志");
  assert.equal(stream.push("message", { message: "m2", from: "观察者", project: "Architect", to: "eng", item: null, text: "好" }).line, "#2 消息 · 观察者（Architect）：好", "no item, no item part");
  const long = String(stream.push("message", { message: "m3", from: "名".repeat(80), project: "Whitefoot", to: "eng", item: "k".repeat(200), text }).line);
  assert.ok(long.endsWith("：" + text), "the text is whole, its last character included");
  assert.equal(chars(long), LINE_LIMIT, "a prefix cut to its limit and the longest text fill the line exactly");
  assert.ok(long.startsWith("#3 消息 · " + "名".repeat(10)) && long.includes("…："), "the sender is cut, marked with …");
});

test("each agent's stream numbers, keeps and replays on its own, a holder route reaches the holder's stream, and with no holder the architect's or none", async t => {
  const dir = await scratch(t);
  const wake = new Wake({ dir, now: () => T0 });
  const held: Record<string, string> = { p1: "工程师甲", p2: "eng-b" };
  wake.routeBy(item => held[item]);
  const merged = (waiter: string) => ({ item: "a", project: "Whitefoot", title: "中文检查", prs: ["Ming-Research/Whitefoot#7"], waiter });
  const pushed = [wake.push("item-done", done("c1", "p1")), wake.push("item-done", done("c2", "p2")), wake.push("item-done", done("c3", "p1")), wake.push("dep-merged", merged("nobody"))];
  assert.deepEqual(pushed.map(f => f.n), [1, 1, 2, 1], "each stream numbers from 1");
  assert.deepEqual(wake.agent(ARCHITECT_SESSION).pending().frames.map(f => f.waiter), ["nobody"], "only the push that has an `otherwise` falls to the architect's stream");
  assert.throws(() => wake.push("item-done", done("c5", "nobody")), /holding nobody, and there is none/, "a push for a holder alone is not made without one");
  assert.equal(wake.agent(ARCHITECT_SESSION).latest(), 1, "and takes no number");
  assert.deepEqual(wake.agent("工程师甲").pending().frames.map(f => f.item), ["c1", "c3"]);
  assert.deepEqual(wake.agent("eng-b").pending().frames.map(f => f.item), ["c2"]);
  assert.deepEqual((await readdir(dir)).sort(), [agentFileName(ARCHITECT_SESSION), agentFileName("eng-b"), agentFileName("工程师甲")].sort(), "one file per agent, named by a hash of its name");
  const again = new Wake({ dir, now: () => T0 });
  assert.ok(again.hasAgent("工程师甲") && again.hasAgent("eng-b") && again.hasAgent(ARCHITECT_SESSION), "a restart reads every agent's stream");
  assert.deepEqual(again.agent("工程师甲").pending().frames.map(f => f.n), [1, 2]);
  assert.equal(again.agent("工程师甲").push("item-done", done("c5", "p1")).n, 3, "numbering goes on after a restart");
  assert.equal(again.agent(ARCHITECT_SESSION).latest(), 1, "the architect's numbers are its own");
});

test("a push for a waiter goes to the session holding the waiter, else to the architect's stream", () => {
  const wake = new Wake({ now: () => T0 });
  wake.routeBy(item => ({ held: "工程师甲" })[item as "held"]);
  const merged = (waiter: string) => ({ item: "a", project: "Whitefoot", title: "中文检查", prs: ["Ming-Research/Whitefoot#7"], waiter });
  wake.push("dep-merged", merged("held"));
  wake.push("dep-merged", merged("nobody"));
  assert.deepEqual(wake.agent("工程师甲").pending().frames.map(f => f.waiter), ["held"]);
  assert.deepEqual(wake.agent(ARCHITECT_SESSION).pending().frames.map(f => f.waiter), ["nobody"], "nobody holds the waiter: the architect is told, since an item nobody holds is the architect's to start");
  assert.deepEqual(wake.agent("工程师甲").pending().frames.length, 1, "and the holder's stream got one only");
});

test("a push routed to the session of the architect goes to its own agent stream, with the ones its kind sends there, and no stream is made under the retired PM's name", async t => {
  const dir = await scratch(t), wake = new Wake({ dir, now: () => T0 });
  const held: Record<string, string> = { theirs: ARCHITECT_SESSION };
  wake.routeBy(item => held[item]);
  const message = (to: string) => ({ message: "m", from: "eng", project: "Whitefoot", to, item: null, text: "看" });
  wake.push("message", message(ARCHITECT_SESSION));
  wake.push("item-done", done("c2", "theirs"));
  assert.deepEqual(wake.agent(ARCHITECT_SESSION).pending().frames.map(f => [f.event, f.item ?? f.to]), [["message", ARCHITECT_SESSION], ["item-done", "c2"]], "what is for the architect's session goes to its agent stream");
  // A holder-routed kind with no item to name (the red main line no PR explains) is the architect's too.
  wake.push("main-red", { repo: "o/r", project: "p", branch: "main", commit: "c", failed: [], url: "u", item: null, pr: null });
  assert.equal(wake.agent(ARCHITECT_SESSION).pending().frames.at(-1)!.event, "main-red");
  // The owner's notes and the architect's own wake are the architect's by their kind.
  wake.push("note", { note: "n1", target: "it:a", kind: "comment", title: "中文检查", project: "Whitefoot" });
  wake.push("timed-architect", { since: "2026-10-17T00:00:00Z", changed: [], working: 0 });
  assert.deepEqual(wake.agent(ARCHITECT_SESSION).pending().frames.slice(3).map(f => f.event), ["note", "timed-architect"]);
  assert.equal(wake.hasAgent("PM"), false, "nothing made a stream under the name the PM had");
  assert.equal(wake.hasAgent(ARCHITECT_SESSION), true);
});

test("a stream file that holds a kind the table no longer has loads without it, and its numbering goes on", async t => {
  const dir = await scratch(t);
  const frame = (n: number, event: string, fields: object) => ({ n, at: "2026-10-17T00:00:00.000Z", event, ...fields });
  await writeFile(join(dir, agentFileName("eng")), [
    { name: "eng" }, { latest: 3 },
    frame(1, "no-answer", { session: "eng", item: "a", project: "Whitefoot", title: "t", since: "2026-10-17T00:00:00Z" }),
    frame(2, "item-done", { ...done("c1", "p"), line: "x" }),
    frame(3, "pr-red", { repo: "o/r", number: 1 }),
  ].map(l => JSON.stringify(l) + "\n").join(""));
  const wake = new Wake({ dir, now: () => T0 }), stream = wake.agent("eng");
  assert.deepEqual(stream.pending().frames.map(f => [f.n, f.event]), [[2, "item-done"]], "the two retired kinds are not kept");
  assert.equal(stream.push("item-done", done("c2", "p")).n, 4, "and numbering goes on past them");
  // The first retired push was never delivered, so the session is told that one was dropped, then it gets what is kept.
  const lines = wake.footer("eng").split("\n");
  assert.equal(lines.length, 4, "a tool result is made of what is kept: its head, the line that a push was dropped and the two item-done lines");
  assert.match(lines[1]!, /只留 #2 及以后的/);
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

test("a tool result says when undelivered pushes were dropped, naming the oldest the board still keeps", () => {
  const wake = new Wake({ now: () => T0 }), stream = wake.agent("eng");
  for (let i = 1; i <= 205; i++) stream.push("item-done", done("c" + i, "p"));
  assert.equal(stream.oldest(), 6, "an agent's stream keeps its newest 200");
  const lines = wake.footer("eng").split("\n");
  assert.equal(lines[1], "有推送没送到就被丢了（看板只留 #6 及以后的）：去看板读最近的变化", "the same words the wait script prints");
  assert.match(lines[2]!, /^#6 子条目做完 /);
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
async function refused(t: { after(fn: () => void): void }, url: string, path: string) {
  const socket = new WebSocket(url.replace("http:", "ws:") + path);
  socket.on("error", () => {}); t.after(() => socket.terminate());
  // A refused upgrade answers with a status; one that is wrongly accepted opens the socket, and the test fails at once instead of waiting.
  return await Promise.race([
    once(socket, "unexpected-response").then(([, response]) => { response.resume(); return response.statusCode as number; }),
    once(socket, "open").then(() => 101),
  ]);
}

test("an agent's socket gets what was not delivered, then its own live pushes only; after its ack they are not sent again", async t => {
  const wake = new Wake({ now: () => T0 });
  const { url } = await server(t, { wake });
  const first = wake.agent("eng").push("item-done", done("c1", "p"));
  const eng = await agentSocket(t, url, "eng"), other = await agentSocket(t, url, "other"), architect = await agentSocket(t, url, ARCHITECT_SESSION);
  assert.deepEqual(eng.frames, [{ event: "connected", latest: 1 }, first]);
  assert.deepEqual(other.frames, [{ event: "connected", latest: 0 }]);
  eng.socket.send(JSON.stringify({ ack: 1 })); await eng.sync();
  assert.equal(wake.agent("eng").deliveredUpTo(), 1);
  const back = await agentSocket(t, url, "eng");
  assert.deepEqual(back.frames, [{ event: "connected", latest: 1 }], "a delivered push is not replayed");
  const live = wake.agent("eng").push("item-done", done("c2", "p"));
  wake.push("slow-op", { op: "tool brief", ms: 4000, limitMs: 1000, params: "" });
  for (const s of [architect, eng, other, back]) await s.sync();
  assert.deepEqual(eng.events().map(f => f.n), [1, 2]); assert.deepEqual(back.events(), [live]);
  assert.deepEqual(other.events(), [], "another agent's push does not reach this stream");
  assert.deepEqual(architect.events().map(f => f.event), ["slow-op"], "an agent's push does not reach the architect's stream, nor the architect's an agent's");
  eng.socket.send("not json"); eng.socket.send(JSON.stringify({ ack: "2" })); await eng.sync();
  assert.equal(wake.agent("eng").deliveredUpTo(), 1, "anything but a numeric ack is ignored");
  // Valid JSON that is not an object has no fields to read: it is ignored, and the stream still takes the next ack.
  for (const message of ["null", "[]", "1", '"ack"']) eng.socket.send(message);
  eng.socket.send(JSON.stringify({ ack: 2 })); await eng.sync();
  assert.equal(wake.agent("eng").deliveredUpTo(), 2, "a message that is not an object is ignored, and the next ack counts");
  for (const path of ["/wake/", "/wake/eng?after=1", "/wake/a%2Fb", "/wake/" + "x".repeat(81), "/wake/%E0%A4%A"]) assert.equal(await refused(t, url, path), 400, path);
});

test("an agent's tool call (the architect's too) carries its undelivered pushes once, by its credential's session when it has one", async t => {
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
  // The architect's calls carry what was pushed to its stream like any agent's.
  const owed = wake.agent(ARCHITECT_SESSION).push("item-done", done("arch", "p"));
  assert.equal(await call({ session: ARCHITECT_SESSION }), `${plain}\n\n${FOOTER_HEAD}\n${lineOf(owed)}`);
  assert.equal(await call({ session: ARCHITECT_SESSION }), plain, "carried once");
  assert.equal(await call({ session: " eng " }), `${plain}\n\n${FOOTER_HEAD}\n${lineOf(wake.agent("eng").since(1).frames[0]!)}`, "spaces around the name are ignored");
  const credential: Resolved = { ok: true, who: { author: "Whitefoot", session: "cred-eng", access: { role: "工程师", project: "Whitefoot", roots: ["a"] } } };
  const mine = wake.agent("cred-eng").push("item-done", done("c3", "p"));
  wake.agent("eng").push("item-done", done("c4", "p"));
  assert.equal(await call({ session: "eng" }, credential), `${plain}\n\n${FOOTER_HEAD}\n${lineOf(mine)}`, "the credential's session, not the one the call names");
  assert.equal(wake.agent("eng").deliveredUpTo(), 2);
  const architect: Resolved = { ok: true, who: { author: "Architect", session: ARCHITECT_SESSION, access: { role: "架构师", project: "Architect", roots: [] } } };
  const second = wake.agent(ARCHITECT_SESSION).push("item-done", done("c5", "p"));
  assert.equal(await call({ session: "eng" }, architect), `${plain}\n\n${FOOTER_HEAD}\n${lineOf(second)}`, "the architect's credential: its own stream, whatever session the call names");
  assert.equal(wake.agent(ARCHITECT_SESSION).deliveredUpTo(), 2);
  // The architect's turns write as the architect but are not the conversation the pushes are for: what is pushed to 「架构师」 waits for it.
  const owedToConversation = wake.agent(ARCHITECT_SESSION).push("item-done", done("c6", "p"));
  assert.equal(await call({ session: "架构师轮次" }), plain, "a call from the turns' session carries nothing of the architect's");
  assert.equal(await call({ session: " 架构师轮次 " }), plain, "spaces around the name change nothing");
  const turn: Resolved = { ok: true, who: { author: "Architect", session: "架构师轮次", access: { role: "架构师", project: "Architect", roots: [] } } };
  assert.equal(await call({ session: ARCHITECT_SESSION }, turn), plain, "the architect's role under the turns' session is the turns': whatever session the call names, the conversation's pushes stay");
  assert.equal(wake.agent(ARCHITECT_SESSION).deliveredUpTo(), 2, "and none of it was recorded as delivered");
  assert.equal(await call({ session: ARCHITECT_SESSION }), `${plain}\n\n${FOOTER_HEAD}\n${lineOf(owedToConversation)}`, "the conversation's next call carries it");
  assert.equal(wake.agent(ARCHITECT_SESSION).deliveredUpTo(), 3);
  // So is every other name that starts with 「架构师」: the rights are shared, the conversation's pushes are not.
  const owedAgain = wake.agent(ARCHITECT_SESSION).push("item-done", done("c7", "p"));
  for (const session of ["架构师·观察", " 架构师·整理 ", "架构师2"]) assert.equal(await call({ session }), plain, `${session}: a call carries nothing of the architect's`);
  const observer: Resolved = { ok: true, who: { author: "Architect", session: "架构师·观察", access: { role: "架构师", project: "Architect", roots: [] } } };
  assert.equal(await call({ session: ARCHITECT_SESSION }, observer), plain, "the architect's role under such a name: whatever session the call names, the conversation's pushes stay");
  assert.equal(wake.agent(ARCHITECT_SESSION).deliveredUpTo(), 3, "and none of it was recorded as delivered");
  assert.equal(await call({ session: ARCHITECT_SESSION }), `${plain}\n\n${FOOTER_HEAD}\n${lineOf(owedAgain)}`, "the conversation's next call carries it");
});

test("an item becoming done tells the session holding each open item that waits on it, once, and nobody else, the architect included", async t => {
  const wake = new Wake({ now: () => T0 });
  const { url, op } = await server(t, { wake });
  // Item a is owned by area, which nobody holds, and shared by b, which an engineer holds.
  await op.dispatchStart({ ...asArchitect, id: "b", role: "工程师", level: 2, model: "Sonnet", agent: "b-worker", agentId: "agent-1" });
  const architect = await agentSocket(t, url, ARCHITECT_SESSION);
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "accept", accept: true, text: "独立验收通过", state: "done" } });
  await until(() => wake.hasAgent("b-worker") && wake.agent("b-worker").latest() === 1, "the item-done push");
  const [frame] = wake.agent("b-worker").pending().frames;
  assert.deepEqual({ ...frame, at: undefined, line: undefined }, { n: 1, at: undefined, event: "item-done", item: "a", project: "Whitefoot", title: "中文检查", parent: "b", line: undefined });
  await op.appendLog({ ...asArchitect, id: "a", text: "a later write to the done item" });
  await architect.sync();
  assert.equal(wake.agent("b-worker").latest(), 1, "a done item is announced once");
  assert.deepEqual(architect.events().filter(f => f.event === "item-done"), [], "nobody holds area, so no push is made for it, and the architect has none of it");
});

/** The fixture's item a with an open merge row that names a PR its 改动 section names too, and item b waiting on it by a shared row. */
async function openMergeRow(op: Awaited<ReturnType<typeof server>>["op"], store: Awaited<ReturnType<typeof server>>["store"], text = "合入 Ming-Research/Whitefoot#7") {
  await op.updateItem({ author: "Whitefoot", id: "a", rev: store.snapshot().items.a!.rev, head: "背景\n\n## 改动\n\nMing-Research/Whitefoot#7", reason: "name the PR" });
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "merge", text, state: "doing" } });
}
/** How many pushes a stream has had, 0 for a stream nobody has made (asking for one makes it). */
const had = (wake: Wake, name: string) => wake.hasAgent(name) ? wake.agent(name).latest() : 0;
const merged = (op: Awaited<ReturnType<typeof server>>["op"]) => op.markMerged({ author: "Whitefoot", session: "看板", id: "a", row: "merge", merged: [{ repo: "Ming-Research/Whitefoot", number: 7 }], log: "Ming-Research/Whitefoot#7 已在 GitHub 合入" });

test("a merge row turning done tells the session holding each open item that waits on it by a shared row, once, and not the owner", async t => {
  const wake = new Wake({ now: () => T0 });
  const { url, op, store } = await server(t, { wake });
  // Item a is owned by area, which nobody holds, and shared by b, which an engineer holds.
  await op.dispatchStart({ ...asArchitect, id: "b", role: "工程师", level: 2, model: "Sonnet", agent: "b-worker", agentId: "agent-1" });
  const architect = await agentSocket(t, url, ARCHITECT_SESSION);
  await openMergeRow(op, store);
  await architect.sync();
  assert.equal(had(wake, "b-worker"), 0, "an open merge row tells nobody");
  await merged(op);
  await until(() => had(wake, "b-worker") === 1, "the dep-merged push");
  const [frame] = wake.agent("b-worker").pending().frames;
  assert.deepEqual({ ...frame, at: undefined, line: undefined }, { n: 1, at: undefined, event: "dep-merged", item: "a", project: "Whitefoot", title: "中文检查", prs: ["Ming-Research/Whitefoot#7"], waiter: "b", line: undefined });
  await op.appendLog({ ...asArchitect, id: "a", text: "a later write to the item" });
  await architect.sync();
  assert.equal(had(wake, "b-worker"), 1, "told once");
  assert.equal(had(wake, ARCHITECT_SESSION), 0, "the holder was told, so the architect is not");
  assert.deepEqual(architect.events().filter(f => f.event === "dep-merged"), [], "area owns a and nobody holds it: an owner's row is not a wait, and the architect is not told");
});

test("a merge row turning done tells the architect of an open waiter nobody holds, and a row marked done by hand counts", async t => {
  const wake = new Wake({ now: () => T0 });
  const { url, op, store } = await server(t, { wake });
  const architect = await agentSocket(t, url, ARCHITECT_SESSION);
  await openMergeRow(op, store);
  // By hand, as a session may: the same row, done.
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "merge", text: "合入 Ming-Research/Whitefoot#7", state: "done" } });
  await until(() => had(wake, ARCHITECT_SESSION) === 1, "the dep-merged push to the architect");
  await architect.sync();
  const [frame] = wake.agent(ARCHITECT_SESSION).pending().frames;
  assert.deepEqual([frame!.event, frame!.item, frame!.waiter, frame!.prs], ["dep-merged", "a", "b", ["Ming-Research/Whitefoot#7"]]);
  assert.deepEqual(architect.events().map(f => f.event), ["dep-merged"], "and the architect's socket was sent it");
});

test("what is not a merge row turning done tells nobody: a row naming no PR its 改动 section names, a step that only says 合入, a dropped row, a waiter that is done or paused", async t => {
  const wake = new Wake({ now: () => T0 });
  const { url, op, store } = await server(t, { wake });
  await op.dispatchStart({ ...asArchitect, id: "b", role: "工程师", level: 2, model: "Sonnet", agent: "b-worker", agentId: "agent-1" });
  const architect = await agentSocket(t, url, ARCHITECT_SESSION);
  // A PR the 改动 section does not name.
  await openMergeRow(op, store, "合入 Ming-Research/Whitefoot#8");
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "merge", text: "合入 Ming-Research/Whitefoot#8", state: "done" } });
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "check", text: "确认 Ming-Research/Whitefoot#7 没问题", state: "doing" } });
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "check", text: "确认 Ming-Research/Whitefoot#7 没问题", state: "done" } });
  // A step that says 合入 and names the PR but is not the merge row: a plan that has one, an online check and a step that waits for another merge.
  for (const [id, text] of [["verify", "合入后线上验证 Ming-Research/Whitefoot#7"], ["ship", "合入 Ming-Research/Whitefoot#7"], ["wait", "前半已验：Ming-Research/Whitefoot#7 合入，等 Ming-Research/Whitefoot#9 合入"]] as const) {
    await op.setPlan({ ...asArchitect, id: "a", row: { id, text, state: "doing" } });
    await op.setPlan({ ...asArchitect, id: "a", row: { id, text, state: "done" } });
  }
  // A dropped row did not merge.
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "merge-2", text: "合入 Ming-Research/Whitefoot#7", state: "doing" } });
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "merge-2", text: "合入 Ming-Research/Whitefoot#7", state: "dropped", reason: "不做了" } });
  await architect.sync();
  assert.equal(had(wake, "b-worker"), 0, "none of these told the holder of b");
  // A waiter that is paused is not waiting on anyone: nothing is told for it, held or not.
  await op.setPause({ ...asArchitect, id: "b", paused: true, reason: "waits for the owner" });
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "merge-3", text: "合入 Ming-Research/Whitefoot#7", state: "doing" } });
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "merge-3", text: "合入 Ming-Research/Whitefoot#7", state: "done" } });
  await architect.sync();
  assert.equal(had(wake, "b-worker"), 0, "b is paused");
  assert.equal(had(wake, ARCHITECT_SESSION), 0, "and it is not the architect's to hear of either");
  // The same row shape once b is open again is told, so the silences above are the conditions' and not a push that never works.
  await op.setPause({ ...asArchitect, id: "b", paused: false });
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "merge-4", text: "合入 Ming-Research/Whitefoot#7", state: "doing" } });
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "merge-4", text: "合入 Ming-Research/Whitefoot#7", state: "done" } });
  await until(() => had(wake, "b-worker") === 1, "the push once b is open");
});

test("a row of an old plan that starts with 合入 and names the PR is a merge row when the plan has no merge stage row", async t => {
  const wake = new Wake({ now: () => T0 });
  const { op, store } = await server(t, { wake });
  await op.dispatchStart({ ...asArchitect, id: "b", role: "工程师", level: 2, model: "Sonnet", agent: "b-worker", agentId: "agent-1" });
  await op.updateItem({ author: "Whitefoot", id: "a", rev: store.snapshot().items.a!.rev, head: "背景\n\n## 改动\n\nMing-Research/Whitefoot#7", reason: "name the PR" });
  // The row's id is not a stage's: only its text makes it the merge row.
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "ship", text: "合入 Ming-Research/Whitefoot#7", state: "doing" } });
  await op.setPlan({ ...asArchitect, id: "a", row: { id: "ship", text: "合入 Ming-Research/Whitefoot#7", state: "done" } });
  await until(() => had(wake, "b-worker") === 1, "the dep-merged push");
});

test("the pools count the candidates a group stands for and those past the rows listed, as the independent count does", async t => {
  const doc = (title: string, extra: object = {}) => ({ title, group: "Whitefoot", difficulty: 2, plan: [{ id: "accept", text: "某项检查通过", state: "todo", accept: true }], updated: later, head: "**完成条件**：某项检查通过", ...extra });
  // The count of what can start in the 2+ pool, read without the code under test.
  const independent = (s: Snapshot, r: ReturnType<(typeof import("../src/rules.ts"))["rules"]>) => Object.keys(s.items).filter(id => r.startable(id) && holderOf(s, id) === undefined && s.items[id]!.difficulty! >= 2).length;
  // Five startable parts under one parent are listed as the parent and 5, not as five rows.
  const grouped = await board(t), children = Array.from({ length: 5 }, (_, i) => `part${i}`);
  await grouped.store.commit({ author, message: "Seed", puts: [
    { kind: "item", id: "parent", expectRev: null, doc: doc("有五个部分的条目", { plan: [...children.map(id => ({ id, item: id, own: true, after: [] })), { id: "accept", text: "某项检查通过", state: "todo", accept: true }] }) },
    ...children.map(id => ({ kind: "item" as const, id, expectRev: null, doc: doc(`部分 ${id}`) })),
  ] });
  const g = grouped.store.snapshot(), gr = grouped.store.derived.rules(g, T0), gpool = candidates(g, gr).pools.find(p => p.pool === "2+")!;
  assert.ok(gpool.listed.some(x => "parent" in x && x.count === 5), "the five parts are listed as one group");
  assert.equal(gpool.total, independent(g, gr), "the five parts are all counted in the pool");
  assert.ok(independent(g, gr) >= 6, "the five parts and the fixture's own candidate");
  // A parent whose parts are of two levels is one group in each pool, and each pool counts only its own parts.
  const mixed = await board(t), levels = [2, 2, 2, 1, 1];
  await mixed.store.commit({ author, message: "Seed", puts: [
    { kind: "item", id: "mparent", expectRev: null, doc: doc("两个级别的部分", { plan: [...levels.map((_, i) => ({ id: `m${i}`, item: `m${i}`, own: true, after: [] })), { id: "accept", text: "某项检查通过", state: "todo", accept: true }] }) },
    ...levels.map((difficulty, i) => ({ kind: "item" as const, id: `m${i}`, expectRev: null, doc: doc(`部分 m${i}`, { difficulty }) })),
  ] });
  const m = mixed.store.snapshot(), mr = mixed.store.derived.rules(m, T0);
  const ofLevel = (level: (d: number) => boolean) => Object.keys(m.items).filter(id => mr.startable(id) && holderOf(m, id) === undefined && level(m.items[id]!.difficulty!)).length;
  assert.deepEqual(candidates(m, mr).pools.map(p => [p.pool, p.total]), [["1", ofLevel(d => d === 1)], ["2+", ofLevel(d => d >= 2)]]);
  assert.equal(ofLevel(d => d === 1), 2, "the two level 1 parts");
  // Twelve loose candidates are more than the rows listed for a pool: the rest are only counted.
  const crowded = await board(t), loose = Array.from({ length: 12 }, (_, i) => `loose${i}`);
  await crowded.store.commit({ author, message: "Seed", puts: loose.map(id => ({ kind: "item" as const, id, expectRev: null, doc: doc(`单独 ${id}`) })) });
  const c = crowded.store.snapshot(), cr = crowded.store.derived.rules(c, T0), cpool = candidates(c, cr).pools.find(p => p.pool === "2+")!;
  assert.ok(cpool.more > 0, "some candidates are past the rows listed");
  assert.equal(cpool.total, independent(c, cr), "the twelve are all counted in the pool, though only some are listed");
  assert.ok(independent(c, cr) >= 13, "the twelve and the fixture's own candidate");
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
  // Rewritten past its retention, a file still starts with its name, and a restart finds the stream with its pushes.
  const small = new AgentStream("named", { file: join(dir, agentFileName("named")), now: () => T0, retain: 2 });
  for (let i = 0; i < 3; i++) small.push("note", { note: "x" + i, target: "it:a", kind: "comment", title: "t", project: "p" });
  small.deliver(2);
  const file = (await readFile(join(dir, agentFileName("named")), "utf8")).split("\n");
  assert.equal(file[0], '{"name":"named"}', "the name is the first line after a rewrite");
  const back = new Wake({ dir, now: () => T0 });
  assert.equal(back.hasAgent("named"), true);
  assert.deepEqual([back.agent("named").latest(), back.agent("named").deliveredUpTo(), back.agent("named").pending().frames.map(f => f.note)], [3, 2, ["x2"]]);
  // A record is the name only when name is all it holds: an event carrying a name field, even first, is not taken for it.
  await writeFile(join(dir, agentFileName("real")), [{ n: 1, at: "2026-10-17T00:00:00.000Z", event: "note", name: "impostor" }, { name: "real" }].map(l => JSON.stringify(l) + "\n").join(""));
  assert.equal(new Wake({ dir, now: () => T0 }).hasAgent("real"), true);
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
