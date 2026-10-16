// One-time migration of the temporary difficulties that plan rows carried in their text ("实现（难度 2）：…",
// "写设计文档（架构师做）") into the difficulty field. Delete this file, its CLI and its test once it has run on the live
// board. It only reads a snapshot and plans; apply() writes the plan as one commit.

import type { Difficulty, Item, PlanRow, Snapshot } from "./model.ts";
import { rules } from "./rules.ts";
import type { Store } from "./store.ts";
import { difficultyLogText } from "./ops.ts";

/** Exactly the forms the architect wrote: 「（难度 N）」 with N in 1–5, and 「（架构师做）」, in full-width or ASCII parentheses. */
const LEVEL = /[（(]难度 ?([1-5])[）)]/g;
const ARCHITECT = /[（(]架构师做[）)]/g;
/** Any parenthetical about 难度: what is left after the exact forms are the ones a person must settle. */
const ANY_LEVEL = /[（(]难度[^）)]*[）)]/g;
export const MIGRATION_REASON = "迁移：计划行文字里写的难度改存到字段";

export interface MigratedRow { id: string; from: string; to: string }
export interface MigratedItem { id: string; group: string; difficulty: Difficulty; /** Already set to this: only the row texts change. */ alreadySet: boolean; rows: MigratedRow[] }
export interface ByHand { id: string; group: string; reason: string; rows: string[] }
export interface MigrationPlan {
  items: MigratedItem[];
  byHand: ByHand[];
  /** Done or cancelled items that still mention a difficulty in a row: left as they are. */
  closed: string[];
  /** Open work that stays without a difficulty after the migration and will raise 缺难度: the number the rollout meets. */
  stillUnrated: number;
}

interface Marked { row: Extract<PlanRow, { text: string }>; levels: Difficulty[]; unparsed: string[]; stripped: string }
function marked(row: PlanRow): Marked | undefined {
  if (!("text" in row)) return undefined;
  const levels: Difficulty[] = [];
  let rest = row.text;
  rest = rest.replace(LEVEL, (_, n: string) => { levels.push(Number(n) as Difficulty); return ""; });
  rest = rest.replace(ARCHITECT, () => { levels.push("architect"); return ""; });
  const unparsed = rest.match(ANY_LEVEL) ?? [];
  return levels.length || unparsed.length ? { row, levels, unparsed, stripped: rest.trim() } : undefined;
}

export function planDifficultyMigration(s: Snapshot): MigrationPlan {
  const r = rules(s), plan: MigrationPlan = { items: [], byHand: [], closed: [], stillUnrated: 0 };
  const migrating = new Set<string>();
  for (const id of Object.keys(s.items).sort()) {
    const it = s.items[id]!, rows = it.plan.map(marked).filter((m): m is Marked => !!m);
    if (!rows.length || it.record) continue;
    if (!r.isOpenWork(id)) { plan.closed.push(id); continue; }
    const hand = (reason: string) => plan.byHand.push({ id, group: it.group, reason, rows: rows.map(m => m.row.text) });
    if (rows.some(m => m.unparsed.length)) { hand(`写法不在迁移认得的两种之内：${rows.flatMap(m => m.unparsed).join("、")}`); continue; }
    // The level of what is still to do: finished and dropped rows are history and carry no say.
    const live = rows.filter(m => m.row.state === "todo" || m.row.state === "doing");
    const levels = new Set(live.flatMap(m => m.levels));
    if (!levels.size) { hand("只有已完成或放弃的行写了难度，剩下的行没写"); continue; }
    if (levels.size > 1) { hand(`未完成的行写了不同的难度：${[...levels].join("、")}`); continue; }
    const difficulty = [...levels][0]!;
    if (it.difficulty !== undefined && it.difficulty !== difficulty) { hand(`字段已经是 ${it.difficulty}，行里写的是 ${difficulty}`); continue; }
    if (rows.some(m => !m.stripped)) { hand("去掉标记后有一行是空的"); continue; }
    migrating.add(id);
    plan.items.push({ id, group: it.group, difficulty, alreadySet: it.difficulty !== undefined, rows: rows.map(m => ({ id: m.row.id, from: m.row.text, to: m.stripped })) });
  }
  for (const id of Object.keys(s.items)) {
    const it = s.items[id]!;
    if (!it.record && it.difficulty === undefined && !migrating.has(id) && r.isOpenWork(id) && !r.isRequest(id) && !r.isBacklog(id) && !r.isPaused(id)) plan.stillUnrated++;
  }
  return plan;
}

/** The documents the plan changes, ready to commit: each item gets its difficulty, its row texts without the marker, and two log lines. */
export function migratedItems(s: Snapshot, plan: MigrationPlan, at: string): Array<{ id: string; doc: Item }> {
  return plan.items.map(m => {
    const it = s.items[m.id]!, texts = new Map(m.rows.map(row => [row.id, row.to]));
    const log = [...it.log];
    if (!m.alreadySet) log.push({ at, by: "Architect", text: difficultyLogText(undefined, m.difficulty, MIGRATION_REASON) });
    log.push({ at, by: "Architect", text: `迁移：计划行里的难度标记已去掉：${m.rows.map(row => `${row.id}「${row.from}」`).join("；")}` });
    return { id: m.id, doc: { ...it, difficulty: m.difficulty, plan: it.plan.map(row => "text" in row && texts.has(row.id) ? { ...row, text: texts.get(row.id)! } : row), log, updated: at } };
  });
}

/** Writes the plan as one commit, or nothing when there is nothing to migrate. */
export async function applyDifficultyMigration(store: Store, plan: MigrationPlan, at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")): Promise<string | undefined> {
  if (!plan.items.length) return undefined;
  const s = store.snapshot();
  const puts = migratedItems(s, plan, at).map(({ id, doc }) => ({ kind: "item" as const, id, doc, expectRev: s.items[id]!.rev }));
  return (await store.commit({ author: "Architect", session: "difficulty-migration", message: `migrate_difficulty ${puts.length} items`, puts })).commit;
}

/** The report the CLI prints. */
export function reportLines(plan: MigrationPlan): string[] {
  const lines = [`migrate: ${plan.items.length}, by hand: ${plan.byHand.length}, closed items left alone: ${plan.closed.length}, open work still unrated afterwards (raises 缺难度): ${plan.stillUnrated}`];
  for (const m of plan.items) lines.push(`migrate ${m.id} [${m.group}] ${m.difficulty === "architect" ? "架构师做" : m.difficulty}${m.alreadySet ? " (field already set)" : ""}`, ...m.rows.map(row => `    ${row.id}: ${row.from}  →  ${row.to}`));
  for (const h of plan.byHand) lines.push(`by hand ${h.id} [${h.group}]: ${h.reason}`, ...h.rows.map(text => `    ${text}`));
  if (plan.closed.length) lines.push(`closed: ${plan.closed.join(", ")}`);
  return lines;
}
