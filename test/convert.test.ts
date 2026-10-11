import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Board, Item, Decision, Note } from "../src/model.ts";
import { Store } from "../src/store.ts";
import { convertExport, importExport } from "../src/convert.ts";
import { verifyConverted } from "../scripts/verify-import.ts";

const t0 = "2026-10-11T00:00:00Z";
const t1 = "2026-10-11T01:00:00Z";
const t2 = "2026-10-11T02:00:00Z";
const t3 = "2026-10-11T03:00:00Z";
const t4 = "2026-10-11T04:00:00Z";
const t5 = "2026-10-11T05:00:00Z";
const row = (id: string, data: Record<string, unknown>) => ({ id, data });
function fixture() {
  return {
    exportedAt: t5,
    meta: [{ id: "meta", data: { title: "Synthetic board", eyebrow: "实验", goal: "Preserve every field", freshSince: t0, updated: t4, revision: 12 } }],
    items: [
      row("snow", { title: "Snow area", agent: "Store", group: "Snowghost-wf", short: "Snow", order: 4, status: "wip", priority: "P0", updated: t1, deps: [], qs: ["card"] }),
      row("old", { title: "Changed #3", parent: "snow", area: "other", text: "Now #3, Whitefoot#4, Firn-wf#5, a#6, 9#7, /#8, 中文#9.", data: "data #10", status: "wip", priority: "P1", updated: t1,
        log: [{ at: "2026-10-11T01:00:00+00:00", by: "Old writer", text: "Old #11" }, { at: "2026-10-11T03:00:00.123+00:00", text: "New #12" }],
        ask: "Merge #13", askUrl: "https://example.com/pr/13", askChat: true, links: [{ label: "PR", url: "https://example.com/pr/3" }], order: 3, agent: "Handover" }),
      row("fold", { title: "Area child", area: "snow", head: "Head wins #14", text: "Ignored body", data: "", ask: "", askUrl: "", status: "todo", priority: "P2", updated: t1 }),
      row("empty", { title: "Empty parent falls back to area", parent: "", area: "snow", status: "todo", priority: "P2", updated: t1, head: "#15" }),
      row("done", { title: "Done child", parent: "snow", status: "done", priority: "P2", updated: t1, deps: ["card", "shared", { id: "old", why: "Need history" }] }),
      row("shared", { title: "Cancelled child", parent: "snow", status: "cancelled", priority: "P2", updated: t1 }),
      row("halo", { title: "Halo", group: "Halo-wf", updated: t1, head: "#16" }),
      row("new", { title: "New item", parent: "halo", status: "todo", priority: "P1", updated: t4, head: "#17", log: [{ at: t4, text: "#18" }] }),
      row("firn", { title: "Firn", group: "Firn-wf", updated: t1, status: "todo", priority: "P2", head: "#19" }),
      row("archive", { title: "Archive fallback", status: "done", priority: "P2" }),
      row("readFallback", { title: "Read fallback", status: "todo", priority: "P2" }),
      row("logFallback", { title: "Log fallback", status: "done", priority: "P2", log: [{ at: t2, text: "first" }, { at: t1, text: "older" }] }),
    ],
    decisions: [
      row("card", { item: "snow", question: "Choose?", background: "Why", options: [{ key: "A", text: "First", recommended: true }, { key: "B", text: "Second" }], confidence: "3/5。reason", status: "ruled", ruling: "A chosen", at: t1 }),
      row("shared", { item: "snow", question: "Other?", background: "Other background", options: [{ key: "A", text: "One" }], confidence: "unknown", status: "open" }),
      row("colon", { item: "firn", question: "Colon?", background: "Background", options: [{ key: "C", text: "Third" }], confidence: "4/5：中文理由", status: "withtree", ruling: "Recorded", at: t2 }),
      row("legacyPlace", { question: "Legacy placement?", background: "Placement", options: [{ key: "A", text: "A" }], status: "open", at: t1 }),
    ],
    notes: [
      row("reply", { target: "it:old", kind: "explain", text: "Explain", at: t1, state: "done", sentAt: t1, reply: "New reply", repliedAt: t4, repliedBy: "Store", anchor: { kind: "log", at: "2026-10-11T01:00:00+00:00" } }),
      row("missing", { target: "it:old", title: "Stale title", text: "Comment", at: t1, state: "done", sentAt: t1, reply: "Old reply", anchor: null }),
      row("stale", { target: "it:old", kind: "comment", text: "", at: t1, state: "sent", repliedAt: t4 }),
      row("choice", { target: "q:card", kind: "choice", choice: "B", text: "Earlier", at: t3, state: "done" }),
      row("approve", { target: "q:card", kind: "approve", choice: "A", text: "Latest", at: t4, state: "done", reply: "Recorded", repliedAt: t4, anchor: { kind: "note", id: "choice" } }),
      row("orphan", { target: "it:gone", text: "Unchanged", custom: { nested: true } }),
    ],
    reads: [row("all", { at: t1 }), row("it:old", { at: t2, snap: { title: "Old title", text: "Read #20", data: "", status: "todo" } }), row("it:readFallback", { at: t2 }), row("q:card", { at: t2 }), row("it:gone", { at: t3, snap: { text: "Orphan read" } })],
    archived: [row("archive", { at: t3 })],
  };
}
function fullFixture() {
  const input = fixture();
  input.items[0]!.data.qs = ["card", "legacyPlace"];
  return input;
}

