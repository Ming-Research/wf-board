// What stands under an item (src/under.ts): the cards on the items it owns, the open pull requests its open parts name and the sessions at
// work. `context` lists the cards of the owned items; the replies of `set_pause` and of a cancelling `set_status` list all three.
// docs/design.md, section 6, Lean replies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import { createMcpServer } from "../src/mcp.ts";
import { Board, Decision, Item } from "../src/model.ts";
import type { Snapshot } from "../src/model.ts";
import { cardLine, cardLines, cardsUnder, dispatchesUnder, prsUnder, subtreeIds, underText, UNDER_CARDS_MAX } from "../src/under.ts";
import { asArchitect, conf, opt } from "./helpers.ts";

// ---- a board in memory ----

const T = "2026-10-18T00:00:00Z";
const ACCEPT = { id: "accept", text: "验收", state: "todo", accept: true } as const;
const owns = (...ids: string[]) => ids.map(item => ({ id: item, item, own: true, after: [] as string[] }));
const dispatch = (agent: string, role: string, fields: Record<string, unknown> = {}) => ({ agentId: `${agent}-id`, agent, role, level: 2, model: "Sonnet", started: T, ...fields });
const card = (item: string, fields: Record<string, unknown> = {}) => Decision.parse({
  item, question: `question of ${item}`, kind: "design", status: "open", updated: T, rev: 1,
  options: [{ key: "A", text: "a", recommended: true }, { key: "B", text: "b" }, { key: "C", text: "c" }], ...fields,
});
/**
 * p owns c1, which owns g1; `other` is no part of them. p names an open pull request (wf-board#9) and has a card of its own and an engineer;
 * c1 has a ruled card, a withdrawn one and a pull request whose merge row is done (wf-board#12); g1 has a card that blocks and a review session open,
 * and an architect's turn, which is no session at work.
 */
function fixture(): Snapshot {
  const specs: Record<string, Record<string, unknown>> = {
    p: { plan: [...owns("c1"), ACCEPT], head: "**问题**：x\n\n**改动**：Ming-Research/wf-board#9（草稿）\n", dispatches: [dispatch("p", "工程师")] },
    c1: { plan: [...owns("g1"), { id: "merge", text: "合入 Ming-Research/wf-board#12", state: "done", doneAt: T }, ACCEPT], head: "**改动**：Ming-Research/wf-board#12\n" },
    g1: { plan: [ACCEPT], dispatches: [dispatch("g1-review", "审查"), dispatch("turn", "架构师")] },
    other: { plan: [ACCEPT], dispatches: [dispatch("elsewhere", "工程师")] },
  };
  const items: Record<string, Item> = {};
  for (const [id, spec] of Object.entries(specs)) items[id] = Item.parse({ title: `title of ${id}`, group: "Whitefoot", updated: T, rev: 1, difficulty: 2, ...spec });
  const decisions = {
    "q-own": card("p", { question: "the item's own card" }),
    "q-ruled": card("c1", { status: "ruled", choice: "A", ruledAt: "2026-10-18T01:00:00Z" }),
    "q-gone": card("c1", { status: "withdrawn", ruledAt: T }),
    "q-block": card("g1", { blocks: "the part cannot go on" }),
    "q-other": card("other"),
  };
  return { board: Board.parse({ title: "t", projects: [{ name: "Whitefoot", repo: "Ming-Research/wf-board" }] }), items, decisions, notes: {}, glossaries: {}, owner: {}, head: "0".repeat(40) };
}

test("what is under an item is the items it owns at any depth, and nothing of another item", () => {
  const s = fixture(), r = rules(s);
  assert.deepEqual(subtreeIds(s, r, "p"), ["p", "c1", "g1"]);
  assert.deepEqual(subtreeIds(s, r, "g1"), ["g1"]);
});

