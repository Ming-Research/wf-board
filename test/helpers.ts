import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { createHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";
import type { Wake } from "../src/wake.ts";

export const at = "2026-10-11T01:02:03Z";
export const later = "2026-10-11T02:03:04Z";
export const author = "Whitefoot";
/** The architect's author name and session: together the only writer that creates, cancels or retitles items and does what the board reserves for the architect. */
export const architect = "Architect";
export const architectSession = "架构师";
export const asArchitect = { author: architect, session: architectSession };
/** Synthetic plans preserve the unrelated query, note and history witnesses. */
export async function board(t: { after(fn: () => void | Promise<void>): void }, options: { sharedProjects?: boolean; unmigrated?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-agent-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [{ name: "Whitefoot", repo: "Ming-Research/Whitefoot" }, { name: "Firn" }, { name: "总管" }, { name: "Architect" }] } });
  // Rated, so a fixture item raises no 缺难度 check and can be listed as startable; tests of difficulty change it.
  const item = (title: string, fields: object = {}) => ({ title, group: author, priority: "P1", difficulty: 2, plan: [{ id: "accept", accept: true, text: "独立验收通过", state: "todo" }], updated: at, ...fields });
  const nonRoot = (doc: Record<string, unknown>) => { delete doc.priority; return doc; };
  await store.commit({ author: "Fixture", message: "Seed synthetic board", puts: [
    { kind: "item", id: "area", expectRev: null, doc: item("解释器工作", { group: "Whitefoot", plan: [{ id: "a", item: "a", own: true, after: [] }, { id: "b", item: "b", own: true, after: [] }, { id: "accept", accept: true, text: "解释器目标通过", state: "todo" }] }) },
    { kind: "item", id: "other", expectRev: null, doc: item("其他项目", { group: options.sharedProjects ? "Whitefoot" : "Firn" }) },
    { kind: "item", id: "a", expectRev: null, doc: nonRoot(item("中文检查", { head: "稳定中文背景 Whitefoot#341", data: "中文数据", ask: { text: "批准中文检查" }, links: [{ label: "Pull request", url: "https://github.com/Ming-Research/Whitefoot/pull/341" }],
      log: Array.from({ length: 7 }, (_, i) => ({ at: `2026-10-11T01:02:0${i}Z`, by: i === 0 ? "中文作者" : author, text: i === 0 ? "早期中文记录" : i === 6 ? "最新中文记录" : `Progress ${i}` })) })) },
    { kind: "item", id: "b", expectRev: null, doc: nonRoot(item("阻塞证据", { priority: "P0", head: "未注明仓库 #341; Other#341", plan: [{ id: "a", item: "a", own: false, after: [] }, { id: "choice", card: "choice", after: [] }, { id: "accept", accept: true, text: "阻塞证据验收通过", state: "todo" }] })) },
    { kind: "decision", id: "choice", expectRev: null, doc: { item: "a", question: "中文方案？", background: "中文背景 Whitefoot PR #341", options: [{ key: "A", text: "中文选项", recommended: true }, { key: "B", text: "另一选项" }], confidence: { score: 4, reason: "Evidence" }, status: "open", at, updated: at } },
    { kind: "decision", id: "ruled", expectRev: null, doc: { item: "a", question: "旧方案？", background: "Old", options: [{ key: "A", text: "Old" }], status: "ruled", ruling: "中文裁决", ruledAt: later, updated: later } },
    { kind: "note", id: "note-1", expectRev: null, doc: { target: "it:a", kind: "comment", text: "中文意见 Whitefoot #341", at, sentAt: at, state: "sent" } },
    { kind: "note", id: "note-2", expectRev: null, doc: { target: "q:choice", kind: "explain", text: "解释 #341", at, state: "done", reply: "中文回复", repliedAt: later, repliedBy: author } },
  ] });
  return { dir, store, op: ops(store, () => later) };
}

/** The daemon's pieces over a fresh board, listening on a free port; `wake` and `timedWakeMs` reach the wake channel. */
export async function server(t: Parameters<typeof board>[0], extra: { now?: () => number; checkIntervalMs?: number; maxMcpSessions?: number; wake?: Wake; timedWakeMs?: number; prepare?: (fixture: Awaited<ReturnType<typeof board>>) => void } = {}) {
  const fixture = await board(t), { store, op } = fixture;
  extra.prepare?.(fixture);
  const http = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: join(import.meta.dirname, "../web"), createMcp: () => createMcpServer({ store, ops: op, wake: extra.wake }), now: extra.now, checkIntervalMs: extra.checkIntervalMs, maxMcpSessions: extra.maxMcpSessions, wake: extra.wake, timedWakeMs: extra.timedWakeMs });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(() => new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())));
  const address = http.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  async function api(path: string, data?: unknown, method = "POST") {
    const response = await fetch(url + path, data === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  }
  return { ...fixture, http, url, api, port: address.port };
}

/** A client of the wake stream: every frame it receives, and `sync`, which returns once the server has sent all it had. */
export async function wakeSocket(t: { after(fn: () => void): void }, url: string, after?: number) {
  const socket = new WebSocket(url.replace("http:", "ws:") + "/wake" + (after === undefined ? "" : "?after=" + after));
  t.after(() => socket.terminate());
  const frames: Array<Record<string, unknown>> = [];
  socket.on("message", data => frames.push(JSON.parse(data.toString())));
  await once(socket, "open");
  // The server sends its connected frame in the same step as the upgrade; ping/pong is the wire-order barrier after it.
  const sync = async () => { const pong = once(socket, "pong"); socket.ping(); await pong; };
  await sync();
  return { frames, sync, socket, events: () => frames.filter(f => typeof f.n === "number") };
}