test("conversion applies every cleanup, preserves prose and validates every resulting document", () => {
  const input = fullFixture();
  const original = structuredClone(input);
  const out = convertExport(input);
  assert.deepEqual(input, original);
  assert.deepEqual(out.board, { title: "Synthetic board", eyebrow: "实验", goal: "Preserve every field" });
  assert.equal(out.current.items.old!.parent, "snow");
  assert.equal(out.current.items.fold!.parent, "snow");
  // The old page read up(it) = it.parent || it.area: an empty parent falls back to area.
  assert.equal(out.current.items.empty!.parent, "snow");
  assert.equal(out.current.items.snow!.status, undefined);
  assert.equal(out.current.items.snow!.priority, undefined);
  assert.equal(out.current.items.snow!.agent, "Store");
  assert.equal(out.current.items.snow!.group, "Snowghost-wf");
  assert.equal(out.current.items.snow!.short, "Snow");
  assert.equal(out.current.items.fold!.head, "Head wins #14");
  assert.equal(out.current.items.fold!.data, undefined);
  assert.equal(out.current.items.fold!.ask, undefined);
  assert.equal(out.current.items.old!.head, "Now #3, Whitefoot#4, Firn-wf#5, a#6, 9#7, /#8, 中文#9.");
  assert.equal(out.current.items.old!.data, "data #10");
  assert.deepEqual(out.current.items.old!.ask, { text: "Merge #13", url: "https://example.com/pr/13", chat: true });
  assert.deepEqual(out.current.items.done!.deps, [{ card: "card", why: "（迁移时补：原依赖没有记录理由）" }, { id: "shared", why: "（迁移时补：原依赖没有记录理由）" }, { id: "old", why: "Need history" }]);
  assert.deepEqual(out.current.items.snow!.deps, [{ id: "old", why: "子条目：Changed #3" }, { id: "fold", why: "子条目：Area child" }, { id: "empty", why: "子条目：Empty parent falls back to area" }]);
  assert.equal(out.current.items.old!.updated, "2026-10-11T03:00:00.123Z");
  assert.equal(out.current.items.old!.created, t1);
  assert.equal(out.current.items.old!.log[0]!.by, undefined);
  assert.equal(out.current.items.archive!.updated, t3);
  assert.equal(out.current.items.readFallback!.updated, t2);
  assert.equal(out.current.items.logFallback!.updated, t2);
  assert.equal(out.current.items.logFallback!.created, t1);
  assert.equal(out.current.items.halo!.head, "#16");
  assert.equal(out.current.items.new!.head, "#17");
  assert.equal(out.current.items.firn!.head, "#19");
  assert.equal(out.current.items.empty!.head, "#15");
  assert.equal(out.current.decisions.card!.choice, "A");
  assert.equal(out.current.decisions.card!.ruledAt, t4);
  assert.equal(out.current.decisions.card!.updated, t4);
  assert.deepEqual(out.current.decisions.card!.confidence, { score: 3, reason: "reason" });
  assert.deepEqual(out.current.decisions.colon!.confidence, { score: 4, reason: "中文理由" });
  assert.equal(out.current.decisions.colon!.ruledAt, undefined);
  assert.equal(out.current.decisions.colon!.updated, t2);
  assert.equal(out.current.decisions.shared!.confidence, undefined);
  assert.equal(out.current.decisions.shared!.updated, t5);
  assert.equal(out.current.decisions.legacyPlace!.item, "snow");
  assert.equal(out.current.notes.missing!.kind, "comment");
  assert.equal(out.current.notes.missing!.repliedAt, t1);
  assert.equal(out.current.notes.missing!.anchor, undefined);
  assert.equal(out.current.notes.stale!.repliedAt, undefined);
  assert.equal(out.current.notes.reply!.sentAt, t1);
  assert.deepEqual(out.orphans.notes, [input.notes.at(-1)]);
  assert.deepEqual(out.orphans.reads, [input.reads.at(-1)]);
  assert.deepEqual(out.owner.archived, { archive: t3 });
  for (const state of [out.asRead, out.current]) {
    Board.parse(out.board);
    for (const item of Object.values(state.items)) { Item.parse(item); assert.equal(item.rev, 1); }
    for (const card of Object.values(state.decisions)) { Decision.parse(card); assert.equal(card.rev, 1); }
    for (const note of Object.values(state.notes)) { Note.parse(note); assert.equal(note.rev, 1); }
  }
  for (const action of ["Fold area", "Rename text", "both head and text", "Drop empty", "Remove parent status", "Remove parent priority", "bare dependency", "decision dependency", "unfinished child", "newest log", "archive/read", "oldest log", "Normalize log", "confidence", "qs", "ruledAt", "note kind", "note title", "null note anchor", "reply time", "repliedAt without reply", "orphan notes", "orphan reads", "rev to 1"]) assert.ok(out.report.some(line => line.includes(action)), action);
  assert.ok(out.report.every(line => /: \d+ \(examples: .+\)$/.test(line)));
});

