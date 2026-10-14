// Invariants over every kind of clickable thing on the owner's page: each check clicks like the owner, then compares
// where the page landed with what the element claims, computed independently from the stored board with the shared
// rules (src/rules.ts) and the server's unread history (src/history.ts). A check returns its violations, each opening
// with the family name, so a test can assert none and a regression witness can assert the one its bug causes.

import { rules } from "../../src/rules.ts";
import type { Rules } from "../../src/rules.ts";
import { unreadSteps } from "../../src/history.ts";
import type { Snapshot } from "../../src/model.ts";
import type { Store } from "../../src/store.ts";
import type { BoardPage, BoardServer } from "./harness.ts";
import { prng } from "./board-gen.ts";

export interface Oracle {
  s: Snapshot; r: Rules;
  /** An item and every item its plans own, transitively. */
  subtree(id: string): Set<string>;
  /** What the purple and red numbers after an item's title count: "ask:<item>" and "q:<card>". */
  purple(id: string): string[]; red(id: string): string[];
  /** Every wait in the header's 阻塞 and 决策卡 numbers. */
  blocking(): string[]; plainCards(): string[];
  /** Items holding unread content (their own changes, their cards', comments on either), and the unread documents. */
  fresh: Set<string>; docs: Set<string>;
  /** The items under (or equal to) an item that hold unread content: what its blue number counts. */
  freshUnder(id: string): string[];
  /** The number of units the header's 新 number counts. */
  units: number;
}

export async function oracle(store: Store): Promise<Oracle> {
  const s = store.snapshot(), r = rules(s);
  const subtree = (id: string) => { const seen = new Set<string>(); const walk = (v: string) => { if (seen.has(v)) return; seen.add(v); r.children(v).forEach(walk); }; walk(id); return seen; };
  const cardsIn = (sub: Set<string>, pred: (k: string) => boolean) => Object.keys(s.decisions).filter(k => sub.has(s.decisions[k]!.item) && pred(k)).map(k => "q:" + k);
  const steps = await unreadSteps(store, s.owner.cursor, s.owner.readMarks, s.head);
  const fresh = new Set<string>(), docs = new Set<string>(), units = new Set<string>();
  for (const step of steps) for (const d of step.docs) {
    docs.add(d.kind + ":" + d.id);
    let item: string | undefined, card: string | undefined;
    if (d.kind === "item") item = d.id;
    else if (d.kind === "decision") { card = d.id; item = s.decisions[d.id]?.item; }
    else if (d.kind === "note") { const target = s.notes[d.id]?.target; if (target?.startsWith("q:")) { card = target.slice(2); item = s.decisions[card]?.item; } else item = target?.slice(3); }
    if (item && s.items[item]) { fresh.add(item); units.add("it:" + item); }
    else units.add(card && s.decisions[card] ? "q:" + card : d.kind + ":" + d.id);
  }
  return {
    s, r, subtree,
    purple: id => { const sub = subtree(id); return [...[...sub].filter(v => r.askPending(v)).map(v => "ask:" + v), ...cardsIn(sub, k => r.cardBlocking(k))]; },
    red: id => cardsIn(subtree(id), k => r.cardWaiting(k) && !r.cardBlocking(k)),
    blocking: () => [...Object.keys(s.items).filter(v => r.askPending(v)).map(v => "ask:" + v), ...Object.keys(s.decisions).filter(k => r.cardBlocking(k)).map(k => "q:" + k)],
    plainCards: () => Object.keys(s.decisions).filter(k => r.cardWaiting(k) && !r.cardBlocking(k)).map(k => "q:" + k),
    fresh, docs, units: units.size,
    freshUnder: id => [...fresh].filter(y => y === id || r.ancestors(y).includes(id)),
  };
}

