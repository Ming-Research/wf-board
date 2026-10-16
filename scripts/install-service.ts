// Explicit installer; prints the launchctl command without running it.
// WF_BOARD_NODE names the node to run (default: this node). Give a stable path such as
// /opt/homebrew/opt/node@24/bin/node: process.execPath resolves to a versioned Cellar path
// that a Homebrew upgrade removes. WF_BOARD_PATH gives the service's PATH (default: this shell's), so it runs
// the same git as the shell rather than launchd's default /usr/bin/git, an Xcode shim that fails
// while an Xcode license is unaccepted.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDir } from "../src/data-dir.ts";
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const home = homedir();
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const template = await readFile(join(repo, "ops/wf-board.plist"), "utf8");
const values = { NODE: process.env.WF_BOARD_NODE ?? process.execPath, REPO: repo, HOME: home, PATH: process.env.WF_BOARD_PATH ?? process.env.PATH ?? "/usr/bin:/bin", DATA: process.env.WF_BOARD_DATA ?? defaultDataDir(repo) };
const plist = template.replace(/{{(NODE|REPO|HOME|PATH|DATA)}}/g, (_, key: keyof typeof values) => escape(values[key]));
const target = join(home, "Library/LaunchAgents/org.ming-research.wf-board.plist");
await mkdir(dirname(target), { recursive: true });
await mkdir(join(home, "Library/Logs"), { recursive: true });
await writeFile(target, plist);
console.info(`launchctl bootstrap gui/${process.getuid!()} '${target.replace(/'/g, "'\\''")}'`);
