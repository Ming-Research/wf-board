// What the browser layer checks that needs a layout (where a box lands, how wide it is, what a browser hides), and the oracle both
// layers use: what the page's numbers should count, computed independently from the stored board with the shared rules
// (src/rules.ts) and the server's unread history (src/history.ts). The checks whose answer needs no layout run without a browser
// (test/dom/checks.ts). A check returns its violations, each opening with the family name, so a test can assert none and a
// regression witness can assert the one its bug causes.

import { rules } from "../../src/rules.ts";
import type { Rules } from "../../src/rules.ts";
import { unreadSteps } from "../../src/history.ts";
import { boardTags, tagApplies } from "../../src/model.ts";
import { addArchitectProject } from "./seed.ts";
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
async function attempt(v: string[], what: string, fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return true; } catch (e) { v.push(`${what}: ${(e instanceof Error ? e.message : String(e)).split("\n").map(l => l.trim()).filter((l, i, all) => l && all.indexOf(l) === i).slice(0, 10).join(" | ")}`); return false; }
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
  const card = (k: string, blocks?: string) => ({ kind: "decision" as const, id: `burst${round}-${k}`, expectRev: null, doc: { item: first, question: `第 ${round} 轮新问题 ${k}？`, options: [{ key: "A", text: "做" }, { key: "B", text: "不做" }], status: "open", ...(blocks ? { blocks } : {}), at, updated: at } });
  // The blocking card joins the first item's plan in the same commit, before its acceptance step; the other has no row.
  const { rev: firstRev, ...firstDoc } = s.items[first]!, cut = firstDoc.plan.findIndex(row => "accept" in row && row.accept);
  const rows = [{ id: `burst${round}-block`, card: `burst${round}-block` }];
  await commit("burst: new waits on the first item", [card("block", "合并突发修复"), card("plain"),
    { kind: "item", id: first, expectRev: firstRev, doc: { ...firstDoc, plan: [...firstDoc.plan.slice(0, cut < 0 ? firstDoc.plan.length : cut), ...rows, ...firstDoc.plan.slice(cut < 0 ? firstDoc.plan.length : cut)], updated: at } }]);
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
    await commit("burst: ruling", [{ kind: "decision", id: ruled, expectRev: rev, doc: { ...doc, status: "ruled", choice: "A", ruledAt: at, updated: at } }]);
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

/** The blocks of an item's detail that had a maximum width of 78 characters (76 for the paragraphs of a card). */
export const FULL_WIDTH_BLOCKS = [".note", ".log", ".rich", ".editor", ".body p", ".ask", ".checks", ".deplists", ".card p", ".refpop"] as const;
export interface BlockBox { item: string; sel: string; at: number; x: number; w: number; parentW: number; maxWidth: string; fills: boolean }
/** The column's content, the item's box in it (a bordered box with padding) and its content, and the body inside that. */
export interface ColumnBox { item: string; column: number; box: number; boxContent: number; body: number; detailScroll: number; detailClient: number }
/** Items that between them show every block in FULL_WIDTH_BLOCKS: the one with listed comments (and a head, a log), the one with
 * code in its head, items with an ask, with checks, with dependents, and the home of a card no plan names. */
function widthProbes(o: Oracle, w: BoardServer["gen"]["witness"]): string[] {
  const ids = Object.keys(o.s.items), live = (id: string) => o.r.statusOf(id) !== "cancelled";
  const some = (n: number, pred: (id: string) => boolean) => ids.filter(id => live(id) && pred(id)).slice(0, n);
  return [...new Set([
    w.commentItem, w.code,
    ...some(2, id => !!o.s.items[id]!.ask),
    ...some(2, id => o.r.checks(id).length > 0),
    ...some(2, id => o.r.dependents(id).some(d => !d.own && live(d.id))),
    o.s.decisions[w.recordCard]!.item, o.s.decisions[w.otherPlanCard]!.item,
  ])];
}
/** Opens each probe item with its log and comment lists unfolded and the comment field open, and measures every block of
 * FULL_WIDTH_BLOCKS in its detail at the window's current width. */
