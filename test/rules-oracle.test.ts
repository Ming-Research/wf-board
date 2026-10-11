import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { Item, Decision, Note } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { rules } from "../src/rules.ts";
import { legacyRules } from "./legacy/board-rules.js";
import type { LegacyState } from "./legacy/board-rules.js";
import { compare } from "./legacy/compare.ts";
import { compareExport } from "../scripts/compare-legacy.ts";
import type { LegacyExport } from "../scripts/compare-legacy.ts";

const T0 = "2026-10-10T00:00:00Z", T1 = "2026-10-11T00:00:00Z", T2 = "2026-10-12T00:00:00Z";
const dep = (id: string, why = "needs it") => ({ id, why });
function oldBoard(): LegacyState {
  const old: LegacyState = {
    items: [
      { id: "area", title: "Area", agent: "session", group: "Project", order: 1, deps: [dep("mid"), dep("bare"), dep("cancelled"), dep("missingdep"), dep("blocked"), dep("wip"), dep("unblock"), dep("stuck")] },
      { id: "mid", parent: "area", deps: [dep("deep")], status: "done", priority: "P0" },
      { id: "deep", parent: "mid", deps: [dep("leaf")] },
      { id: "leaf", parent: "deep", priority: "P2" },
      { id: "external", agent: "other", priority: "P0", deps: [dep("mid")] },
      { id: "bare", area: "area", priority: "P1", deps: ["leaf"] },
      { id: "cancelled", area: "area", status: "cancelled", priority: "P0" },
      { id: "missingdep", area: "area", priority: "P2", deps: [dep("absent"), dep("cancelled", "")] },
      { id: "blocked", area: "area", priority: "P2", status: "blocked", deps: [dep("leaf")] },
      { id: "wip", area: "area", priority: "P1", status: "wip", deps: [dep("leaf")] },
      { id: "unblock", area: "area", priority: "P2", status: "blocked", deps: [dep("done")] },
      { id: "stuck", area: "area", priority: "P2", status: "blocked" },
      { id: "done", parent: "area", status: "done", priority: "P1", deps: ["leaf"] },
      { id: "unlisted", parent: "area", priority: "P2" },
      { id: "noagent", priority: "P2" },
      { id: "orphan", parent: "absent", priority: "P2" },
      { id: "cycle-a", parent: "area", priority: "P2", deps: [dep("cycle-b")] },
      { id: "cycle-b", parent: "area", priority: "P1", deps: [dep("cycle-a")] },
      { id: "self", parent: "area", priority: "P2", deps: [dep("self")] },
      { id: "mixed-parent", parent: "area", deps: [dep("mixed-child")] },
      { id: "mixed-child", parent: "mixed-parent", priority: "P2", deps: [dep("mixed-parent")] },
      { id: "parent-cycle-a", parent: "parent-cycle-b" }, { id: "parent-cycle-b", parent: "parent-cycle-a" },
      { id: "archive", parent: "area", priority: "P0", deps: [dep("leaf")] },
      { id: "archive-child", parent: "archive", priority: "P0", deps: [dep("leaf")] },
      { id: "unarchive-log", parent: "area", priority: "P2", log: [{ at: T2, text: "new" }, { at: T0, text: "old" }] },
      { id: "unarchive-reply", parent: "area", priority: "P2" },
      { id: "archive-no-reply", parent: "area", priority: "P2" },
      { id: "ask", parent: "area", priority: "P2", ask: "merge" },
      { id: "ask-approved", parent: "area", priority: "P2", ask: "merge" },
      { id: "ask-done", parent: "area", priority: "P2", ask: "merge", askUrl: "https://example.com/pr" },
      { id: "ask-draft", parent: "area", priority: "P2", ask: "merge" },
      { id: "card-open", parent: "area", priority: "P1", qs: ["open", "ruled"] },
      { id: "card-choice", parent: "area", priority: "P1", qs: ["choice"] },
      { id: "card-draft", parent: "area", priority: "P1", qs: ["draft"] },
      { id: "ruled-only", parent: "area", priority: "P1", qs: ["withtree", "elsewhere"] },
    ],
    decisions: [
      { id: "open", item: "card-open", status: "open" }, { id: "ruled", item: "card-open", status: "ruled" },
      { id: "choice", status: "open" }, { id: "draft", status: "open" },
      { id: "withtree", status: "withtree" }, { id: "elsewhere", status: "elsewhere" },
    ],
    notes: [
      { id: "approval", target: "it:ask-approved", kind: "approve", text: "同意：merge", state: "sent", at: T0 },
      { id: "done", target: "it:ask-done", kind: "done", text: "已完成：merge", state: "done", at: T0 },
      { id: "draft", target: "it:ask-draft", kind: "approve", text: "同意：merge", state: "draft", at: T0 },
      { id: "choice", target: "q:choice", kind: "choice", text: "A", choice: "A", state: "sent", at: T0 },
      { id: "choice-draft", target: "q:draft", kind: "choice", text: "A", choice: "A", state: "draft", at: T0 },
      { id: "reply", target: "it:unarchive-reply", kind: "comment", text: "why", state: "done", at: T0, reply: "answer", repliedAt: T2 },
      { id: "no-reply", target: "it:archive-no-reply", kind: "comment", text: "why", state: "sent", at: T2 },
    ],
    archived: Object.fromEntries(["archive", "unarchive-log", "unarchive-reply", "archive-no-reply"].map(id => [id, { at: T1 }])),
  };
  // Additional independent leaves cover all statuses/priorities and sibling ties.
  for (let i = 0; i < 15; i++) {
    const id = "extra-" + i;
    old.items.push({ id, parent: "area", status: (["todo", "wip", "blocked", "done", "cancelled"] as const)[i % 5], priority: (["P0", "P1", "P2"] as const)[i % 3], order: i % 3 });
    old.items[0]!.deps!.push(dep(id));
  }
  for (const it of old.items) { it.title ||= it.id; it.updated ||= T0; }
  return old;
}

