/** One-time offline migration CLI (see migrate-architect-level.ts): no default path, no daemon connection; stop the daemon first. */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Store } from "./store.ts";

try {
  const { values } = parseArgs({ options: { data: { type: "string" } } });
  if (!values.data) throw new Error("Usage: npm run migrate:architect-level -- --data DIR\nClears the retired level 「架构师做」 from the items that hold it, in one commit. Stop the daemon first, or run on a copy of the data.");
  const store = await Store.open(resolve(values.data), { clearArchitectLevel: true });
  const ids = [...store.clearedArchitectLevel].sort();
  console.info(ids.length ? `Cleared the retired level from ${ids.length} items: ${ids.join(", ")}\nCommit ${store.snapshot().head}` : "Nothing to migrate.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
