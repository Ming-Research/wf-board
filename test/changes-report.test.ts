import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { board, author, appendCommits, asArchitect } from "./helpers.ts";
import { createMcpServer, formatChanges, formatReport } from "../src/mcp.ts";
import { ops } from "../src/ops.ts";
import * as q from "../src/query.ts";
import { Store } from "../src/store.ts";

// The patrol read: what `changes` answers by default (docs/design.md, section 6, Finding things). Each case builds a range
// of commits with sessions and reads the answer back through the same entry the tool uses.

const at = "2026-10-11T01:02:03Z";
const LONG_TITLE = "长".repeat(25);
const doc = (title: string, fields: object = {}) => ({ title, group: "Whitefoot", priority: "P1", difficulty: 2, plan: [{ id: "accept", accept: true, text: "passes", state: "todo" }], updated: at, ...fields });
const put = (id: string, document: object) => ({ kind: "item" as const, id, expectRev: null, doc: document });

/** Writes item `id` as session `session`: `change` turns the stored document (without its revision) into the next one. */
async function write(store: Store, session: string, id: string, change: (doc: Record<string, unknown>) => Record<string, unknown>) {
  const { rev, ...rest } = store.snapshot().items[id] as unknown as { rev: number } & Record<string, unknown>;
  await store.commit({ author, session, message: `write ${id}`, puts: [{ kind: "item", id, expectRev: rev, doc: change(rest) }] });
}
const create = (store: Store, session: string, id: string, document: object) => store.commit({ author, session, message: `create ${id}`, puts: [put(id, document)] });
const report = (store: Store, since: string, scope: q.Scope = {}, options: q.ReportOptions = {}) => q.changesReport(store, store.snapshot(), since, scope, options);
const flagged = (r: Awaited<ReturnType<typeof report>>) => Object.fromEntries(r.flags.map(f => [f.item, f]));

test("a flag that appears in the range is listed once with the sessions that wrote the item; a flag that was there before is not", async t => {
  const { store } = await board(t);
  // Before the range: one item already carries the title-length flag.
  await create(store, "early", "wordy", doc(LONG_TITLE));
  const since = store.snapshot().head;
  // In the range: a second long title appears, and the first one is edited while it stays long.
  await create(store, "eng-1", "fresh", doc(LONG_TITLE + "二"));
  await write(store, "eng-2", "wordy", d => ({ ...d, title: LONG_TITLE + "三" }));
  const r = await report(store, since);
  assert.deepEqual(r.flags, [], "the new item's flag is on the new item's row, not in the flag group");
  assert.deepEqual(r.created.map(c => [c.id, c.by]), [["fresh", "eng-1"]]);
  assert.ok(r.created[0]!.flags.some(name => /^标题超过 20 个字$/.test(name)), `the title-length flag is on the new row: ${r.created[0]!.flags}`);
  // The edited title is still too long: the same flag, so not new, although the text carries another count.
  assert.ok(!JSON.stringify(r).includes("wordy"), "an unchanged flag is never listed");
});

test("a flag another item's change brings out has no writer of its own, and a flag on an item written in the range names its writers", async t => {
  const { store, op } = await board(t);
  const since = store.snapshot().head;
  // b waits on a shared row for a; cancelling a gives b the cancelled-dependency flag although nobody wrote b.
  await op.setStatus({ ...asArchitect, id: "a", status: "cancelled", log: "Superseded" });
  // A new item with only its acceptance row is flagged "only acceptance left", and written by two sessions.
  await create(store, "eng-1", "quick", doc("只有验收"));
  await write(store, "eng-2", "quick", d => ({ ...d, head: "More" }));
  const r = await report(store, since), f = flagged(r);
  assert.deepEqual(f.b?.flags, ["依赖的条目已取消"]);
  assert.deepEqual(f.b?.by, [], "nobody wrote b in the range");
  assert.equal(f.quick, undefined, "a new item carries its flags on its own row");
  assert.deepEqual(r.created.find(c => c.id === "quick")!.flags, ["只差验收：其它行都已完成"]);
});