// Intentionally no card deps: those did not exist on the page and have unit
// coverage in rules.test.ts. Freshness/read snapshots are outside this module.
// This mapping is written here, independently of the CLI's export mapper.
function mapBoard(old: LegacyState): Pick<Snapshot, "items" | "decisions" | "notes" | "owner"> {
  return {
    items: Object.fromEntries(old.items.map(it => [it.id, Item.parse({
      title: it.title, parent: it.parent || it.area || undefined, agent: it.agent,
      group: it.group, order: it.order, status: it.status, priority: it.priority,
      head: it.head || it.text, ask: it.ask ? { text: it.ask, url: it.askUrl, chat: it.askChat } : undefined,
      log: it.log || [], deps: (it.deps || []).map(e => typeof e === "string" ? { id: e, why: "" } : { id: e.id, why: e.why || "" }),
      updated: it.updated, rev: 1,
    })])),
    decisions: Object.fromEntries(old.decisions.map(d => [d.id, Decision.parse({
      item: d.item || old.items.find(it => it.qs?.includes(d.id))?.id,
      status: d.status, question: d.id, background: "why", options: [{ key: "A", text: "option" }], updated: T0, rev: 1,
    })])),
    notes: Object.fromEntries(old.notes.map(n => { const { id, ...data } = n; return [id, Note.parse({ ...data, rev: 1 })]; })),
    owner: { archived: Object.fromEntries(Object.entries(old.archived).map(([id, a]) => [id, a.at])) },
  };
}
function exportBoard(old: LegacyState): LegacyExport {
  const rows = <T extends { id: string }>(list: T[]) => list.map(({ id, ...data }) => ({ id, data }));
  return { exportedAt: T1, meta: {}, items: rows(old.items), decisions: rows(old.decisions), notes: rows(old.notes), reads: [], archived: Object.entries(old.archived).map(([id, data]) => ({ id, data })) };
}

test("synthetic legacy oracle agrees on eight item rules and area ordering (four levels, all statuses/priorities)", () => {
  const old = oldBoard(), mapped = mapBoard(old);
  assert.ok(old.items.length >= 40);
  assert.deepEqual(compare(old, mapped), []);
  // Ensure equality exercised meaningful non-default outcomes, not empty flags.
  const legacy = legacyRules(old);
  assert.deepEqual(new Set(old.items.map(it => legacy.statusOf(it))), new Set(["todo", "wip", "blocked", "done", "cancelled"]));
  assert.deepEqual(new Set(old.items.map(it => legacy.priorityOf(it))), new Set(["P0", "P1", "P2", ""]));
  assert.equal(legacy.ancestors(old.items.find(it => it.id === "leaf")!).length, 3);
  assert.equal(legacy.raisedBy(old.items.find(it => it.id === "leaf")!)?.id, "external");
  const texts = new Set(old.items.flatMap(it => legacy.checksOf(it).map(c => c.text)));
  for (const text of ["依赖的条目不存在：absent", "依赖的条目已取消", "依赖没写为什么：", "依赖成环", "顶层条目没有负责会话（agent）", "上级条目不存在：absent", "上级没有把它列在依赖里（上级必须是直接依赖它的条目）：", "可解除阻塞：等的都已完成", "卡住了，但没写在等什么", "标为进行中，但还在等别的"]) assert.ok(texts.has(text), text);
  const current = rules(mapped);
  for (const a of old.items) for (const b of old.items) assert.equal(Math.sign(current.compareSiblings(a.id, b.id)), Math.sign(legacy.byPriority(a, b)), `${a.id}/${b.id}`);
});