const q = (s: string) => s.replace(/["\\]/g, "\\$&");
const sameSet = (a: Iterable<string>, b: Iterable<string>) => { const x = [...new Set(a)].sort(), y = [...new Set(b)].sort(); return x.length === y.length && x.every((v, i) => v === y[i]); };
async function attempt(v: string[], what: string, fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return true; } catch (e) { v.push(`${what}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`); return false; }
}
/** Where a wait landed: the current card, or an item's own request when no card is current. */
async function landing(bp: BoardPage): Promise<string> {
  const cards = await bp.currentCards(), sel = await bp.selected();
  if (cards.length === 1) return "q:" + cards[0];
  if (cards.length > 1) return "several current cards: " + cards.join(",");
  return sel && await bp.page.locator(`#item-detail [id="ask-${q(sel)}"]`).count() ? "ask:" + sel : "nothing current (selected " + sel + ")";
}
/** The item a wait belongs to. */
function homeOf(o: Oracle, wait: string): string | undefined { return wait.startsWith("ask:") ? wait.slice(4) : o.s.decisions[wait.slice(2)]?.item; }

/** Every tree row's title selects that item and shows its detail. */
export async function checkTreeRows(bp: BoardPage, _o: Oracle): Promise<string[]> {
  const v: string[] = [];
  for (const id of await bp.treeRows()) {
    if (!await attempt(v, `tree-row ${id}`, () => bp.head(id).locator(".item-title").click())) continue;
    await bp.settle();
    const sel = await bp.selected();
    if (sel !== id) v.push(`tree-row: clicking ${id}'s title selected ${sel}`);
    else if (!await bp.page.locator(`#item-detail [id="detail-it-${q(id)}"].cur`).count()) v.push(`tree-row: ${id} selected but its detail is not the current selection`);
  }
  return v;
}

/** Plan rows in an item's detail: an item row goes to its item and Back returns; a card row unfolds that card right
 * under the row without changing the selected item; a step row selects the step and keeps the item. */
export async function checkPlanRows(bp: BoardPage, o: Oracle, items: string[]): Promise<string[]> {
  const v: string[] = [], page = bp.page;
  const ensure = async (x: string) => { if (await bp.selected() !== x) await bp.select(x); return await bp.selected() === x; };
  for (const x of items) {
    if (!await ensure(x)) { v.push(`plan: could not select ${x}`); continue; }
    const plan = o.s.items[x]!.plan;
    const firstOwn = plan.find(row => "item" in row && row.own);
    const firstStep = plan.find(row => "text" in row);
    for (const row of plan) {
      const el = "plan-" + encodeURIComponent(JSON.stringify([x, row.id])), sel = `#item-detail [id="${q(el)}"]`;
      if ("item" in row) {
        if (row.own && row !== firstOwn) continue;
        if (!await ensure(x)) { v.push(`plan: could not reselect ${x}`); break; }
        if (!await attempt(v, `plan-item-row ${x}→${row.item}`, () => page.locator(sel + " .plan-main a.plan-link").click())) continue;
        await bp.settle();
        const got = await bp.selected();
        if (got !== row.item) { v.push(`plan-item-row: in ${x}'s plan, the row for ${row.item} selected ${got}`); continue; }
        if (!await attempt(v, `back from ${row.item} to ${x}`, () => page.locator("#backbtn").click())) continue;
        await bp.settle();
        if (await bp.selected() !== x) v.push(`back: after following ${row.item} from ${x}'s plan, 返回 selected ${await bp.selected()}`);
      } else if ("card" in row) {
        if (!await ensure(x)) { v.push(`plan: could not reselect ${x}`); break; }
        const card = row.card, home = o.s.decisions[card]?.item;
        const after = () => page.evaluate(([rowId, c]) => { const next = document.getElementById(rowId!)?.nextElementSibling; return !!next && next.id === "q-" + c && (next as HTMLElement).offsetParent !== null; }, [el, card]);
        const click = () => attempt(v, `plan-card-row ${x}→${card}`, () => page.locator(sel + " .plan-main a").first().click());
        if (await after()) { if (!await click()) continue; await bp.settle(); }
        if (!await click()) continue;
        await bp.settle();
        const got = await bp.selected();
        if (got !== x) v.push(`plan-card-row: in ${x}'s plan, clicking card ${card} (home ${home}${home === x ? "" : ", status " + (o.r.statusOf(home ?? "") ?? "record")}) switched the selected item to ${got} instead of unfolding the card under the row`);
        else if (!await after()) v.push(`plan-card-row: in ${x}'s plan, clicking card ${card} did not unfold that card right under its row`);
      } else if (row === firstStep) {
        if (!await ensure(x)) continue;
        if (!await attempt(v, `plan-step-row ${x}@${row.id}`, () => page.locator(sel + " > .g").click())) continue;
        await bp.settle();
        if (await bp.selected() !== x) v.push(`plan-step-row: clicking step ${row.id} of ${x} selected ${await bp.selected()}`);
        else if (!await page.locator(sel + ".cur").count()) v.push(`plan-step-row: clicking step ${row.id} of ${x} did not make it the current selection`);
      }
    }
  }
  return v;
}

/** The 被依赖 rows of an item's detail list exactly its open dependents through shared rows; each selects its item and
 * Back returns. */
export async function checkDependents(bp: BoardPage, o: Oracle, items: string[]): Promise<string[]> {
  const v: string[] = [], page = bp.page;
  for (const x of items) {
    const ws = o.r.dependents(x).filter(d => !d.own).map(d => d.id).filter(id => o.s.items[id] && o.r.statusOf(id) !== "cancelled");
    await bp.select(x);
    const rows = page.locator("#item-detail .deplists .deprow");
    const n = await rows.count();
    if (n !== ws.length) { v.push(`dep-row: ${x} lists ${n} dependents, expected ${ws.length} (${ws.join(",")})`); continue; }
    for (let i = 0; i < n; i++) {
      if (await bp.selected() !== x) await bp.select(x);
      if (!await attempt(v, `dep-row ${x}#${i}`, () => rows.nth(i).click())) continue;
      await bp.settle();
      const got = await bp.selected();
      if (got !== ws[i]) { v.push(`dep-row: ${x}'s dependent row ${i} selected ${got}, expected ${ws[i]}`); continue; }
      if (!await attempt(v, `back to ${x}`, () => page.locator("#backbtn").click())) continue;
      await bp.settle();
      if (await bp.selected() !== x) v.push(`back: after following dependent ${ws[i]} from ${x}, 返回 selected ${await bp.selected()}`);
    }
  }
  return v;
}

/** The purple and red numbers after each tree title equal the waits in that item's owned subtree; clicking a number as
 * many times as it says visits each of those waits once, each in its own item. */
export async function checkBadges(bp: BoardPage, o: Oracle): Promise<string[]> {
  const v: string[] = [];
  for (const id of await bp.treeRows()) {
    for (const [cls, expected, name] of [["waittag", o.purple(id), "purple"], ["asktag", o.red(id), "red"]] as const) {
      const chip = bp.head(id).locator(":scope > ." + cls);
      const shown = await chip.count();
      if (!expected.length) { if (shown) v.push(`badge-count: ${id} shows a ${name} number with nothing to count`); continue; }
      if (!shown) { v.push(`badge-count: ${id} has ${expected.length} ${name} waits but no number`); continue; }
      const text = Number(await chip.textContent());
      if (text !== expected.length) v.push(`badge-count: ${id}'s ${name} number says ${text}, its subtree holds ${expected.length}: ${expected.join(",")}`);
      const visited: string[] = [];
      for (let k = 0; k < expected.length; k++) {
        if (!await attempt(v, `badge ${name} ${id}`, () => chip.click())) break;
        await bp.settle();
        const got = await landing(bp), sel = await bp.selected();
        visited.push(got);
        if (!expected.includes(got)) v.push(`badge-landing: ${name} number of ${id} went to ${got} (item ${sel}, project ${o.s.items[sel ?? ""]?.group}), not one of its waits ${expected.join(",")}`);
        else if (sel !== homeOf(o, got)) v.push(`badge-landing: ${name} number of ${id} showed ${got} but selected item ${sel}`);
      }
      if (!sameSet(visited, expected) && visited.every(w => expected.includes(w))) v.push(`badge-landing: ${expected.length} clicks on ${id}'s ${name} number visited ${[...new Set(visited)].join(",")}, missing ${expected.filter(w => !visited.includes(w)).join(",")}`);
    }
  }
  return v;
}

/** The header's 阻塞 and 决策卡 numbers, and the wait panel's rows, cover exactly the board's waits. */
export async function checkWaitPanel(bp: BoardPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], page = bp.page, blocking = o.blocking(), plain = o.plainCards();
  const label = async (cls: string) => { const b = page.locator("#summary .sbtn." + cls); return await b.count() ? Number((await b.textContent())!.match(/\d+/)![0]) : 0; };
  if (await label("s-block") !== blocking.length) v.push(`wait-count: 阻塞 says ${await label("s-block")}, the board has ${blocking.length} blocking waits`);
  if (await label("s-wait") !== plain.length) v.push(`wait-count: 决策卡 says ${await label("s-wait")}, the board has ${plain.length} waiting cards`);
  const rows = page.locator("#wait-panel .waitrow"), n = await rows.count();
  if (n !== blocking.length) v.push(`wait-count: the wait panel has ${n} rows for ${blocking.length} blocking waits`);
  const seen: string[] = [];
  for (let i = 0; i < n; i++) {
    if (!await attempt(v, `wait-row ${i}`, () => rows.nth(i).click())) continue;
    await bp.settle();
    const got = await landing(bp); seen.push(got);
    if (!blocking.includes(got)) v.push(`wait-landing: wait panel row ${i} went to ${got}, not a blocking wait`);
    else if (await bp.selected() !== homeOf(o, got)) v.push(`wait-landing: wait panel row ${i} showed ${got} but selected ${await bp.selected()}`);
  }
  if (n === blocking.length && !sameSet(seen, blocking)) v.push(`wait-landing: the wait panel rows reached ${seen.join(",")}, the blocking waits are ${blocking.join(",")}`);
  return v;
}

