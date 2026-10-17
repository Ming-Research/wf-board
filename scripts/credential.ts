// Issues, lists and revokes the long-lived credentials (the architect's, the PM's, the observer's, the resource agent's) that the board
// reads from a file outside its data directory; only the service writes the data directory, so this file is written here.
// The file holds each credential's SHA-256 only, so the token is printed once, when it is issued, and cannot be shown again.
//
//   node scripts/credential.ts issue <session> <role> <project> [--roots a,b]   prints the token on stdout
//   node scripts/credential.ts list
//   node scripts/credential.ts revoke <session>
//
// WF_BOARD_CREDENTIALS names the file (default: wf-board/credentials.json in the user's configuration directory, mode 0600). The service reads it again whenever
// it changes. docs/design.md, section 9, tells what a credential protects against.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CredentialsFile, LongLived, defaultCredentialsPath, hashToken, newToken } from "../src/credentials.ts";
import type { LongLived as Entry } from "../src/credentials.ts";
import { LONG_LIVED_ROLES } from "../src/model.ts";

const file = defaultCredentialsPath();
const usage = `usage: node scripts/credential.ts issue <session> <role: ${LONG_LIVED_ROLES.join("|")}> <project> [--roots a,b] | list | revoke <session>`;
const [command, ...rest] = process.argv.slice(2);

async function load(): Promise<Entry[]> {
  const text = await readFile(file, "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
  return text === undefined ? [] : CredentialsFile.parse(JSON.parse(text)).credentials;
}
async function save(credentials: Entry[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.${process.pid}.tmp`;
  await writeFile(next, JSON.stringify(CredentialsFile.parse({ credentials }), null, 2) + "\n", { mode: 0o600 });
  await chmod(next, 0o600);
  await rename(next, file);
}

if (command === "issue") {
  const roots = rest.includes("--roots") ? (rest[rest.indexOf("--roots") + 1] ?? "").split(",").filter(Boolean) : [];
  const [session, role, project] = rest.filter((word, n) => word !== "--roots" && rest[n - 1] !== "--roots");
  if (!session || !role || !project) throw new Error(usage);
  const token = newToken();
  const entry = LongLived.parse({ session, role, project, roots, hash: hashToken(token) });
  await save([...(await load()).filter(c => c.session !== entry.session), entry]);
  console.error(`${entry.session} (${entry.role}, project ${entry.project}) can now write with this token; it is not shown again. Put it in the session's MCP configuration as the Authorization header "Bearer <token>". File: ${file}`);
  console.log(token);
} else if (command === "list") {
  for (const c of await load()) console.log(`${c.session}\t${c.role}\t${c.project}\t${c.roots.join(",")}`);
} else if (command === "revoke") {
  const [session] = rest;
  if (!session) throw new Error(usage);
  const all = await load(), left = all.filter(c => c.session !== session);
  if (left.length === all.length) throw new Error(`no credential for session ${session}`);
  await save(left);
  console.error(`revoked the credential of ${session}`);
} else throw new Error(usage);
