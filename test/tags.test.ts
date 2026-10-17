import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OpError } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import { describeChanges } from "../src/query.ts";
import { createMcpServer } from "../src/mcp.ts";
import { ARCHITECT_WRITER } from "../src/model.ts";
import { board, author, architect, asArchitect, asPM, rx } from "./helpers.ts";

const vocabulary = { 健全性: "改动影响程序是否被正确拒绝或接受", 报错信息: "改动影响诊断的措辞或位置" };

/** The two standard tags, applicable to every project. */
async function withTags(t: Parameters<typeof board>[0]) {
  const b = await board(t);
  for (const [name, meaning] of Object.entries(vocabulary)) await b.op.setTag({ ...asArchitect, name, meaning });
  return b;
}
const refuses = (call: Promise<unknown>, message: RegExp) => assert.rejects(call, e => { assert.ok(e instanceof OpError, String(e)); assert.match(e.message, message); return true; });

test("the PM may not change the tag vocabulary: only the session 架构师 may", async t => {
  const { store, op } = await withTags(t);
  const before = store.snapshot(), count = (await store.log()).length;
  await refuses(op.setTag({ ...asPM, name: "新标签", meaning: "新" }), rx`only ${ARCHITECT_WRITER} may change the tag vocabulary`);
  await refuses(op.renameTag({ ...asPM, name: "健全性", to: "安全" }), rx`only ${ARCHITECT_WRITER} may change the tag vocabulary`);
  await refuses(op.removeTag({ ...asPM, name: "报错信息" }), rx`only ${ARCHITECT_WRITER} may change the tag vocabulary`);
  assert.deepEqual(store.snapshot(), before);
  assert.equal((await store.log()).length, count, "a refusal makes no commit");
});

test("vocabulary writes are refused for every author but Architect and change nothing", async t => {
  const { store, op } = await withTags(t);
  const before = store.snapshot(), count = (await store.log()).length;
  for (const who of [author, "Firn"]) {
    await refuses(op.setTag({ author: who, name: "新标签", meaning: "新" }), /only Architect.*decision card/);
    await refuses(op.renameTag({ author: who, name: "健全性", to: "安全" }), /only Architect/);
    await refuses(op.removeTag({ author: who, name: "报错信息" }), /only Architect/);
  }
  assert.deepEqual(store.snapshot(), before);
  assert.equal((await store.log()).length, count, "a refusal makes no commit");
  // Architect may.
  await op.setTag({ ...asArchitect, name: "新标签", meaning: "新" });
  assert.equal(store.snapshot().board.tags!.length, 3);
});

test("a tag name is 1–12 characters without whitespace or commas, and names are unique", async t => {
  const { store, op } = await withTags(t);
  for (const name of ["", "有 空格", "a,b", "a，b", "a、b", "一二三四五六七八九十一二三"]) await assert.rejects(op.setTag({ ...asArchitect, name, meaning: "x" }), OpError, name);
  await op.setTag({ ...asArchitect, name: "健全性", meaning: "改了说明" });
  assert.deepEqual(store.snapshot().board.tags!.map(t => t.name), ["健全性", "报错信息"], "an upsert of an existing name replaces it in place");
  assert.equal(store.snapshot().board.tags![0]!.meaning, "改了说明");
  await refuses(op.setTag({ ...asArchitect, name: "只给Firn", meaning: "x", projects: ["不存在"] }), /project 不存在/);
});

test("renaming a tag updates every carrying item and the vocabulary in one commit", async t => {
  const { store, op } = await withTags(t);
  await op.setTags({ author, id: "a", tags: ["健全性", "报错信息"] });
  await op.setTags({ author, id: "b", tags: ["健全性"] });
  await op.setTags({ author: "Firn", id: "other", tags: ["报错信息"] });
  const count = (await store.log()).length;
  await refuses(op.renameTag({ ...asArchitect, name: "健全性", to: "报错信息" }), /already a tag/);
  await refuses(op.renameTag({ ...asArchitect, name: "没有", to: "新名" }), /not in the tag vocabulary/);
  assert.equal((await store.log()).length, count);
  const res = await op.renameTag({ ...asArchitect, name: "健全性", to: "安全" });
  assert.equal((await store.log()).length, count + 1, "one commit");
  const s = store.snapshot();
  assert.deepEqual(s.items.a!.tags, ["安全", "报错信息"]);
  assert.deepEqual(s.items.b!.tags, ["安全"]);
  assert.deepEqual(s.items.other!.tags, ["报错信息"], "an item without the tag is untouched");
  assert.deepEqual(s.board.tags!.map(t => t.name), ["安全", "报错信息"]);
  assert.match(s.items.a!.log.at(-1)!.text, /健全性 → 安全/);
  const changed = (await store.log()).find(c => c.commit === res.commit)!.files;
  assert.deepEqual([...changed].sort(), ["board.yaml", "items/a.yaml", "items/b.yaml"]);
});

