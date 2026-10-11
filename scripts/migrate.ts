// One-time migration of the claude.ai artifact board into a wf-board data repository
// (docs/design.md section 10). Usage: node scripts/migrate.ts <data-dir> <export.json>
// The export stays in <data-dir>/import/ as provenance; records whose target was deleted
// go to import/orphans.json; the board is written as two commits (as the owner last read
// it, then the changes since) with the owner's read cursor between them.
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Store } from "../src/store.ts";
import { convertExport, importExport } from "../src/convert.ts";

const run = promisify(execFile);
const [dirArg, exportArg] = process.argv.slice(2);
if (!dirArg || !exportArg) { console.error("Usage: node scripts/migrate.ts <data-dir> <export.json>"); process.exit(2); }
const dir = resolve(dirArg);
const exportJson = JSON.parse(await readFile(exportArg, "utf8")) as unknown;
const converted = convertExport(exportJson);
await mkdir(join(dir, "import"), { recursive: true });
const orphans = join(dir, "import/orphans.json");
await writeFile(orphans, JSON.stringify(converted.orphans, null, 2) + "\n");
await run("git", ["add", "--", relative(dir, orphans)], { cwd: dir });
await run("git", ["-c", "commit.gpgsign=false", "commit", "-q", "--author", "migration <migration@wf-board.invalid>", "-m", "Keep the notes and reads whose target was deleted before the migration"], { cwd: dir });
const store = await Store.open(dir, { init: true, board: converted.board });
const result = await importExport(store, exportJson);
await store.flushOwner("migration");
console.log(converted.report.join("\n"));
console.log(`as read: ${result.asReadCommit}\ncurrent: ${result.currentCommit}`);