export async function measureBlocks(bp: BoardPage, o: Oracle): Promise<{ blocks: BlockBox[]; columns: ColumnBox[]; doc: [number, number] }> {
  const page = bp.page, w = bp.board.gen.witness, blocks: BlockBox[] = [], columns: ColumnBox[] = [];
  for (const id of widthProbes(o, w)) {
    await bp.select(id);
    for (let k = 0; k < 3; k++) {
      const folded = await page.evaluate(() => { const bs = [...document.querySelectorAll<HTMLElement>('#item-detail .notes-toggle[aria-expanded="false"]')]; bs.forEach(b => b.click()); return bs.length; });
      await bp.settle();
      if (!folded) break;
    }
    const field = page.locator("#item-detail .item-comment").first();
    if (await field.count()) {
      await field.click(); await bp.settle();
      // Typing "#" and the start of a title opens the popup of items under the comment field.
      if (id === w.commentItem) {
        await page.locator("#item-detail textarea").first().pressSequentially("#" + o.s.items[id]!.title.slice(0, 2));
        await page.waitForSelector("#item-detail .refpop", { timeout: 3_000 }).catch(() => undefined);
      }
    }
    const got = await page.evaluate(([sels, item]) => {
      const detail = document.getElementById("item-detail")!;
      const content = (e: HTMLElement) => { const cs = getComputedStyle(e); return e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); };
      const seen: BlockBox[] = [];
      for (const sel of sels!) [...detail.querySelectorAll<HTMLElement>(sel)].forEach((e, at) => {
        if (!e.checkVisibility()) return;
        const parent = e.parentElement!, pcs = getComputedStyle(parent), rect = e.getBoundingClientRect();
        // A flex item of a row, or an inline box, takes the width of its content; it is capped only by max-width.
        const shrinks = (pcs.display.includes("flex") && pcs.flexDirection.startsWith("row")) || getComputedStyle(e).display.startsWith("inline");
        seen.push({ item: item!, sel, at, x: rect.x, w: rect.width, parentW: content(parent), maxWidth: getComputedStyle(e).maxWidth, fills: !shrinks });
      });
      const box = detail.querySelector<HTMLElement>(":scope > .item"), body = box?.querySelector<HTMLElement>(":scope > .body");
      return { seen, column: { item: item!, column: content(detail), box: box ? box.getBoundingClientRect().width : -1, boxContent: box ? content(box) : -1, body: body ? content(body) : -1, detailScroll: detail.scrollWidth, detailClient: detail.clientWidth } };
    }, [FULL_WIDTH_BLOCKS as readonly string[], id] as const);
    blocks.push(...got.seen); columns.push(got.column);
  }
  return { blocks, columns, doc: await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth] as [number, number]) };
}
/** In a window 2400, 1500 and 700px wide the blocks of an item's detail have no maximum width and fill the column: each
 * is as wide as the box that holds it, the item's box is as wide as the column's content and its body as wide as the
 * box's content, and the page does not scroll sideways; at 1500px and wider the column does not either (at 704px and
 * narrower the column is `overflow-x: hidden`, so its scroll width says nothing a reader sees). Violations open with
 * `full-width-cap <block>:` (a maximum width), `full-width-fill <block>:` (narrower than its box), `full-width-box:`,
 * `full-width-body:`, `full-width-scroll:` (the column) and `full-width-page:`. */
export async function checkFullWidth(bp: BoardPage): Promise<string[]> {
  const v: string[] = [], o = await oracle(bp.board.store);
  for (const width of [2400, 1500, 700]) {
    await bp.page.setViewportSize({ width, height: 1000 });
    await bp.settle();
    const { blocks, columns, doc } = await measureBlocks(bp, o);
    if (width === 2400) for (const sel of FULL_WIDTH_BLOCKS) if (!blocks.some(b => b.sel === sel)) v.push(`full-width-setup: no ${sel} is shown in any probe item`);
    for (const b of blocks) {
      if (b.maxWidth !== "none") v.push(`full-width-cap ${b.sel}: at ${width}px a ${b.sel} in ${b.item} has max-width ${b.maxWidth}`);
      else if (b.fills && b.w < b.parentW - 3) v.push(`full-width-fill ${b.sel}: at ${width}px a ${b.sel} in ${b.item} is ${Math.round(b.w)}px wide, its box ${Math.round(b.parentW)}px`);
    }
    for (const c of columns) {
      if (Math.abs(c.box - c.column) > 3) v.push(`full-width-box: at ${width}px the box of ${c.item} is ${Math.round(c.box)}px wide, the column's content ${Math.round(c.column)}px`);
      if (Math.abs(c.body - c.boxContent) > 3) v.push(`full-width-body: at ${width}px the body of ${c.item} is ${Math.round(c.body)}px wide, the content of its box ${Math.round(c.boxContent)}px`);
      if (width >= 1500 && c.detailScroll > c.detailClient + 1) v.push(`full-width-scroll: at ${width}px the column of ${c.item} scrolls sideways (${c.detailScroll}px in ${c.detailClient}px)`);
    }
    if (doc[0] > doc[1] + 1) v.push(`full-width-page: at ${width}px the page is ${doc[0]}px wide in a window of ${doc[1]}px`);
  }
  await bp.page.setViewportSize({ width: 1500, height: 1000 });
  await bp.settle();
  return v;
}