test("a flag on an existing item names every session that wrote it in the range", async t => {
  const { store } = await board(t);
  const since = store.snapshot().head;
  await write(store, "eng-1", "a", d => ({ ...d, plan: [{ id: "wait", text: "Wait for CI", state: "todo", waits: "CI" }, { id: "accept", accept: true, text: "passes", state: "todo" }] }));
  await write(store, "eng-2", "a", d => ({ ...d, head: "More" }));
  const f = flagged(await report(store, since));
  assert.deepEqual(f.a?.flags, ["在等文字"]);
  assert.deepEqual(f.a?.by, ["eng-1", "eng-2"]);
});

test("a tag vocabulary introduced in the range makes the untagged items new flags, found by putting the board's settings back too", async t => {
  const { store } = await board(t);
  const since = store.snapshot().head, current = store.snapshot();
  await store.commit({ author: "Architect", session: "架构师", message: "Approve a tag", board: { ...current.board, tags: [{ name: "测试", meaning: "Applies to tests", projects: ["Whitefoot"] }] } });
  const f = flagged(await report(store, since));
  assert.deepEqual(f.a?.flags, ["缺标签"]);
  assert.deepEqual(f.a?.by, [], "the vocabulary is not an item write");
  assert.equal(f.other, undefined, "Firn has no tag in the vocabulary, so its items are not flagged");
});

test("a stalled step is a new flag when time passes without a commit: the old board is worked out at the since time", async t => {
  const { dir, store: seed } = await board(t);
  const base = Math.floor(Date.now() / 1000) - 4 * 3600, iso = (sec: number) => new Date(sec * 1000).toISOString();
  // stuck is written once, at base, with a step in progress; another item is written every 20 minutes for the next three
  // hours, so the board stays busy while stuck stands still.
  const stuck = { ...doc("卡住的", { updated: iso(base) }), rev: 1, plan: [{ id: "work", text: "Own work", state: "doing", since: iso(base) }, { id: "accept", accept: true, text: "passes", state: "todo" }] };
  const busy = Array.from({ length: 9 }, (_, k) => ({ at: base + 1200 * (k + 1), message: `busy ${k}`, session: "busy", files: { "items/other.yaml": { ...(seed.snapshot().items.other as object), rev: 2 + k, head: `busy ${k}`, updated: iso(base + 1200 * (k + 1)) } } }));
  await appendCommits(dir, [{ at: base, message: "start work", session: "eng-1", files: { "items/stuck.yaml": stuck } }, ...busy]);
  const store = await Store.open(dir), log = await store.log({ since: iso(base - 60), at: store.snapshot().head });
  // Forty minutes after stuck was written it is not stalled yet; now, four hours on, it is.
  const early = log.find(c => c.message === "busy 1")!.commit;
  const r = await report(store, early);
  assert.deepEqual(flagged(r).stuck?.flags, ["无人推进"]);
  // Only the daemon's own numbering commit (the fixture's documents came without short numbers) wrote it after that.
  assert.ok(!flagged(r).stuck!.by.some(name => name === "eng-1" || name === "busy"), "no session wrote stuck after the since commit");
  // Asked from a time after it was already stalled, the flag is not new.
  const late = log.find(c => c.message === "busy 8")!.commit;
  assert.equal(flagged(await report(store, late)).stuck, undefined);
});