test("removing a tag is refused while an item carries it, and replace retags every carrier in one commit", async t => {
  const { store, op } = await withTags(t);
  await op.setTag({ ...asArchitect, name: "仅Firn", meaning: "Firn 专用", projects: ["Firn"] });
  await op.setTags({ author, id: "a", tags: ["健全性", "报错信息"] });
  await op.setTags({ author, id: "b", tags: ["健全性"] });
  const before = store.snapshot(), count = (await store.log()).length;
  await refuses(op.removeTag({ ...asArchitect, name: "健全性" }), /2 items still carry it.*a.*b.*replace/);
  await refuses(op.removeTag({ ...asArchitect, name: "健全性", replace: "健全性" }), /replace/);
  await refuses(op.removeTag({ ...asArchitect, name: "健全性", replace: "仅Firn" }), /does not apply.*a, b/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal((await store.log()).length, count);
  await op.removeTag({ ...asArchitect, name: "健全性", replace: "报错信息" });
  assert.equal((await store.log()).length, count + 1, "one commit");
  const s = store.snapshot();
  assert.deepEqual(s.items.a!.tags, ["报错信息"], "an item already holding the replacement does not get it twice");
  assert.deepEqual(s.items.b!.tags, ["报错信息"]);
  assert.deepEqual(s.board.tags!.map(t => t.name), ["报错信息", "仅Firn"]);
  await op.removeTag({ ...asArchitect, name: "仅Firn" });
  assert.deepEqual(store.snapshot().board.tags!.map(t => t.name), ["报错信息"], "an unused tag is removed without replace");
});

test("narrowing a tag's projects is refused while another project's item carries it", async t => {
  const { store, op } = await withTags(t);
  await op.setTags({ author: "Firn", id: "other", tags: ["健全性"] });
  await refuses(op.setTag({ ...asArchitect, name: "健全性", meaning: "x", projects: [author] }), /outside the list still carry.*other/);
  await op.setTag({ ...asArchitect, name: "报错信息", meaning: "x", projects: [author] });
  assert.deepEqual(store.snapshot().board.tags![1]!.projects, [author]);
  await op.setTag({ ...asArchitect, name: "报错信息", meaning: "y", projects: null });
  assert.equal(store.snapshot().board.tags![1]!.projects, undefined, "null makes the tag apply to every project");
});

test("item tags outside the vocabulary or not applicable to the project are refused, naming the allowed tags", async t => {
  const { store, op } = await withTags(t);
  await op.setTag({ ...asArchitect, name: "仅Firn", meaning: "Firn 专用", projects: ["Firn"] });
  const before = store.snapshot();
  await refuses(op.setTags({ author, id: "a", tags: ["没有这个"] }), /没有这个.*not in the tag vocabulary.*allowed for Whitefoot: 健全性, 报错信息/);
  await refuses(op.setTags({ author, id: "a", tags: ["仅Firn"] }), /仅Firn.*applies only to Firn, not Whitefoot.*allowed for Whitefoot: 健全性, 报错信息/);
  await refuses(op.setTags({ author, id: "a", tags: ["健全性", "健全性"] }), /once/);
  await refuses(op.setTags({ author, id: "a", tags: [] }), /at least one.*健全性/);
  await refuses(op.setTags({ author: "Firn", id: "a", tags: ["健全性"] }), /belongs to project Whitefoot/);
  assert.deepEqual(store.snapshot(), before);
  await op.setTags({ author: "Firn", id: "other", tags: ["仅Firn"] });
  assert.deepEqual(store.snapshot().items.other!.tags, ["仅Firn"]);
  const count = (await store.log()).length;
  await op.setTags({ author: "Firn", id: "other", tags: ["仅Firn"] });
  assert.equal((await store.log()).length, count, "an identical list is a no-op");
});

test("creating an item (in any project) needs a valid tag once the vocabulary has one for the project, and accepts none before", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  const create = { ...asArchitect, key: "n1", owner: "area", title: "New", accept: "Passes" };
  const firnItem = { ...asArchitect, group: "Firn", key: "r1", title: "Req", head: "h", accept: "Passes", priority: "P1" as const };
  // Before any tag exists: none is required, and naming one is refused.
  await op.createItem(create);
  assert.equal(store.snapshot().items.n1!.tags, undefined);
  await refuses(op.createItem({ ...create, key: "n2", tags: ["健全性"] }), /not in the tag vocabulary.*no tag is approved for Whitefoot yet/);
  await op.createItem(firnItem);
  // Once one exists, a missing or invalid tag is refused and a valid one stored.
  await op.setTag({ ...asArchitect, name: "健全性", meaning: "m" });
  await op.setTag({ ...asArchitect, name: "仅Firn", meaning: "m", projects: ["Firn"] });
  const before = store.snapshot();
  await refuses(op.createItem({ ...create, key: "n3" }), /tags: give at least one.*健全性/);
  await refuses(op.createItem({ ...create, key: "n3", tags: ["仅Firn"] }), /applies only to Firn/);
  await refuses(op.createItem({ ...firnItem, key: "r2" }), /tags: give at least one.*allowed for Firn: 健全性, 仅Firn/);
  await refuses(op.createItem({ ...firnItem, key: "r2", tags: ["没有"] }), /not in the tag vocabulary/);
  assert.deepEqual(store.snapshot(), before);
  await op.createItem({ ...create, key: "n3", tags: ["健全性"] });
  await op.createItem({ ...firnItem, key: "r2", tags: ["仅Firn"] });
  assert.deepEqual(store.snapshot().items.n3!.tags, ["健全性"]);
  assert.deepEqual(store.snapshot().items.r2!.tags, ["仅Firn"]);
  // A record is an item too.
  await refuses(op.createItem({ ...asArchitect, key: "rec", group: author, record: true, title: "Rec" }), /tags: give at least one/);
});

