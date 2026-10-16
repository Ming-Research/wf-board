import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ops, OpError } from "../src/ops.ts";
import { Store } from "../src/store.ts";

const architect = "Architect";

// A synthetic board with the Architect project, its notes item and the tag the journal records carry.
async function journalBoard(t: { after(fn: () => void | Promise<void>): void }, now: () => string) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [{ name: architect }], tags: [{ name: "协作流程", meaning: "process" }] } });
  const op = ops(store, now);
  await op.createItem({ author: architect, key: "architect-notes", title: "架构师笔记", record: true, group: architect, tags: ["协作流程"] });
  return { store, op };
}

// The local calendar day of an instant, as the journal's key names it, computed here independently of the code under test.
function localDay(iso: string): string {
  const d = new Date(iso), pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localClock(iso: string): string {
  const d = new Date(iso), pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

test("the first entry of a day creates that day's record under the notes item, and later entries join its text", async t => {
  // Both instants fall on one local day in every timezone from UTC-12 to UTC+14.
  const first = "2026-10-16T12:00:00Z", second = "2026-10-16T13:30:00Z";
  let clock = first;
  const { store, op } = await journalBoard(t, () => clock);
  const key = `architect-journal-${localDay(first)}`;

  await op.journalEntry({ author: architect, text: "第一条" });
  clock = second;
  await op.journalEntry({ author: architect, text: "第二条\n跨行保留" });

  const it = store.snapshot().items[key]!;
  assert.equal(it.title, `架构师日志 ${localDay(first)}`);
  assert.equal(it.record, true);
  assert.deepEqual(it.tags, ["协作流程"]);
  assert.equal(it.head, `**${localClock(first)}** 第一条\n\n**${localClock(second)}** 第二条\n跨行保留`);
  assert.equal(store.snapshot().items["architect-notes"]!.plan!.some(row => "item" in row && row.item === key && row.own === true), true);
  assert.ok(it.log.some(entry => entry.text === `改了 head：加了 ${localClock(second)} 的一条`));
});

test("an entry on the next local day opens that day's record", async t => {
  // Exactly a day apart: two local days in every timezone.
  let clock = "2026-10-16T12:00:00Z";
  const { store, op } = await journalBoard(t, () => clock);
  await op.journalEntry({ author: architect, text: "昨天" });
  clock = "2026-10-17T12:00:00Z";
  await op.journalEntry({ author: architect, text: "今天" });

  const items = store.snapshot().items;
  const yesterday = items[`architect-journal-${localDay("2026-10-16T12:00:00Z")}`]!;
  const today = items[`architect-journal-${localDay("2026-10-17T12:00:00Z")}`]!;
  assert.equal(yesterday.head, `**${localClock("2026-10-16T12:00:00Z")}** 昨天`);
  assert.equal(today.head, `**${localClock("2026-10-17T12:00:00Z")}** 今天`);
});

test("only the Architect project writes the journal; another project is refused with the reason", async t => {
  const { op } = await journalBoard(t, () => "2026-10-16T12:00:00Z");
  await assert.rejects(() => op.journalEntry({ author: "Whitefoot", text: "别人的" }), (error: unknown) => error instanceof OpError && /only the Architect project writes the journal/.test(error.message));
});

test("an entry with only blank text is refused", async t => {
  const { op } = await journalBoard(t, () => "2026-10-16T12:00:00Z");
  await assert.rejects(() => op.journalEntry({ author: architect, text: "   " }), /nonempty|provide/);
});
