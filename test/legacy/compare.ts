// Shared assertion surface, not a shared rules implementation or mapper.
import type { Snapshot } from "../../src/model.ts";
import { rules } from "../../src/rules.ts";
import { legacyRules } from "./board-rules.js";
import type { LegacyState } from "./board-rules.js";

export interface Disagreement { id: string; rule: string; old: unknown; new: unknown }
export function compare(old: LegacyState, snapshot: Pick<Snapshot, "items" | "decisions" | "notes" | "owner">): Disagreement[] {
  const legacy = legacyRules(old), current = rules(snapshot), disagreements: Disagreement[] = [];
  for (const it of old.items) {
    const values: Array<[string, unknown, unknown]> = [
      ["statusOf", legacy.statusOf(it), current.statusOf(it.id)],
      ["priorityOf", legacy.priorityOf(it), current.priorityOf(it.id)],
      ["effectivePriorityOf", legacy.effPriorityOf(it), current.effectivePriorityOf(it.id)],
      ["raisedBy", legacy.raisedBy(it)?.id || null, current.raisedBy(it.id)],
      ["needsOwner", legacy.needsOwner(it), current.needsOwner(it.id)],
      ["onCycle", legacy.onCycle().has(it.id), current.onCycle(it.id)],
      ["inArchive", legacy.inArchive(it), current.inArchive(it.id)],
      ["checks", legacy.checksOf(it).map(c => c.text), current.checks(it.id).map(c => c.text)],
    ];
    for (const [rule, before, after] of values) if (JSON.stringify(before) !== JSON.stringify(after)) disagreements.push({ id: it.id, rule, old: before, new: after });
  }
  const before = legacy.tops().map(it => it.id), after = current.areas(id => !current.isArchived(id));
  if (JSON.stringify(before) !== JSON.stringify(after)) disagreements.push({ id: "board", rule: "areas", old: before, new: after });
  return disagreements;
}
