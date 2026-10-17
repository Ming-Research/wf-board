import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ops, OpError } from "../src/ops.ts";
import { createMcpServer } from "../src/mcp.ts";
import { unreadSteps } from "../src/history.ts";
import { Store } from "../src/store.ts";

const architect = "Architect";
/** The architect writes as author Architect from the session 架构师; the journal takes no other writer. */
const asArchitect = { author: architect, session: "架构师" };

// A synthetic board with the Architect project, its notes item and the process tag the journal records carry.
// `tagProjects` limits the tag; `notes: false` leaves the notes item out.
async function journalBoard(t: { after(fn: () => void | Promise<void>): void }, now: () => string, options: { tagProjects?: string[]; notes?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const tag = { name: "协作流程", meaning: "process", ...(options.tagProjects ? { projects: options.tagProjects } : {}) };
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [{ name: architect }, { name: "Whitefoot" }], tags: [tag] } });
  const op = ops(store, now);
  if (options.notes !== false) await op.createItem({ author: architect, session: "架构师", key: "architect-notes", title: "架构师笔记", record: true, group: architect, tags: ["协作流程"] });
  return { store, op };
}

// The local calendar day and clock time of an instant, computed here independently of the code under test.
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

  await op.journalEntry({ ...asArchitect, text: "第一条" });
  clock = second;
  await op.journalEntry({ ...asArchitect, text: "第二条\n跨行保留" });

  const it = store.snapshot().items[key]!;
  assert.equal(it.title, `架构师日志 ${localDay(first)}`);
  assert.equal(it.record, true);
  assert.deepEqual(it.tags, ["协作流程"]);
  assert.equal(it.head, `**${localClock(first)}** 第一条\n\n**${localClock(second)}** 第二条\n跨行保留`);
  assert.equal(store.snapshot().items["architect-notes"]!.plan!.some(row => "item" in row && row.item === key && row.own === true), true);
  assert.ok(it.log.some(entry => entry.text === `改了 head：加了 ${localClock(second)} 的一条`));
});

test("the day follows the local timezone, not UTC: one UTC day can hold two journal days", async t => {
  // Pinned to UTC+14 for this test and restored after it.
  const saved = process.env.TZ;
  t.after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  process.env.TZ = "Pacific/Kiritimati";
  // 09:30Z is 23:30 on 2026-10-16 there, 10:30Z is 00:30 on 2026-10-17: two local days, one UTC day.
  let clock = "2026-10-16T09:30:00Z";
  const { store, op } = await journalBoard(t, () => clock);
  await op.journalEntry({ ...asArchitect, text: "第一条" });
  clock = "2026-10-16T10:30:00Z";
  await op.journalEntry({ ...asArchitect, text: "第二条" });

  const items = store.snapshot().items;
  assert.equal(items["architect-journal-2026-10-16"]!.head, "**23:30** 第一条");
  assert.equal(items["architect-journal-2026-10-17"]!.head, "**00:30** 第二条");
});

test("an entry on the next local day opens that day's record", async t => {
  // Exactly a day apart: two local days in every timezone.
  let clock = "2026-10-16T12:00:00Z";
  const { store, op } = await journalBoard(t, () => clock);
  await op.journalEntry({ ...asArchitect, text: "昨天" });
  clock = "2026-10-17T12:00:00Z";
  await op.journalEntry({ ...asArchitect, text: "今天" });

  const items = store.snapshot().items;
  const yesterday = items[`architect-journal-${localDay("2026-10-16T12:00:00Z")}`]!;
  const today = items[`architect-journal-${localDay("2026-10-17T12:00:00Z")}`]!;
  assert.equal(yesterday.head, `**${localClock("2026-10-16T12:00:00Z")}** 昨天`);
  assert.equal(today.head, `**${localClock("2026-10-17T12:00:00Z")}** 今天`);
});

test("each write marks the record new for the owner: it is among the unread steps after each call", async t => {
  let clock = "2026-10-16T12:00:00Z";
  const { store, op } = await journalBoard(t, () => clock);
  const key = `architect-journal-${localDay(clock)}`;
  const touches = (steps: Awaited<ReturnType<typeof unreadSteps>>) => steps.some(step => step.docs.some(doc => doc.id === key));

  const before = store.snapshot().head;
  await op.journalEntry({ ...asArchitect, text: "第一条" });
  assert.ok(touches(await unreadSteps(store, before)));

  const afterFirst = store.snapshot().head;
  clock = "2026-10-16T13:30:00Z";
  await op.journalEntry({ ...asArchitect, text: "第二条" });
  assert.ok(touches(await unreadSteps(store, afterFirst)));
});

test("only the architect writes the journal; another project is refused with the reason", async t => {
  const { op } = await journalBoard(t, () => "2026-10-16T12:00:00Z");
  await assert.rejects(() => op.journalEntry({ author: "Whitefoot", text: "别人的" }), (error: unknown) => error instanceof OpError && /^author: only Architect with session 架构师 may write the journal under architect-notes$/.test(error.message));
});