/** In an item's plan, the link of a card row keeps at least 20 px (a long pick must not squeeze it), and a click on it brings the card
 * into the item's pane. Violations start with "plan-card-row". */
export async function checkPlanCardLayout(bp: BoardPage, o: Oracle, items: string[]): Promise<string[]> {
  const v: string[] = [], page = bp.page;
  for (const x of items) {
    for (const row of o.s.items[x]!.plan) {
      if (!("card" in row)) continue;
      if (await bp.selected() !== x) await bp.select(x);
      if (await bp.selected() !== x) { v.push(`plan: could not select ${x}`); break; }
      const card = row.card, sel = `#item-detail [id="${q("plan-" + encodeURIComponent(JSON.stringify([x, row.id])))}"]`;
      const goWidth = await page.locator(sel + " .plan-main a").first().evaluate(a => a.getBoundingClientRect().width);
      if (goWidth < 20) { v.push(`plan-card-row: in ${x}'s plan, the question of card ${card} is squeezed to ${Math.round(goWidth)} px by the rest of its row`); continue; }
      if (!await attempt(v, `plan-card-row ${x}→${card}`, () => page.locator(sel + " .plan-main a").first().click())) continue;
      await bp.settle();
      if (await bp.selected() !== x) continue;
      if (!await page.evaluate(c => { const e = document.getElementById("q-" + c), pane = document.getElementById("item-detail"); if (!e || !pane) return false; const a = e.getBoundingClientRect(), b = pane.getBoundingClientRect(); return a.bottom > b.top && a.top < b.bottom; }, card)) v.push(`plan-card-row: in ${x}'s plan, clicking card ${card} did not bring the card into view`);
    }
  }
  return v;
}

/** A closed card shows one line: what is under its line is not displayed while the line is folded, and is once the line is clicked.
 * Violations start with "card-fold". */
export async function checkCardFold(bp: BoardPage, o: Oracle, cards: string[]): Promise<string[]> {
  const v: string[] = [];
  for (const card of cards) {
    const d = o.s.decisions[card]!;
    if (d.status === "open") continue;
    if (await bp.selected() !== d.item) await bp.select(d.item);
    const box = bp.page.locator(`#item-detail [id="q-${q(card)}"]`), fold = box.locator("details.cardfold");
    if (await fold.count() !== 1) { v.push(`card-fold: ${d.status} card ${card} has ${await fold.count()} folds`); continue; }
    if (await fold.evaluate(e => (e as HTMLDetailsElement).open)) continue;
    if (await box.locator(".cardbody").isVisible()) v.push(`card-fold: ${d.status} card ${card} shows what is under its line while folded`);
    if (!await attempt(v, `card-fold ${card}`, async () => { await box.locator("details.cardfold > summary").dispatchEvent("click"); await bp.settle(); })) continue;
    if (!await box.locator(".cardbody").isVisible()) v.push(`card-fold: ${d.status} card ${card} shows nothing under its line once the line is clicked`);
  }
  return v;
}

/** The detail's difficulty chip lies on the line of the tags and below the title. Checked on an open tagged item with a rating.
 * Violations start with "difficulty-chip". */
export async function checkDifficultyChipLayout(bp: BoardPage, o: Oracle): Promise<string[]> {
  const v: string[] = [];
  const id = Object.keys(o.s.items).find(x => !o.s.items[x]!.record && o.r.isOpenWork(x) && o.s.items[x]!.tags?.length && typeof o.s.items[x]!.difficulty === "number");
  if (!id) return ["difficulty-chip: the board has no open tagged item that is rated"];
  await bp.select(id);
  const got = await bp.page.evaluate(() => {
    const box = document.querySelector("#item-detail > .item"), top = (e: Element | null | undefined) => e ? e.getBoundingClientRect().top : null;
    const chip = box?.querySelector(".item-tags .diffchip"), tag = box?.querySelector(".item-tags .tagchip:not(.diffchip)"), title = box?.querySelector(".item-title");
    return { chipTop: top(chip), tagTop: top(tag), titleBottom: title ? title.getBoundingClientRect().bottom : null };
  });
  if (got.chipTop === null || got.tagTop === null) return [`difficulty-chip: ${id} shows no chip beside its tags`];
  if (Math.abs(got.chipTop - got.tagTop) > 2) v.push(`difficulty-chip: ${id}'s chip is not on its tags' line (${got.chipTop} against ${got.tagTop})`);
  if (got.titleBottom !== null && got.chipTop < got.titleBottom - 1) v.push(`difficulty-chip: ${id}'s chip is not below its title (${got.chipTop} against ${got.titleBottom})`);
  return v;
}

