// What the board's tools return and refuse, kept short and self-explaining (docs/design.md, section 6, Lean replies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, formatContext, formatOverview } from "../src/mcp.ts";
import { LEAD_LIMIT, PREAMBLE, selectSections, splitHead, summarizeHead } from "../src/head-sections.ts";
import * as q from "../src/query.ts";
import { rules as makeRules } from "../src/rules.ts";
import { board, author, asArchitect } from "./helpers.ts";

async function connected(t: Parameters<typeof board>[0]) {
  const { store, op } = await board(t, { sharedProjects: true }), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Lean replies", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct); t.after(async () => { await client.close(); await server.close(); });
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as Array<{ type: string; text: string }>).map(c => c.text).join("\n");
  return { store, op, client, text };
}

test("every tool, given a parameter it does not have, answers with its parameter table and an example call that passes validation", async t => {
  const { client, text } = await connected(t), tools = (await client.listTools()).tools;
  assert.ok(tools.length > 40, "the loop below must cover the board's tools");
  for (const tool of tools) {
    const reply = await client.callTool({ name: tool.name, arguments: { not_a_parameter: 1 } });
    assert.equal(reply.isError, true, tool.name);
    const body = text(reply);
    assert.match(body, /arguments not accepted/, tool.name);
    assert.match(body, /unknown parameter "not_a_parameter"/, tool.name);
    for (const parameter of Object.keys(tool.inputSchema.properties ?? {})) assert.match(body, new RegExp(`^ {2}${parameter} \\(`, "m"), `${tool.name}: the table has a row for ${parameter}`);
    const example = /^Example: (\S+) (.*)$/m.exec(body);
    assert.ok(example && example[1] === tool.name, `${tool.name}: an example call`);
    // The example gets past validation; a write is then refused only because the example names no author.
    const again = await client.callTool({ name: tool.name, arguments: JSON.parse(example[2]!) });
    assert.doesNotMatch(text(again), /arguments not accepted/, `${tool.name}: ${example[2]}`);
  }
});

test("a missing required parameter and a wrong type are named in plain words, with the table", async t => {
  const { client, text } = await connected(t);
  const missing = text(await client.callTool({ name: "rule_card", arguments: { author } }));
  assert.match(missing, /missing required parameter "key"/);
  assert.match(missing, /^ {2}key \(string, required\)/m);
  const wrong = text(await client.callTool({ name: "context", arguments: { id: "a", log: "some" } }));
  assert.match(wrong, /"log"/); assert.match(wrong, /arguments not accepted/);
  const direction = text(await client.callTool({ name: "graph", arguments: { id: "a", direction: "sideways" } }));
  assert.match(direction, /"direction" must be one of: up, down, both/);
});

test("names the tools do not have but agents write are read as the name they have, and the reply says so", async t => {
  const { client, text, store } = await connected(t);
  const byKey = await client.callTool({ name: "context", arguments: { key: "a" } });
  assert.equal(byKey.isError, undefined, text(byKey)); assert.match(text(byKey), /^a · /m); assert.match(text(byKey), /^note: key read as id$/m);
  const logged = await client.callTool({ name: "append_log", arguments: { author, key: "a", text: "written under the name key" } });
  assert.equal(logged.isError, undefined, text(logged)); assert.match(text(logged), /^note: key read as id$/m);
  assert.equal(store.snapshot().items.a!.log.at(-1)!.text, "written under the name key");
  // Where the tool names the card key and the caller wrote id.
  const card = await client.callTool({ name: "withdraw_card", arguments: { author, id: "choice", log: "No longer needed" } });
  assert.equal(card.isError, undefined, text(card)); assert.match(text(card), /^note: id read as key$/m);
  // A filter written beside the tool's filters is moved into them; project is the group.
  const notes = await client.callTool({ name: "notes", arguments: { limit: 1, state: ["sent"] } });
  assert.equal(notes.isError, undefined, text(notes)); assert.match(text(notes), /^note: limit read as filters\.limit; state read as filters\.state$/m);
  assert.equal(text(notes).split("\n").filter(line => line.startsWith("note-")).length, 1);
  const found = await client.callTool({ name: "search", arguments: { query: "中文", project: author } });
  assert.equal(found.isError, undefined, text(found)); assert.match(text(found), /^note: project read as filters\.group$/m);
  // A name that is not an alias is still refused, and a name given together with the right one is not guessed at.
  const both = await client.callTool({ name: "context", arguments: { id: "a", key: "b" } });
  assert.equal(both.isError, true); assert.match(text(both), /unknown parameter "key"/);
});