test("except drops the sessions' commits from the counts, the new items, and the notes and cards, but not from the flags", async t => {
  const { store, op } = await board(t);
  const since = store.snapshot().head;
  // PM creates an item, pauses a (b waits on it), and ruled a card; eng-1 creates one item and replies to a note.
  await create(store, "PM", "pm-made", doc("PM 建的"));
  await create(store, "eng-1", "eng-made", doc("工程师建的"));
  await write(store, "PM", "a", d => ({ ...d, paused: { reason: "Owner wants it later", at } }));
  await op.ruleCard({ author, session: "PM", key: "choice", choice: "A", ruling: "A" });
  await op.replyNote({ author, session: "eng-1", id: "note-1", reply: "Seen" });
  const all = await report(store, since), kept = await report(store, since, {}, { except: ["PM"] });
  assert.deepEqual(all.created.map(c => c.id).sort(), ["eng-made", "pm-made"]);
  assert.deepEqual(kept.created.map(c => c.id), ["eng-made"]);
  assert.deepEqual(kept.replies.map(x => `${x.kind}:${x.id}`), ["note:note-1"]);
  assert.deepEqual(all.replies.map(x => `${x.kind}:${x.id}`).sort(), ["card:choice", "note:note-1"]);
  assert.deepEqual(kept.commits, { total: 5, dropped: 3 }, "PM wrote three of the five commits; the total counts them all");
  assert.deepEqual(all.commits, { total: 5, dropped: 0 });
  // The pause flag stays listed, naming PM as its writer.
  const paused = flagged(kept).a;
  assert.deepEqual(paused?.by, ["PM", "eng-1"], "the reply to a note on a counts as a write to a");
  assert.match(paused!.flags.join(" "), /暂停冲突/);
  // Excluding a session no commit carries changes nothing; a commit without a session cannot be excluded.
  assert.deepEqual((await report(store, since, {}, { except: ["nobody"] })).created.map(c => c.id).sort(), ["eng-made", "pm-made"]);
});

test("each row says who wrote it: a created item its creator, a note or card the sessions of its commits", async t => {
  const { store, op } = await board(t);
  const since = store.snapshot().head;
  await create(store, "eng-1", "mine", doc("我的"));
  await op.replyNote({ author, session: "eng-2", id: "note-1", reply: "Seen" });
  const r = await report(store, since);
  assert.equal(r.created[0]!.by, "eng-1");
  const row = r.replies.find(x => x.id === "note-1")!;
  assert.deepEqual([row.item, row.by], ["a", ["eng-2"]]);
  assert.match(row.summary, /new reply/);
});

test("the other changes are counted by kind and session, and never listed twice", async t => {
  const { store, op } = await board(t);
  const since = store.snapshot().head;
  await create(store, "eng-1", "new-one", doc("新条目"));
  await write(store, "eng-1", "a", d => ({ ...d, head: "More" }));
  await op.appendLog({ author, session: "eng-2", id: "b", text: "Log" });
  await op.appendLog({ author, session: "eng-2", id: "a", text: "Log" });
  const r = await report(store, since, {}, { detail: true });
  assert.equal(r.others.items, 2, "a and b; the created item is not counted again");
  assert.deepEqual(r.others.bySession, { "eng-1": 1, "eng-2": 2 });
  const listed = r.others.groups.flatMap(g => g.documents.map(d => d.id));
  assert.deepEqual(listed.sort(), ["a", "b"]);
  assert.ok(r.others.groups.every(g => g.documents.every(d => d.commits.every(c => c.session !== undefined))), "the commits carry their sessions");
  // Without detail the groups are left out: the counts are all there is.
  assert.deepEqual((await report(store, since)).others.groups, []);
  // The documents behind the counts are the document listing, from one and the same grouping.
  const documents = await q.changes(store, store.snapshot(), since), shown = new Set(r.others.groups.flatMap(g => g.documents.map(d => d.id)));
  assert.deepEqual(documents.map(g => ({ ...g, documents: g.documents.filter(d => shown.has(d.id)) })).filter(g => g.documents.length), r.others.groups);
});

test("scope filters reach every group, and the limit cuts each group with the rest counted", async t => {
  const { store } = await board(t);
  const since = store.snapshot().head;
  await create(store, "eng-1", "w-long", doc(LONG_TITLE));
  await create(store, "eng-1", "f-long", doc(LONG_TITLE, { group: "Firn" }));
  await write(store, "eng-1", "other", d => ({ ...d, plan: [{ id: "wait", text: "Wait for CI", state: "todo", waits: "CI" }, { id: "accept", accept: true, text: "passes", state: "todo" }] }));
  const firn = await report(store, since, { group: "Firn" });
  assert.deepEqual(firn.created.map(c => c.id), ["f-long"]);
  assert.deepEqual(Object.keys(flagged(firn)), ["other"]);
  const text = formatReport(await report(store, since), { limit: 1 });
  assert.match(text, /还有 1 行/);
});

