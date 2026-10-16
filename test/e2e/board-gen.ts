// A seeded generator of a synthetic board with the structural variety of the real one: deep and wide ownership trees,
// records owning backlog work, shared rows inside and across projects, decision cards (options with a name and a
// detail, a confidence; a row in the item's plan only for a card that blocks; some placed in the head by a line of their
// own, old ones in a section at its end, the rest not placed at all; old ones with a nameless option and their legacy
// background, ruled in words or withdrawn; open ones on a record item and on a done item), asks, inbox requests, explicit and inherited
// pauses, comments folded or open with replies and anchors, code blocks, tables, references, glossary terms,
// targets, tags, and a history split into read and unread commits. All text comes from the word lists below; no real
// board text is copied. test/e2e/shapes.ts names the shape categories and test/board-gen.test.ts checks every one is
// present. The real board's counts, surveyed when this was written, are in docs/design.md section 11.

import type { Put } from "../../src/store.ts";

export interface Batch { message: string; puts: Omit<Put, "expectRev">[] }
export interface Witness {
  /** A cancelled item the tree hides (no open work under it) whose title changed after the owner last read. */
  hiddenFresh: string;
  /** An open item whose head holds a fenced code block. */
  code: string;
  /** An open item with listed comments, for the comment flow; the test folds its list in localStorage. */
  commentItem: string;
  /** An open card its item's head places, with listed comments; folded in localStorage by the test. */
  commentCard: string;
  /** An open blocking card its item's head places between two paragraphs. */
  multiPlanCard: string;
  /** A ruled card on a done item, keeping the row it had. */
  donePlanCard: string;
  /** An open card that does not block, with no row and no line in its item's head: the page draws it only when asked,
   * from the 决策 line. */
  otherPlanCard: string;
  /** An open blocking card its item's head does not place: the page draws it under its plan row when asked. */
  rowCard: string;
  /** An open card on a record item. */
  recordCard: string;
  /** A ruled card that was converted from the old form: nameless options, its background kept as legacy text. */
  legacyCard: string;
  /** A card ruled in words, with no choice, whose ruling is the card's ruling field. */
  proseCard: string;
  /** A card withdrawn without a choice. */
  withdrawnCard: string;
  /** An open blocking card converted from the old form: it keeps its old background, which its reader decides from. */
  openLegacyCard: string;
  /** An item paused explicitly, whose descendants inherit the pause. */
  pausedRoot: string;
  /** An open, unpaused item with a plan. */
  unpaused: string;
}
export interface Generated {
  board: { title: string; eyebrow: string; goal: string; projects: Array<{ name: string; repo?: string }>; tags: Array<{ name: string; meaning: string; projects?: string[] }> };
  batches: Batch[];
  /** The owner has read every batch before this index; later batches are unread. */
  readBefore: number;
  witness: Witness;
}