test("the cards under an item are the open and ruled ones on the items it owns; its own come with `self`, a withdrawn card never", () => {
  const s = fixture(), r = rules(s);
  assert.deepEqual(cardsUnder(s, r, "p", false).map(c => [c.item, c.key, c.status]), [["c1", "q-ruled", "ruled"], ["g1", "q-block", "open"]]);
  assert.deepEqual(cardsUnder(s, r, "p", true).map(c => c.key), ["q-own", "q-ruled", "q-block"]);
  assert.deepEqual(cardsUnder(s, r, "g1", false), [], "a leaf owns nothing");
  const [ruled, blocking] = cardsUnder(s, r, "p", false);
  assert.equal(cardLine(ruled!), "q-ruled · ruled · design · question of c1 · chosen A");
  assert.equal(cardLine(blocking!), "q-block · open · design · question of g1 · blocks: the part cannot go on");
  assert.deepEqual(cardLines([ruled!, blocking!]), ["  c1 · title of c1", `    ${cardLine(ruled!)}`, "  g1 · title of g1", `    ${cardLine(blocking!)}`], "grouped by the item they stand on");
  const many = Array.from({ length: UNDER_CARDS_MAX + 3 }, () => blocking!);
  assert.equal(cardLines(many).at(-1), "  … 3 more cards (context of each item has them)", "a long list is cut and the rest counted");
});

test("the pull requests under an item are those its open parts name in 改动, without those of a merge row that is done", () => {
  const s = fixture(), r = rules(s);
  assert.deepEqual(prsUnder(s, r, "p"), [{ repo: "Ming-Research/wf-board", number: 9, item: "p" }], "wf-board#12 is merged: its merge row is done");
  assert.deepEqual(prsUnder(s, r, "c1"), []);
});

test("the sessions at work under an item are its open engineer and review dispatches and those of the items it owns, not an architect's turn", () => {
  const s = fixture(), r = rules(s);
  assert.deepEqual(dispatchesUnder(s, r, "p").map(d => [d.item, d.agent, d.role]), [["p", "p", "工程师"], ["g1", "g1-review", "审查"]]);
  s.items.p!.dispatches![0]!.finish = { ended: T } as never;
  assert.deepEqual(dispatchesUnder(s, r, "p").map(d => d.agent), ["g1-review"], "an ended dispatch is no session at work");
});

test("the reply text lists open and ruled cards, the pull requests and the sessions, and says none when there is none", () => {
  const s = fixture(), r = rules(s);
  assert.equal(underText(s, r, "p"), [
    "under p (and the 2 items it owns):",
    "open cards: 2",
    "  p · title of p",
    "    q-own · open · design · the item's own card",
    "  g1 · title of g1",
    "    q-block · open · design · question of g1 · blocks: the part cannot go on",
    "ruled cards: 1",
    "  c1 · title of c1",
    "    q-ruled · ruled · design · question of c1 · chosen A",
    "pull requests named in 改动, merge row not done: Ming-Research/wf-board#9 (p)",
    "sessions at work: p (工程师, level 2, on p, since 2026-10-18T00:00:00Z); g1-review (审查, level 2, on g1, since 2026-10-18T00:00:00Z)",
  ].join("\n"));
  assert.equal(underText(s, r, "other"), [
    "under other:", "open cards: 1", "  other · title of other", "    q-other · open · design · question of other", "ruled cards: none",
    "pull requests named in 改动, merge row not done: none", "sessions at work: elsewhere (工程师, level 2, on other, since 2026-10-18T00:00:00Z)",
  ].join("\n"));
});

// ---- through the tools ----

async function served(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-under-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [{ name: "Whitefoot", repo: "Ming-Research/wf-board" }, { name: "Firn" }, { name: "Architect" }] } });
  const op = ops(store);
  const server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "t", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  const item = (key: string, extra: Record<string, unknown> = {}) => op.createItem({ ...asArchitect, key, group: "Whitefoot", title: `title of ${key}`, accept: "通过", difficulty: 2, difficultyReason: "测试用的评级", ...extra } as Parameters<typeof op.createItem>[0]);
  const call = async (name: string, args: Record<string, unknown> = {}) => { const r = await client.callTool({ name, arguments: { ...args } }); assert.equal(r.isError, undefined, text(r)); return text(r); };
  return { store, op, item, call };
}

