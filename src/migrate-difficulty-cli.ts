/** One-time offline migration CLI (see migrate-difficulty.ts): no default path, no daemon connection; stop the daemon first. */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Store } from "./store.ts";
import { planDifficultyMigration, applyDifficultyMigration, reportLines } from "./migrate-difficulty.ts";

try {
  const { values } = parseArgs({ options: { data: { type: "string" }, apply: { type: "boolean" } } });
  if (!values.data) throw new Error("Usage: npm run migrate:difficulty -- --data DIR [--apply]\nWithout --apply it only prints the report. Stop the daemon first, or run on a copy of the data.");
  const store = await Store.open(resolve(values.data));
  const plan = planDifficultyMigration(store.snapshot());
  console.info(reportLines(plan).join("\n"));
  if (values.apply) {
    const commit = await applyDifficultyMigration(store, plan);
    console.info(commit ? `Migrated ${plan.items.length} items in ${commit}` : "Nothing to migrate.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
