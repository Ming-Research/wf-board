// One-time migration of the retired difficulty level 「架构师做」: an item file written with `difficulty: architect` is
// cleared to unrated, with a log line saying so (docs/design.md, section 5, Difficulty). The board refuses to start on
// such a file; Store.open(dir, { clearArchitectLevel: true }) clears them in one commit, and the command in
// migrate-architect-level-cli.ts does that offline. Delete this file, the command, its test, the npm script, the start
// option in store.ts and the design paragraph once it has run on the live board. What stays is store.ts's omission of the
// level from old versions, and the rule that unread reads its clearing as bookkeeping (rules.ts).

import type { Item } from "./model.ts";

/** What the refusal to start says about an item file that still holds the level. */
export const RETIRED_LEVEL_REFUSAL = "difficulty: the level 「架构师做」 no longer exists; clear it once with the daemon stopped: npm run migrate:architect-level -- --data DIR";
/** The log line of the item that held it, in the form of the difficulty log lines (from → to, and why). */
export const CLEARED_LOG = "难度：架构师做 → 未评，理由：迁移：这一级已取消，条目都评 1–5 级，等 PM 评级";

/** The item as the migration leaves it: no difficulty (the file has been read without the level), one log line more. */
export function clearedItem(item: Item, at: string): Item {
  return { ...item, updated: at, log: [...item.log, { at, by: "wf-board", text: CLEARED_LOG }] };
}