test("asRead reconstructs snapshots and logs, excludes new items and removes unread replies", () => {
  const out = convertExport(fullFixture());
  assert.equal(out.asRead.items.old!.title, "Old title");
  assert.equal(out.asRead.items.old!.head, "Read #20");
  assert.equal(out.asRead.items.old!.data, undefined);
  assert.equal(out.asRead.items.old!.status, "todo");
  assert.equal(out.asRead.items.old!.updated, t2);
  assert.deepEqual(out.asRead.items.old!.log, [{ at: t1, text: "Old #11" }]);
  assert.equal(out.asRead.items.new, undefined);
  assert.deepEqual(out.asRead.items.fold, out.current.items.fold);
  assert.deepEqual(out.asRead.decisions, out.current.decisions);
  assert.equal(out.asRead.notes.reply!.reply, undefined);
  assert.equal(out.asRead.notes.reply!.repliedAt, undefined);
  assert.equal(out.asRead.notes.reply!.repliedBy, undefined);
  assert.equal(out.asRead.notes.reply!.state, "sent");
  assert.equal(out.asRead.notes.approve!.reply, undefined);
  assert.equal(out.asRead.notes.missing!.reply, "Old reply");
});

test("read time uses the latest per-item/all/floor, respects milliseconds, and falls back to exportedAt", () => {
  const input = fullFixture();
  input.meta[0]!.data.freshSince = t4;
  assert.deepEqual(convertExport(input).asRead.items.old, convertExport(input).current.items.old);
  input.meta[0]!.data.freshSince = t0;
  input.reads[0]!.data.at = t4;
  assert.deepEqual(convertExport(input).asRead.items.old, convertExport(input).current.items.old);
  input.reads = [];
  delete (input.meta[0]!.data as Record<string, unknown>).freshSince;
  const out = convertExport(input);
  assert.equal(out.current.items.readFallback!.updated, t5);
  assert.ok(out.report.some(line => line.includes("missing updated from exportedAt")));
  assert.equal(out.asRead.items.old, undefined);
});

test("snap head wins over text; existing read without snapshot preserves fields and filters logs", () => {
  const input = fullFixture();
  const read = input.reads.find(r => r.id === "it:old")!;
  read.data.snap = { title: "Read", head: "Head #1", text: "Text #2", data: "old #3", status: "blocked" };
  let out = convertExport(input);
  assert.equal(out.asRead.items.old!.head, "Head #1");
  assert.equal(out.asRead.items.old!.data, "old #3");
  delete read.data.snap;
  out = convertExport(input);
  assert.equal(out.asRead.items.old!.title, out.current.items.old!.title);
  assert.equal(out.asRead.items.old!.log.length, 1);
});

test("PR references are kept as written: a project's items also cite other repositories' PRs", () => {
  const input = fullFixture();
  const text = "#1 Whitefoot #2 Whitefoot#3 Firn-wf#4 PR #5";
  input.items.find(r => r.id === "firn")!.data.head = text;
  const out = convertExport(input);
  assert.equal(out.current.items.firn!.head, text);
  assert.deepEqual(verifyConverted(input, out), []);
});

