import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { stringify } from "yaml";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { ownerOps } from "../src/owner-ops.ts";
import { createHttpServer } from "../src/http.ts";
import { createMcpServer } from "../src/mcp.ts";
import type { Wake } from "../src/wake.ts";
import type { GithubWatch } from "../src/watch.ts";
import type { UsageWatch } from "../src/usage-watch.ts";
import type { Credentials } from "../src/credentials.ts";

/** A RegExp from a template whose interpolated values match literally: an expected error text built from the same definition the code builds it from. */
export const rx = (strings: TemplateStringsArray, ...values: string[]): RegExp =>
  new RegExp(strings.raw.map((part, i) => part + (i < values.length ? values[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "")).join(""));

/** What a write under the retired author 总管 is told, written out: the process is written as the PM, the rules and the architect's own entries as Architect. */
export const retiredText = "author 总管: this identity is retired; write the process as PM (session PM), and the rules and the architect's own entries as Architect";
export const retired = rx`${retiredText}`;
export const retiredExactly = new RegExp(`^${retired.source}$`);

export const at = "2026-10-11T01:02:03Z";
export const later = "2026-10-11T02:03:04Z";
export const author = "Whitefoot";
/** The architect's author name and session: together the writer that does what the board reserves for the architect (the journal, the tag vocabulary) and everything the PM does. */
export const architect = "Architect";
export const architectSession = "架构师";
export const asArchitect = { author: architect, session: architectSession };
/** The PM writes as author PM (a project of its own) from the session PM: it creates, cancels and retitles items, but writes no journal and changes no tag vocabulary. */
export const pmAuthor = "PM";
export const pmSession = "PM";
export const asPM = { author: pmAuthor, session: pmSession };
/** Synthetic plans preserve the unrelated query, note and history witnesses. */
export async function board(t: { after(fn: () => void | Promise<void>): void }, options: { sharedProjects?: boolean; unmigrated?: boolean; requireBudget?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-agent-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = await Store.open(dir, { init: true, requireBudget: options.requireBudget, board: { title: "Synthetic board", projects: [{ name: "Whitefoot", repo: "Ming-Research/Whitefoot" }, { name: "Firn" }, { name: "总管" }, { name: "Architect" }, { name: pmAuthor }] } });
  // Rated, so a fixture item raises no 缺难度 check and can be listed as startable; tests of difficulty change it.
  const item = (title: string, fields: object = {}) => ({ title, group: author, priority: "P1", difficulty: 2, plan: [{ id: "accept", accept: true, text: "独立验收通过", state: "todo" }], updated: at, ...fields });
  const nonRoot = (doc: Record<string, unknown>) => { delete doc.priority; return doc; };
  await store.commit({ author: "Fixture", message: "Seed synthetic board", puts: [
    { kind: "item", id: "area", expectRev: null, doc: item("解释器工作", { group: "Whitefoot", plan: [{ id: "a", item: "a", own: true, after: [] }, { id: "b", item: "b", own: true, after: [] }, { id: "accept", accept: true, text: "解释器目标通过", state: "todo" }] }) },
    { kind: "item", id: "other", expectRev: null, doc: item("其他项目", { group: options.sharedProjects ? "Whitefoot" : "Firn" }) },
    { kind: "item", id: "a", expectRev: null, doc: nonRoot(item("中文检查", { head: "稳定中文背景 Whitefoot#341", data: "中文数据", ask: { text: "批准中文检查" }, links: [{ label: "Pull request", url: "https://github.com/Ming-Research/Whitefoot/pull/341" }],
      log: Array.from({ length: 7 }, (_, i) => ({ at: `2026-10-11T01:02:0${i}Z`, by: i === 0 ? "中文作者" : author, text: i === 0 ? "早期中文记录" : i === 6 ? "最新中文记录" : `Progress ${i}` })) })) },
    { kind: "item", id: "b", expectRev: null, doc: nonRoot(item("阻塞证据", { priority: "P0", head: "未注明仓库 #341; Other#341\n\n[[q:choice]]", plan: [{ id: "a", item: "a", own: false, after: [] }, { id: "ruled", card: "ruled", after: [] }, { id: "choice", card: "choice", after: [] }, { id: "accept", accept: true, text: "阻塞证据验收通过", state: "todo" }] })) },
    { kind: "decision", id: "choice", expectRev: null, doc: { item: "b", question: "中文方案？", options: [{ key: "A", text: "中文选项", recommended: true }, { key: "B", text: "另一选项" }], status: "open", blocks: "阻塞证据的验收等它", at, updated: at } },
    { kind: "decision", id: "ruled", expectRev: null, doc: { item: "b", question: "旧方案？", options: [{ key: "A", text: "Old" }], status: "ruled", choice: "A", ruledAt: later, ruling: "中文裁决", legacy: { background: "Old Whitefoot PR #341" }, updated: later } },
    { kind: "note", id: "note-1", expectRev: null, doc: { target: "it:a", kind: "comment", text: "中文意见 Whitefoot #341", at, sentAt: at, state: "sent" } },
    { kind: "note", id: "note-2", expectRev: null, doc: { target: "q:choice", kind: "explain", text: "解释 #341", at, state: "done", reply: "中文回复", repliedAt: later, repliedBy: author } },
  ] });
  return { dir, store, op: ops(store, () => later) };
}

/** The daemon's pieces over a fresh board, listening on a free port; `wake` and `timedWakeMs` reach the wake channel. */
export async function server(t: Parameters<typeof board>[0], extra: { now?: () => number; checkIntervalMs?: number; credentials?: Credentials; wake?: Wake; timedWakeMs?: number; architectTimedWakeMs?: number; watch?: (fixture: Awaited<ReturnType<typeof board>>) => GithubWatch; usage?: (fixture: Awaited<ReturnType<typeof board>>) => UsageWatch; webDir?: string; prepare?: (fixture: Awaited<ReturnType<typeof board>>) => void; requireBudget?: boolean } = {}) {
  const fixture = await board(t, { requireBudget: extra.requireBudget }), { store, op } = fixture;
  extra.prepare?.(fixture);
  const http = createHttpServer({ store, ops: op, ownerOps: ownerOps(store), webDir: extra.webDir ?? join(import.meta.dirname, "../web"), createMcp: credential => createMcpServer({ store, ops: op, wake: extra.wake, credential }), credentials: extra.credentials, now: extra.now, checkIntervalMs: extra.checkIntervalMs, wake: extra.wake, timedWakeMs: extra.timedWakeMs, architectTimedWakeMs: extra.architectTimedWakeMs, watch: extra.watch?.(fixture), usage: extra.usage?.(fixture) });
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

/** A client of the wake stream: every frame it receives, and `sync`, which returns once the server has sent all it had. `path` is
 * the stream's address: the PM's by default. */
export async function wakeSocket(t: { after(fn: () => void): void }, url: string, after?: number, path = "/wake") {
  const socket = new WebSocket(url.replace("http:", "ws:") + path + (after === undefined ? "" : "?after=" + after));
  t.after(() => socket.terminate());
  const frames: Array<Record<string, unknown>> = [];
  socket.on("message", data => frames.push(JSON.parse(data.toString())));
  await once(socket, "open");
  // The server sends its connected frame in the same step as the upgrade; ping/pong is the wire-order barrier after it.
  const sync = async () => { const pong = once(socket, "pong"); socket.ping(); await pong; };
  await sync();
  return { frames, sync, socket, events: () => frames.filter(f => typeof f.n === "number") };
}

/** A client of the architect's wake stream, `/wake/架构师`, like wakeSocket. */
export const architectSocket = (t: { after(fn: () => void): void }, url: string, after?: number) => wakeSocket(t, url, after, "/wake/" + encodeURIComponent("架构师"));

/** A client of an agent's wake stream, `/wake/<name>`, like wakeSocket. */
export async function agentSocket(t: { after(fn: () => void): void }, url: string, name: string) {
  const socket = new WebSocket(url.replace("http:", "ws:") + "/wake/" + encodeURIComponent(name));
  t.after(() => socket.terminate());
  const frames: Array<Record<string, unknown>> = [];
  socket.on("message", data => frames.push(JSON.parse(data.toString())));
  await once(socket, "open");
  const sync = async () => { const pong = once(socket, "pong"); socket.ping(); await pong; };
  await sync();
  return { frames, sync, socket, events: () => frames.filter(f => typeof f.n === "number") };
}

/** A commit to write with `appendCommits`: `at` is seconds since the epoch, `files` maps a path to the document it holds from then on, or null for deleted. */
export interface HistoryCommit { at: number; message: string; author?: string; session?: string; files: Record<string, unknown | null> }

/** Writes commits onto the data repository's main branch with git fast-import, so a history of hundreds of commits takes a
 * moment, and brings the working tree to the last. A store opened before must be opened again; the documents must be valid. */
export async function appendCommits(dir: string, commits: HistoryCommit[]): Promise<void> {
  const parts: Buffer[] = [];
  commits.forEach((commit, k) => {
    const message = commit.message + (commit.session ? `\n\nSession: ${commit.session}` : "");
    parts.push(Buffer.from(`commit refs/heads/main\nauthor ${commit.author ?? "Fixture"} <fixture@wf-board.invalid> ${commit.at} +0000\ncommitter wf-board <wf-board@wf-board.invalid> ${commit.at} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${k === 0 ? "from refs/heads/main^0\n" : ""}`));
    for (const [path, doc] of Object.entries(commit.files)) {
      if (doc === null) { parts.push(Buffer.from(`D ${path}\n`)); continue; }
      const body = Buffer.from(stringify(doc, { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" }));
      parts.push(Buffer.from(`M 100644 inline ${path}\ndata ${body.length}\n`), body, Buffer.from("\n"));
    }
  });
  const child = spawn("git", ["fast-import", "--quiet"], { cwd: dir, stdio: ["pipe", "inherit", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const done = once(child, "exit");
  child.stdin.end(Buffer.concat(parts));
  const [code] = await done;
  assert.equal(code, 0, `git fast-import: ${stderr}`);
  await promisify(execFile)("git", ["reset", "--hard", "-q", "HEAD"], { cwd: dir });
}
