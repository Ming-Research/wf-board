/** Offline CLI for the one-time card migration. Reports by default; --apply writes, with the daemon stopped. */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Store, readRawCardData } from "./store.ts";
import { migrateCards } from "./migrate-cards.ts";

try {
  const { values } = parseArgs({ options: { data: { type: "string" }, apply: { type: "boolean" } } });
  if (!values.data) throw new Error("Usage: npm run migrate:cards -- --data DIR [--apply]  (apply only with the daemon stopped)");
  const data = resolve(values.data), raw = await readRawCardData(data);
  const result = migrateCards(raw, new Date().toISOString());
  const { errors, ...counts } = result.report;
  console.info(JSON.stringify({ head: raw.head, ...counts, errors: errors.length }, null, 2));
  if (errors.length) throw new Error(errors.slice(0, 20).join("\n") + (errors.length > 20 ? `\n… ${errors.length - 20} more` : ""));
  if (values.apply) console.info(`Migrated in ${await Store.commitCardMigration(data, raw, result, "wf-board")}`);
  else console.info("Report only; nothing written. Stop the daemon, then run again with --apply.");
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