test("context lists the cards on the items an item owns apart from its own, says none for a part with no card, and says nothing of a leaf", async t => {
  const { op, item, call } = await served(t);
  await item("parent");
  await item("part", { owner: "parent", after: [] });
  await item("alone");
  await op.writeCard({ ...asArchitect, key: "own-q", item: "parent", kind: "design", question: "own question?", options: [opt("A", true), opt("B"), opt("C")], confidence: conf });
  const none = await call("context", { id: "parent" });
  assert.match(none, /\nown-q · OPEN · own question\?/, "the item's own card is where it was");
  assert.match(none, /\ncards on the items it owns: none\n/);
  await op.writeCard({ ...asArchitect, key: "part-q", item: "part", kind: "design", question: "part question?", blocks: "the part waits", options: [opt("A", true), opt("B"), opt("C")], confidence: conf });
  const some = await call("context", { id: "parent" });
  assert.match(some, /\ncards on the items it owns \(1, open and ruled; the item's own are above\):\n  part · title of part\n    part-q · open · design · part question\? · blocks: the part waits\n/);
  assert.ok(some.indexOf("own-q · OPEN") < some.indexOf("cards on the items it owns"), "the item's own cards stand before them");
  const full = await call("context", { id: "parent", full: true });
  assert.match(full, /\ncards on the items it owns \(1, open and ruled/, "the whole answer has them too");
  const leaf = await call("context", { id: "alone" });
  assert.equal(leaf.includes("cards on the items it owns"), false, "a leaf has no such part");
  const part = await call("context", { id: "part" });
  assert.equal(part.includes("cards on the items it owns"), false);
  const card = await call("context", { id: "part-q" });
  assert.equal(card.includes("cards on the items it owns"), false, "a card read on its own is the card");
  const sectioned = await call("context", { id: "parent", section: "all" });
  assert.equal(sectioned.includes("cards on the items it owns"), false, "a section answers with the head alone");
});

test("the reply of a pause lists the cards, the open pull requests and the sessions under the item; a resume lists nothing, and a repeated pause does not repeat it", async t => {
  const { op, item, call } = await served(t);
  await item("parent", { head: "**改动**：Ming-Research/wf-board#7（草稿）\n" });
  await item("part", { owner: "parent", after: [] });
  await op.writeCard({ ...asArchitect, key: "part-q", item: "part", kind: "design", question: "part question?", options: [opt("A", true), opt("B"), opt("C")], confidence: conf });
  await op.dispatchStart({ ...asArchitect, id: "part", role: "工程师", level: 2, model: "Sonnet", agent: "part-eng", agentId: "part-eng-1" });
  const paused = await call("set_pause", { ...asArchitect, id: "parent", paused: true, reason: "owner asked" });
  assert.match(paused, /\nnote: under parent \(and the 1 item it owns\):\nopen cards: 1\n  part · title of part\n    part-q · open · design · part question\?\nruled cards: none\npull requests named in 改动, merge row not done: Ming-Research\/wf-board#7 \(parent\)\nsessions at work: part-eng \(工程师, level 2, on part, since /);
  const again = await call("set_pause", { ...asArchitect, id: "parent", paused: true, reason: "owner asked" });
  assert.equal(again.includes("under parent"), false, "the same pause again changes nothing and says nothing");
  const resumed = await call("set_pause", { ...asArchitect, id: "parent", paused: false });
  assert.equal(resumed.includes("under parent"), false, "a resume sets nothing aside");
});

test("the reply of a cancel lists what stood under the item before it, the cards it withdrew included", async t => {
  const { op, item, call } = await served(t);
  await item("leaf", { head: "**改动**：Ming-Research/wf-board#8\n" });
  await op.writeCard({ ...asArchitect, key: "leaf-q", item: "leaf", kind: "design", question: "leaf question?", options: [opt("A", true), opt("B"), opt("C")], confidence: conf });
  await op.dispatchStart({ ...asArchitect, id: "leaf", role: "工程师", level: 2, model: "Sonnet", agent: "leaf-eng", agentId: "leaf-eng-1" });
  const reopened = await call("set_status", { ...asArchitect, id: "leaf", status: "cancelled", log: "not needed" });
  assert.match(reopened, /\nnote: under leaf:\nopen cards: 1\n  leaf · title of leaf\n    leaf-q · open · design · leaf question\?\nruled cards: none\npull requests named in 改动, merge row not done: Ming-Research\/wf-board#8 \(leaf\)\nsessions at work: leaf-eng /);
  const back = await call("set_status", { ...asArchitect, id: "leaf", status: "open", log: "needed after all" });
  assert.equal(back.includes("under leaf"), false, "reopening sets nothing aside");
});