/** mulberry32: a small deterministic PRNG, so a seed always gives the same board. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!,
    chance: (p: number) => next() < p,
  };
}

const SUBJECTS = ["解释器", "检查器", "调度器", "存储层", "协议栈", "渲染器", "页面", "测试集", "发布包", "缓存", "索引", "编码器"];
const VERBS = ["通过", "支持", "拒绝", "回放", "压缩", "比对", "迁移", "并行处理", "报告"];
const OBJECTS = ["长脚本", "并发写入", "空列表", "大对象", "跨项目引用", "嵌套计划", "旧格式数据", "错误位置", "超时请求"];
const LATIN = ["ARM64", "UTF-8", "p99", "CI", "WASM", "LRU", "TLS", "JSON"];
const STEPS = ["写出最小复现", "补齐边界用例", "在托管 CI 上跑完整门禁", "对照参照实现核对输出", "整理设计说明", "测量前后耗时", "修掉评审发现", "合并到主线"];
const PROJECTS = [
  { name: "Kestrel", repo: "Example/Kestrel", slug: "kes" },
  { name: "Lumen-wf", repo: "Example/Lumen-wf", slug: "lum" },
  { name: "Marlin-wf", repo: "Example/Marlin-wf", slug: "mar" },
  { name: "Nimbus-kit", repo: "Example/Nimbus-kit", slug: "nim" },
  { name: "协调", slug: "xie" },
] as const;
const TAGS = [
  { name: "正确性", meaning: "结果错了时打。" },
  { name: "性能", meaning: "跑得慢或占内存时打。" },
  { name: "诊断", meaning: "报错信息不清楚时打。" },
  { name: "文档", meaning: "给读者的文字有问题时打。" },
  { name: "CI与工具", meaning: "门禁或工具不顺手时打。" },
  { name: "调研", meaning: "产出是结论或决定时打。" },
  { name: "协议", meaning: "只用于网络协议项目。", projects: ["Lumen-wf", "Marlin-wf"] },
  { name: "排期", meaning: "只用于协调项目。", projects: ["协调"] },
];

const BASE = Date.parse("2026-09-20T08:00:00Z");
const iso = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

interface PlanRowDraft { id: string; text?: string; state?: "done" | "doing" | "todo" | "dropped"; accept?: true; item?: string; own?: boolean; card?: string; after?: string[]; waits?: string; reason?: string }
interface ItemDraft {
  id: string; index: number; title: string; group: string; record?: boolean; parent?: string; children: string[];
  steps: PlanRowDraft[]; extra: PlanRowDraft[]; cards: string[]; head: string; log: Array<{ at: string; by?: string; text: string }>;
  tags: string[]; status?: "cancelled"; paused?: { reason: string; at: string }; ask?: { text: string; url?: string; chat?: boolean };
  request?: { by: string; at: string }; targets?: Array<{ id: string; goal: string; target: string; current: string; baseline: string; date: string }>;
  links: Array<{ label: string; url: string }>; provisional?: true; priority?: string; data?: string; leafKind: "done" | "wip" | "todo" | "blocked" | "parent";
}
interface CardDraft {
  id: string; item: string; question: string; options: Array<{ key: string; text: string; detail: string; recommended?: boolean }>; status: "open" | "ruled" | "withdrawn"; blocks?: string;
  confidence: { score: number; reason: string }; choice?: string; ruling?: string; ruledAt?: string; legacy?: { background: string }; at: string;
  /** Converted from the old form; the head places it in the section at its end. */
  old?: true;
}