test("export comparison is independent of the oracle test mapper and reports changed results", () => {
  const data = exportBoard(oldBoard());
  const equal = compareExport(data);
  assert.deepEqual(equal.disagreements, []);
  assert.equal(equal.comparisons, data.items.length * 8 + 1);
  const old = oldBoard(), mapped = mapBoard(old);
  const wrong = { ...mapped, items: { ...mapped.items, leaf: { ...mapped.items.leaf!, priority: "P0" as const } } };
  assert.ok(compare(old, wrong).some(d => d.id === "leaf" && d.rule === "priorityOf" && d.old === "P2" && d.new === "P0"));
});

test("comparison CLI prints all disagreements and exits nonzero, using synthetic exports only", async () => {
  // The CLI fixture is temporary and never writes into the checkout.
  const dir = await mkdtemp(join(tmpdir(), "wf-board-oracle-"));
  try {
    const filename = join(dir, "export.json"), old = oldBoard();
    await writeFile(filename, JSON.stringify(exportBoard(old)));
    const ok = spawnSync(process.execPath, ["scripts/compare-legacy.ts", filename], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /51 items, 409 comparisons, 0 disagreements/);
    // This intentionally inconsistent qs is a real difference between models:
    // new needsOwner uses decision.item, while the page used each item's qs.
    old.items.find(it => it.id === "card-open")!.qs = [];
    old.items.find(it => it.id === "done")!.qs = ["open"];
    await writeFile(filename, JSON.stringify(exportBoard(old)));
    const bad = spawnSync(process.execPath, ["scripts/compare-legacy.ts", filename], { encoding: "utf8" });
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stdout, /card-open needsOwner: old=false new=true/);
    assert.match(bad.stdout, /done needsOwner: old=true new=false/);
    assert.match(bad.stdout, /2 disagreements/);
    const missing = spawnSync(process.execPath, ["scripts/compare-legacy.ts"], { encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Usage:/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("R8 areas follow the first area in order, independently of insertion order", () => {
  const old: LegacyState = { items: [
    { id: "a", title: "A", agent: "session", group: "A", order: 9, updated: T0 },
    { id: "z", title: "Z", agent: "session", group: "Z", order: -4, updated: T0 },
    { id: "a2", title: "A2", agent: "session", group: "A", order: 1, updated: T0 },
  ], decisions: [], notes: [], archived: {} };
  assert.deepEqual(legacyRules(old).tops().map(i => i.id), ["z", "a2", "a"]);
  assert.deepEqual(compare(old, mapBoard(old)), []);
  assert.deepEqual(rules(mapBoard(old)).areas(), ["z", "a2", "a"]);
});

test("R9 shared owner-action predicates distinguish asks from cards and draft from sent answers", () => {
  const s = mapBoard(oldBoard()), r = rules(s);
  assert.equal(r.askPending("ask"), true);
  assert.equal(r.askPending("ask-approved"), false);
  assert.equal(r.askPending("ask-done"), false);
  assert.equal(r.askPending("ask-draft"), true);
  assert.equal(r.askPending("card-open"), false);
  assert.equal(r.cardWaiting("open"), true);
  assert.equal(r.cardWaiting("choice"), false);
  assert.equal(r.cardWaiting("draft"), true);
  assert.equal(r.cardWaiting("ruled"), false);
  assert.equal(r.cardWaiting("absent"), false);
  for (const id of Object.keys(s.items)) assert.equal(r.needsOwner(id), r.askPending(id) || r.cardsOf(id).some(r.cardWaiting));
});


test("R8 hidden archived areas do not determine visible project group order", () => {
  const old: LegacyState = { items: [
    { id: "archived", title: "Archived A", agent: "session", group: "A", order: -9, updated: T0 },
    { id: "z", title: "Z", agent: "session", group: "Z", order: -4, updated: T0 },
    { id: "a", title: "A", agent: "session", group: "A", order: 1, updated: T0 },
  ], decisions: [], notes: [], archived: { archived: { at: T1 } } };
  assert.deepEqual(compare(old, mapBoard(old)), []);
});
