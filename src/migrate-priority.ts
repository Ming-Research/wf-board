// One-time migration of the retired item priority (an item file's `priority: P0 | P1 | P2`; docs/design.md, section 5,
// Status). No schema accepts the field any more, but the files of the live board hold it on every root, and old versions
// in history hold it too, which historical comparison omits as it omits the other retired fields (section 9). A board
// whose files still hold it refuses to start unless Store.open is given { clearPriority: true }; the daemon gives it, so
// the first start with this code clears the field in one commit, and the command in migrate-priority-cli.ts does the same
// offline on a copy. The commit is bookkeeping: it sets no `updated` and adds no log line, so no item looks changed; the value
// each item held stays in git history and in the report. Delete this file, the command, its test, the npm script, the start
// option in store.ts and main.ts, the commit's bookkeeping checks in store.ts and timed-wake.ts and the design paragraph once it
// has run on the live board. What stays is store.ts's omission of the field from old versions.

/** What the refusal to start says about an item file that still holds the field. */
export const RETIRED_PRIORITY_REFUSAL = "priority: the item priority no longer exists; start with the migration, or clear it once with the daemon stopped: npm run migrate:priority -- --data DIR";
/** The message of the one commit that clears them. */
export const CLEAR_PRIORITY_MESSAGE = "clear_priority";
/** Whether a commit message is the clearing commit: bookkeeping, not work on the items, so activity and the timed wake leave it out. */
export const isPriorityClearing = (message: string): boolean => message.startsWith(`${CLEAR_PRIORITY_MESSAGE} `);

/** An item file that holds the field, and its value. */
export interface ClearedPriority { id: string; group: string; priority: string }

/** The report the command and the daemon's log print: one line per item (key, project, the value it held), the totals by value first. */
export function priorityReport(cleared: readonly ClearedPriority[]): string[] {
  const byValue = new Map<string, number>();
  for (const c of cleared) byValue.set(c.priority, (byValue.get(c.priority) ?? 0) + 1);
  const totals = [...byValue].sort(([a], [b]) => a.localeCompare(b)).map(([value, n]) => `${value} ${n}`).join(", ");
  return [`Cleared the retired priority of ${cleared.length} items (${totals})`, ...[...cleared].sort((a, b) => a.id.localeCompare(b.id)).map(c => `${c.id} · ${c.group} · ${c.priority}`)];
}
