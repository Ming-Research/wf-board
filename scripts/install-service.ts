// Explicit installer; prints the launchctl command without running it.
// WF_BOARD_NODE names the node to run (default: this node). Give a stable path such as
// /opt/homebrew/opt/node@24/bin/node: process.execPath resolves to a versioned Cellar path
// that a Homebrew upgrade removes.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const home = homedir();
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const template = await readFile(join(repo, "ops/wf-board.plist"), "utf8");
const plist = template.replace(/{{(NODE|REPO|HOME)}}/g, (_, key: "NODE" | "REPO" | "HOME") => escape({ NODE: process.env.WF_BOARD_NODE ?? process.execPath, REPO: repo, HOME: home }[key]));
const target = join(home, "Library/LaunchAgents/org.ming-research.wf-board.plist");
await mkdir(dirname(target), { recursive: true });
await mkdir(join(home, "Library/Logs"), { recursive: true });
await writeFile(target, plist);
console.info(`launchctl bootstrap gui/${process.getuid!()} '${target.replace(/'/g, "'\\''")}'`);
