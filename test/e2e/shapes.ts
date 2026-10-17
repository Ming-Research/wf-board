// The structural shape categories of a board, counted with the shared rules. The generator test requires every
// category in the generated board; the same function surveyed the real board (counts in docs/design.md section 11).

import { rules } from "../../src/rules.ts";
import type { Snapshot } from "../../src/model.ts";

export function shapeCounts(s: Snapshot): Record<string, number> {
  const r = rules(s), c: Record<string, number> = {};
  const inc = (k: string, n = 1) => { c[k] = (c[k] ?? 0) + n; };
  const ids = Object.keys(s.items);
  const plans = (pred: (row: Snapshot["items"][string]["plan"][number]) => boolean) => ids.filter(o => s.items[o]!.plan.some(pred));
  for (const id of ids) {
    const it = s.items[id]!, st = r.statusOf(id) ?? "record";
    inc("items"); inc("status " + st);
    if (it.paused) inc("explicit pause");
    if (r.isPaused(id) && !it.paused) inc("inherited pause");
    if (r.askPending(id)) inc("pending ask");
    if (it.ask && !r.askPending(id)) inc("answered ask");
    if (it.provisional) inc("provisional plan");
    if (it.targets?.length) inc("targets");
    if ((it.tags?.length ?? 0) > 1) inc("two or more tags");
    if (typeof it.difficulty === "number") inc("difficulty 1–5");
    if (r.checks(id).some(c => c.label === "缺难度")) inc("missing difficulty");
    if (r.ancestors(id).length >= 5) inc("depth 5 or more");
    if (r.children(id).length > 10) inc("more than 10 owned children");
    if (r.ancestors(id).some(a => s.items[a]!.record)) inc("owned under a record");
    const shared = plans(row => "item" in row && row.item === id && !row.own);
    if (shared.length) inc("named by a shared row");
    if (shared.some(o => s.items[o]!.group !== it.group)) inc("shared across projects");
    if (it.plan.some(row => row.after)) inc("parallel plan rows");
    if (it.plan.some(row => "state" in row && row.state === "dropped")) inc("dropped step");
    if (it.plan.some(row => "state" in row && row.state === "doing")) inc("doing step");
    if (it.plan.length > 10) inc("plan over 10 rows");
    if (it.plan.some(row => "card" in row && s.decisions[row.card]?.item !== id)) inc("plan names another item's card");
    if (/```/.test(it.head ?? "")) inc("code block in head");
    if (/\n\|/.test(it.head ?? "")) inc("table in head");
    if (/\[\[(it|q):/.test(it.head ?? "")) inc("reference in head");
    if (it.log.length > 20) inc("log over 20 entries");
    if (it.links.length) inc("links");
    if (r.blockingBelow(id) > 1) inc("purple count over 1");
    if (r.nonBlockingBelow(id) > 1) inc("red count over 1");
  }
  for (const [k, d] of Object.entries(s.decisions)) {
    inc("cards"); inc("card " + d.status);
    if (r.cardBlocking(k)) inc("open blocking card");
    const named = plans(row => "card" in row && row.card === k);
    if (named.length > 1) inc("card named by several plans");
    if (named.some(o => o !== d.item && r.statusOf(o) === "done")) inc("card named by a done item's plan");
    if (named.length && !named.includes(d.item)) inc("card named only by other plans");
    if (d.status === "open" && !named.length) inc("open card no plan names");
    if (d.status === "open" && !named.length && s.items[d.item]?.record) inc("open card on a record, no plan names");
    if (d.status === "open" && r.statusOf(d.item) === "done") inc("open card on a done item");
  }
  for (const n of Object.values(s.notes)) {
    inc("note " + n.kind); inc("note " + n.state);
    if (n.reply) inc("note with reply");
    if (n.anchor) inc("anchored note");
    if (n.target.startsWith("q:")) inc("note on a card");
  }
  inc("glossary terms", Object.values(s.glossaries).reduce((a, g) => a + g.terms.length, 0));
  inc("project-limited tags", (s.board.tags ?? []).filter(t => t.projects).length);
  return c;
}

/** Every category the generated board must contain at least once. */
export const REQUIRED_SHAPES = [
  "status done", "status cancelled", "status wip", "status idle", "status blocked", "status todo", "status paused", "status record",
  "explicit pause", "inherited pause", "pending ask", "answered ask", "provisional plan", "targets",
  "two or more tags", "difficulty 1–5", "missing difficulty", "depth 5 or more", "more than 10 owned children", "owned under a record", "named by a shared row",
  "shared across projects", "parallel plan rows", "dropped step", "doing step", "plan over 10 rows",
  "plan names another item's card", "code block in head", "table in head", "reference in head", "log over 20 entries", "links",
  "purple count over 1", "red count over 1", "card open", "card ruled", "open blocking card", "card named by several plans",
  "card named by a done item's plan", "card named only by other plans", "open card no plan names",
  "open card on a record, no plan names", "open card on a done item", "note comment", "note choice", "note explain",
  "note approve", "note sent", "note done", "note with reply", "anchored note", "note on a card",
  "glossary terms", "project-limited tags",
];
