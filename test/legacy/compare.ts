// Shared assertion surface, not a shared rules implementation or mapper.
import type { Snapshot } from "../../src/model.ts";
import { rules } from "../../src/rules.ts";
import { legacyRules } from "./board-rules.js";
import type { LegacyState } from "./board-rules.js";

export interface Disagreement { id: string; rule: string; old: unknown; new: unknown }
export function compare(old: LegacyState, snapshot: Pick<Snapshot, "board" | "items" | "decisions" | "notes" | "owner">): Disagreement[] {
  const legacy = legacyRules(old), current = rules(snapshot), disagreements: Disagreement[] = [];
  // The legacy rules are what an unmigrated project uses, so priority compares
  // too. Per-item agent checks are superseded by project configuration checks;
  // The stalled-work check depends on wall-clock activity the legacy page never
  // had, so it is excluded as well; compare every other legacy flag, including order and targets elsewhere.
  for (const it of old.items) {
    const values: Array<[string, unknown, unknown]> = [
      ["statusOf", legacy.statusOf(it), current.statusOf(it.id)],
      ["priorityOf", legacy.priorityOf(it), current.writtenPriorityOf(it.id)],
      ["effectivePriorityOf", legacy.effPriorityOf(it), current.priorityOf(it.id)],
      ["raisedBy", legacy.raisedBy(it)?.id || null, current.raisedBy(it.id)],
      ["needsOwner", legacy.needsOwner(it), current.needsOwner(it.id)],
      ["onCycle", legacy.onCycle().has(it.id), current.onCycle(it.id)],
      ["inArchive", legacy.inArchive(it), current.inArchive(it.id)],
      ["checks", legacy.checksOf(it).map(c => c.text).filter(t => t !== "顶层条目没有负责会话（agent）"), current.checks(it.id).filter(c => c.label !== "无人推进").map(c => c.text).filter(t => !/^项目没有配置：/.test(t))],
    ];
    for (const [rule, before, after] of values) if (JSON.stringify(before) !== JSON.stringify(after)) disagreements.push({ id: it.id, rule, old: before, new: after });
  }
  const before = legacy.tops().map(it => it.id), after = current.areas(id => !current.isArchived(id));
  if (JSON.stringify(before) !== JSON.stringify(after)) disagreements.push({ id: "board", rule: "areas", old: before, new: after });
  return disagreements;
}