test("the journal is the architect's: Architect without the session 架构师, the PM included, is refused, and nothing is written", async t => {
  const { store, op } = await journalBoard(t, () => "2026-10-16T12:00:00Z");
  const before = store.snapshot();
  for (const who of [{ author: architect }, { author: architect, session: "engineer" }, { author: "Whitefoot", session: "架构师" }, { author: architect, session: "PM" }]) {
    await assert.rejects(() => op.journalEntry({ ...who, text: "不该写进去" }), (error: unknown) => error instanceof OpError && /^author: only Architect with session 架构师 may write the journal under architect-notes$/.test(error.message));
    assert.deepEqual(store.snapshot(), before);
  }
});

test("an entry with only blank text is refused by the nonempty rule", async t => {
  const { op } = await journalBoard(t, () => "2026-10-16T12:00:00Z");
  await assert.rejects(() => op.journalEntry({ ...asArchitect, text: "   " }), (error: unknown) => error instanceof OpError && /input\.text: provide nonempty text after trimming/.test(error.message));
});

test("a day's key already used by a non-record item is refused, and the item is left as it was", async t => {
  const { store, op } = await journalBoard(t, () => "2026-10-16T12:00:00Z");
  const key = `architect-journal-${localDay("2026-10-16T12:00:00Z")}`;
  await op.createItem({ author: architect, session: "架构师", key, owner: "architect-notes", title: "不是记录", accept: "做完", tags: ["协作流程"] });
  const before = store.snapshot().items[key]!;
  await assert.rejects(() => op.journalEntry({ ...asArchitect, text: "一条" }), /journal architect-journal-.*is not a record/);
  assert.deepEqual(store.snapshot().items[key], before);
});

test("without the notes item the journal has no owner and the write is refused naming it", async t => {
  const { store, op } = await journalBoard(t, () => "2026-10-16T12:00:00Z", { notes: false });
  await assert.rejects(() => op.journalEntry({ ...asArchitect, text: "一条" }), /owner architect-notes: choose an existing item/);
  assert.equal(Object.hasOwn(store.snapshot().items, `architect-journal-${localDay("2026-10-16T12:00:00Z")}`), false);
});

test("a day's first entry refuses when the process tag does not apply to the Architect project", async t => {
  const { store, op } = await journalBoard(t, () => "2026-10-16T12:00:00Z", { tagProjects: ["Whitefoot"], notes: false });
  await op.createItem({ author: architect, session: "架构师", key: "architect-notes", title: "架构师笔记", record: true, group: architect });
  await assert.rejects(() => op.journalEntry({ ...asArchitect, text: "一条" }), /tags 协作流程: applies only to Whitefoot, not Architect/);
  assert.equal(Object.hasOwn(store.snapshot().items, `architect-journal-${localDay("2026-10-16T12:00:00Z")}`), false);
});

test("journal_entry over MCP: a call from the architect writes the entry, and another project's call returns the refusal as an error", async t => {
  const { store, op } = await journalBoard(t, () => "2026-10-16T12:00:00Z");
  const server = createMcpServer({ store, ops: op, now: () => "2026-10-16T12:00:00Z" });
  const client = new Client({ name: "Journal test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });

  const written = await client.callTool({ name: "journal_entry", arguments: { ...asArchitect, text: "经 MCP 的一条" } });
  assert.equal(written.isError, undefined);
  assert.match(JSON.stringify(written.content), /journal_entry architect-journal-/);
  assert.equal(store.snapshot().items[`architect-journal-${localDay("2026-10-16T12:00:00Z")}`]!.head, `**${localClock("2026-10-16T12:00:00Z")}** 经 MCP 的一条`);

  const refused = await client.callTool({ name: "journal_entry", arguments: { author: "Whitefoot", text: "别人的" } });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.content), /author: only Architect with session 架构师 may write the journal under architect-notes/);
});

test("a journal entry sent again by the same session within a minute is not written twice, for the day's first entry and for a later one, though the time of day in the head has moved on", async t => {
  // Each repeat falls in the next minute of the day, so the head line it would add differs from the first in its time.
  let clock = "2026-10-16T12:00:50Z";
  const { store, op } = await journalBoard(t, () => clock);
  const key = `architect-journal-${localDay(clock)}`;
  const head = () => store.snapshot().items[key]!.head!;

  const first = await op.journalEntry({ ...asArchitect, text: "第一条" });
  clock = "2026-10-16T12:01:20Z";
  const again = await op.journalEntry({ ...asArchitect, text: "第一条" });
  assert.equal(again.repeated, true);
  assert.equal(again.commit, first.commit);
  assert.equal(head(), `**${localClock("2026-10-16T12:00:50Z")}** 第一条`, "the day's first entry is in the head once");

  clock = "2026-10-16T12:03:50Z";
  const second = await op.journalEntry({ ...asArchitect, text: "第二条" });
  assert.equal(second.repeated, undefined);
  clock = "2026-10-16T12:04:20Z";
  const secondAgain = await op.journalEntry({ ...asArchitect, text: "第二条" });
  assert.equal(secondAgain.repeated, true);
  assert.equal(secondAgain.commit, second.commit);
  assert.equal(head().split("第二条").length - 1, 1, "and so is the later one");
  // Other words, or more than a minute later, are an entry of their own.
  assert.equal((await op.journalEntry({ ...asArchitect, text: "第三条" })).repeated, undefined);
  clock = "2026-10-16T12:06:00Z";
  assert.equal((await op.journalEntry({ ...asArchitect, text: "第三条" })).repeated, undefined);
  assert.equal(head().split("第三条").length - 1, 2);
});