test("since may be a commit or a time and gives the same answer", async t => {
  const { store } = await board(t);
  const since = store.snapshot().head, time = (await store.log({ at: since, limit: 1 }))[0]!.at;
  // Git dates commits to the second and a time excludes its own second, so the next commit comes a second later.
  await new Promise(resolve => setTimeout(resolve, 1100));
  await create(store, "eng-1", "late", doc(LONG_TITLE));
  const byCommit = await report(store, since), byTime = await report(store, time);
  assert.deepEqual(byTime.created.map(c => c.id), ["late"]);
  assert.deepEqual(byTime, { ...byCommit, since: time });
});

test("what the default returns follows the rows to handle, not the changed documents; the detail listing follows the documents", async t => {
  const base = Math.floor(Date.now() / 1000) - 7200, iso = (sec: number) => new Date(sec * 1000).toISOString();
  const many = Array.from({ length: 300 }, (_, k) => `many-${k}`);
  const size: Record<number, { compact: number; detail: number }> = {};
  for (const n of [10, 300]) {
    // The same board each time: 300 items, then `n` of them edited, then two new long-titled items by another session.
    const { dir } = await board(t);
    await appendCommits(dir, [{ at: base, message: "Many items", session: "seed", files: Object.fromEntries(many.map(id => [`items/${id}.yaml`, { ...doc(`条目 ${id}`), rev: 1 }])) }]);
    const before = await Store.open(dir), from = before.snapshot().head;
    await appendCommits(dir, [
      ...many.slice(0, n).map((id, k) => ({ at: base + 100 + k, message: `touch ${id}`, session: "eng-1", files: { [`items/${id}.yaml`]: { ...doc(`条目 ${id}`), head: `edit ${n}`, rev: 2, updated: iso(base + 100 + k) } } })),
      { at: base + 1000, message: "Flagged", session: "eng-2", files: { "items/flag-1.yaml": { ...doc(LONG_TITLE), rev: 1 }, "items/flag-2.yaml": { ...doc(LONG_TITLE + "二"), rev: 1 } } },
    ]);
    const store = await Store.open(dir), full = await q.changesReport(store, store.snapshot(), from, {}, { detail: true });
    assert.equal(full.created.length, 2);
    assert.equal(full.others.items, n);
    size[n] = { compact: formatReport(full, {}).length, detail: formatReport(full, { detail: true, limit: 1000 }).length };
  }
  assert.ok(Math.abs(size[300]!.compact - size[10]!.compact) <= 12, `the compact answers differ by ${size[300]!.compact - size[10]!.compact} characters: ${size[10]!.compact} for 10 documents, ${size[300]!.compact} for 300`);
  assert.ok(size[300]!.detail > 10 * size[10]!.detail / 2, `the detail listing grows with the documents: ${size[10]!.detail} then ${size[300]!.detail}`);
});

test("deleted documents in the range do not break the old board, and a document created and deleted in the range leaves no row", async t => {
  const { store } = await board(t);
  const since = store.snapshot().head;
  await create(store, "eng-1", "flash", doc("短暂"));
  const { rev } = store.snapshot().items.flash!;
  await store.commit({ author, session: "eng-1", message: "delete flash", deletes: [{ kind: "item", id: "flash", expectRev: rev }] });
  await store.commit({ author, session: "eng-2", message: "delete note", deletes: [{ kind: "note", id: "note-1", expectRev: store.snapshot().notes["note-1"]!.rev }] });
  const r = await report(store, since);
  assert.deepEqual(r.created, []);
  assert.equal(r.others.notes, 1);
});

