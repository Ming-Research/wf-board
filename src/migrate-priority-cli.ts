/** One-time offline migration CLI (see migrate-priority.ts): no default path, no daemon connection; stop the daemon first, or run on a copy. */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Store } from "./store.ts";
import { priorityReport } from "./migrate-priority.ts";

try {
  const { values } = parseArgs({ options: { data: { type: "string" } } });
  if (!values.data) throw new Error("Usage: npm run migrate:priority -- --data DIR\nClears the retired item priority from the items that hold it, in one commit, and prints the value each held. Stop the daemon first, or run on a copy of the data.");
  const store = await Store.open(resolve(values.data), { clearPriority: true });
  const cleared = store.clearedPriority;
  console.info(cleared.length ? `${priorityReport(cleared).join("\n")}\nCommit ${store.snapshot().head}` : "Nothing to migrate.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