/** Each blue number counts the items under it holding unread content and leads to one of them; the header's 新 number
 * counts every unit; n walks every item holding unread content, landing on nothing else, and each landing is a row
 * the tree shows: a done or cancelled item holding unread content stays in the tree, dimmed, until read. */
export async function checkFresh(bp: BoardPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], page = bp.page;
  const head = page.locator("#unread-row .sbtn.s-new"), total = await head.count() ? Number((await head.textContent())!.match(/\d+/)![0]) : 0;
  if (total !== o.units) v.push(`new-count: 新 says ${total}, the unread history holds ${o.units} units`);
  for (const id of await bp.treeRows()) {
    const expected = o.freshUnder(id), chip = bp.head(id).locator(":scope > .freshchip");
    if (!await chip.count()) { if (expected.length) v.push(`fresh-count: ${id} has ${expected.length} items with unread content under it but no blue number`); continue; }
    const n = Number(await chip.textContent());
    if (n !== expected.length) v.push(`fresh-count: ${id}'s blue number says ${n}, expected ${expected.length}: ${expected.join(",")}`);
    if (!await attempt(v, `fresh ${id}`, () => chip.click())) continue;
    await bp.settle();
    const sel = await bp.selected();
    if (!sel || !expected.includes(sel)) v.push(`fresh-landing: ${id}'s blue number went to ${sel}, not one of ${expected.join(",")}`);
  }
  const visited = new Set<string>();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  for (let k = 0; k < 4 * o.docs.size + 4; k++) {
    await page.keyboard.press("n"); await bp.settle();
    const sel = await bp.selected();
    if (sel && !o.fresh.has(sel)) v.push(`n-walk: n landed on ${sel}, which holds no unread content`);
    if (sel && !await bp.row(sel).count()) v.push(`n-walk: n landed on ${sel}, which the left tree does not show`);
    if (sel) visited.add(sel);
    if ([...o.fresh].every(id => visited.has(id))) break;
  }
  const missed = [...o.fresh].filter(id => !visited.has(id));
  if (missed.length) v.push(`n-walk: ${4 * o.docs.size + 4} presses of n never reached ${missed.join(",")}`);
  return v;
}

