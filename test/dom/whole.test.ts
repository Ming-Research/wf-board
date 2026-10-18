// The whole view on the page in a DOM library: the block above the agent list counts the same open work as the architect's
// whole_view tool, shows a runner report as soon as the board has it, folds, and opens a kind to more rows. The layout of the block
// (where it lies, how it wraps) is not a question for this layer. docs/design.md, section 7, The whole view.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ops } from "../../src/ops.ts";
import { rules } from "../../src/rules.ts";
import { createMcpServer } from "../../src/mcp.ts";
import { wholeView, BUCKETS, BUCKET_TEXT, BUCKET_ROWS, EXPANDED_ROWS } from "../../src/whole-view.ts";
import type { Bucket } from "../../src/whole-view.ts";
import { startBoard } from "../e2e/board-server.ts";
import type { BoardServer, Hooks } from "../e2e/board-server.ts";
import { DomPage } from "./page.ts";
import { asPM } from "../helpers.ts";

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The counts the tool's answer gives in its first line: the remaining work and the number in each kind. */
async function counts(board: BoardServer, t: Hooks) {
  const server = createMcpServer({ store: board.store, ops: ops(board.store) });
  const client = new Client({ name: "t", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => { await client.close(); await server.close(); });
  return async () => {
    const answer = await client.callTool({ name: "whole_view", arguments: {} });
    const head = (answer.content as Array<{ text: string }>).map(c => c.text).join("\n").split("\n")[0]!;
    const remaining = Number(/没做完的工作 (\d+) 件/.exec(head)?.[1]);
    const kind = Object.fromEntries(BUCKETS.map(b => [b, Number(new RegExp(`${BUCKET_TEXT[b]} (\\d+)`).exec(head.split("：")[1] ?? "")?.[1])])) as Record<Bucket, number>;
    return { remaining, kind };
  };
}
/** What the block says: the remaining work from its toggle and the number on each kind's heading. */
function blockCounts(bp: DomPage) {
  const toggle = bp.$("#whole .whole-toggle")?.textContent ?? "";
  const remaining = Number(/没做完 (\d+) 件/.exec(toggle)?.[1]);
  const kind = Object.fromEntries(BUCKETS.map(b => [b, Number(new RegExp(`^${BUCKET_TEXT[b]} (\\d+)`).exec(bp.$(`#whole .whole-kind.${b}`)?.textContent ?? "")?.[1] ?? 0)])) as Record<Bucket, number>;
  return { remaining, kind };
}
/** The rows the block lists under one kind. */
function kindRows(bp: DomPage, bucket: Bucket): string[] {
  const list = bp.$(`#whole .whole-kind.${bucket}`)?.nextElementSibling;
  return list ? bp.$$("li.whole-row", list as HTMLElement).map(row => row.dataset.item!) : [];
}
const same = (a: { remaining: number; kind: Record<Bucket, number> }) => ({ remaining: a.remaining, kind: Object.fromEntries(BUCKETS.map(b => [b, a.kind[b] ?? 0])) });

test("the block counts what the tool counts, and a kind lists the rows the tool's default answer lists", async t => {
  const board = await startBoard(t), bp = await DomPage.open(t, board, { storage: { "board-whole": "open" } }), read = await counts(board, t);
  assert.equal(bp.visible(bp.$("#whole")), true, "the board has open work, so the block is drawn");
  const expected = await read();
  assert.ok(expected.remaining > 0 && expected.kind.unattended > BUCKET_ROWS.unattended, "the generated board gives the cap something to cut");
  assert.deepEqual(same(blockCounts(bp)), same(expected), "the same remaining work and the same kinds");
  for (const b of BUCKETS) {
    if (!expected.kind[b]) continue;
    const rows = kindRows(bp, b);
    assert.ok(rows.length >= 1 && rows.length <= BUCKET_ROWS[b], `${b}: at most ${BUCKET_ROWS[b]} rows are listed (${rows.length})`);
  }
  assert.equal(bp.$("#whole .whole-toggle")!.getAttribute("aria-expanded"), "true");
  assert.deepEqual(bp.errors, []);
});

test("a runner report moves its item into the block's kind as soon as the board has it", async t => {
  const board = await startBoard(t);
  // The runner writes as the PM, a project of the real board that the generated board does not have.
  await ops(board.store).createProject({ ...asPM, name: "PM" });
  const bp = await DomPage.open(t, board, { storage: { "board-whole": "open" } }), read = await counts(board, t);
  const s = board.store.snapshot(), now = Date.now(), view = wholeView(s, rules(s, now), now);
  const target = view.rows.find(x => x.bucket === "unattended")!;
  assert.ok(target, "the generated board has an item nobody holds");
  const before = blockCounts(bp);
  assert.ok(!kindRows(bp, "overdue").includes(target.id));
  const base = bp.changes();
  // The report is three hours old when it is written, so its item has waited for CI past the 90 minutes the limit allows.
  await ops(board.store, () => iso(Date.now() - 3 * HOUR)).reportState({ ...asPM, id: target.id, state: "ci", note: "wf-board#98 的 CI" });
  await bp.waitChanges(base + 1);
  const after = blockCounts(bp);
  assert.equal(after.kind.overdue, before.kind.overdue + 1, "one more waits too long");
  assert.equal(after.kind.unattended, before.kind.unattended - 1, "and one less is nobody's");
  assert.equal(after.remaining, before.remaining, "the work left is the same work");
  assert.deepEqual(same(after), same(await read()), "the block and the tool agree after the report");
  assert.ok(kindRows(bp, "overdue").includes(target.id), "the item has its row under 等太久");
  const row = bp.$(`#whole li.whole-row[data-item="${target.id}"]`)!;
  assert.match(row.textContent!, /等 CI：wf-board#98 的 CI/);
  assert.deepEqual(bp.errors, []);
});

test("the block is folded to its heading until it is opened and the choice is kept, and a kind opens to more rows and closes again", async t => {
  const board = await startBoard(t), bp = await DomPage.open(t, board), read = await counts(board, t);
  const expected = await read(), total = expected.kind.unattended;
  assert.ok(total > BUCKET_ROWS.unattended);
  // A page nobody has opened the block on draws only the heading, which still counts the work left and what needs a person.
  const toggle = () => bp.$("#whole .whole-toggle")!;
  assert.equal(toggle().getAttribute("aria-expanded"), "false");
  assert.equal(bp.$$("#whole .whole-kind").length, 0, "folded: no kind is drawn");
  assert.equal(toggle().textContent, `▸ 全貌 · 没做完 ${expected.remaining} 件` + (expected.kind.overdue ? ` · 等太久 ${expected.kind.overdue}` : "") + (expected.kind.unattended ? ` · 没人管 ${expected.kind.unattended}` : ""));
  bp.click(toggle(), "the heading of the block");
  await bp.settle();
  assert.equal(toggle().getAttribute("aria-expanded"), "true");
  assert.equal(bp.win.localStorage.getItem("board-whole"), "open");
  assert.deepEqual(same(blockCounts(bp)), same(expected), "opened: the kinds the tool counts");
  const more = () => bp.$<HTMLButtonElement>('#whole .whole-more[data-kind="unattended"]');
  assert.match(more()!.textContent!, new RegExp(`还有 ${total - BUCKET_ROWS.unattended} 件`));
  bp.click(more(), "the button that lists more");
  await bp.settle();
  assert.equal(kindRows(bp, "unattended").length, Math.min(total, EXPANDED_ROWS), "opened: up to the expanded number of rows");
  assert.equal(more()!.textContent, "收起");
  bp.click(more(), "the button that lists fewer");
  await bp.settle();
  assert.equal(kindRows(bp, "unattended").length, BUCKET_ROWS.unattended, "closed again");
  bp.click(toggle(), "the heading of the block");
  await bp.settle();
  assert.equal(bp.$$("#whole .whole-kind").length, 0, "folded again");
  assert.equal(bp.win.localStorage.getItem("board-whole"), "closed");
  await bp.reset({ "board-whole": "open" });
  assert.equal(bp.$$("#whole .whole-kind").length > 0, true, "a page opened later keeps the block open");
  await bp.reset({ "board-whole": "closed" });
  assert.equal(bp.$$("#whole .whole-kind").length, 0, "and keeps it folded");
  assert.deepEqual(bp.errors, []);
});