test("an untagged item shows the 缺标签 check once a tag applies to its project, which clears when it is tagged", async t => {
  const { store, op } = await board(t);
  const missing = () => rules(store.snapshot()).checks("a").filter(c => c.label === "缺标签");
  assert.equal(missing().length, 0, "with no vocabulary nothing could clear the check, so it is not raised");
  await op.setTag({ ...asArchitect, name: "仅Firn", meaning: "m", projects: ["Firn"] });
  assert.equal(missing().length, 0, "nor when no tag applies to the item's project");
  await op.setTag({ ...asArchitect, name: "健全性", meaning: "m" });
  assert.equal(missing().length, 1);
  assert.match(missing()[0]!.text, /set_tags/);
  await op.setTags({ author, id: "a", tags: ["健全性"] });
  assert.equal(missing().length, 0);
  assert.equal(rules(store.snapshot()).checks("b").filter(c => c.label === "缺标签").length, 1, "other untagged items keep it");
});

test("a tag change is a real change in describeChanges", () => {
  assert.equal(describeChanges({ tags: ["甲"], num: 1 }, { tags: ["甲", "乙"], num: 2 }, "item"), "tags 甲→甲 乙");
  assert.equal(describeChanges({ num: 1 }, { num: 2 }, "item"), "metadata changed", "numbers still are not");
});

