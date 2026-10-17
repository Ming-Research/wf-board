// Credentials: the tokens, the long-lived file, the dispatch credentials and what a connection that carries one may do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CredentialFile, Credentials, CredentialsFile, REFUSED, bearer, hashToken, newToken } from "../src/credentials.ts";
import type { Resolved } from "../src/credentials.ts";
import { createMcpServer } from "../src/mcp.ts";
import { ops } from "../src/ops.ts";
import { board, server, asArchitect } from "./helpers.ts";

async function credentialsFile(t: Parameters<typeof board>[0], entries: unknown[] | string, log: (m: string) => void = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-credentials-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const path = join(dir, "credentials.json");
  const write = (content: unknown[] | string) => writeFile(path, typeof content === "string" ? content : JSON.stringify({ credentials: content }));
  await write(entries);
  return { path, write, file: new CredentialFile(path, log) };
}
const entry = (token: string, fields: Record<string, unknown> = {}) => ({ session: "观察者", role: "观察者", project: "Architect", roots: [], hash: hashToken(token), ...fields });

test("a token is 256 random bits behind a prefix, only its hash is compared, and Bearer is the one header form", () => {
  const a = newToken(), b = newToken();
  assert.match(a, /^wfb_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.match(hashToken(a), /^[0-9a-f]{64}$/);
  assert.equal(hashToken(a), hashToken(a));
  assert.notEqual(hashToken(a), hashToken(b));
  assert.equal(bearer("Bearer abc"), "abc");
  assert.equal(bearer("bearer  abc "), "abc");
  for (const header of [undefined, "", "Basic abc", "Bearer", "Bearer two words"]) assert.equal(bearer(header), undefined, String(header));
});

test("the long-lived file: a missing file holds none, a change is read at the next look, a bad file is refused with its reason and logged once", async t => {
  const logged: string[] = [];
  const { path, write, file } = await credentialsFile(t, [entry("one")], m => logged.push(m));
  assert.deepEqual((file.read() as { entries: unknown[] }).entries.map(e => (e as { session: string }).session), ["观察者"]);
  await write([entry("one"), entry("two", { session: "资源管理", role: "资源管理", roots: ["x"] })]);
  assert.deepEqual((file.read() as { entries: unknown[] }).entries.map(e => (e as { session: string }).session), ["观察者", "资源管理"], "a longer file is read again");
  await write("{ not json");
  const bad = file.read();
  assert.ok("error" in bad && /the credentials file is not valid/.test(bad.error));
  file.read(); file.read();
  assert.equal(logged.length, 1, "the same bad file is logged once");
  await write([entry("one")]);
  assert.ok("entries" in file.read(), "the file fixed, it counts again");
  const missing = new CredentialFile(path + ".none", () => {});
  assert.deepEqual(missing.read(), { entries: [] });
});

test("the file's entries are checked: a role of its own, the architect only as itself, no two alike", () => {
  const ok = entry("x");
  assert.ok(CredentialsFile.safeParse({ credentials: [ok] }).success);
  const bad: Array<[string, unknown]> = [
    ["a role a dispatch has", { ...ok, role: "工程师" }],
    ["the architect as another session", { ...ok, role: "架构师", session: "别人", project: "Architect" }],
    ["the architect in another project", { ...ok, role: "架构师", session: "架构师", project: "Firn" }],
    ["the architect's session name for another role", { ...ok, session: "架构师" }],
    ["the architect's session name for the resource agent", { ...ok, role: "资源管理", session: "架构师" }],
    ["a hash that is not one", { ...ok, hash: "abc" }],
    ["an unknown field", { ...ok, token: "wfb_x" }],
  ];
  for (const [what, credential] of bad) assert.equal(CredentialsFile.safeParse({ credentials: [credential] }).success, false, what);
  assert.equal(CredentialsFile.safeParse({ credentials: [ok, ok] }).success, false, "the same session twice");
  assert.ok(CredentialsFile.safeParse({ credentials: [entry("a", { role: "架构师", session: "架构师", project: "Architect" })] }).success);
});

test("a credential is resolved to its writer; none without a header, a refusal for one that names nothing valid", async t => {
  const { store } = await board(t), s = store.snapshot();
  const { file } = await credentialsFile(t, [entry("long-lived", { roots: ["a"] })]);
  const credentials = new Credentials(file);
  assert.equal(credentials.resolve(undefined, s), undefined);
  assert.deepEqual(credentials.resolve("Bearer long-lived", s), { ok: true, who: { author: "Architect", session: "观察者", access: { role: "观察者", project: "Architect", roots: ["a"] } } });
  const unknown = credentials.resolve("Bearer unknown", s);
  assert.ok(unknown && !unknown.ok && unknown.problem === REFUSED, "a token nothing knows");
  for (const header of ["Basic long-lived", "Bearer"]) {
    const refused = credentials.resolve(header, s);
    assert.ok(refused && !refused.ok && /the Authorization header is not "Bearer <token>"/.test(refused.problem), header);
  }
  const broken = new Credentials((await credentialsFile(t, "{")).file);
  const refused = broken.resolve("Bearer long-lived", s) as Extract<Resolved, { ok: false }>;
  assert.match(refused.problem, /the credentials file is not valid/, "a file that does not parse refuses every credential, the dispatch ones excepted");
});

test("a dispatch issues a credential for its session, role, item and project, and ending the dispatch revokes it", async t => {
  const { store, op } = await board(t);
  const credentials = new Credentials((await credentialsFile(t, [])).file);
  const { credential } = await op.dispatchStart({ ...asArchitect, id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "a-worker", agentId: "agent-1" });
  assert.deepEqual(credentials.resolve(`Bearer ${credential}`, store.snapshot()), { ok: true, who: { author: "Whitefoot", session: "a-worker", access: { role: "工程师", project: "Whitefoot", roots: ["a"] } } });
  // The architect's session name is the architect's alone: a dispatch credential under it would be taken for the architect's.
  await assert.rejects(op.dispatchStart({ ...asArchitect, id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "架构师", agentId: "agent-3" }), /agent.*the architect's session name/);
  await assert.rejects(op.dispatchStart({ ...asArchitect, id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "架构师 ", agentId: "agent-4" }), /agent.*the architect's session name/, "spaces around the name do not make another name: the board ignores them where it takes a session for the architect's");
  assert.equal(store.snapshot().items.a!.dispatches?.some(d => d.agent.trim() === "架构师") ?? false, false, "and no dispatch was recorded");
  const review = await op.dispatchStart({ ...asArchitect, id: "a", role: "审查", level: 3, model: "Opus", agent: "a-review", agentId: "agent-2" });
  const reviewer = credentials.resolve(`Bearer ${review.credential}`, store.snapshot()) as Extract<Resolved, { ok: true }>;
  assert.equal(reviewer.who.access.role, "审查");
  assert.notEqual(credential, review.credential);
  await op.dispatchFinish({ ...asArchitect, id: "a", agentId: "agent-1", result: "一次通过", usage: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }, cost: 1, reports: 0, kickbacks: 0 });
  const revoked = credentials.resolve(`Bearer ${credential}`, store.snapshot());
  assert.ok(revoked && !revoked.ok && revoked.problem === REFUSED, "the ended dispatch's credential no longer counts");
  assert.ok(credentials.resolve(`Bearer ${review.credential}`, store.snapshot())?.ok, "the other dispatch's credential still does");
  assert.equal(store.snapshot().items.a!.dispatches![0]!.credential, undefined, "its hash is not kept");
});

async function connected(t: Parameters<typeof board>[0], credential?: Resolved) {
  const fixture = await board(t), mcp = createMcpServer({ store: fixture.store, ops: fixture.op, credential });
  const client = new Client({ name: "Credential test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  return { ...fixture, client, text };
}
const engineer: Resolved = { ok: true, who: { author: "Whitefoot", session: "a-worker", access: { role: "工程师", project: "Whitefoot", roots: ["a"] } } };

test("a write over a connection with a credential is recorded under the credential's session, whatever the call says", async t => {
  const { client, text, store } = await connected(t, engineer);
  const plain = await client.callTool({ name: "append_log", arguments: { id: "a", text: "without author or session" } });
  assert.ok(!plain.isError, text(plain));
  assert.doesNotMatch(text(plain), /ignored/, "nothing to tell: the call named no writer");
  assert.equal((await store.log({ limit: 1 }))[0]!.session, "a-worker");
  assert.equal(store.snapshot().items.a!.log.at(-1)!.by, "Whitefoot");
  const claimed = await client.callTool({ name: "append_log", arguments: { author: "Architect", session: "架构师", id: "a", text: "claims to be the architect" } });
  assert.ok(!claimed.isError, text(claimed));
  assert.match(text(claimed), /note: author and session ignored: this connection's credential writes as author Whitefoot, session a-worker/);
  const [newest] = await store.log({ limit: 1 });
  assert.equal(newest!.session, "a-worker");
  assert.equal(newest!.author, "Whitefoot", "the commit is the credential's too");
  const same = await client.callTool({ name: "append_log", arguments: { author: "Whitefoot", session: "a-worker", id: "a", text: "says the same as the credential" } });
  assert.doesNotMatch(text(same), /ignored/);
});

test("a credential holds the writer to its role over MCP as it does in ops", async t => {
  const { client, text, store } = await connected(t, engineer);
  const before = store.snapshot().head;
  const cancel = await client.callTool({ name: "set_status", arguments: { id: "a", status: "cancelled", log: "no" } });
  assert.equal(cancel.isError, true);
  assert.match(text(cancel), /item\.cancel: a 工程师 credential may not write this part/);
  // An engineer makes items, but only inside its subtree: a top item is no part of it.
  const create = await client.callTool({ name: "create_item", arguments: { key: "n", title: "N", priority: "P1", accept: "ok", group: "Whitefoot" } });
  assert.equal(create.isError, true);
  assert.match(text(create), /item n: outside the subtree of a/);
  const sibling = await client.callTool({ name: "append_log", arguments: { id: "b", text: "outside" } });
  assert.equal(sibling.isError, true);
  assert.match(text(sibling), /item b: outside the subtree of a/);
  assert.equal(store.snapshot().head, before);
});

test("a credential that is not valid refuses every call, reads too, and writes nothing", async t => {
  const { client, text, store } = await connected(t, { ok: false, problem: REFUSED });
  const before = store.snapshot().head;
  for (const [name, args] of [["context", { id: "a" }], ["append_log", { author: "Whitefoot", session: "s", id: "a", text: "falls back to the old way?" }], ["projects", {}]] as const) {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, true, name);
    assert.match(text(r), /credential is not valid/, name);
  }
  assert.equal(store.snapshot().head, before, "an invalid credential does not fall back to the call's own author");
});

test("without a credential the board is read as before, and a write names its author or is refused", async t => {
  const { client, text, store } = await connected(t);
  assert.ok(!(await client.callTool({ name: "context", arguments: { id: "a" } })).isError);
  const refused = await client.callTool({ name: "append_log", arguments: { id: "a", text: "who am I" } });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /no credential, so it can only read the board/);
  const old = await client.callTool({ name: "append_log", arguments: { author: "Whitefoot", session: "self-reported", id: "a", text: "the old way still works" } });
  assert.ok(!old.isError, text(old));
  assert.equal((await store.log({ limit: 1 }))[0]!.session, "self-reported");
  for (const tool of (await client.listTools()).tools.filter(tool => tool.inputSchema.properties && "author" in tool.inputSchema.properties)) assert.ok(!(tool.inputSchema.required ?? []).includes("author"), `${tool.name}: author is optional`);
});

test("dispatch_start answers with the credential once, and a connection that carries it writes as that session over HTTP", async t => {
  const { file } = await credentialsFile(t, [entry("architect-token", { session: "架构师", role: "架构师" })]);
  const { url } = await server(t, { credentials: new Credentials(file) });
  const connect = async (token: string) => {
    const client = new Client({ name: "HTTP credential test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    t.after(() => client.close());
    return client;
  };
  const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  const architect = await connect("architect-token");
  const started = text(await architect.callTool({ name: "dispatch_start", arguments: { id: "a", role: "工程师", level: 2, model: "Sonnet", agent: "a-worker", agentId: "agent-1" } }));
  const token = /credential: (wfb_\S+)/.exec(started)?.[1];
  assert.ok(token, started);
  assert.match(started, /shown once/);
  const context = text(await architect.callTool({ name: "context", arguments: { id: "a" } }));
  assert.ok(!context.includes(token!), "the credential is not shown again");
  const worker = await connect(token!);
  const wrote = await worker.callTool({ name: "append_log", arguments: { id: "a", text: "from the dispatched session" } });
  assert.ok(!wrote.isError, text(wrote));
  assert.match(text(await architect.callTool({ name: "context", arguments: { id: "a" } })), /Whitefoot: from the dispatched session/);
  const outside = await worker.callTool({ name: "append_log", arguments: { id: "other", text: "another project" } });
  assert.equal(outside.isError, true);
  await architect.callTool({ name: "dispatch_finish", arguments: { id: "a", agentId: "agent-1", result: "一次通过", usage: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }, cost: 1, reports: 0, kickbacks: 0 } });
  const after = await worker.callTool({ name: "append_log", arguments: { id: "a", text: "after the dispatch ended" } });
  assert.equal(after.isError, true);
  assert.match(text(after), /credential is not valid/);
});

test("ops stay usable without any credential: the GitHub watch and the old callers", async t => {
  const { store } = await board(t), op = ops(store, () => "2026-10-16T10:00:00Z");
  await op.appendLog({ author: "Whitefoot", id: "a", text: "no session, no access" });
  assert.equal(store.snapshot().items.a!.log.at(-1)!.text, "no session, no access");
});