/** Generates the board. `scale` multiplies the number of items per project (1 gives about 160 items). */
export function generateBoard(seed = 1, scale = 1): Generated {
  const r = prng(seed);
  const items = new Map<string, ItemDraft>(), cards = new Map<string, CardDraft>();
  const notes: Array<{ id: string; doc: Record<string, unknown> }> = [];
  let clock = 0, made = 0, noteSeq = 0;
  const tick = () => iso(clock += 7);
  const title = (k: number) => r.pick(SUBJECTS) + r.pick(VERBS) + r.pick(OBJECTS) + (r.chance(0.3) ? " " + r.pick(LATIN) : "") + " " + k;
  const tagsFor = (group: string) => {
    const usable = TAGS.filter(t => !t.projects || t.projects.includes(group)).map(t => t.name);
    const n = 1 + r.int(3), out = new Set<string>();
    while (out.size < n) out.add(r.pick(usable));
    return [...out];
  };
  // Keys follow the board's Key pattern, a few with dots and underscores so selectors and element ids meet them.
  const key = (slug: string) => { made++; return made % 11 === 0 ? `${slug}.${made}` : made % 7 === 0 ? `${slug}_${made}` : `${slug}-${made}`; };
  function newItem(group: string, slug: string, parent?: string, record?: boolean): ItemDraft {
    const id = key(slug);
    const it: ItemDraft = { id, index: items.size, title: title(items.size + 1), group, parent, record, children: [], steps: [], extra: [], cards: [], head: "", log: [], tags: tagsFor(group), links: [], leafKind: "parent" };
    items.set(id, it);
    if (parent) items.get(parent)!.children.push(id);
    return it;
  }
  // Ownership trees: a few roots per project and a fixed budget of items spread over random owners up to depth 4, plus
  // one spine six levels deep and one node owning twelve items.
  const roots: ItemDraft[] = [];
  for (const [pi, p] of PROJECTS.entries()) {
    const nRoots = 2 + r.int(3), budget = Math.round(26 * scale);
    const frontier: Array<{ node: ItemDraft; depth: number }> = [];
    for (let k = 0; k < nRoots; k++) { const root = newItem(p.name, p.slug); roots.push(root); frontier.push({ node: root, depth: 0 }); }
    for (let k = 0; k < budget; k++) {
      const { node, depth } = r.pick(frontier.filter(f => f.depth < 4));
      frontier.push({ node: newItem(p.name, p.slug, node.id), depth: depth + 1 });
    }
    if (pi === 0) { const wide = newItem(p.name, p.slug, frontier[0]!.node.id); for (let c = 0; c < 12; c++) newItem(p.name, p.slug, wide.id); }
    if (pi === 1) { let node = frontier[0]!.node; for (let d = 0; d < 6; d++) node = newItem(p.name, p.slug, node.id); }
    // A record owning backlog work, in two projects.
    if (pi < 2) {
      const rec = newItem(p.name, p.slug, undefined, true);
      rec.title = "待排工作 " + p.name;
      for (let c = 0; c < 3; c++) newItem(p.name, p.slug, rec.id);
    }
  }
  const all = () => [...items.values()];
  const leaves = () => all().filter(it => !it.children.length && !it.record);
  // Leaf states: the rules derive every parent's status from these.
  for (const it of leaves()) {
    const roll = r.next();
    it.leafKind = roll < 0.35 ? "done" : roll < 0.5 ? "wip" : roll < 0.62 ? "blocked" : "todo";
    if (roll > 0.94) it.status = "cancelled";
  }
  // Steps: text rows before the acceptance step; doing rows carry waits; some plans drop a step or run rows in parallel.
  for (const it of all()) {
    if (it.record) continue;
    const n = it.children.length ? r.int(2) : 1 + r.int(it.index % 9 === 0 ? 12 : 4);
    for (let s = 0; s < n; s++) {
      const state = it.leafKind === "done" ? (r.chance(0.15) ? "dropped" : "done") : it.leafKind === "wip" && s === n - 1 ? "doing" : it.leafKind === "todo" || it.leafKind === "blocked" ? (s === 0 && r.chance(0.5) ? "done" : "todo") : r.chance(0.5) ? "done" : "todo";
      it.steps.push({ id: "s" + (s + 1), text: r.pick(STEPS), state, ...(state === "dropped" ? { reason: "改由别的条目覆盖" } : {}), ...(state === "doing" && r.chance(0.5) ? { waits: "托管 CI 排队" } : {}) });
    }
    it.steps.push({ id: "accept", accept: true, text: "验收：" + r.pick(STEPS) + "，结果一致", state: it.leafKind === "done" ? "done" : "todo" });
    if (it.children.length && it.index % 3 === 0) it.provisional = true;
  }
  // Items in creation order; a shared row or card row only points to a later item, so no plan cycle can form.
  const order = all();
  const later = (it: ItemDraft, pred: (x: ItemDraft) => boolean) => order.filter(x => x.index > it.index && !x.record && x.id !== it.id && pred(x) && !ancestors(it.id).includes(x.id) && !it.children.includes(x.id));
  function ancestors(id: string): string[] { const out: string[] = []; for (let p = items.get(id)?.parent; p; p = items.get(p)?.parent) out.push(p); return out; }
  // Blocked leaves wait on a shared item, a third of them in another project.
  for (const it of order) {
    if (it.leafKind !== "blocked" && !r.chance(0.12)) continue;
    const pool = later(it, x => r.chance(0.33) ? x.group !== it.group : x.group === it.group);
    if (!pool.length) continue;
    const target = r.pick(pool);
    if (!it.extra.some(row => row.item === target.id)) it.extra.push({ id: target.id, item: target.id, own: false });
  }
  // Cards: 0–2 per open item, more ruled than open, some blocking; each is a row of its own item's plan.
  let cardSeq = 0;
  /** A card written in the current form. Only a card that blocks has a row; a closed card keeps the row it had, half of them. */
  function newCard(item: ItemDraft, status: CardDraft["status"], blocking = false, row = blocking || (status !== "open" && r.chance(0.5))): CardDraft {
    const id = `${item.id.replace(/[._]/g, "-")}-q${++cardSeq}`;
    const options = Array.from({ length: 2 + r.int(3) }, (_, k) => ({
      key: String.fromCharCode(65 + k), text: r.pick(VERBS) + r.pick(OBJECTS),
      detail: r.pick(STEPS) + "。代价是" + r.pick(OBJECTS) + "要多花一轮评审；" + (k === 0 ? "推荐，因为已有一次测量。" : "没有测量支持。"), ...(k === 0 ? { recommended: true } : {}),
    }));
    const at = tick();
    const card: CardDraft = { id, item: item.id, question: `${item.title.split(" ")[0]}：选哪种做法？`, options, status, confidence: { score: 1 + r.int(5), reason: "依据一次测量；换一台机器可能推翻。" }, at };
    if (blocking) card.blocks = "合并" + item.title.split(" ")[0] + "的修复";
    if (status === "ruled") {
      card.choice = "A"; card.ruledAt = tick();
      notes.push({ id: "n" + ++noteSeq, doc: { target: "q:" + id, kind: "choice", choice: "A", text: "选 A", at: card.at, sentAt: card.at, state: "done" } });
      if (r.chance(0.3)) card.ruling = "选 A：" + options[0]!.text;
      // Cards written before options had grounds keep their old text as the option's detail, with no name, and their background.
      if (r.chance(0.5)) convert(card, "背景：" + r.pick(SUBJECTS) + "在" + r.pick(OBJECTS) + "上出错。\n\n```sh\n# 复现\nrun --case " + cardSeq + "\n```");
    }
    cards.set(id, card); item.cards.push(id);
    if (row) item.extra.push({ id, card: id });
    return card;
  }
  /** The shape the migration gives an old card: the option text becomes the detail, the name stays empty, the background is legacy. */
  function convert(card: CardDraft, background: string) {
    if (!card.old) card.options = card.options.map(({ key, text, detail, recommended }) => ({ key, text: "", detail: text + "。" + detail, ...(recommended ? { recommended } : {}) }));
    card.legacy = { background }; card.old = true;
  }
  for (const it of order) {
    if (it.record || it.status) continue;
    const n = r.chance(0.35) ? 1 + r.int(2) : 0;
    for (let k = 0; k < n; k++) {
      const done = it.leafKind === "done";
      const status = done || r.chance(0.6) ? (r.chance(0.9) ? "ruled" : "withdrawn") : "open";
      newCard(it, status, status === "open" && r.chance(0.35));
    }
  }
  const open = (x: ItemDraft) => !x.record && !x.status && x.leafKind !== "done" && !x.children.length;
  const pickItem = (pred: (x: ItemDraft) => boolean) => { const pool = order.filter(pred); return pool[r.int(pool.length)]!; };
  // Witness shapes the random pass may miss.
  const p0 = PROJECTS[0].name, p1 = PROJECTS[1].name;
  const home = pickItem(x => open(x) && x.group === p0);
  const multiPlanCard = newCard(home, "open", true);
  const doneHome = pickItem(x => !x.record && !x.status && x.leafKind === "done");
  const donePlanCard = newCard(doneHome, "ruled", false, true);
  const otherHome = pickItem(x => open(x) && x.group === p1);
  const otherPlanCard = newCard(otherHome, "open");
  const record = order.find(x => x.record)!;
  const recordCard = newCard(record, "open");
  // An open blocking card on a done item: only it holds the item back.
  newCard(pickItem(x => x.leafKind === "done" && !x.status && !x.record), "open", true);
  // An open blocking card its head does not place, shown under its plan row when asked.
  const rowCard = newCard(pickItem(x => open(x) && x.group === p0 && x.id !== home.id), "open", true);
  // The old texts: a ruled card converted from the old form, one ruled in words (no choice), one withdrawn, an open one.
  const legacyCard = newCard(pickItem(x => open(x) && x.group === p0 && x.id !== home.id && x.id !== rowCard.item), "ruled");
  convert(legacyCard, "背景：旧卡的背景。");
  legacyCard.ruling = "选 A：旧卡的裁定。";
  const proseCard = newCard(pickItem(x => open(x) && x.group === p1 && x.id !== otherHome.id), "ruled");
  delete proseCard.choice; proseCard.ruling = "主人在对话里定了：先不做。";
  convert(proseCard, "背景：这张卡由主人用文字裁决。");
  const withdrawnCard = newCard(pickItem(x => open(x) && x.group === PROJECTS[2].name), "withdrawn");
  const openLegacyCard = newCard(pickItem(x => open(x) && x.group === p1 && x.id !== otherHome.id && x.id !== proseCard.item), "open", true);
  convert(openLegacyCard, "背景：待裁定的旧卡的背景。");
  // The comment witnesses: an open item and an open card its head places, each with listed comments.
  const commentItem = pickItem(x => open(x) && x.group === p0 && x.id !== home.id);
  const commentHome = pickItem(x => open(x) && x.group === PROJECTS[2].name);
  const commentCard = newCard(commentHome, "open");
  // Code blocks, tables, lists, references and glossary terms in heads.
  const code = pickItem(x => open(x) && x.group === p1);
  for (const it of order) {
    const parts = ["**问题**：" + r.pick(SUBJECTS) + "在" + r.pick(OBJECTS) + "上" + r.pick(VERBS) + "失败，复现见下。", "**做法**：" + r.pick(STEPS) + "。"];
    if (it === code || r.chance(0.17)) parts.push("```wf\n// 1. 读入\nlet x = read(input)\n// 2. 出错的那一行\nlet y = x.field\n```");
    if (r.chance(0.05)) parts.push("| 指标 | 之前 | 之后 |\n| --- | ---: | ---: |\n| p99 | 12 ms | 9 ms |");
    if (r.chance(0.2)) parts.push("- " + r.pick(STEPS) + "\n- " + r.pick(STEPS));
    if (r.chance(0.1)) { const other = r.pick(order); parts.push("参见 [[it:" + other.id + "]]。"); }
    if (r.chance(0.15)) parts.push("术语：" + (it.group === p0 ? "冷启动预算" : "回放窗口") + "。");
    // The code witness carries two 参考 sections at the end of its head, the way research reports sit there.
    if (it === code) parts.push("**参考：推导**\n\n推导的第一段。\n\n推导的第二段。\n\n**参考：测量**\n\n测量的正文。");
    // A card is placed by a line of its own: always the witnesses, otherwise about half of the open ones and a few closed ones.
    // The converted old cards are all placed in the section at the end, before any 参考 section, the way the migration does.
    const oldKeys: string[] = [];
    for (const key of it.cards) {
      const card = cards.get(key)!;
      if (key === otherPlanCard.id || key === rowCard.id) continue;
      if (card.old) oldKeys.push(key);
      else if (key === multiPlanCard.id) parts.splice(Math.min(1, parts.length), 0, "[[q:" + key + "]]");
      else if (key === commentCard.id || (card.status === "open" ? r.chance(0.5) : r.chance(0.15))) parts.push("[[q:" + key + "]]");
    }
    if (oldKeys.length) {
      const section = "**以前的决定**\n\n" + oldKeys.map(key => "[[q:" + key + "]]").join("\n\n"), refs = parts.findIndex(part => part.startsWith("**参考："));
      parts.splice(refs < 0 ? parts.length : refs, 0, section);
    }
    it.head = parts.join("\n\n");
    const nLog = it.index % 13 === 0 ? 25 : r.int(4);
    for (let k = 0; k < nLog; k++) it.log.push({ at: tick(), by: it.group, text: r.pick(STEPS) + "，" + r.pick(["完成", "进行中", "有新发现"]) + "。" });
    if (r.chance(0.2)) it.links.push({ label: "PR #" + (100 + it.index), url: `https://example.invalid/${it.group}/pull/${100 + it.index}` });
  }
  // Pauses: one root explicitly, its descendants by inheritance.
  const pausedRoot = roots.find(x => x.group === PROJECTS[3].name && x.children.length) ?? roots[3]!;
  pausedRoot.paused = { reason: "等主人确认排期", at: tick() };
  const unpaused = pickItem(x => open(x) && x.leafKind === "wip" && !ancestors(x.id).includes(pausedRoot.id));
  // Asks: one approval, one merge with a link, one in chat; one ask already approved.
  const asks = order.filter(x => open(x) && x !== commentItem).slice(0, 4);
  asks[0]!.ask = { text: "批准" + asks[0]!.title.split(" ")[0] + "的方案" };
  asks[1]!.ask = { text: "合并" + asks[1]!.title.split(" ")[0], url: "https://example.invalid/merge/1" };
  asks[2]!.ask = { text: "在对话里确认重启会话", chat: true };
  asks[3]!.ask = { text: "批准发布" };
  notes.push({ id: "n" + ++noteSeq, doc: { target: "it:" + asks[3]!.id, kind: "approve", text: "同意：批准发布", at: tick(), sentAt: tick(), state: "done", reply: "已按批准发布。", repliedAt: tick(), repliedBy: asks[3]!.group } });
  // Targets and data lines.
  for (const it of order.filter(x => !x.record).slice(5, 8)) { it.targets = [{ id: "p99", goal: "p99 延迟", target: "≤ 10 ms", current: "12 ms", baseline: "参照实现 9 ms", date: tick() }]; it.data = "p99 12 ms；吞吐 1.2 万次/秒"; }
  // Comments: on items and cards, with replies, anchors, explain requests, sent ones still waiting.
  const comment = (target: string, extra: Record<string, unknown> = {}) => notes.push({ id: "n" + ++noteSeq, doc: { target, kind: "comment", text: "这里" + r.pick(OBJECTS) + "为什么" + r.pick(VERBS) + "？", at: tick(), sentAt: tick(), state: "done", reply: "因为" + r.pick(SUBJECTS) + "还没" + r.pick(VERBS) + "。", repliedAt: tick(), repliedBy: "Kestrel", ...extra } });
  comment("it:" + commentItem.id); comment("it:" + commentItem.id);
  comment("q:" + commentCard.id);
  for (const it of order) if (r.chance(0.12)) comment("it:" + it.id, it.log[0] && r.chance(0.3) ? { anchor: { kind: "log", at: it.log[0].at } } : {});
  for (const c of cards.values()) if (r.chance(0.15)) comment("q:" + c.id);
  notes.push({ id: "n" + ++noteSeq, doc: { target: "it:" + unpaused.id, kind: "explain", text: "请详细解释这一项。", at: tick(), sentAt: tick(), state: "done", reply: "这一项把检查前移。", repliedAt: tick(), repliedBy: unpaused.group } });
  notes.push({ id: "n" + ++noteSeq, doc: { target: "it:" + code.id, kind: "comment", text: "还在等回复的评论", at: tick(), sentAt: tick(), state: "sent" } });
  // Roots carry priority; inbox requests come later, in the unread batches.
  for (const it of roots) it.priority = r.pick(["P0", "P1", "P1", "P2"]);
  for (const it of order) if (it.record) it.priority = undefined;

  const itemDoc = (it: ItemDraft): Record<string, unknown> => {
    const own = it.children.map(c => ({ id: c, item: c, own: true }));
    const rows: PlanRowDraft[] = [...own, ...it.steps.filter(s => !s.accept), ...it.extra, ...it.steps.filter(s => s.accept)];
    // Parallel groups: in every fifth plan, the rows before acceptance all follow the first row.
    if (it.index % 5 === 0 && rows.length > 3) for (let k = 2; k < rows.length - 1; k++) rows[k] = { ...rows[k]!, after: [rows[0]!.id] };
    const at = iso(30 + it.index);
    const plan = it.record ? rows.filter(row => !row.accept && row.text === undefined) : rows.map(row => {
      if (row.text === undefined) return row;
      const stamp = row.state === "done" ? { doneAt: at } : row.state === "doing" ? { since: at } : row.state === "dropped" ? { droppedAt: at } : {};
      return { ...row, ...stamp };
    });
    return {
      title: it.title, group: it.group, ...(it.record ? { record: true } : {}), ...(it.priority ? { priority: it.priority } : {}), ...(it.status ? { status: it.status } : {}),
      ...(it.paused ? { paused: it.paused } : {}), tags: it.tags, head: it.head, log: it.log, plan, ...(it.provisional ? { provisional: true } : {}),
      ...(it.targets ? { targets: it.targets } : {}), ...(it.data ? { data: it.data } : {}), links: it.links, ...(it.ask ? { ask: it.ask } : {}),
      ...(it.request ? { request: it.request } : {}), created: at, updated: at, order: it.index,
    };
  };
  const cardDoc = ({ id: _id, old: _old, ...c }: CardDraft): Record<string, unknown> => ({ ...c, updated: c.ruledAt ?? c.at });
  const batches: Batch[] = [];
  batches.push({ message: "Seed generated board", puts: [
    ...all().map(it => ({ kind: "item" as const, id: it.id, doc: itemDoc(it) })),
    ...[...cards.values()].map(c => ({ kind: "decision" as const, id: c.id, doc: cardDoc(c) })),
    ...notes.map(n => ({ kind: "note" as const, id: n.id, doc: n.doc })),
    { kind: "glossary", id: p0, doc: { terms: [{ term: "冷启动预算", definition: "进程启动到第一次回复允许花的时间。", updated: tick(), by: p0 }] } },
    { kind: "glossary", id: p1, doc: { terms: [{ term: "回放窗口", definition: "重放日志时一次读入的条数。", updated: tick(), by: p1 }] } },
  ] });
  // Read history: progress and rulings the owner has seen.
  const touched = order.filter((_, k) => k % 6 === 1);
  batches.push({ message: "Progress the owner read", puts: touched.map(it => ({ kind: "item" as const, id: it.id, doc: { ...itemDoc(it), log: [...it.log, { at: tick(), by: it.group, text: "已读的进展。" }], updated: tick() } })) });
  const readBefore = batches.length;
  // Unread history, several commits: progress on plans, new replies, new cards, new items, inbox requests.
  const progressed = order.filter((x, k) => k % 9 === 4 && !x.record && x.steps.some(s => s.state === "todo" && !s.accept));
  batches.push({ message: "Unread plan progress", puts: progressed.map(it => {
    const doc = itemDoc(it), plan = (doc.plan as Array<Record<string, unknown>>).map(row => row.state === "todo" && !row.accept ? { ...row, state: "doing", since: tick() } : row);
    return { kind: "item" as const, id: it.id, doc: { ...doc, plan, updated: tick() } };
  }) });
  // Unread content on a cancelled item the tree hides: n and the new-content counts must pass over it.
  const hiddenFresh = pickItem(x => x.status === "cancelled" && x.children.length === 0 && !x.record);
  batches.push({ message: "Unread change on a hidden cancelled item", puts: [{ kind: "item" as const, id: hiddenFresh.id, doc: { ...itemDoc(hiddenFresh), title: hiddenFresh.title + "（改）", updated: tick() } }] });
  // Unread changes at several depths, at both ends of the tree and in the middle: n must wrap from the bottom row to the
  // first of them, and a lap of n must pass each once.
  const depthOf = (x: ItemDraft) => ancestors(x.id).length;
  const touchable = order.filter(x => !x.record && !x.status && !ancestors(x.id).some(a => items.get(a)!.status));
  const lastGroup = PROJECTS[PROJECTS.length - 1]!.name;
  const spread = [touchable.find(x => x.group === p0 && depthOf(x) === 0), touchable.filter(x => x.group === p0 && depthOf(x) === 2)[0], touchable.filter(x => x.group === p1 && depthOf(x) === 3)[0],
    touchable.filter(x => x.group === lastGroup && depthOf(x) === 1).at(-1), touchable.filter(x => x.group === lastGroup && depthOf(x) === 3).at(-1), touchable.filter(x => x.group === lastGroup).at(-1)].filter((x): x is ItemDraft => !!x);
  batches.push({ message: "Unread changes at several depths", puts: [...new Set(spread)].map(it => ({ kind: "item" as const, id: it.id, doc: { ...itemDoc(it), title: it.title + "（改）", updated: tick() } })) });
  const replied = notes.filter((n, k) => n.doc.kind === "comment" && n.doc.reply && k % 3 === 0).slice(0, 6);
  batches.push({ message: "Unread replies", puts: replied.map(n => ({ kind: "note" as const, id: n.id, doc: { ...n.doc, reply: "补充：" + n.doc.reply, repliedAt: tick() } })) });
  const newHome = pickItem(x => open(x) && x.group === PROJECTS[2].name && x !== commentHome);
  const freshCard = newCard(newHome, "open", true);
  batches.push({ message: "Unread new card", puts: [
    { kind: "decision", id: freshCard.id, doc: cardDoc(freshCard) },
    { kind: "item", id: newHome.id, doc: { ...itemDoc(newHome), updated: tick() } },
  ] });
  const parentOfNew = pickItem(x => x.children.length > 0 && !x.record && x.group === PROJECTS[1].name && !x.status);
  const child = newItem(parentOfNew.group, "lum", parentOfNew.id);
  child.steps = [{ id: "s1", text: r.pick(STEPS), state: "todo" }, { id: "accept", accept: true, text: "验收：新条目通过", state: "todo" }];
  const inbox = ([[PROJECTS[2], PROJECTS[0]], [PROJECTS[3], PROJECTS[1]]] as const).map(([to, by]) => { const it = newItem(to.name, to.slug); it.request = { by: by.name, at: tick() }; it.steps = [{ id: "accept", accept: true, text: "验收：请求的需要满足", state: "todo" }]; it.priority = "P1"; return it; });
  batches.push({ message: "Unread new items and requests", puts: [
    { kind: "item", id: child.id, doc: itemDoc(child) },
    { kind: "item", id: parentOfNew.id, doc: { ...itemDoc(parentOfNew), updated: tick() } },
    ...inbox.map(it => ({ kind: "item" as const, id: it.id, doc: itemDoc(it) })),
  ] });
  return {
    board: { title: "合成看板", eyebrow: "状态看板", goal: "合成数据：结构像真实看板，文字全是生成的。", projects: PROJECTS.map(p => ({ name: p.name, ...("repo" in p ? { repo: p.repo } : {}) })), tags: TAGS.map(t => ({ ...t })) },
    batches, readBefore,
    witness: { code: code.id, commentItem: commentItem.id, commentCard: commentCard.id, multiPlanCard: multiPlanCard.id, donePlanCard: donePlanCard.id, otherPlanCard: otherPlanCard.id, rowCard: rowCard.id, recordCard: recordCard.id, legacyCard: legacyCard.id, proseCard: proseCard.id, withdrawnCard: withdrawnCard.id, openLegacyCard: openLegacyCard.id, pausedRoot: pausedRoot.id, unpaused: unpaused.id, hiddenFresh: hiddenFresh.id },
  };
}