test("MCP shows tags in rows, context, list and brief, lists the vocabulary, and enforces the tag tools", async t => {
  const { store, op } = await withTags(t);
  const server = createMcpServer({ store, ops: op, now: () => "2026-10-12T00:00:00Z" });
  const client = new Client({ name: "Tags test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }); return { error: r.isError === true, text: (r.content as Array<{ text: string }>).map(c => c.text).join("\n") }; };
  const set = await call("set_tags", { author, id: "a", tags: ["健全性", "报错信息"] });
  assert.equal(set.error, false); assert.match(set.text, /\[健全性 报错信息\]/, "a write answers with the row, tags included");
  assert.match((await call("context", { id: "a" })).text.split("\n")[0]!, / · \[健全性 报错信息\]/);
  assert.match((await call("list", { filters: { group: author } })).text, /中文检查 · \[健全性 报错信息\]/);
  const brief = JSON.parse((await call("brief", { project: author })).text);
  assert.deepEqual(brief.tags.map((x: { name: string }) => x.name), ["健全性", "报错信息"], "brief lists the vocabulary");
  assert.deepEqual(JSON.stringify(brief).includes('"tags":["健全性","报错信息"]'), true, "brief rows carry item tags");
  const vocab = await call("tags", {});
  assert.match(vocab.text, /健全性: 改动影响程序是否被正确拒绝或接受/); assert.match(vocab.text, /报错信息: 改动影响诊断的措辞或位置/);
  assert.equal((await call("set_tags", { author, id: "a", tags: ["没有"] })).error, true);
  const refused = await call("set_tag", { author, name: "新", meaning: "m" });
  assert.equal(refused.error, true); assert.match(refused.text, /only Architect/);
  assert.equal((await call("rename_tag", { ...asArchitect, name: "健全性", to: "安全" })).error, false);
  assert.equal((await call("remove_tag", { ...asArchitect, name: "安全" })).error, true, "in use");
  assert.equal((await call("remove_tag", { ...asArchitect, name: "安全", replace: "报错信息" })).error, false);
  assert.deepEqual(store.snapshot().items.a!.tags, ["报错信息"]);
});

test("set_tags_many sets many items' tags in one commit with set_tags' checks, all or nothing", async t => {
  const { store, op } = await withTags(t);
  await op.setTags({ author, id: "b", tags: ["健全性"] });
  const count = (await store.log()).length, before = store.snapshot();
  // One refused entry refuses the whole write, naming the entry.
  await refuses(op.setTagsMany({ author, items: [{ id: "a", tags: ["健全性"] }, { id: "area", tags: ["没有这个"] }] }), /items\.1 \(area\): tags 没有这个: not in the tag vocabulary/);
  await refuses(op.setTagsMany({ author, items: [{ id: "a", tags: ["健全性"] }, { id: "other", tags: ["健全性"] }] }), /items\.1 \(other\): item other belongs to project Firn/);
  await refuses(op.setTagsMany({ author, items: [{ id: "a", tags: ["健全性"] }, { id: "a", tags: ["报错信息"] }] }), /items\.1\.id a: name each item once/);
  await refuses(op.setTagsMany({ author, items: [{ id: "a", tags: [] }] }), /items\.0 \(a\): tags: give the item's whole tag list/);
  await refuses(op.setTagsMany({ author, items: [] }), /at least one/);
  assert.deepEqual(store.snapshot(), before); assert.equal((await store.log()).length, count, "a refusal makes no commit");
  const res = await op.setTagsMany({ author, items: [{ id: "a", tags: ["健全性", "报错信息"] }, { id: "area", tags: ["报错信息"] }, { id: "b", tags: ["健全性"] }] });
  assert.equal((await store.log()).length, count + 1, "one commit for every item");
  assert.equal(res.rev, undefined);
  const [commit] = await store.log({ limit: 1 });
  assert.deepEqual(commit!.files.sort(), ["items/a.yaml", "items/area.yaml"], "an unchanged list (b) writes nothing");
  assert.deepEqual(store.snapshot().items.a!.tags, ["健全性", "报错信息"]);
  assert.deepEqual(store.snapshot().items.area!.tags, ["报错信息"]);
  await op.setTagsMany({ author, items: [{ id: "a", tags: ["健全性", "报错信息"] }] });
  assert.equal((await store.log()).length, count + 1, "all unchanged writes no commit");
});

test("the set_tags_many tool reports one commit", async t => {
  const { store, op } = await withTags(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Tags", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "set_tags_many", arguments: { author, items: [{ id: "a", tags: ["健全性"] }, { id: "b", tags: ["报错信息"] }] } });
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.match((result.content as Array<{ text: string }>)[0]!.text, /^set_tags 2 items · commit [0-9a-f]{40}$/);
  assert.deepEqual([store.snapshot().items.a!.tags, store.snapshot().items.b!.tags], [["健全性"], ["报错信息"]]);
});