const STATUS_LABELS: Record<string, string> = { 进行中: "wip", 卡住: "blocked", 暂停: "paused", 未开始: "todo", 完成: "done", 取消: "cancelled" };
/** Each project's filter buttons: the number on a button counts its matches in that project; pressed, the tree shows
 * every match whose owners are in the project, undimmed, and dims or hides everything else of the project. */
export async function checkFilters(bp: BoardPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], page = bp.page, tags = new Set((o.s.board.tags ?? []).map(t => t.name));
  for (const { name: g } of o.s.board.projects) {
    const section = page.locator(`#areas section.group[data-group="${q(g)}"]`);
    if (!await section.count()) continue;
    const labels = await section.locator(".grp-filters .sbtn").allTextContents();
    for (const text of labels) {
      const m = text.match(/^(.*) (\d+)$/); if (!m) continue;
      const [, label, count] = m as unknown as [string, string, string];
      // The number counts every item of the project the filter names; pressed, a tag or check filter keeps only the
      // open ones among them (closed items show under the status filters).
      const status = STATUS_LABELS[label], ended = (id: string) => /^(done|cancelled)$/.test(o.r.statusOf(id) ?? "");
      const counted: ((id: string) => boolean) | undefined = status ? id => o.r.statusOf(id) === status
        : label === "需核对" ? id => o.r.checks(id).length > 0 : tags.has(label) ? id => !!o.s.items[id]!.tags?.includes(label) : undefined;
      if (!counted) continue;
      const pred = status ? counted : (id: string) => counted(id) && !ended(id);
      const all = Object.keys(o.s.items).filter(id => o.s.items[id]!.group === g && counted(id)), ids = all.filter(pred);
      if (Number(count) !== all.length) v.push(`filter-count: ${g} 「${label}」 says ${count}, the project has ${all.length}`);
      const button = () => page.locator(`#areas section.group[data-group="${q(g)}"] .grp-filters .sbtn`, { hasText: new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\d+$") }).first();
      if (!await attempt(v, `filter ${g} ${label}`, () => button().click())) continue;
      await bp.settle();
      const rows = await page.evaluate(() => [...document.querySelectorAll("#areas .item")].map(e => ({ id: e.id.slice(3), ctx: e.classList.contains("ctx") })));
      const shown = new Set(rows.filter(row => !row.ctx).map(row => row.id));
      for (const row of rows) if (!row.ctx && o.s.items[row.id]?.group === g && !pred(row.id)) v.push(`filter-sound: ${g} 「${label}」 shows ${row.id} undimmed, which does not match`);
      for (const id of ids) if (o.r.ancestors(id).every(a => o.s.items[a]!.group === g) && !shown.has(id)) v.push(`filter-complete: ${g} 「${label}」 hides its match ${id}`);
      if (!await attempt(v, `unfilter ${g} ${label}`, () => button().click())) continue;
      await bp.settle();
    }
  }
  return v;
}

/** The "/" search finds an item or card by its short number first, and choosing it shows that item, or that card in its item. */
export async function checkSearch(bp: BoardPage, o: Oracle, seed = 7): Promise<string[]> {
  const v: string[] = [], page = bp.page, r = prng(seed), w = bp.board.gen.witness;
  const items = Object.keys(o.s.items), cards = Object.keys(o.s.decisions);
  const targets: Array<["item" | "card", string]> = [
    ...[...new Set([...Array.from({ length: 10 }, () => r.pick(items)), ...items.filter(id => o.r.statusOf(id) === "done").slice(0, 3), ...items.filter(id => o.s.items[id]!.record)])].map(id => ["item", id] as ["item", string]),
    ...[...new Set([w.multiPlanCard, w.donePlanCard, w.otherPlanCard, w.recordCard, w.commentCard, ...Array.from({ length: 5 }, () => r.pick(cards))])].map(id => ["card", id] as ["card", string]),
  ];
  for (const [kind, key] of targets) {
    const doc = kind === "item" ? o.s.items[key]! : o.s.decisions[key]!, title = kind === "item" ? o.s.items[key]!.title : o.s.decisions[key]!.question.split("\n")[0]!;
    if (!await attempt(v, `search ${key}`, () => bp.search("#" + doc.num))) continue;
    const first = page.locator("#search .searchrow").first();
    if (!(await first.textContent() ?? "").includes(title.replace(/[*`]/g, ""))) { v.push(`search: #${doc.num} does not list ${kind} ${key} first`); await page.keyboard.press("Escape"); continue; }
    await page.keyboard.press("Enter"); await bp.settle();
    const sel = await bp.selected();
    if (kind === "item" && sel !== key) v.push(`search: choosing item ${key} selected ${sel}`);
    if (kind === "card") {
      const home = o.s.decisions[key]!.item;
      if (o.s.items[home] && sel !== home) v.push(`search: choosing card ${key} selected item ${sel}, its home is ${home}`);
      if (!(await bp.currentCards()).includes(key)) v.push(`search: choosing card ${key} did not show it as the current card`);
    }
  }
  return v;
}

/** Writing a comment, on an item and on a card whose comment lists the owner folded: the saved draft and its send
 * button are in view, and the send button sends that comment. */
export async function checkComments(bp: BoardPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], page = bp.page, store = bp.board.store, w = bp.board.gen.witness;
  const flow = async (target: string, open: () => Promise<void>) => {
    await open(); await bp.settle();
    const box = page.locator(`[id="ed-${target.replace(/[^A-Za-z0-9_-]/g, "_")}"]`);
    if (!await box.count()) { v.push(`comment-open: no comment field opened for ${target}`); return; }
    const text = "e2e 评论 " + target + " " + Date.now();
    const base = await bp.changes();
    await box.fill(text); await box.press("Enter");
    await bp.waitChanges(base + 1);
    const note = Object.entries(store.snapshot().notes).find(([, n]) => n.target === target && n.text === text);
    if (!note) { v.push(`comment-save: saving on ${target} stored no draft`); return; }
    const el = page.locator(`[id="note-${note[0].replace(/[^A-Za-z0-9_-]/g, "_")}"]`), send = el.locator(":scope > .cardsend");
    if (!await el.isVisible() || !await send.isVisible()) { v.push(`comment-hidden: after saving a comment on ${target}, the draft ${await el.isVisible() ? "shows but its 发送 button is hidden" : "is not in view (its comment list stayed folded)"}`); return; }
    const before = await bp.changes();
    await send.click(); await bp.waitChanges(before + 1);
    if (store.snapshot().notes[note[0]]?.state !== "sent") v.push(`comment-send: 发送 under the draft on ${target} did not send it`);
    else if (!(await el.locator(":scope > .who").textContent() ?? "").includes("已发送")) v.push(`comment-send: the sent comment on ${target} does not say it was sent`);
  };
  await flow("it:" + w.commentItem, async () => { await bp.select(w.commentItem); await page.locator("#item-detail .item-comment").click(); });
  const card = w.commentCard, home = o.s.decisions[card]!.item;
  await flow("q:" + card, async () => {
    await bp.select(home);
    const cardBox = page.locator(`#item-detail [id="q-${q(card)}"]`);
    if (!await cardBox.count()) { await page.locator(`#item-detail [id="${q("plan-" + encodeURIComponent(JSON.stringify([home, card])))}"] a.cardtoggle`).click(); await bp.settle(); }
    await cardBox.locator(".card-top h3").click(); await bp.settle();
    await page.keyboard.press("c");
  });
  return v;
}

/** Code blocks are set in Monaco at 13.5px, and the inner code element inherits the block's font. */
export async function checkCodeFont(bp: BoardPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], x = bp.board.gen.witness.code;
  await bp.select(x);
  const f = await bp.page.evaluate(() => {
    const pre = document.querySelector("#item-detail .rich pre.code"), code = pre?.querySelector("code");
    if (!pre || !code) return null;
    const a = getComputedStyle(pre), b = getComputedStyle(code);
    return { preFamily: a.fontFamily, preSize: a.fontSize, codeFamily: b.fontFamily, codeSize: b.fontSize };
  });
  if (!f) return [`code-font: ${x} (${o.s.items[x]!.title}) shows no code block`];
  if (f.preFamily.split(",")[0]!.trim().replace(/["']/g, "") !== "Monaco") v.push(`code-font: a code block's font is ${f.preFamily}, not Monaco first`);
  if (f.preSize !== "13.5px") v.push(`code-font: a code block is ${f.preSize}, not 13.5px`);
  if (f.codeFamily !== f.preFamily || f.codeSize !== f.preSize) v.push(`code-font: the code text inside a block is set in ${f.codeFamily} ${f.codeSize}, not the block's ${f.preFamily} ${f.preSize}`);
  return v;
}

/** No empty row under an item's title: every part of the detail after its head row carries text. */
export async function checkEmptyRows(bp: BoardPage, items: string[]): Promise<string[]> {
  const v: string[] = [];
  for (const x of items) {
    await bp.select(x);
    const empty = await bp.page.evaluate(() => {
      const box = document.querySelector("#item-detail > .item");
      return box ? [...box.children].slice(1).filter(e => !(e.textContent ?? "").trim()).map(e => e.className || e.tagName) : ["no detail"];
    });
    for (const e of empty) v.push(`empty-row: ${x}'s detail has an empty ${e} under its title`);
  }
  return v;
}

/** Tag chips name the item's tags, and their text contrasts with what is behind it at least 4.5:1 (WCAG AA), in
 * light and dark themes. Chips in dimmed rows (a context row of a filter, a closed item on the path to open work) are
 * faded on purpose and left out. */
export async function checkTagChips(bp: BoardPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], page = bp.page;
  const texts = await page.evaluate(() => [...document.querySelectorAll("#areas .item")].map(e => ({ id: e.id.slice(3), tags: [...e.querySelectorAll(":scope > .item-row .tagchip")].map(t => t.textContent) })));
  for (const { id, tags } of texts) if (JSON.stringify(tags) !== JSON.stringify(o.s.items[id]?.tags ?? [])) v.push(`tag-text: ${id}'s chips say ${tags.join(",")}, its tags are ${(o.s.items[id]?.tags ?? []).join(",")}`);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const low = await page.evaluate(() => {
      const rgba = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0]!, g: p[1]!, b: p[2]!, a: p.length > 3 ? p[3]! : 1 }; };
      const lum = (c: { r: number; g: number; b: number }) => { const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const over = (top: { r: number; g: number; b: number; a: number }, under: { r: number; g: number; b: number }) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a) });
      const out: string[] = [];
      for (const chip of document.querySelectorAll<HTMLElement>(".tagchip")) {
        if (!chip.offsetParent) continue;
        let faded = false, layers: Array<{ r: number; g: number; b: number; a: number }> = [];
        for (let e: Element | null = chip; e; e = e.parentElement) {
          const st = getComputedStyle(e);
          if (Number(st.opacity) < 1) faded = true;
          const bg = rgba(st.backgroundColor);
          if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
        }
        if (faded) continue;
        let base = { r: 255, g: 255, b: 255 };
        if (!layers.length || layers.at(-1)!.a < 1) base = (() => { const c = rgba(getComputedStyle(document.body).backgroundColor); return c ? { r: c.r, g: c.g, b: c.b } : base; })();
        for (const layer of layers.reverse()) base = over(layer, base);
        const fg = rgba(getComputedStyle(chip).color)!, text = over(fg, base);
        const [a, b] = [lum(text), lum(base)].sort((x, y) => y - x);
        const ratio = (a! + 0.05) / (b! + 0.05);
        if (ratio < 4.5) out.push(`${chip.closest("[id]")?.id ?? "?"} 「${chip.textContent}」 ${ratio.toFixed(2)}:1 (${getComputedStyle(chip).color} on rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)}))`);
      }
      return out;
    });
    for (const l of low) v.push(`tag-contrast (${scheme}): ${l}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  return v;
}

/** A burst of writes, as sessions make them, that touch items other than the one under test: two new waits on the
 * first item in board order (so every later wait moves), progress, log lines, a ruling, replies and a new item. Returns
 * how many commits it made, for waiting on the page's event stream. */
export async function burst(board: BoardServer, round: number): Promise<number> {
  const store = board.store, s = store.snapshot(), r = rules(s), w = board.gen.witness, rnd = prng(100 + round);
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const keep = new Set<string>([...Object.values(w)]);
  const ids = Object.keys(s.items).filter(id => !keep.has(id) && !s.items[id]!.record);
  let commits = 0;
  const commit = async (message: string, puts: Parameters<Store["commit"]>[0]["puts"]) => { await store.commit({ author: "Burst", message, puts }); commits++; };
  const first = r.areas()[0]!;
  const card = (k: string, blocks?: string) => ({ kind: "decision" as const, id: `burst${round}-${k}`, expectRev: null, doc: { item: first, question: `第 ${round} 轮新问题 ${k}？`, background: "突发写入。", options: [{ key: "A", text: "做" }, { key: "B", text: "不做" }], status: "open", ...(blocks ? { blocks } : {}), at, updated: at } });
  await commit("burst: new waits on the first item", [card("block", "合并突发修复"), card("plain")]);
  for (let k = 0; k < 4; k++) {
    const id = rnd.pick(ids), it = store.snapshot().items[id]!, { rev, ...doc } = it;
    await commit("burst: log", [{ kind: "item", id, expectRev: rev, doc: { ...doc, log: [...it.log, { at, by: it.group, text: "突发写入的日志。" }], updated: at } }]);
  }
  for (const id of ids.filter(id => store.snapshot().items[id]!.plan.some(row => "state" in row && row.state === "todo" && !row.accept)).slice(round * 2, round * 2 + 2)) {
    const it = store.snapshot().items[id]!, { rev, ...doc } = it;
    let flipped = false;
    const plan = it.plan.map(row => !flipped && "state" in row && row.state === "todo" && !row.accept ? (flipped = true, { ...row, state: "doing" as const, since: at }) : row);
    await commit("burst: progress", [{ kind: "item", id, expectRev: rev, doc: { ...doc, plan, updated: at } }]);
  }
  const open = Object.keys(s.decisions).filter(k => r.cardWaiting(k) && !keep.has(k) && !k.startsWith("burst"));
  const ruled = open[(round * 5) % Math.max(1, open.length)];
  if (ruled) {
    const d = s.decisions[ruled]!, { rev, ...doc } = d;
    await commit("burst: ruling", [{ kind: "decision", id: ruled, expectRev: rev, doc: { ...doc, status: "ruled", choice: "A", ruling: "选 A", ruledAt: at, updated: at } }]);
  }
  const replied = Object.entries(s.notes).filter(([, n]) => n.reply && n.kind === "comment").slice(round * 2, round * 2 + 2);
  for (const [id, n] of replied) { const { rev, ...doc } = n; await commit("burst: reply", [{ kind: "note", id, expectRev: rev, doc: { ...doc, reply: n.reply + " 再补充。", repliedAt: at } }]); }
  const owner = ids.find(id => s.items[id]!.group === s.board.projects[2]!.name && r.children(id).length && r.isOpenWork(id))!;
  const child = `burst${round}-item`, o = store.snapshot().items[owner]!, { rev, ...odoc } = o;
  await commit("burst: new item", [
    { kind: "item", id: child, expectRev: null, doc: { title: `第 ${round} 轮新条目`, group: o.group, tags: [o.tags![0]!], plan: [{ id: "accept", accept: true, text: "验收", state: "todo" }], updated: at, created: at } },
    { kind: "item", id: owner, expectRev: rev, doc: { ...odoc, plan: [{ id: child, item: child, own: true }, ...o.plan], updated: at } },
  ]);
  return commits;
}
