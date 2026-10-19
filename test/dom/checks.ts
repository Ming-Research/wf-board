// Invariants over every kind of clickable thing on the owner's page, run on the page in a DOM library (test/dom/page.ts):
// each check clicks like the owner, then compares where the page landed with what the element claims, computed independently
// from the stored board with the shared rules (src/rules.ts) and the server's unread history (src/history.ts). A check returns
// its violations, each opening with the family name, so a test can assert none and a witness can assert the one its bug causes.
// These are the checks whose answer does not depend on layout; what needs a box (a position, a size, a hit) is in the browser
// layer (test/e2e/invariants.ts). Families: tree-row, plan-*, card-*, dep-row, badge-*, wait-*, new-*, fresh-*, n-walk, filter-*,
// search, comment-*, empty-row, tag-text, difficulty-chip, idle-status, wrap-*, ref-fold-*, shared-section-*.

import { ops } from "../../src/ops.ts";
import { placedCards, rules } from "../../src/rules.ts";
import type { Rules } from "../../src/rules.ts";
import { difficultyText } from "../../src/model.ts";
import type { Snapshot } from "../../src/model.ts";
import { prng } from "../e2e/board-gen.ts";
import type { BoardServer } from "../e2e/board-server.ts";
import { oracle } from "../e2e/invariants.ts";
import type { Oracle } from "../e2e/invariants.ts";
import { attr, DomPage } from "./page.ts";

export { oracle, burst } from "../e2e/invariants.ts";
export type { Oracle } from "../e2e/invariants.ts";

const sameSet = (a: Iterable<string>, b: Iterable<string>) => { const x = [...new Set(a)].sort(), y = [...new Set(b)].sort(); return x.length === y.length && x.every((v, i) => v === y[i]); };
/** Runs `fn`; an error it throws (a click that cannot land) becomes a violation, so one dead control does not stop the walk. */
function attempt(v: string[], what: string, fn: () => unknown): boolean {
  try { fn(); return true; } catch (e) { v.push(`${what}: ${(e instanceof Error ? e.message : String(e)).split("\n").map(l => l.trim()).filter((l, i, all) => l && all.indexOf(l) === i).slice(0, 10).join(" | ")}`); return false; }
}
/** Where a wait landed: the current card, or an item's own request when no card is current. */
function landing(bp: DomPage): string {
  const cards = bp.currentCards(), sel = bp.selected();
  if (cards.length === 1) return "q:" + cards[0];
  if (cards.length > 1) return "several current cards: " + cards.join(",");
  return sel && bp.$$(`#item-detail [id="ask-${attr(sel)}"]`).length ? "ask:" + sel : "nothing current (selected " + sel + ")";
}
/** The item a wait belongs to. */
function homeOf(o: Oracle, wait: string): string | undefined { return wait.startsWith("ask:") ? wait.slice(4) : o.s.decisions[wait.slice(2)]?.item; }
const text = (e: Element | null | undefined) => e?.textContent ?? "";
const plain = (e: Element | null | undefined) => text(e).replace(/\s+/g, " ").trim();

/** Every tree row's title selects that item and shows its detail. */
export async function checkTreeRows(bp: DomPage, _o: Oracle, rows: string[] = bp.treeRows()): Promise<string[]> {
  const v: string[] = [];
  for (const id of rows) {
    if (!attempt(v, `tree-row ${id}`, () => bp.click(bp.$(".item-title", bp.head(id)!), `the title of ${id}`))) continue;
    await bp.settle();
    const sel = bp.selected();
    if (sel !== id) v.push(`tree-row: clicking ${id}'s title selected ${sel}`);
    else if (!bp.$$(`#item-detail [id="detail-it-${attr(id)}"].cur`).length) v.push(`tree-row: ${id} selected but its detail is not the current selection`);
  }
  return v;
}

/** Plan rows in an item's detail: an item row goes to its item and Back returns; a card row goes to that card in the
 * body without changing the selected item; a step row selects the step and keeps the item. (Whether the card lands inside the
 * pane, and the width left to the row's link, need a layout: test/e2e.) */
