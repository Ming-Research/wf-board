// One-time migration of the retired item priority (an item file's `priority: P0 | P1 | P2`; docs/design.md, section 5,
// Status). No schema accepts the field any more, but the files of the live board hold it on every root, and old versions
// in history hold it too, which historical comparison omits as it omits the other retired fields (section 9). A board
// whose files still hold it refuses to start unless Store.open is given { clearPriority: true }; the daemon gives it, so
// the first start with this code clears the field in one commit, and the command in migrate-priority-cli.ts does the same
// offline on a copy. Delete this file, the command, its test, the npm script, the start option in store.ts and main.ts and
// the design paragraph once it has run on the live board. What stays is store.ts's omission of the field from old versions.

import type { Item } from "./model.ts";

/** What the refusal to start says about an item file that still holds the field. */
export const RETIRED_PRIORITY_REFUSAL = "priority: the item priority no longer exists; start with the migration, or clear it once with the daemon stopped: npm run migrate:priority -- --data DIR";
/** The message of the one commit that clears them. */
export const CLEAR_PRIORITY_MESSAGE = "clear_priority";
/** The log line of an item that held a priority, in the form of the other migration lines (from → to, and why). */
export const clearedPriorityLog = (was: unknown): string => `优先级：${String(was)} → 去掉，理由：迁移：先做什么改由架构师定，必须先做的用依赖表达`;

/** An item file that holds the field, and its value. */
export interface ClearedPriority { id: string; group: string; priority: string }

/** The item as the migration leaves it: no priority (the file has been read without it), one log line more. */
export function priorityClearedItem(item: Item, was: unknown, at: string): Item {
  return { ...item, updated: at, log: [...item.log, { at, by: "wf-board", text: clearedPriorityLog(was) }] };
}

/** The report the command and the daemon's log print: one line per item (key, project, the value it held), the totals by value first. */
export function priorityReport(cleared: readonly ClearedPriority[]): string[] {
  const byValue = new Map<string, number>();
  for (const c of cleared) byValue.set(c.priority, (byValue.get(c.priority) ?? 0) + 1);
  const totals = [...byValue].sort(([a], [b]) => a.localeCompare(b)).map(([value, n]) => `${value} ${n}`).join(", ");
  return [`Cleared the retired priority of ${cleared.length} items (${totals})`, ...[...cleared].sort((a, b) => a.id.localeCompare(b.id)).map(c => `${c.id} · ${c.group} · ${c.priority}`)];
}