// The left tree's band behind each row in progress or idle: as wide as the plan's share, its gradient sized to the whole row
// (so the colour at any point is the colour that point has across the row), and no band on the other rows. Both colour
// schemes (docs/design.md, How the page shows a plan).
export async function checkProgressBands(bp: BoardPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], page = bp.page;
  // Only items whose tree row is rendered: a row under a folded parent is not in the page.
  const shown = new Set(await page.evaluate(() => [...document.querySelectorAll('[id^="it-"]')].map(e => e.id.slice(3))));
  const ids = Object.keys(o.s.items).filter(id => !o.s.items[id]!.record && shown.has(id));
  // A standing item is in progress with no share of its plan, so it is none of the rows these checks look for; it has its own below.
  const withStatus = (status: string) => ids.find(id => !o.s.items[id]!.standing && o.r.statusOf(id) === status);
  const part = withStatus("wip"), idle = withStatus("idle"), todo = withStatus("todo");
  if (!part) v.push("progress-band: the board has no item in progress");
  if (!todo) v.push("progress-band: the board has no todo item");
  // Statuses that must carry no band. The generated board must have an item of each; cancelled is not among them, because
  // the tree hides a cancelled item that has no open work under it (test/e2e/board-gen.ts), so no tree row can show it.
  // The tree hides a done item with no open work under it, so a done item can be absent from the page; the board itself must have one.
  const plainStatuses = ["todo", "done", "blocked", "paused"];
  const allIds = Object.keys(o.s.items).filter(id => !o.s.items[id]!.record);
  for (const status of plainStatuses) if (!allIds.some(id => o.r.statusOf(id) === status)) v.push(`progress-band: the board has no item with status ${status}`);
  const plain = plainStatuses.map(withStatus).filter((id): id is string => !!id);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const id of [part, idle, ...plain]) {
      if (!id) continue;
      const status = o.r.statusOf(id);
      const got = await page.evaluate((key: string) => {
        const row = document.getElementById("it-" + key)?.querySelector<HTMLElement>(":scope > .item-row.tree-row") ?? null;
        const band = row?.querySelector<HTMLElement>(":scope > .progress-band") ?? null;
        // The colours the page's gradient stops resolve to in this scheme, read through probe elements.
        const probe = (name: string) => { const e = document.createElement("span"); e.style.backgroundColor = "var(" + name + ")"; document.body.appendChild(e); const c = getComputedStyle(e).backgroundColor; e.remove(); return c; };
        const style = band ? getComputedStyle(band) : null;
        return {
          row: !!row, rowWidth: row ? row.getBoundingClientRect().width : 0, from: probe("--prog-from"), to: probe("--prog-to"),
          count: !!row?.querySelector(".steps-ratio"),
          band: band && style ? { width: band.getBoundingClientRect().width, image: style.backgroundImage, size: style.backgroundSize } : null,
        };
      }, id);
      if (!got.row) { v.push(`progress-band (${scheme}): ${id} has no tree row`); continue; }
      // A row with a band shows no count of its done rows; a row without one keeps the count, where it has a plan.
      if (status !== "wip" && status !== "idle") {
        if (got.band) v.push(`progress-band (${scheme}): ${id} (${status}) carries a band`);
        if (o.s.items[id]!.plan.length && !got.count) v.push(`progress-band (${scheme}): ${id} (${status}) has no count of its rows`);
        continue;
      }
      if (got.count) v.push(`progress-band (${scheme}): ${id} (${status}) shows a count next to its band`);
      if (!got.band) { v.push(`progress-band (${scheme}): ${id} (${status}) carries no band`); continue; }
      const want = o.r.progressShare(id), ratio = got.band.width / got.rowWidth;
      if (Math.abs(ratio - want) > 0.01) v.push(`progress-band (${scheme}): ${id} is ${(ratio * 100).toFixed(1)}% of the row wide, not the plan's ${(want * 100).toFixed(1)}%`);
      // Chromium returns background-size as a percentage of the band: the gradient spans the band's width times that, which must be the row's width.
      const [first = ""] = got.band.size.split(" "), gradient = first.endsWith("%") ? got.band.width * parseFloat(first) / 100 : parseFloat(first);
      if (Math.abs(gradient - got.rowWidth) > 1) v.push(`progress-band (${scheme}): ${id}'s gradient is ${gradient.toFixed(1)}px wide, not the row's ${got.rowWidth}px`);
      const { image } = got.band, fromAt = image.indexOf(got.from), toAt = image.indexOf(got.to);
      if (!image.includes("linear-gradient") || fromAt < 0 || toAt <= fromAt) v.push(`progress-band (${scheme}): ${id}'s gradient does not run from ${got.from} to ${got.to}: ${image}`);
    }
  }
  // A standing item is in progress and has no share of its plan, so its tree row draws no band and no count of rows done, and its 常设 tag
  // lies on the title's line inside the row (docs/design.md, section 7).
  const standing = ids.find(id => o.s.items[id]!.standing);
  if (!standing) v.push("standing-tag: the board has no standing item in the tree");
  else for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const got = await page.evaluate((key: string) => {
      const row = document.getElementById("it-" + key)?.querySelector<HTMLElement>(":scope > .item-row.tree-row") ?? null;
      const tag = row?.querySelector<HTMLElement>(".standing-tag") ?? null, title = row?.querySelector<HTMLElement>(".item-title") ?? null;
      const box = (e: Element | null) => { if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      return { row: box(row), band: !!row?.querySelector(".progress-band"), count: !!row?.querySelector(".steps-ratio"), text: tag?.textContent ?? null, tag: box(tag), title: box(title) };
    }, standing);
    if (!got.row) { v.push(`standing-tag (${scheme}): ${standing} has no tree row`); continue; }
    if (got.band) v.push(`standing-tag (${scheme}): ${standing} carries a progress band`);
    if (got.count) v.push(`standing-tag (${scheme}): ${standing} shows a count of rows done`);
    if (got.text !== "常设" || !got.tag || !got.title) { v.push(`standing-tag (${scheme}): ${standing} shows no 常设 tag after its title (${JSON.stringify(got.text)})`); continue; }
    if (got.tag.right - got.tag.left <= 0) v.push(`standing-tag (${scheme}): ${standing}'s tag has no width`);
    if (!(got.tag.top < got.title.bottom && got.tag.bottom > got.title.top)) v.push(`standing-tag (${scheme}): ${standing}'s tag is not on its title's line (${got.tag.top}–${got.tag.bottom} against ${got.title.top}–${got.title.bottom})`);
    if (got.tag.left < got.row.left - 1 || got.tag.right > got.row.right + 1) v.push(`standing-tag (${scheme}): ${standing}'s tag lies outside its row (${got.tag.left}–${got.tag.right} against ${got.row.left}–${got.row.right})`);
  }
  // A selected row keeps its highlight: its band is drawn at 45 % opacity, and an unselected band at full opacity.
  if (part) {
    await bp.select(part);
    const got = await page.evaluate((key: string) => {
      const box = document.getElementById("it-" + key);
      const band = box?.querySelector<HTMLElement>(":scope > .item-row.tree-row > .progress-band") ?? null;
      return { selected: !!box?.classList.contains("selected"), opacity: band ? getComputedStyle(band).opacity : null };
    }, part);
    if (!got.selected) v.push(`progress-band: ${part} is not marked selected after it was selected`);
    if (got.opacity !== "0.45") v.push(`progress-band: the selected row ${part} draws its band at opacity ${got.opacity}, not 0.45`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  return v;
}

/**
 * A standing item on the board, a top item of the project the generated board's unpaused witness lives in, for the checks that need one.
 * It has one done and one todo step, as an ordinary item with a band and a count would: a probe with no rows could not show a page that draws them.
 */
export async function seedStanding(board: BoardServer): Promise<void> {
  const s = board.store.snapshot();
  if (s.items["standing-probe"]) return;
  await addArchitectProject(board.ops, board.store);
  const group = s.items[board.gen.witness.unpaused]!.group;
  // Tags are required of a new item when the vocabulary offers its project one.
  const tag = boardTags(s.board).find(x => tagApplies(x, group));
  await board.ops.createItem({ author: "Architect", session: "架构师", key: "standing-probe", group, title: "Standing probe", standing: true, ...(tag ? { tags: [tag.name] } : {}) });
  for (const row of [{ id: "done", text: "A step done", state: "done" }, { id: "next", text: "A step to do", state: "todo" }] as const) {
    await board.ops.setPlan({ author: "Architect", session: "架构师", id: "standing-probe", row });
  }
}