test("a mistake inside a plan row is placed at the row, and set_plan reads plan as rows", async t => {
  const { client, text, store } = await connected(t);
  const reply = text(await client.callTool({ name: "set_plan", arguments: { author, id: "a", rows: [{ id: "s", text: "x", state: "done", doneAt: "2026-10-11T01:02:03Z" }] } }));
  assert.match(reply, /^- unknown parameter "doneAt" in rows\[0\]$/m); assert.match(reply, /^Example: set_plan \{"id":"my-item","row":/m);
  const alias = await client.callTool({ name: "set_plan", arguments: { author, id: "a", plan: [{ id: "s", text: "x", state: "todo" }, { id: "accept", accept: true, text: "ok", state: "todo" }] } });
  assert.equal(alias.isError, undefined, text(alias)); assert.match(text(alias), /^note: plan read as rows$/m);
  assert.deepEqual(store.snapshot().items.a!.plan.map(row => row.id), ["s", "accept"]);
});

// --- The head in sections -------------------------------------------------------------------------------------------

const table = (rows: number) => ["| 做法 | 代价 | 风险 |", "|---|---|---|", ...Array.from({ length: rows }, (_, i) => `| 做法 ${i} | 要改 ${i} 处，每处都要重新跑一遍检查 | 回退很难 |`)].join("\n");
/** A head shaped like a study item's: bold section titles, bullets under one, a fenced block, two 参考 sections with long tables, a 改动 section. */
const STUDY_HEAD = [
  "**问题**：看板工具返回太多，上下文被它填满。数据是从会话记录里数的：",
  "- `context` 调了 433 次，返回 159 万字符，平均 3.7k。",
  "- `overview` 每次 2.4 万字符。",
  "",
  "**为什么**：上下文被填满就频繁压缩，压缩后又要重读，判断变慢也变差。",
  "第二行还属于这一段。",
  "",
  "第二段，不在默认的回复里：它讲了一大堆背景，需要时再取。".repeat(8),
  "",
  "**做法**（直接做：只加可选参数）：默认只回各节第一段。",
  "",
  "```",
  "**不是标题**：围栏里的粗体行不切节",
  "# 也不是标题",
  "这一块代码比较长，默认的回复里放不下，所以它不在第一段里，需要时再取。",
  "同一块里再多写几行，让它超过只值得一行说明的长度。",
  "再多一行，保证这一块比默认回复里一条「略」的说明贵。",
  "```",
  "",
  "## 想过的别的做法",
  "",
  "- 重新设计全部工具：太慢。",
  "- 让代理自己截断：截掉的可能正是要的。",
  "",
  "**参考：容量规则的几种选法**",
  "",
  "开头一段说明。",
  "",
  table(30),
  "",
  "**参考：另一份推导**",
  "",
  table(20),
  "",
  "**改动**",
  "",
  "- wf-board#76：草稿。",
  "",
].join("\n");

test("the sections of a head laid end to end are the head, character for character", () => {
  const heads = [STUDY_HEAD, "", "一行", "没有标题\n\n第二段\n", "**只有标题**", "前言\n\n**问题**：内容\r\n\r\n**做法**\r\n内容\r\n", "```\n**围栏**\n```\n**真标题**：x\n", "**问题**：a\n**问题**：b\n"];
  for (const head of heads) assert.equal(splitHead(head).map(s => s.text).join(""), head, JSON.stringify(head));
  assert.deepEqual(splitHead(STUDY_HEAD).map(s => s.title), ["问题", "为什么", "做法", "想过的别的做法", "参考：容量规则的几种选法", "参考：另一份推导", "改动"]);
  // The text before the first title is a section of its own, called by a name a reader can ask for.
  assert.deepEqual(splitHead("前言\n\n**问题**：内容").map(s => s.title), ["", "问题"]);
});

test("a title line inside a fenced block, or a bold phrase that begins a sentence, does not start a section", () => {
  const head = "**问题**：x\n```\n**围栏里**：y\n## 也不是\n```\n**重点**是这一句的开头，不是标题\n";
  assert.deepEqual(splitHead(head).map(s => s.title), ["问题"]);
});

test("the summary keeps each section's title line and first paragraph, shows a 参考 section by its title, and says what it left out", () => {
  const summary = summarizeHead(STUDY_HEAD);
  assert.deepEqual(summary.titles, ["问题", "为什么", "做法", "想过的别的做法", "参考：容量规则的几种选法", "参考：另一份推导", "改动"]);
  // 问题: the title line and the bullets directly under it, which no blank line separates from it.
  assert.match(summary.text, /^\*\*问题\*\*：.*\n- `context` 调了 433 次.*\n- `overview` 每次 2.4 万字符。$/m);
  // 为什么: both lines of its first paragraph, not its second paragraph.
  assert.match(summary.text, /第二行还属于这一段。/); assert.doesNotMatch(summary.text, /第二段，不在默认的回复里/);
  // A heading with nothing after it on its line: the paragraph below it is the first paragraph.
  assert.match(summary.text, /## 想过的别的做法\n\n- 重新设计全部工具：太慢。\n- 让代理自己截断：截掉的可能正是要的。/);
  // 参考: the title only; the tables stay out.
  assert.match(summary.text, /\*\*参考：容量规则的几种选法\*\*/); assert.doesNotMatch(summary.text, /\| 做法 0 \|/); assert.doesNotMatch(summary.text, /开头一段说明/);
  assert.match(summary.text, /\(section "参考：容量规则的几种选法"\)/);
  assert.ok(summary.omitted > 1500 && summary.text.length < STUDY_HEAD.length / 2, `${summary.omitted} left out, ${summary.text.length} of ${STUDY_HEAD.length} shown`);
  // The fenced block under 做法 is not a first paragraph: the title line's paragraph ends at the blank line.
  assert.match(summary.text, /\*\*做法\*\*（直接做：只加可选参数）：默认只回各节第一段。\n  … /);
  // A head that fits is shown as it is.
  assert.deepEqual(summarizeHead("**问题**：短\n\n**做法**：也短\n"), { text: "**问题**：短\n\n**做法**：也短", omitted: 0, titles: ["问题", "做法"] });
  // One very long line is cut where the limit falls, not left whole.
  const long = summarizeHead(`**问题**：${"长".repeat(LEAD_LIMIT * 2)}`);
  assert.ok(long.text.length < LEAD_LIMIT + 200 && long.omitted > LEAD_LIMIT / 2);
});

test("a section is chosen by its title, by the start of it, or by all; an unknown title is not guessed", () => {
  assert.equal(selectSections(STUDY_HEAD, "做法")![0]!.text, splitHead(STUDY_HEAD).find(s => s.title === "做法")!.text);
  assert.deepEqual(selectSections(STUDY_HEAD, "参考")!.map(s => s.title), ["参考：容量规则的几种选法", "参考：另一份推导"]);
  assert.equal(selectSections(STUDY_HEAD, "all")![0]!.text, STUDY_HEAD);
  assert.equal(selectSections("前言\n\n**问题**：内容", PREAMBLE)![0]!.text, "前言\n\n");
  assert.equal(selectSections(STUDY_HEAD, "没有这一节"), undefined);
});

// --- context ---------------------------------------------------------------------------------------------------------

/** The fixture's item a, with a study-shaped head, long log entries, handled notes and open cards with long grounds. */
async function richItem(t: Parameters<typeof board>[0]) {
  const c = await connected(t), { store } = c;
  const a = store.snapshot().items.a!, at = "2026-10-11T01:02:03Z";
  const entry = (i: number) => ({ at: `2026-10-11T02:0${i}:00Z`, by: author, text: `第 ${i} 条日志：${"这一条写了很多验收证据和修复情况，工程师写日志向来写得长。".repeat(12)} Whitefoot#${100 + i} Whitefoot#${200 + i}` });
  const done = (id: string) => ({ id, text: `做完的一步 ${id}`, state: "done" as const, doneAt: at });
  await store.commit({ author, message: "Rich item", puts: [
    { kind: "item", id: "a", expectRev: a.rev, doc: { ...a, head: STUDY_HEAD, log: [1, 2, 3, 4, 5].map(entry), plan: [done("s1"), done("s2"), done("s3"), ...a.plan] } },
    ...["card-1", "card-2"].map(id => ({ kind: "decision" as const, id, expectRev: null, doc: { item: "a", question: `选哪个 ${id}？`, options: [
      { key: "A", text: "做法甲", detail: "做法甲的说明。".repeat(60), recommended: true }, { key: "B", text: "做法乙", detail: "做法乙的说明。".repeat(60) }, { key: "C", text: "做法丙", detail: "做法丙的说明。".repeat(60) }],
      confidence: { score: 4, reason: "依据很长的一段话。".repeat(40) }, status: "open" as const, at, updated: at } })),
    ...[1, 2].map(i => ({ kind: "note" as const, id: `done-${i}`, expectRev: null, doc: { target: "it:a", kind: "comment" as const, text: `主人的意见 ${i}：${"写得很长。".repeat(60)}`, at, sentAt: at, state: "done" as const, reply: `回复 ${i}：${"处理的经过。".repeat(60)}`, repliedAt: at, repliedBy: author } })),
  ] });
  return c;
}

test("context answers with each head section's first paragraph, a line for a handled note, an open card without its grounds and cut log entries, in under half the characters", async t => {
  const { client, text, store } = await richItem(t);
  const whole = formatContext(q.context(store.snapshot(), makeRules(store.snapshot()), "a"));
  const lean = text(await client.callTool({ name: "context", arguments: { id: "a" } }));
  assert.ok(lean.length < whole.length / 2, `${lean.length} of ${whole.length} characters`);
  // The head.
  assert.match(lean, /^head \(cut: \d+ characters left out; sections: 问题 · 为什么 · 做法 · 想过的别的做法 · 参考：容量规则的几种选法 · 参考：另一份推导 · 改动; section: "<title>" or "all" gets them whole\):$/m);
  assert.doesNotMatch(lean, /\| 做法 0 \|/);
  // The log: each entry cut, and how to get them whole.
  assert.match(lean, /第 5 条日志：.*… \(\d+ characters in all\)/); assert.match(lean, /entries over 240 characters are cut; log: N gets the last N whole/);
  // A handled note: its text and reply cut; the card's options by name.
  assert.match(lean, /done-1 · DONE comment · it:a · .*… \(\d+ characters in all\)\n {2}reply .*… \(\d+ characters in all\)/);
  assert.match(lean, /^card-1 · OPEN · 选哪个 card-1？ · rev 1/m); assert.match(lean, /^ {2}A \(recommended\): 做法甲$/m); assert.match(lean, /^ {2}B: 做法乙$/m);
  assert.match(lean, /\(grounds left out; context card-1 has them\)/); assert.doesNotMatch(lean, /做法甲的说明/);
  assert.match(lean, /^confidence 4\/5：依据很长的一段话。.*… \(\d+ characters in all\)$/m);
  // What is not cut: the plan, the item's row, the open card's rev.
  assert.match(lean, /^plan:\n/m); assert.match(lean, /^a · /m);
  // The plan folds its finished rows into a count; the pull requests the text names stop at five.
  assert.match(lean, /^ {2}✓ 3 项已完成$/m); assert.doesNotMatch(lean, /做完的一步/);
  assert.match(lean, /^PRs: (Whitefoot#\d+, ){5}… 7 more \(prs tool\)$/m);
  // full: nothing cut and nothing folded.
  const full = text(await client.callTool({ name: "context", arguments: { id: "a", full: true } }));
  assert.ok(full.includes(`head: ${STUDY_HEAD}`)); assert.match(full, /做完的一步 s1/); assert.ok(full.includes("做法甲的说明。".repeat(60)));
  assert.match(full, /^PRs: (Whitefoot#\d+, ){11}#76 \(repository unknown\)$/m); assert.doesNotMatch(full, /characters in all|entries over 240/);
  assert.ok(full.length >= whole.length - 20, `${full.length} against ${whole.length}`);
  // A call that asks for the log whole gets it whole, and the card read on its own is whole.
  const wholeLog = text(await client.callTool({ name: "context", arguments: { id: "a", log: 1 } }));
  assert.ok(wholeLog.includes(store.snapshot().items.a!.log.at(-1)!.text)); assert.doesNotMatch(wholeLog, /entries over 240/);
  const card = text(await client.callTool({ name: "context", arguments: { id: "card-1" } }));
  assert.ok(card.includes("做法甲的说明。".repeat(60)));
});

test("context with a section answers with that section of the head, exactly as written, and nothing else", async t => {
  const { client, text, store } = await richItem(t);
  const sections = splitHead(STUDY_HEAD);
  for (const s of sections) {
    const reply = text(await client.callTool({ name: "context", arguments: { id: "a", section: s.title } }));
    assert.ok(reply.includes(`section: ${s.text.trimEnd()}`), s.title);
    assert.doesNotMatch(reply, /^plan:|^log \(|^card-1/m, "the head alone");
    assert.match(reply, new RegExp(`^rev ${store.snapshot().items.a!.rev} · updated `, "m"));
  }
  const all = text(await client.callTool({ name: "context", arguments: { id: "a", section: "all" } }));
  assert.ok(all.includes(`head: ${STUDY_HEAD}`));
  const refs = text(await client.callTool({ name: "context", arguments: { id: "a", section: "参考" } }));
  assert.ok(refs.includes(sections[4]!.text.trimEnd()) && refs.includes(sections[5]!.text.trimEnd()));
  const unknown = await client.callTool({ name: "context", arguments: { id: "a", section: "没有这一节" } });
  assert.equal(unknown.isError, true); assert.match(text(unknown), /section 没有这一节: this head has "问题", "为什么", "做法"/);
  const onCard = await client.callTool({ name: "context", arguments: { id: "card-1", section: "问题" } });
  assert.equal(onCard.isError, true); assert.match(text(onCard), /only an item has sections/);
});

test("a head that is context's summary is refused when it is written back, and the whole head is not", async t => {
  const { client, text, store } = await richItem(t);
  const summary = summarizeHead(STUDY_HEAD).text;
  assert.match(summary, /more characters \(section "/, "the summary carries its marks");
  const before = store.snapshot();
  const refused = await client.callTool({ name: "update_item", arguments: { author, id: "a", rev: before.items.a!.rev, head: summary, reason: "edited the summary" } });
  assert.equal(refused.isError, true); assert.match(text(refused), /holds the line "… \d+ more characters \(section "[^"]*"\)"/); assert.match(text(refused), /context section: "all"/);
  const created = await client.callTool({ name: "create_item", arguments: { ...asArchitect, key: "fresh", title: "新条目", head: summary, accept: "通过", group: author, priority: "P1" } });
  assert.equal(created.isError, true); assert.match(text(created), /context section: "all"/);
  assert.deepEqual(store.snapshot(), before, "nothing was written");
  // The whole head, changed, is written.
  const ok = await client.callTool({ name: "update_item", arguments: { author, id: "a", rev: before.items.a!.rev, head: `${STUDY_HEAD}\n追加一行`, reason: "added a line" } });
  assert.equal(ok.isError, undefined, text(ok)); assert.ok(store.snapshot().items.a!.head!.endsWith("追加一行"));
});

test("a summary whose cut section has a quoted title is refused too", async t => {
  const { client, text, store } = await richItem(t);
  const head = `**问题**：短\n\n## 为什么用 "section"\n\n${"这一节很长，需要被截掉一部分才行。".repeat(20)}\n\n第二段，也很长。${"再写一些字。".repeat(30)}\n`;
  const summary = summarizeHead(head).text;
  assert.match(summary, /more characters \(section "为什么用 "section""\)/, "the mark carries the quoted title");
  const before = store.snapshot();
  const refused = await client.callTool({ name: "update_item", arguments: { author, id: "a", rev: before.items.a!.rev, head: summary, reason: "edited the summary" } });
  assert.equal(refused.isError, true); assert.match(text(refused), /context section: "all"/);
  assert.deepEqual(store.snapshot(), before);
});

test("acceptance rows stay in the plan, done or not, and every fold says how to get the rest", async t => {
  const { client, text, store } = await richItem(t);
  const a = store.snapshot().items.a!;
  await store.commit({ author, message: "An acceptance row done", puts: [{ kind: "item", id: "a", expectRev: a.rev, doc: { ...a, plan: [{ id: "accepted", accept: true, text: "验收做完了", state: "done", doneAt: "2026-10-11T01:02:03Z" }, ...a.plan] } }] });
  const lean = text(await client.callTool({ name: "context", arguments: { id: "a" } }));
  assert.match(lean, /^ {2}L\d+ ✓ accepted \[验收\] 验收做完了/m, "a done acceptance row is listed");
  assert.match(lean, /^ {2}✓ 3 项已完成$/m); assert.doesNotMatch(lean, /做完的一步/);
  assert.match(lean, /\(finished rows are folded into a count; full: true lists them\)/);
  assert.match(lean, /\(handled notes are cut to 160 characters; full: true or the notes tool has them whole\)/);
  assert.match(lean, /entries over 240 characters are cut; log: N gets the last N whole/);
  assert.match(lean, /… 7 more \(prs tool\)$/m);
  const card = text(await client.callTool({ name: "context", arguments: { id: "card-1" } }));
  assert.doesNotMatch(card, /characters in all/, "a card read on its own has its notes whole");
});

test("an open card says what it leaves out: option grounds, and the background an old card kept", async t => {
  const { client, text, store } = await connected(t);
  const at = "2026-10-11T01:02:03Z";
  await store.commit({ author, message: "An old card", puts: [{ kind: "decision", id: "old", expectRev: null, doc: { item: "a", question: "旧卡？", options: [{ key: "A", text: "", detail: "第一行\n第二行说明" }], status: "open", legacy: { background: "旧的背景" }, at, updated: at } }] });
  const lean = text(await client.callTool({ name: "context", arguments: { id: "a" } }));
  assert.match(lean, /^ {2}A: 第一行$/m); assert.doesNotMatch(lean, /第二行说明|旧的背景/);
  assert.match(lean, /\(grounds and legacy background left out; context old has them\)/);
});

test("a read tool ignores an author it is given, and a write tool that lacks reason refuses it with its parameters", async t => {
  const { client, text, store } = await connected(t);
  const rows = await client.callTool({ name: "dispatches", arguments: { author, id: "a" } });
  assert.equal(rows.isError, undefined, text(rows)); assert.match(text(rows), /^note: author ignored: this tool takes none; id read as filters\.id$/m);
  const before = store.snapshot();
  const moved = await client.callTool({ name: "move_item", arguments: { author, id: "b", owner: "area", reason: "tidy" } });
  assert.equal(moved.isError, true); assert.match(text(moved), /unknown parameter "reason"/); assert.match(text(moved), /^ {2}owner \(/m);
  assert.deepEqual(store.snapshot(), before);
});

// --- overview --------------------------------------------------------------------------------------------------------

test("overview lists, under a project's counts, only the areas with something to handle and caps their rows; detail lists everything", () => {
  const row = (id: string, extra: object = {}) => ({ id, status: "todo", title: `条目 ${id}`, checks: [{ text: `检查 ${id}：${"很长的说明".repeat(30)}` }], ...extra });
  const area = (id: string, owner: number, blocked: number, checks: number, counts: object) => ({ ...row(id), group: "Whitefoot", areaId: id, counts: { todo: 0, idle: 0, wip: 0, blocked: 0, paused: 0, done: 0, cancelled: 0, ...counts },
    ownerActions: Array.from({ length: owner }, (_, i) => row(`${id}-o${i}`)), blocked: Array.from({ length: blocked }, (_, i) => row(`${id}-b${i}`, { status: "blocked" })), checks: Array.from({ length: checks }, (_, i) => row(`${id}-c${i}`)) });
  const result = [{ project: "Whitefoot", areas: [area("busy", 7, 3, 6, { todo: 2, blocked: 3 }), area("calm", 0, 0, 0, { todo: 5 }), area("calm2", 0, 2, 0, { blocked: 2 })] }, { project: "Empty", areas: [] }] as unknown as Parameters<typeof formatOverview>[0];
  const lean = formatOverview(result);
  assert.match(lean, /^Whitefoot · 3 areas · TODO 7 · BLOCK 5 · owner waiting 7 · blocked 5 · checks 6$/m);
  assert.match(lean, /^Empty · 0 areas · owner waiting 0 · blocked 0 · checks 0$/m);
  // Only the busy area is listed; its rows stop at five and say how many more there are; blocked rows are counted, not listed.
  assert.match(lean, /^ {2}busy · TODO/m); assert.doesNotMatch(lean, /calm/);
  assert.equal(lean.split("\n").filter(l => l.startsWith("    owner: ")).length, 5); assert.match(lean, /^ {4}… 2 more owner rows \(detail: true\)$/m);
  assert.equal(lean.split("\n").filter(l => l.startsWith("    check: ")).length, 5); assert.match(lean, /^ {4}… 1 more check rows \(detail: true\)$/m);
  assert.doesNotMatch(lean, /busy-b0/);
  assert.match(lean, /^ {2}2 other areas have no owner waiting and no checks$/m);
  assert.match(lean, /detail: true lists every area/);
  // A row is the key, status and title; a check adds its short label, not its explanation.
  assert.match(lean, /^ {4}owner: busy-o0 · TODO · 条目 busy-o0$/m); assert.match(lean, /^ {4}check: busy-c0 · TODO · 条目 busy-c0 · .{1,12}$/m); assert.doesNotMatch(lean, /很长的说明/);
  // detail: the answer as it was.
  const detail = formatOverview(result, true);
  assert.match(detail, /^Whitefoot$/m); assert.match(detail, /^ {2}owner: busy-o6 /m); assert.match(detail, /^ {2}blocked: busy-b2 /m); assert.match(detail, /^calm · /m);
  assert.ok(detail.length > lean.length);
});

test("overview through the tool: the default and detail", async t => {
  const { client, text } = await connected(t);
  const lean = text(await client.callTool({ name: "overview", arguments: { group: "Whitefoot" } }));
  assert.match(lean, /^Whitefoot · \d+ areas · /m); assert.match(lean, /\(detail: true lists every area with all its rows\)/);
  const detail = text(await client.callTool({ name: "overview", arguments: { group: "Whitefoot", detail: true } }));
  assert.match(detail, /^Whitefoot$/m); assert.doesNotMatch(detail, /detail: true lists/);
});