test("note replies use target/all read times even when the item freshness floor is later", () => {
  const input = fullFixture();
  input.meta[0]!.data.freshSince = t5;
  const out = convertExport(input);
  assert.deepEqual(out.asRead.items.old, out.current.items.old);
  assert.equal(out.asRead.notes.reply!.reply, undefined);
  assert.equal(out.asRead.notes.approve!.reply, undefined);
});

test("malformed documents, duplicate ids and parent cycles fail rather than dropping data", () => {
  const invalid = fullFixture(); invalid.items[1]!.data.priority = "urgent";
  assert.throws(() => convertExport(invalid));
  const duplicate = fullFixture(); duplicate.items.push(duplicate.items[0]!);
  assert.throws(() => convertExport(duplicate), /Duplicate/);
  const cycle = fullFixture(); cycle.items[0]!.data.parent = "old";
  assert.throws(() => convertExport(cycle), /cycle/);
});

test("orphan note ids remain verbatim even when they are unsuitable as new filenames", () => {
  const input = fullFixture();
  input.notes.at(-1)!.id = "old orphan / id";
  const out = convertExport(input);
  assert.deepEqual(out.orphans.notes, [input.notes.at(-1)]);
  assert.deepEqual(verifyConverted(input, out), []);
});

test("importExport writes two migration commits, keeps the cursor at asRead and round trips through Store", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await Store.open(dir, { init: true, board: { title: "Empty" } });
  const input = fullFixture();
  const expected = convertExport(input);
  const initial = store.snapshot().head;
  const { asReadCommit, currentCommit } = await importExport(store, input);
  assert.notEqual(asReadCommit, currentCommit);
  const log = await store.log({ since: initial });
  assert.equal(log.length, 2);
  assert.deepEqual(log.map(c => c.author), ["migration", "migration"]);
  assert.deepEqual(log.map(c => c.message), ["Import the board's changes since the owner's last read", "Import the board as the owner last read it"]);
  assert.equal(store.snapshot().owner.cursor, asReadCommit);
  assert.deepEqual(store.snapshot().owner.archived, expected.owner.archived);
  assert.deepEqual(await store.show("item", "old", asReadCommit), expected.asRead.items.old);
  assert.deepEqual(await store.show("item", "old", currentCommit), { ...expected.current.items.old, rev: 2 });
  assert.equal(await store.show("item", "new", asReadCommit), null);
  assert.deepEqual(await store.show("item", "new", currentCommit), expected.current.items.new);
  assert.match(await store.diff("item", "old", asReadCommit, currentCommit), /New #12/);
  assert.equal(store.snapshot().notes.reply!.rev, 2);
  assert.equal(store.snapshot().decisions.card!.rev, 1);
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
  assert.ok((await readFile(join(dir, "state/owner.yaml"), "utf8")).includes(asReadCommit));
});

test("independent oracle detects lost fields, logs, deps, cards, notes and orphan data", () => {
  const input = fullFixture();
  const converted = convertExport(input);
  assert.deepEqual(verifyConverted(input, converted), []);
  const cases = [
    (c: typeof converted) => { c.current.items.old!.head = "lost"; },
    (c: typeof converted) => { c.current.items.old!.title = "lost"; },
    (c: typeof converted) => { c.current.items.old!.priority = "P0"; },
    (c: typeof converted) => { c.current.items.old!.log[0]!.at = t2; },
    (c: typeof converted) => { c.current.items.old!.log[0]!.text = "lost"; },
    (c: typeof converted) => { c.current.items.done!.deps = []; },
    (c: typeof converted) => { delete c.current.items.fold; },
    (c: typeof converted) => { c.current.decisions.card!.ruling = "lost"; },
    (c: typeof converted) => { c.current.decisions.card!.options = []; },
    (c: typeof converted) => { c.current.notes.reply!.reply = "lost"; },
    (c: typeof converted) => { delete c.current.notes.reply; },
    (c: typeof converted) => { c.orphans.notes = []; },
    (c: typeof converted) => { c.orphans.reads = []; },
  ];
  for (const corrupt of cases) {
    const broken = structuredClone(converted); corrupt(broken);
    assert.ok(verifyConverted(input, broken).length > 0);
  }
});

test("verify-import CLI accepts only synthetic input here and reports invalid input with nonzero exit", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-oracle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "synthetic.json");
  await writeFile(path, JSON.stringify(fullFixture()));
  const exec = promisify(execFile);
  const result = await exec(process.execPath, ["scripts/verify-import.ts", path]);
  assert.match(result.stdout, /All preservation checks passed/);
  await writeFile(path, "{}");
  await assert.rejects(exec(process.execPath, ["scripts/verify-import.ts", path]));
});