export async function checkPlanRows(bp: DomPage, o: Oracle, items: string[]): Promise<string[]> {
  const v: string[] = [];
  const ensure = async (x: string) => { if (bp.selected() !== x) await bp.select(x); return bp.selected() === x; };
  for (const x of items) {
    if (!await ensure(x)) { v.push(`plan: could not select ${x}`); continue; }
    const plan = o.s.items[x]!.plan;
    const firstOwn = plan.find(row => "item" in row && row.own);
    const firstStep = plan.find(row => "text" in row);
    for (const row of plan) {
      const el = "plan-" + encodeURIComponent(JSON.stringify([x, row.id])), sel = `#item-detail [id="${attr(el)}"]`;
      if ("item" in row) {
        if (row.own && row !== firstOwn) continue;
        if (!await ensure(x)) { v.push(`plan: could not reselect ${x}`); break; }
        if (!attempt(v, `plan-item-row ${x}→${row.item}`, () => bp.click(bp.$(sel + " .plan-main a.plan-link"), `the link of the row for ${row.item}`))) continue;
        await bp.settle();
        const got = bp.selected();
        if (got !== row.item) { v.push(`plan-item-row: in ${x}'s plan, the row for ${row.item} selected ${got}`); continue; }
        if (!attempt(v, `back from ${row.item} to ${x}`, () => bp.click(bp.$("#backbtn"), "the Back button"))) continue;
        await bp.settle();
        if (bp.selected() !== x) v.push(`back: after following ${row.item} from ${x}'s plan, 返回 selected ${bp.selected()}`);
      } else if ("card" in row) {
        if (!await ensure(x)) { v.push(`plan: could not reselect ${x}`); break; }
        const card = row.card, d = o.s.decisions[card]!;
        const rowText = text(bp.$(sel));
        const first = d.question.split("\n")[0]!.replace(/[*`]/g, "").trim();
        if (!rowText.includes(first.slice(0, 12))) v.push(`plan-card-row: in ${x}'s plan, the row for card ${card} does not show its question`);
        if (d.status === "ruled" && d.choice !== undefined && !rowText.includes("选 " + d.choice)) v.push(`plan-card-row: in ${x}'s plan, the ruled card ${card}'s row does not say what was chosen`);
        const picked = d.options.find(op => op.key === d.choice);
        if (picked && !rowText.includes(((picked.text || picked.detail || "").split("\n")[0]!).replace(/[*`]/g, "").trim().slice(0, 4))) v.push(`plan-card-row: in ${x}'s plan, the ruled card ${card}'s row does not name the option chosen`);
        if (!attempt(v, `plan-card-row ${x}→${card}`, () => bp.click(bp.$(sel + " .plan-main a"), `the question link of the row for ${card}`))) continue;
        await bp.settle();
        const got = bp.selected();
        if (got !== x) v.push(`plan-card-row: in ${x}'s plan, clicking card ${card} switched the selected item to ${got} instead of going to the card in the body`);
        else {
          // The click goes to the card in the body, placed or not; it is drawn once and not under the row.
          const drawn = bp.$$(`#item-detail [id="q-${attr(card)}"]`).length;
          if (drawn !== 1) v.push(`plan-card-row: in ${x}'s plan, card ${card} is drawn ${drawn} times in the body, not once`);
          else if (!bp.currentCards().includes(card)) v.push(`plan-card-row: in ${x}'s plan, clicking card ${card} did not make that card the current one in the body`);
          else if (bp.doc.getElementById(el)?.nextElementSibling?.id === "q-" + card) v.push(`plan-card-row: in ${x}'s plan, the card ${card} is drawn under its row as well as in the body`);
        }
      } else if (row === firstStep) {
        if (!await ensure(x)) continue;
        if (!attempt(v, `plan-step-row ${x}@${row.id}`, () => bp.click(bp.$(sel + " > .g"), `the step row ${row.id}`))) continue;
        await bp.settle();
        if (bp.selected() !== x) v.push(`plan-step-row: clicking step ${row.id} of ${x} selected ${bp.selected()}`);
        else if (!bp.$$(sel + ".cur").length) v.push(`plan-step-row: clicking step ${row.id} of ${x} did not make it the current selection`);
      }
    }
  }
  return v;
}

/** A decision card in its item's body: drawn once, with its question once, its options (an open card: a button for each
 * with its name and detail, the recommended one marked) or, once closed, on one line with its pick (which says so when it
 * was ruled in words, then showing the ruling), everything else under that line; the confidence; its old background
 * folded (an open card's starts open). A card the head places with a line [[q:key]] stands at that line inside the head.
 * A card it does not place follows the head, after a line saying it has no place there. Nothing starts open for a card
 * nobody went to, so with `fresh` (the page has not been sent to the card yet) what starts folded must be folded. (That a folded
 * card's body is not drawn is the browser's own rule for a closed `details`; here the body must sit inside the fold.) */
export async function checkCardBox(bp: DomPage, o: Oracle, cards: string[], fresh = false): Promise<string[]> {
  const v: string[] = [];
  for (const card of cards) {
    const d = o.s.decisions[card]!, item = o.s.items[d.item]!;
    if (bp.selected() !== d.item) await bp.select(d.item);
    const placed = placedCards(item.head).includes(card);
    const boxes = bp.$$(`#item-detail [id="q-${attr(card)}"]`);
    if (boxes.length !== 1) { v.push(`${placed ? "card-place" : "card-unplaced"}: card ${card} shows ${boxes.length} times in ${d.item}'s body, not once${placed ? " although its line stands in the head" : " although it is drawn after the head when its line is missing"}`); continue; }
    const box = boxes[0]!;
    const m = (() => {
      const legacy = box.querySelector<HTMLDetailsElement>("details.legacy"), fold = box.querySelector<HTMLDetailsElement>("details.cardfold");
      const parent = box.parentElement!, head = box.closest(".rich"), before = box.previousElementSibling;
      const rich = parent.querySelector(":scope > .rich");
      return { title: text(box.querySelector("h3")),
        options: [...box.querySelectorAll<HTMLElement>("button.optbtn")].map(b => ({ key: b.dataset.option, rec: !!b.querySelector(".recchip"), name: b.querySelector(".optname") ? plain(b.querySelector(".optname")) : null, detail: b.querySelector(".optdetail") ? plain(b.querySelector(".optdetail")) : null })),
        conf: box.querySelector("p.conf") ? text(box.querySelector("p.conf")) : null,
        pick: box.querySelector(".pick") ? text(box.querySelector(".pick")) : null, send: !!box.querySelector(".cardsend"), legacy: legacy ? { open: legacy.open, label: text(legacy.querySelector("summary")) } : null,
        fold: fold ? { open: fold.open, line: text(fold.querySelector("summary")), bodyInside: !!fold.querySelector(":scope > .cardbody") } : null, closedClass: box.classList.contains("closed"),
        inHead: !!head && parent.classList.contains("rich"),
        note: before?.classList.contains("unplacednote") ? plain(before) : null,
        afterHead: !!rich && !!(rich.compareDocumentPosition(box) & bp.win.Node.DOCUMENT_POSITION_FOLLOWING),
        headings: box.querySelectorAll("h3").length, inPlan: !!box.closest(".plan"),
        tags: [...box.querySelectorAll("h3 .waittag, h3 .asktag, h3 .closedtag")].map(t => text(t)) };
    })();
    const first = (s: string) => s.split("\n")[0]!.replace(/[*`]/g, "").trim();
    const title = first(d.question);
    if (!m.title.includes(title.slice(0, 12))) v.push(`card-box: card ${card}'s heading does not show its question`);
    // The question is shown once: one heading in the card, and the card is not a second copy inside a plan.
    if (m.headings !== 1 || m.inPlan) v.push(`card-question: card ${card} shows its question ${m.inPlan ? "inside the plan, as well as in the body" : m.headings + " times in its box"}, not once`);
    const words = d.status === "ruled" && d.choice === undefined;
    // A name when the option has one, else the first line of its detail.
    const label = (op: { text: string; detail?: string }) => (op.text || first(op.detail ?? "")).slice(0, 6);
    const confText = d.confidence ? (d.confidence.score === undefined ? "" : d.confidence.score + "/5：") + d.confidence.reason.slice(0, 6) : null;
    if (d.status === "open") {
      if (m.options.length !== d.options.length) v.push(`card-box: open card ${card} shows ${m.options.length} options, not ${d.options.length}`);
      for (const op of d.options) {
        const shown = m.options.find(x => x.key === op.key);
        if (!!op.recommended !== !!shown?.rec) v.push(`card-box: open card ${card}'s option ${op.key} ${op.recommended ? "is not" : "is"} marked recommended`);
        if (!!op.text !== (shown?.name != null)) v.push(`card-box: open card ${card}'s option ${op.key} ${op.text ? "lost its name" : "shows a name it does not have"}`);
        else if (op.text && !shown!.name!.includes(op.text.slice(0, 6))) v.push(`card-box: open card ${card}'s option ${op.key} does not show its name`);
        if (!!op.detail !== (shown?.detail != null)) v.push(`card-option-detail: open card ${card}'s option ${op.key} ${op.detail ? "lost its detail" : "shows a detail it does not have"}`);
        else if (op.detail && !shown!.detail!.includes(first(op.detail).slice(0, 6))) v.push(`card-option-detail: open card ${card}'s option ${op.key} does not show its detail`);
      }
      if (!m.send) v.push(`card-box: open card ${card} has no 发送 button`);
      if (m.pick !== null) v.push(`card-box: open card ${card} shows a pick`);
      if (m.closedClass || m.fold) v.push(`card-box: open card ${card} is drawn as a closed one`);
      if (confText && !(m.conf ?? "").includes("把握：" + confText)) v.push(`card-confidence: open card ${card} does not show its confidence "${confText}", it says "${m.conf}"`);
      if (!confText && m.conf) v.push(`card-confidence: open card ${card} has no confidence but shows one`);
    } else {
      if (m.options.length) v.push(`card-box: ${d.status} card ${card} still shows ${m.options.length} option buttons`);
      if (m.send) v.push(`card-box: ${d.status} card ${card} still has a 发送 button`);
      if (d.status === "ruled") {
        const chosen = d.options.find(op => op.key === d.choice);
        if (d.choice !== undefined ? !(m.pick ?? "").includes("选 " + d.choice) : !(m.pick ?? "").includes("文字裁决")) v.push(`card-box: ruled card ${card} says "${m.pick}", not its pick`);
        else if (chosen && !(m.pick ?? "").includes(label(chosen))) v.push(`card-box: ruled card ${card}'s line does not name the option chosen`);
      }
      if (words && d.ruling && !(m.pick ?? "").includes(first(d.ruling).slice(0, 6))) v.push(`card-box: card ${card}, ruled in words, does not show its ruling on its line`);
      if (d.status === "withdrawn" && !m.tags.includes("已撤回")) v.push(`card-box: withdrawn card ${card} does not say 已撤回`);
      if (!m.closedClass) v.push(`card-box: ${d.status} card ${card} is not drawn as a closed one`);
      // A closed card is always one line over a fold that holds the rest.
      if (!m.fold) v.push(`card-box: ${d.status} card ${card} has no fold under its line`);
      else {
        if (!m.fold.line.includes(title.slice(0, 12))) v.push(`card-box: ${d.status} card ${card}'s line does not show its question`);
        // Nobody went to the card yet, so a closed card is one folded line.
        if (fresh && m.fold.open) v.push(`card-fold: ${d.status} card ${card} is unfolded by default`);
        if (!m.fold.open) {
          // Under a closed line nothing is on screen; a click on the line shows it.
          if (!m.fold.bodyInside) v.push(`card-fold: ${d.status} card ${card}'s body is not inside its fold, so a folded card shows it`);
          if (!attempt(v, `card-box fold ${card}`, () => bp.$("details.cardfold > summary", box)!.click())) continue;
          await bp.settle();
          if (!bp.$<HTMLDetailsElement>("details.cardfold", box)?.open) v.push(`card-fold: ${d.status} card ${card} shows nothing under its line once the line is clicked`);
        }
        // Under the line: every option with its name and detail, the chosen one marked, the confidence, the ruling.
        const body = (() => {
          const e = box;
          return { listed: [...e.querySelectorAll(".cardbody ul.optlist > li")].map(li => ({ key: text(li.querySelector(".lbl")), rec: !!li.querySelector(".recchip"), chosen: !!li.querySelector(".pickchip"), name: li.querySelector(".optname") ? plain(li.querySelector(".optname")) : null, detail: li.querySelector(".optdetail") ? plain(li.querySelector(".optdetail")) : null })),
            conf: e.querySelector(".cardbody p.conf") ? text(e.querySelector(".cardbody p.conf")) : null, ruling: e.querySelector(".cardbody .ruling") ? text(e.querySelector(".cardbody .ruling")) : null };
        })();
        if (body.listed.length !== d.options.length) v.push(`card-box: ${d.status} card ${card} lists ${body.listed.length} options under its line, not ${d.options.length}`);
        for (const op of d.options) {
          const shown = body.listed.find(x => x.key === op.key + "：");
          if (!shown) { v.push(`card-box: ${d.status} card ${card} does not list its option ${op.key}`); continue; }
          if (!!op.recommended !== shown.rec) v.push(`card-box: ${d.status} card ${card}'s listed option ${op.key} ${op.recommended ? "is not" : "is"} marked recommended`);
          if (shown.chosen !== (op.key === d.choice)) v.push(`card-box: ${d.status} card ${card}'s listed option ${op.key} ${shown.chosen ? "is" : "is not"} marked chosen`);
          if (!!op.text !== (shown.name != null)) v.push(`card-box: ${d.status} card ${card}'s listed option ${op.key} ${op.text ? "lost its name" : "shows a name it does not have"}`);
          if (!!op.detail !== (shown.detail != null)) v.push(`card-option-detail: ${d.status} card ${card}'s listed option ${op.key} ${op.detail ? "lost its detail" : "shows a detail it does not have"}`);
          else if (op.detail && !shown.detail!.includes(first(op.detail).slice(0, 6))) v.push(`card-option-detail: ${d.status} card ${card}'s listed option ${op.key} does not show its detail`);
        }
        if (confText && !(body.conf ?? "").includes("把握：" + confText)) v.push(`card-confidence: ${d.status} card ${card} does not show its confidence under its line`);
        if (!confText && body.conf) v.push(`card-confidence: ${d.status} card ${card} has no confidence but shows one`);
        // The ruling of a card ruled in words is on its line; one with a choice shows it under the line.
        if (d.ruling && !words && !(body.ruling ?? "").includes(first(d.ruling).slice(0, 6))) v.push(`card-box: ${d.status} card ${card} does not show its ruling under its line`);
        if (words && body.ruling) v.push(`card-box: card ${card}, ruled in words, shows its ruling again under its line`);
        if (!d.ruling && body.ruling) v.push(`card-box: ${d.status} card ${card} has no ruling but shows one`);
      }
    }
    // The old background, kept as it was and folded; an open card is decided from it, so that starts open.
    if (!d.legacy?.background && m.legacy) v.push(`card-box: card ${card} has no old background but shows a folded section`);
    if (d.legacy?.background) {
      if (!m.legacy) v.push(`card-box: card ${card} lost its old background`);
      else {
        if (m.legacy.label !== "原卡的背景") v.push(`card-box: card ${card}'s old background is titled "${m.legacy.label}", not "原卡的背景"`);
        if (fresh && m.legacy.open !== (d.status === "open")) v.push(`${d.status === "open" ? "card-legacy-open" : "card-legacy"}: card ${card}'s old background is ${m.legacy.open ? "unfolded" : "folded"} by default, ${d.status === "open" ? "an open card's starts open" : "a closed card's starts folded"}`);
        const marker = first(d.legacy.background).slice(0, 6);
        if (!m.legacy.open && !attempt(v, `card-box legacy ${card}`, () => bp.$("details.legacy > summary", box)!.click())) continue;
        await bp.settle();
        const shown = text(bp.$("details.legacy", box));
        if (marker && !shown.includes(marker)) v.push(`card-box: card ${card}'s old background does not show "${marker}" once unfolded`);
      }
    }
    if (placed !== m.inHead) v.push(`card-place: card ${card} ${placed ? "has its line in the head but shows after it" : "has no line in the head but shows inside it"}`);
    if (!placed) {
      if (!m.note || !m.note.includes("没标位置") || !m.note.includes(`[[q:${card}]]`)) v.push(`card-unplaced: card ${card} has no line in the head but no line before it says so, it has "${m.note}"`);
      if (!m.afterHead && item.head) v.push(`card-unplaced: card ${card} has no line in the head but does not follow the head`);
      // Only an open card can be withdrawn, so only its line offers that.
      if ((d.status === "open") !== !!m.note?.includes("撤回")) v.push(`card-unplaced: ${d.status} card ${card}'s line ${d.status === "open" ? "does not offer" : "offers"} withdrawing it`);
    } else if (m.note) v.push(`card-place: card ${card} has its line in the head but a line before it says it has no place`);
    if (placed && m.inHead) {
      // The card follows the paragraph that precedes its line and comes before the one after it.
      const lines = (item.head ?? "").split("\n"), at = lines.findIndex(l => l.trim() === `[[q:${card}]]`);
      // Plain text only: a line with a reference or another card's line shows as a link or a card, not as its source.
      const before = lines.slice(0, at).filter(l => l.trim() && !/^[`|\-*#>\d]/.test(l.trim()) && !/[\[\]_]/.test(l)).at(-1)?.replace(/[*`]/g, "").trim().slice(0, 6);
      if (before) {
        const headBox = box.closest(".rich")!;
        const prior = [...headBox.querySelectorAll("*")].filter(x => x.compareDocumentPosition(box) & bp.win.Node.DOCUMENT_POSITION_FOLLOWING && !x.contains(box) && text(x).includes(before));
        if (!prior.length) v.push(`card-place: card ${card} does not come after the text "${before}" that precedes its line in the head`);
      }
    }
  }
  return v;
}

/** The 被依赖 rows of an item's detail list exactly its open dependents through shared rows; each selects its item and
 * Back returns. */
export async function checkDependents(bp: DomPage, o: Oracle, items: string[]): Promise<string[]> {
  const v: string[] = [];
  for (const x of items) {
    const ws = o.r.dependents(x).filter(d => !d.own).map(d => d.id).filter(id => o.s.items[id] && o.r.statusOf(id) !== "cancelled");
    await bp.select(x);
    const rows = bp.$$("#item-detail .deplists .deprow"), n = rows.length;
    if (n !== ws.length) { v.push(`dep-row: ${x} lists ${n} dependents, expected ${ws.length} (${ws.join(",")})`); continue; }
    for (let i = 0; i < n; i++) {
      if (bp.selected() !== x) await bp.select(x);
      // The rows are drawn again by the select, so they are looked up afresh.
      if (!attempt(v, `dep-row ${x}#${i}`, () => bp.click(bp.$$("#item-detail .deplists .deprow")[i], `dependent row ${i}`))) continue;
      await bp.settle();
      const got = bp.selected();
      if (got !== ws[i]) { v.push(`dep-row: ${x}'s dependent row ${i} selected ${got}, expected ${ws[i]}`); continue; }
      if (!attempt(v, `back to ${x}`, () => bp.click(bp.$("#backbtn"), "the Back button"))) continue;
      await bp.settle();
      if (bp.selected() !== x) v.push(`back: after following dependent ${ws[i]} from ${x}, 返回 selected ${bp.selected()}`);
    }
  }
  return v;
}

/** The purple and red numbers after each tree title equal the waits in that item's owned subtree; clicking a number as
 * many times as it says visits each of those waits once, each in its own item. */
export async function checkBadges(bp: DomPage, o: Oracle, rows: string[] = bp.treeRows()): Promise<string[]> {
  const v: string[] = [];
  for (const id of rows) {
    for (const [cls, expected, name] of [["waittag", o.purple(id), "purple"], ["asktag", o.red(id), "red"]] as const) {
      const chip = () => bp.$(":scope > ." + cls, bp.head(id)!);
      const shown = chip();
      if (!expected.length) { if (shown) v.push(`badge-count: ${id} shows a ${name} number with nothing to count`); continue; }
      if (!shown) { v.push(`badge-count: ${id} has ${expected.length} ${name} waits but no number`); continue; }
      const count = Number(text(shown));
      if (count !== expected.length) v.push(`badge-count: ${id}'s ${name} number says ${count}, its subtree holds ${expected.length}: ${expected.join(",")}`);
      const visited: string[] = [];
      for (let k = 0; k < expected.length; k++) {
        if (!attempt(v, `badge ${name} ${id}`, () => bp.click(chip(), `the ${name} number of ${id}`))) break;
        await bp.settle();
        const got = landing(bp), sel = bp.selected();
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
export async function checkWaitPanel(bp: DomPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], blocking = o.blocking(), plainCards = o.plainCards();
  const label = (cls: string) => { const b = bp.$("#summary .sbtn." + cls); return b ? Number(text(b).match(/\d+/)![0]) : 0; };
  if (label("s-block") !== blocking.length) v.push(`wait-count: 阻塞 says ${label("s-block")}, the board has ${blocking.length} blocking waits`);
  if (label("s-wait") !== plainCards.length) v.push(`wait-count: 决策卡 says ${label("s-wait")}, the board has ${plainCards.length} waiting cards`);
  const n = bp.$$("#wait-panel .waitrow").length;
  if (n !== blocking.length) v.push(`wait-count: the wait panel has ${n} rows for ${blocking.length} blocking waits`);
  const seen: string[] = [];
  for (let i = 0; i < n; i++) {
    if (!attempt(v, `wait-row ${i}`, () => bp.click(bp.$$("#wait-panel .waitrow")[i], `wait panel row ${i}`))) continue;
    await bp.settle();
    const got = landing(bp); seen.push(got);
    if (!blocking.includes(got)) v.push(`wait-landing: wait panel row ${i} went to ${got}, not a blocking wait`);
    else if (bp.selected() !== homeOf(o, got)) v.push(`wait-landing: wait panel row ${i} showed ${got} but selected ${bp.selected()}`);
  }
  if (n === blocking.length && !sameSet(seen, blocking)) v.push(`wait-landing: the wait panel rows reached ${seen.join(",")}, the blocking waits are ${blocking.join(",")}`);
  return v;
}

/** Each blue number counts the items under it holding unread content and leads to one of them; the header's 新 number
 * counts every unit; n walks every item holding unread content, landing on nothing else, and each landing is a row
 * the tree shows: a done or cancelled item holding unread content stays in the tree, dimmed, until read. `rows`: the tree
 * rows whose blue number is checked (all of them by default); `walk` false leaves the walk with n out. */
export async function checkFresh(bp: DomPage, o: Oracle, rows: string[] = bp.treeRows(), walk = true): Promise<string[]> {
  const v: string[] = [];
  const head = bp.$("#unread-row .sbtn.s-new"), total = head ? Number(text(head).match(/\d+/)![0]) : 0;
  if (total !== o.units) v.push(`new-count: 新 says ${total}, the unread history holds ${o.units} units`);
  for (const id of rows) {
    const expected = o.freshUnder(id), chip = bp.$(":scope > .freshchip", bp.head(id)!);
    if (!chip) { if (expected.length) v.push(`fresh-count: ${id} has ${expected.length} items with unread content under it but no blue number`); continue; }
    const n = Number(text(chip));
    if (n !== expected.length) v.push(`fresh-count: ${id}'s blue number says ${n}, expected ${expected.length}: ${expected.join(",")}`);
    if (!attempt(v, `fresh ${id}`, () => bp.click(chip, `the blue number of ${id}`))) continue;
    await bp.settle();
    const sel = bp.selected();
    if (!sel || !expected.includes(sel)) v.push(`fresh-landing: ${id}'s blue number went to ${sel}, not one of ${expected.join(",")}`);
  }
  if (!walk) return v;
  const visited = new Set<string>();
  bp.blur();
  for (let k = 0; k < 4 * o.docs.size + 4; k++) {
    bp.key("n"); await bp.settle();
    const sel = bp.selected();
    if (sel && !o.fresh.has(sel)) v.push(`n-walk: n landed on ${sel}, which holds no unread content`);
    if (sel && !bp.row(sel)) v.push(`n-walk: n landed on ${sel}, which the left tree does not show`);
    if (sel) visited.add(sel);
    if ([...o.fresh].every(id => visited.has(id))) break;
  }
  const missed = [...o.fresh].filter(id => !visited.has(id));
  if (missed.length) v.push(`n-walk: ${4 * o.docs.size + 4} presses of n never reached ${missed.join(",")}`);
  return v;
}

const STATUS_LABELS: Record<string, string> = { 进行中: "wip", 卡住: "blocked", 暂停: "paused", 停滞: "idle", 未开始: "todo", 完成: "done", 取消: "cancelled" };
/** Each project's filter buttons: the number on a button counts its matches in that project; pressed, the tree shows
 * every match whose owners are in the project, undimmed, and dims or hides everything else of the project. */
export async function checkFilters(bp: DomPage, o: Oracle, projects: string[] = o.s.board.projects.map(p => p.name)): Promise<string[]> {
  const v: string[] = [], tags = new Set((o.s.board.tags ?? []).map(t => t.name));
  for (const g of projects) {
    const buttons = () => bp.$$(`#areas section.group[data-group="${attr(g)}"] .grp-filters .sbtn`);
    if (!bp.$(`#areas section.group[data-group="${attr(g)}"]`)) continue;
    const labels = buttons().map(b => text(b));
    for (const label_ of labels) {
      const m = label_.match(/^(.*) (\d+)$/); if (!m) continue;
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
      const button = () => buttons().find(b => new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\d+$").test(text(b)));
      if (!attempt(v, `filter ${g} ${label}`, () => bp.click(button(), `the filter ${g} ${label}`))) continue;
      await bp.settle();
      const rows = bp.$$("#areas .item").map(e => ({ id: e.id.slice(3), ctx: e.classList.contains("ctx") }));
      const shown = new Set(rows.filter(row => !row.ctx).map(row => row.id));
      for (const row of rows) if (!row.ctx && o.s.items[row.id]?.group === g && !pred(row.id)) v.push(`filter-sound: ${g} 「${label}」 shows ${row.id} undimmed, which does not match`);
      for (const id of ids) if (o.r.ancestors(id).every(a => o.s.items[a]!.group === g) && !shown.has(id)) v.push(`filter-complete: ${g} 「${label}」 hides its match ${id}`);
      if (!attempt(v, `unfilter ${g} ${label}`, () => bp.click(button(), `the filter ${g} ${label}`))) continue;
      await bp.settle();
    }
  }
  return v;
}

/** The "/" search finds an item or card by its short number first, and choosing it shows that item, or that card in its item. */
export async function checkSearch(bp: DomPage, o: Oracle, seed = 7, limit = Infinity): Promise<string[]> {
  const v: string[] = [], r = prng(seed), w = bp.board.gen.witness;
  const items = Object.keys(o.s.items), cards = Object.keys(o.s.decisions);
  const targets: Array<["item" | "card", string]> = [
    ...[...new Set([...Array.from({ length: 10 }, () => r.pick(items)), ...items.filter(id => o.r.statusOf(id) === "done").slice(0, 3), ...items.filter(id => o.s.items[id]!.record)])].map(id => ["item", id] as ["item", string]),
    ...[...new Set([w.multiPlanCard, w.donePlanCard, w.otherPlanCard, w.recordCard, w.commentCard, ...Array.from({ length: 5 }, () => r.pick(cards))])].map(id => ["card", id] as ["card", string]),
  ];
  for (const [kind, key] of targets.slice(0, limit)) {
    const doc = kind === "item" ? o.s.items[key]! : o.s.decisions[key]!, title = kind === "item" ? o.s.items[key]!.title : o.s.decisions[key]!.question.split("\n")[0]!;
    if (!attempt(v, `search ${key}`, () => bp.search("#" + doc.num))) continue;
    // The result rows are drawn after a turn of the page's own.
    await bp.settle();
    if (!text(bp.$("#search .searchrow")).includes(title.replace(/[*`]/g, ""))) { v.push(`search: #${doc.num} does not list ${kind} ${key} first`); bp.key("Escape"); continue; }
    bp.key("Enter"); await bp.settle();
    const sel = bp.selected();
    if (kind === "item" && sel !== key) v.push(`search: choosing item ${key} selected ${sel}`);
    if (kind === "card") {
      const home = o.s.decisions[key]!.item;
      if (o.s.items[home] && sel !== home) v.push(`search: choosing card ${key} selected item ${sel}, its home is ${home}`);
      if (!bp.currentCards().includes(key)) v.push(`search: choosing card ${key} did not show it as the current card`);
    }
  }
  return v;
}

/** Writing a comment, on an item and on a card whose comment lists the owner folded: the saved draft and its send
 * button are in view (shown, not folded away), and the send button sends that comment. */
export async function checkComments(bp: DomPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], store = bp.board.store, w = bp.board.gen.witness;
  const flow = async (target: string, open: () => Promise<void>) => {
    await open(); await bp.settle();
    const box = bp.doc.getElementById("ed-" + target.replace(/[^A-Za-z0-9_-]/g, "_"));
    if (!box) { v.push(`comment-open: no comment field opened for ${target}`); return; }
    const body = "e2e 评论 " + target + " " + Date.now();
    const base = bp.changes();
    bp.fill(box, body); bp.key("Enter");
    await bp.waitChanges(base + 1);
    const note = Object.entries(store.snapshot().notes).find(([, n]) => n.target === target && n.text === body);
    if (!note) { v.push(`comment-save: saving on ${target} stored no draft`); return; }
    // The draft is drawn again when it changes, so it is looked up by its id each time.
    const draft = () => bp.doc.getElementById("note-" + note[0].replace(/[^A-Za-z0-9_-]/g, "_")), send = () => { const el = draft(); return el ? bp.$(":scope > .cardsend", el) : null; };
    if (!bp.visible(draft()) || !bp.visible(send())) { v.push(`comment-hidden: after saving a comment on ${target}, the draft ${bp.visible(draft()) ? "shows but its 发送 button is hidden" : "is not in view (its comment list stayed folded)"}`); return; }
    const before = bp.changes();
    bp.click(send(), "the 发送 button"); await bp.waitChanges(before + 1);
    if (store.snapshot().notes[note[0]]?.state !== "sent") v.push(`comment-send: 发送 under the draft on ${target} did not send it`);
    else if (!text(draft() && bp.$(":scope > .who", draft()!)).includes("已发送")) v.push(`comment-send: the sent comment on ${target} does not say it was sent`);
  };
  await flow("it:" + w.commentItem, async () => { await bp.select(w.commentItem); bp.click(bp.$("#item-detail .item-comment"), "the comment field of the item"); });
  const card = w.commentCard, home = o.s.decisions[card]!.item;
  await flow("q:" + card, async () => {
    await bp.select(home);
    bp.click(bp.$(`#item-detail [id="q-${attr(card)}"]`), "the card"); await bp.settle();
    bp.key("c");
  });
  return v;
}

/** Following up on a comment: select a comment the way the owner does and press c, write, and the saved comment names the one it
 * follows and is listed right under it (the comments written after the first are still below the thread); following up on that
 * comment in turn lists the next one under it, one step further in. The thread is read from the stored anchors, and the page's list
 * must show it as that. (That the steps are indented by the stylesheet is test/dom/styles.ts.) */
export async function checkThreads(bp: DomPage): Promise<string[]> {
  const v: string[] = [], store = bp.board.store, target = "it:" + bp.board.gen.witness.commentItem;
  const idOf = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
  const box = (id: string) => bp.doc.getElementById("note-" + idOf(id));
  const notes = () => Object.entries(store.snapshot().notes).filter(([, n]) => n.target === target).sort(([a, x], [b, y]) => x.at.localeCompare(y.at) || a.localeCompare(b));
  // The notes that follow a note, and those that follow them, in the order written: what the page must list under it.
  const thread = (root: string): string[] => notes().filter(([, n]) => n.anchor?.kind === "note" && n.anchor.id === root).flatMap(([id]) => [id, ...thread(id)]);
  const listed = (root: string): string[] => {
    const out: string[] = [];
    for (let e = box(root)?.nextElementSibling; e && e.classList.contains("follow") && e.id.startsWith("note-"); e = e.nextElementSibling) out.push(e.id);
    return out;
  };
  const first = notes().find(([, n]) => n.kind === "comment" && n.reply !== undefined && !n.anchor);
  if (!first) return ["comment-thread: the generated board has no answered comment on the comment item"];
  await bp.select(bp.board.gen.witness.commentItem);
  let parent = first[0];
  for (const step of [1, 2]) {
    const where = `following up on ${parent} (step ${step})`;
    if (!attempt(v, `comment-thread: ${where}`, () => bp.click(box(parent), "the comment"))) return v;
    bp.key("c"); await bp.settle();
    const field = bp.doc.getElementById("ed-" + idOf(target));
    if (!field) { v.push(`comment-thread: ${where} opened no comment field`); return v; }
    const body = `e2e follow-up ${step} ${Date.now()}`, base = bp.changes();
    bp.fill(field, body); bp.key("Enter");
    await bp.waitChanges(base + 1);
    const made = notes().find(([, n]) => n.text === body);
    if (!made) { v.push(`comment-thread: ${where} stored no comment`); return v; }
    if (made[1].anchor?.kind !== "note" || made[1].anchor.id !== parent) { v.push(`comment-thread: ${where} stored the anchor ${JSON.stringify(made[1].anchor)}, not note ${parent}`); return v; }
    const expected = thread(first[0]).map(id => "note-" + idOf(id)), shown = listed(first[0]);
    if (JSON.stringify(shown) !== JSON.stringify(expected)) v.push(`comment-thread: ${where}: the comments under ${first[0]} are ${shown.join(",")}, the stored thread is ${expected.join(",")}`);
    const draft = box(made[0]);
    if (draft && /关于/.test(text(draft.querySelector(":scope > .anchor")))) v.push(`comment-thread: ${where}: the comment under the one it follows still says what it follows`);
    parent = made[0];
  }
  return v;
}

/** No empty row under an item's title: every part of the detail after its head row carries text. */
export async function checkEmptyRows(bp: DomPage, items: string[]): Promise<string[]> {
  const v: string[] = [];
  for (const x of items) {
    await bp.select(x);
    const box = bp.$("#item-detail > .item");
    const empty = box ? [...box.children].slice(1).filter(e => !text(e).trim()).map(e => e.className || e.tagName) : ["no detail"];
    for (const e of empty) v.push(`empty-row: ${x}'s detail has an empty ${e} under its title`);
  }
  return v;
}

/** Tag chips name the item's tags. (That their text reads at 4.5:1 in both themes is a fact of the stylesheet: test/dom/styles.ts.) */
export async function checkTagText(bp: DomPage, o: Oracle): Promise<string[]> {
  const v: string[] = [];
  for (const e of bp.$$("#areas .item")) {
    const id = e.id.slice(3), tags = [...e.querySelectorAll(":scope > .item-row .tagchip")].map(t => t.textContent);
    if (JSON.stringify(tags) !== JSON.stringify(o.s.items[id]?.tags ?? [])) v.push(`tag-text: ${id}'s chips say ${tags.join(",")}, its tags are ${(o.s.items[id]?.tags ?? []).join(",")}`);
  }
  return v;
}

/** The detail's difficulty chip says the item's difficulty (「难度 N」), is the one chip of its kind, sits in the line of tags under the
 * title, and an unrated item has none. Checked on an item of each kind that also has tags. (That the chip's top lines up with the
 * tags' and lies below the title needs a layout: test/e2e.) */
export async function checkDifficultyChip(bp: DomPage, o: Oracle): Promise<string[]> {
  const v: string[] = [];
  const work = Object.keys(o.s.items).filter(id => !o.s.items[id]!.record && o.r.isOpenWork(id) && o.s.items[id]!.tags?.length);
  const kinds: Array<[string, (d: unknown) => boolean]> = [["rated 1–5", d => typeof d === "number"], ["unrated", d => d === undefined]];
  for (const [kind, matches] of kinds) {
    const id = work.find(id => matches(o.s.items[id]!.difficulty));
    if (!id) { v.push(`difficulty-chip: the board has no open tagged item that is ${kind}`); continue; }
    await bp.select(id);
    const box = bp.$("#item-detail > .item");
    const chip = box?.querySelector(".item-tags .diffchip"), tag = box?.querySelector(".item-tags .tagchip:not(.diffchip)"), count = box?.querySelectorAll(".diffchip").length ?? 0;
    const d = o.s.items[id]!.difficulty, want = d === undefined ? null : difficultyText(d);
    const got = chip ? text(chip) : null;
    if (got !== want) v.push(`difficulty-chip: ${id} (${kind}) shows ${JSON.stringify(got)}, its difficulty says ${JSON.stringify(want)}`);
    if (count !== (want === null ? 0 : 1)) v.push(`difficulty-chip: ${id} (${kind}) has ${count} chips`);
    if (want !== null && chip && !tag) v.push(`difficulty-chip: ${id} has a difficulty chip but no tag chip beside it`);
  }
  return v;
}

/** The 停滞 status (docs/design.md, Status). For an open item of each live status the detail box and its chip carry the
 * status as their class; every project with part-done items has a 停滞 button counting them. (That the chip has a background of
 * its own is a fact of the stylesheet: test/dom/styles.ts.) Violations start with "idle-status". */
export async function checkIdleStatus(bp: DomPage, o: Oracle): Promise<string[]> {
  const v: string[] = [], ids = Object.keys(o.s.items).filter(id => !o.s.items[id]!.record);
  for (const status of ["todo", "idle", "wip", "blocked"]) {
    const id = ids.find(x => o.r.statusOf(x) === status);
    if (!id) { v.push(`idle-status: the board has no item with status ${status}`); continue; }
    await bp.select(id);
    const box = bp.$("#item-detail > .item"), chip = box?.querySelector(".item-head .st");
    const classes = { box: box?.className ?? "", chip: chip?.className ?? "" };
    if (!classes.box.split(" ").includes(status)) v.push(`idle-status: ${id} (${status}) has the box classes ${JSON.stringify(classes.box)}`);
    if (!classes.chip.split(" ").includes(status)) v.push(`idle-status: ${id} (${status}) has the chip classes ${JSON.stringify(classes.chip)}`);
  }
  for (const { name: g } of o.s.board.projects) {
    const n = ids.filter(x => o.s.items[x]!.group === g && o.r.statusOf(x) === "idle").length, section = bp.$(`#areas section.group[data-group="${attr(g)}"]`);
    if (!n || !section) continue;
    const labels = bp.$$(".grp-filters .sbtn", section).map(b => text(b));
    if (!labels.includes(`停滞 ${n}`)) v.push(`idle-status: ${g} has ${n} part-done items, its filter buttons read ${JSON.stringify(labels)}`);
  }
  return v;
}

/** n and the right arrow wrap around the list as it stands. With the bottom row of the left tree selected, n lands on the first row of
 * the tree holding unread content (or on the bottom row itself when that holds some), and a lap of n visits every such row once, in tree
 * order; the right arrow, with a row selected, goes to the first waiting card at or below that row in the list, not to whatever card is
 * nearest the top of the screen. With the cursor moved to an end of the list by j or k instead of a click, n and N start from the cursor.
 * The rows are read once n has walked over every item holding unread content, so a page kept open through writes is judged on the
 * same rows as a freshly loaded one. Families: wrap-n, wrap-card, wrap-cursor. */
export async function checkWrap(bp: DomPage, o: Oracle): Promise<string[]> {
  // A write can leave an item holding unread content that the tree has not drawn (a closed item, which a freshly loaded page draws
  // when it holds some); n draws it when it lands there. So n walks over every such item first, and the rows are read after.
  // The page should draw them without n (live-tree-fresh-ended); when that is fixed, this walk goes and the rows are read at once.
  await bp.settle();
  bp.blur();
  const reached = new Set<string>();
  for (let k = 0; k < 4 * o.docs.size + 4 && [...o.fresh].some(id => !reached.has(id)); k++) {
    bp.key("n"); await bp.settle();
    const sel = bp.selected();
    if (sel) reached.add(sel);
  }
  const v: string[] = [], rows = bp.treeRows();
  if (!rows.length) return v;
  const last = rows[rows.length - 1]!, freshRows = rows.filter(id => o.fresh.has(id));
  if (freshRows.length) {
    const expected = o.fresh.has(last) ? last : freshRows[0]!;
    for (let lap = 0; lap < 2; lap++) {
      await bp.select(last); bp.blur(); bp.key("n"); await bp.settle();
      const sel = bp.selected();
      if (sel !== expected) v.push(`wrap-n: n from the bottom row ${last} landed on ${sel}, expected ${expected}`);
    }
    // A lap of n from the bottom: every row holding unread content once, in tree order, starting with the first.
    await bp.select(last); bp.blur();
    const seen: string[] = [];
    for (let k = 0; k < 6 * o.docs.size + 6 && seen.length < freshRows.length; k++) {
      bp.key("n"); await bp.settle();
      const sel = bp.selected();
      if (sel && seen.at(-1) !== sel) seen.push(sel);
    }
    const start = freshRows.indexOf(expected), lap = [...freshRows.slice(start), ...freshRows.slice(0, start)];
    if (seen.join(",") !== lap.join(",")) v.push(`wrap-n: a lap of n from ${last} went ${seen.join(",")}, expected ${lap.join(",")}`);
  }
  // j and k move the cursor over the rows without selecting them, so the row clicked or landed on last is not the cursor's. n goes
  // from the cursor's row all the same: from the bottom row wrapping to the first row holding unread content, and N from the top row
  // wrapping to the last such row. Family: wrap-cursor.
  if (freshRows.length > 1) {
    const middle = freshRows[Math.floor(freshRows.length / 2)]!, cursor = () => bp.$("#areas .item.cur")?.id.slice(3) ?? null;
    const carry = async (to: string, key: "j" | "k") => {
      for (let k = 0; k < 2 * rows.length + 2 && cursor() !== to; k++) { bp.key(key); await bp.settle(); }
      return cursor() === to;
    };
    // The middle row is clicked and n lands on it; j or k then carries the cursor away from it to an end of the list.
    for (const [from, key, end, expected] of [["n", "j", last, o.fresh.has(last) ? last : freshRows[0]!], ["N", "k", rows[0]!, freshRows.at(-1)!]] as const) {
      await bp.select(middle); bp.blur(); bp.key("n"); await bp.settle();
      if (!await carry(end, key)) { v.push(`wrap-cursor: ${key} did not carry the cursor from ${middle} to ${end}, it stands on ${cursor()}`); continue; }
      bp.key(from); await bp.settle();
      const sel = bp.selected();
      if (sel !== expected) v.push(`wrap-cursor: ${from} with the cursor moved by ${key} to ${end} landed on ${sel}, expected ${expected}`);
    }
  }
  // Select the last row holding a waiting card (and no ask): the right arrow must go to its own card.
  const waiting = (id: string) => o.r.cardsOf(id).filter(k => o.r.cardWaiting(k)).length > 0;
  const target = rows.filter(id => o.s.items[id] && waiting(id) && !o.r.askPending(id)).at(-1);
  if (target) {
    await bp.select(target); bp.blur();
    bp.key("ArrowRight"); await bp.settle();
    const sel = bp.selected(), cards = bp.currentCards();
    if (sel !== target && !(cards[0] && o.s.decisions[cards[0]]?.item === target)) v.push(`wrap-card: the right arrow from ${target} went to ${sel} (card ${cards[0]}), not to the card of ${target}, the last row holding one`);
  }
  return v;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** A head's 参考 sections (not a card's folded old text), checked on the page: each folds shut under its title, looks like body text,
 * opens to its whole text, and stays open across a re-render. Families: ref-fold-split, ref-fold-look, ref-fold-keep. (Whether a folded
 * body is hidden is the browser's rule for a closed `details`; here the section must be closed and its body inside it.) */
export async function checkRefFold(bp: DomPage, b: BoardServer): Promise<string[]> {
  const v: string[] = [], x = b.gen.witness.code, st = bp.styles;
  // The expected titles are written out here, not read through the page's own title rule, so a broken rule cannot make the check
  // expect fewer sections. They are the two sections board-gen.ts writes into the code witness's head.
  const titles = ["参考：推导", "参考：测量"];
  const sections = () => bp.$$<HTMLDetailsElement>("#item-detail .rich details[data-ref]:not(.legacy)");
  const shown = () => sections().map(d => ({ open: d.open, title: text(d.querySelector("summary")), bodyShown: bp.$$(".refbody", d).some(c => bp.shown(c)) }));
  await bp.select(x);
  const first = shown();
  if (first.length !== titles.length) return [`ref-fold-split: ${x} shows ${first.length} 参考 sections, the board's code item has ${titles.length}`];
  first.forEach((d, i) => {
    if (d.title !== titles[i]) v.push(`ref-fold-split: section ${i + 1} is titled "${d.title}", its head says "${titles[i]}"`);
    if (d.open) v.push(`ref-fold-split: section ${i + 1} opens by default`);
    if (d.bodyShown) v.push(`ref-fold-split: folded section ${i + 1} still shows its text`);
  });
  // Its appearance: no monospace or boxed button look, and the text matches an ordinary paragraph of the head.
  const section = sections()[0]!, summary = bp.$("summary", section)!;
  bp.click(summary, "the title of the first 参考 section"); await bp.settle();
  st.forget();
  const family = (e: Element | null) => e ? st.value(e, "font-family") ?? "" : "";
  const bordered = (e: Element) => ["border", "border-width", "border-top-width"].some(prop => { const value = st.value(e, prop); return value !== undefined && !/\bnone\b|^0(px)?$/.test(value.trim()); });
  if (!section.open) v.push(`ref-fold-look: clicking a 参考 title does not open its section`);
  if (/mono|courier|menlo|monaco/i.test(family(summary))) v.push(`ref-fold-look: a 参考 title is set in ${family(summary)}, not the page's text font`);
  if (bordered(section) || bordered(summary)) v.push(`ref-fold-look: a 参考 section has a border, as a button would`);
  const paragraph = bp.$(".refbody p", section), plain = bp.$("#item-detail .rich > p");
  if (paragraph && plain && family(paragraph) !== family(plain)) v.push(`ref-fold-look: text in a 参考 section is set in ${family(paragraph)}, not the head's ${family(plain)}`);
  const gap = st.value(bp.$(".refbody", section)!, "gap") ?? st.value(bp.$(".refbody", section)!, "row-gap");
  if (titles.length > 1 && (gap === undefined || /^(0(px)?|normal)$/.test(gap.trim()))) v.push(`ref-fold-look: paragraphs inside a 参考 section have no space between them`);
  // Every section opens to its whole text.
  for (let i = 0; i < sections().length; i++) { const d = sections()[i]!; if (!d.open) bp.click(bp.$("summary", d), `the title of section ${i + 1}`); }
  await bp.settle();
  const opened = shown();
  opened.forEach((d, i) => { if (!d.open || !d.bodyShown) v.push(`ref-fold-split: section ${i + 1} does not show its whole text when opened`); });
  // The open state survives a re-render: the owner's reading is not folded again when the item changes. A details element tells the
  // page of a change of its state in a task of its own, so that has run before the item is written.
  await pause(20);
  const cur = b.store.snapshot().items[x]!, { rev, ...doc } = cur, at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const base = bp.changes();
  await b.store.commit({ author: "Burst", message: "ref-fold: log the item", puts: [{ kind: "item", id: x, expectRev: rev, doc: { ...doc, log: [...cur.log, { at, by: cur.group, text: "参考展开的检查写入。" }], updated: at } }] });
  await bp.waitChanges(base + 1);
  const kept = shown();
  if (kept.length !== opened.length || kept.some(d => !d.open)) v.push(`ref-fold-keep: a 参考 section the reader opened is folded again after the item changes`);
  return v;
}

/** A project's top-level items sit under its 被其他项目依赖 line exactly when an open item of another project depends on them (the
 * rules); the page is read as drawn, so a stale layout after a live change is a violation. */
function sectionViolations(bp: DomPage, r: Rules, items: Snapshot["items"]): string[] {
  const drawn = bp.$$("#areas .group").flatMap(group => bp.$$(":scope > ul.tree.lines", group).flatMap(list =>
    bp.$$(":scope > li > .item", list).map(e => ({ id: e.id.slice(3), under: !!list.previousElementSibling?.classList.contains("shared-sep") }))));
  const ended = (id: string) => /^(done|cancelled)$/.test(r.statusOf(id) ?? "");
  // Two families, so a witness can name the direction it breaks: an item left above the line when it should be under, or under it when it should not.
  return drawn.filter(d => d.under !== r.dependents(d.id).some(w => !ended(w.id) && items[w.id]?.group !== items[d.id]?.group))
    .map(d => d.under ? `shared-section-under: ${d.id} is drawn under 被其他项目依赖, but no open item of another project depends on it`
      : `shared-section-above: ${d.id} is drawn above 被其他项目依赖, but an open item of another project depends on it`);
}
/** A root another project starts to depend on moves under its project's 被其他项目依赖 line while the page stays open, and returns to
 * the project's own roots when the shared row goes. Writes to the board: a shared row on an item of another project and its removal.
 * Families: shared-section-above, shared-section-under. */
export async function checkSharedSection(bp: DomPage, b: BoardServer): Promise<string[]> {
  const s = b.store.snapshot(), r = rules(s), drawn = new Set(bp.treeRows());
  const v = sectionViolations(bp, r, s.items);
  const live = (id: string) => !s.items[id]!.record && !/^(done|cancelled)$/.test(r.statusOf(id) ?? "");
  const group = (id: string) => s.items[id]!.group;
  // A drawn open root no other project depends on yet; the first item of another project that can take a shared row to it (the write
  // refuses one that would close a cycle).
  const root = r.areas().find(id => drawn.has(id) && live(id) && !r.dependents(id).some(w => group(w.id) !== group(id)));
  if (!root) return [...v, "witness setup: the board draws no open root that no other project depends on"];
  // The first commit after the board is seeded also carries the owner's pending read cursor, and the page answers an owner change by
  // repainting everything, which would put the root in its place even without the group repaint under test. An unrelated write takes
  // that commit first.
  const base = bp.changes(), idle = Object.keys(s.items).sort().filter(id => live(id)).at(-1)!;
  await ops(b.store).appendLog({ author: group(idle), id: idle, text: "A write unrelated to the root, so the next change repaints only what it changes." });
  await bp.waitChanges(base + 1);
  let waiter: string | undefined;
  for (const id of Object.keys(s.items).sort().filter(id => id !== root && group(id) !== group(root) && live(id))) {
    try { await ops(b.store).setPlan({ author: group(id), id, row: { item: root, own: false } }); waiter = id; break; } catch { /* closes a cycle or is refused: try the next item */ }
  }
  if (!waiter) return [...v, "witness setup: no item of another project takes a shared row to the root"];
  await bp.waitChanges(base + 2);
  let now = b.store.snapshot();
  if (!rules(now).dependents(root).some(w => w.id === waiter)) v.push("witness setup: the shared row did not make the other project's item depend on the root");
  v.push(...sectionViolations(bp, rules(now), now.items));
  await ops(b.store).setPlan({ author: group(waiter), id: waiter, remove: root });
  await bp.waitChanges(base + 3);
  now = b.store.snapshot();
  if (rules(now).dependents(root).some(w => w.id === waiter)) v.push("witness setup: removing the shared row left the dependency");
  v.push(...sectionViolations(bp, rules(now), now.items));
  return v;
}