test("the tool answers the compact form by default, the document listing with detail, and takes except", async t => {
  const { store, op } = await board(t);
  const since = store.snapshot().head;
  await create(store, "PM", "pm-made", doc("PM 建的"));
  await create(store, "eng-1", "eng-made", doc("工程师建的"));
  await write(store, "eng-1", "a", d => ({ ...d, head: "More" }));
  const mcp = createMcpServer({ store, ops: ops(store) }), client = new Client({ name: "Patrol", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  const text = async (args: Record<string, unknown>) => ((await client.callTool({ name: "changes", arguments: { since, ...args } })).content as Array<{ text: string }>)[0]!.text;
  const compact = await text({});
  assert.match(compact, /^自 .* 起 3 个提交/);
  assert.match(compact, /新建条目 2 个/);
  assert.match(compact, /eng-made · Whitefoot · 工程师建的 · 建的人：eng-1/);
  assert.doesNotMatch(compact, /item:a\b/, "the other changes are only counted");
  assert.match(compact, /其它改动：条目 1 个/);
  const except = await text({ except: ["PM"] });
  assert.match(except, /去掉 PM 的 1 个/);
  assert.match(except, /新建条目 1 个/);
  assert.doesNotMatch(except, /PM 建的/, "the item PM created is not a new item for the one who reads");
  assert.match(except, /pm-made · Whitefoot · 只差验收：其它行都已完成 · 改的人：PM/, "its flag is still listed, naming PM");
  const detail = await text({ detail: true });
  assert.match(detail, /item:a · /);
  assert.match(detail, /eng-1: write a/, "the commit line names the session");
  assert.doesNotMatch(detail, /item:eng-made/, "a created item is listed once, in its own group");
  assert.equal((await client.callTool({ name: "changes", arguments: { since, except: [""] } })).isError, true, "an empty session name is refused");
});

test("a range that only changes the board's settings still lists the flags it brought, through the tool", async t => {
  const { store } = await board(t);
  const since = store.snapshot().head, current = store.snapshot();
  await store.commit({ author: "Architect", session: "架构师", message: "Approve a tag", board: { ...current.board, tags: [{ name: "测试", meaning: "Applies to tests", projects: ["Whitefoot"] }] } });
  const mcp = createMcpServer({ store, ops: ops(store) }), client = new Client({ name: "Patrol", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await mcp.close(); });
  const text = ((await client.callTool({ name: "changes", arguments: { since } })).content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /^自 .* 起 1 个提交/);
  assert.match(text, /新标记 \d+ 条（缺标签 ×\d+）/);
  assert.match(text, /  a · Whitefoot · 缺标签 · 改的人：范围内没人改它/);
});

test("a range with nothing to show says so, and one with only commits says there is nothing to handle", async t => {
  const { store } = await board(t);
  const since = store.snapshot().head;
  assert.equal(formatReport(await report(store, since)), `自 ${since.slice(0, 12)} 起没有改动。`);
  // A draft note is a change nobody has to handle.
  await store.commit({ author, message: "draft", puts: [{ kind: "note", id: "draft-1", expectRev: null, doc: { target: "it:a", kind: "comment", text: "Not sent", at, state: "draft" } }] });
  const r = await report(store, since);
  assert.deepEqual(r.replies, []);
  assert.equal(r.others.notes, 1, "counted with the other changes");
  assert.match(formatReport(r), /起 1 个提交，没有要处理的行\n其它改动：留言 1 个/);
});

test("a card or note an excluded session wrote counts as new only to those who did not write it; what others did to it is a change", async t => {
  const { store } = await board(t);
  const since = store.snapshot().head, card = (question: string, status: string) => ({ item: "a", question, background: "Evidence", options: [{ key: "A", text: "A" }], status, at, updated: at });
  const note = (text: string, extra: object = {}) => ({ target: "it:a", kind: "comment", text, at, sentAt: at, state: "sent", ...extra });
  const putDoc = (session: string, kind: "decision" | "note", id: string, doc: object) => store.commit({ author, session, message: `write ${id}`, puts: [{ kind, id, expectRev: store.snapshot()[kind === "decision" ? "decisions" : "notes"][id]?.rev ?? null, doc }] });
  await putDoc("PM", "decision", "pm-card", card("PM asks", "open"));
  await putDoc("PM", "decision", "pm-ruled", card("PM asks again", "open"));
  await putDoc("owner", "decision", "pm-ruled", card("PM asks again", "ruled"));
  await putDoc("PM", "note", "pm-note", note("From PM"));
  await putDoc("eng-1", "note", "pm-note", note("From PM", { reply: "Answered", repliedAt: at, repliedBy: "eng-1" }));
  await putDoc("PM", "decision", "pm-edited", card("PM asks a third", "open"));
  await putDoc("eng-1", "decision", "pm-edited", { ...card("PM asks a third", "open"), background: "More evidence" });
  await putDoc("eng-2", "decision", "eng-card", card("Engineer asks", "open"));
  const kept = await report(store, since, {}, { except: ["PM"] });
  assert.deepEqual(kept.replies.map(x => [x.kind, x.id, x.by, x.summary]).sort(), [["card", "eng-card", ["eng-2"], "new card"], ["card", "pm-ruled", ["owner"], "status open→ruled"], ["note", "pm-note", ["eng-1"], "new reply"]]);
  assert.equal(kept.others.cards, 1, "pm-edited: written by PM, changed by someone else, but nothing in it is waited on");
  assert.deepEqual(kept.others.bySession, { "eng-1": 1 });
  const all = await report(store, since);
  assert.deepEqual(all.replies.map(x => x.id).sort(), ["eng-card", "pm-card", "pm-edited", "pm-note", "pm-ruled"]);
});

test("a version of a document from before the range that does not fit today's schema is taken as absent, and the answer says how many", async t => {
  const { dir } = await board(t);
  const base = Math.floor(Date.now() / 1000) + 60, iso = (sec: number) => new Date(sec * 1000).toISOString();
  // old-shape has a field no schema knows, in the version the range starts from; the next commit writes it as today's.
  await appendCommits(dir, [{ at: base, message: "Odd version", session: "seed", files: { "items/old-shape.yaml": { ...doc("旧版本"), rev: 1, retired_field: 1, updated: iso(base) } } }]);
  const odd = (await Store.open(dir).catch(() => undefined));
  assert.equal(odd, undefined, "a board whose head holds that version does not even open");
  await appendCommits(dir, [{ at: base + 60, message: "Fixed", session: "eng-1", files: { "items/old-shape.yaml": { ...doc("旧版本", { head: "Fixed" }), rev: 2, updated: iso(base + 60) } } }]);
  const store = await Store.open(dir), since = (await store.log({ at: store.snapshot().head, limit: 5 })).find(c => c.message === "Odd version")!.commit;
  const r = await report(store, since);
  assert.equal(r.unreadable, 1);
  assert.match(formatReport(r), /1 个旧版本读不出，按没有算/);
  assert.deepEqual(r.created, [], "it was not created in the range; its earlier version is only unreadable");
});

test("a version of the board's settings from before the range that does not fit today's schema is taken as absent too, and counted", async t => {
  const { dir, store: seeded } = await board(t);
  const base = Math.floor(Date.now() / 1000) + 60, settings = seeded.snapshot().board;
  // The settings the range starts from hold a field no schema knows; the range's one commit writes them as today's, with a tag.
  await appendCommits(dir, [
    { at: base, message: "Odd settings", session: "seed", files: { "board.yaml": { ...settings, retired_setting: 1 } } },
    { at: base + 60, message: "Approve a tag", session: "架构师", files: { "board.yaml": { ...settings, tags: [{ name: "测试", meaning: "Applies to tests", projects: ["Whitefoot"] }] } } },
  ]);
  const store = await Store.open(dir), since = (await store.log({ at: store.snapshot().head, limit: 5 })).find(c => c.message === "Odd settings")!.commit;
  const r = await report(store, since);
  assert.equal(r.unreadable, 1, "the unreadable settings are counted like an unreadable document");
  assert.match(formatReport(r), /1 个旧版本读不出，按没有算/);
});
test("the old listing keeps showing the project when a commit has no session", () => {
  const commit = { commit: "a".repeat(40), at: "2026-10-11T00:00:00Z", author: "migration", message: "Import", files: [] };
  const groups = [{ areaId: "x", area: "X", documents: [{ kind: "item" as const, id: "a", title: "a", summary: "new item", commits: [commit, { ...commit, session: "eng-1" }] }] }] as unknown as Parameters<typeof formatChanges>[0];
  const text = formatChanges(groups);
  assert.match(text, /migration: Import/);
  assert.match(text, /eng-1: Import/);
});
