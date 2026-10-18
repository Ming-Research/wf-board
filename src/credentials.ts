import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ARCHITECT, ARCHITECT_ROLE, ARCHITECT_SESSION, ARCHITECT_TURN_SESSION, Key, LONG_LIVED_ROLES, PM_AUTHOR, PM_ROLE, PM_SESSION, isArchitectName } from "./model.ts";
import type { Access, Item, Snapshot } from "./model.ts";

/**
 * Credentials: who is writing is told by the connection, not by the caller (docs/design.md, section 9). A credential is a
 * random token the writer sends as `Authorization: Bearer <token>`; the board keeps only its SHA-256. They protect against
 * a wrong name and a borrowed one by mistake, not against an agent that reads another's configuration on purpose.
 *
 * Two kinds exist. A dispatch credential is issued with the dispatch record (ops dispatchStart) and valid until the dispatch
 * ends; it names the session, the role, the item whose subtree the session works on and the item's project. A long-lived
 * credential belongs to the architect, the PM, the observer or the resource agent; its hash is in a file outside the data directory,
 * which the service only reads (the script scripts/credential.ts writes it).
 */

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
/** A new token: 256 random bits behind a prefix that tells what it is when one turns up in a file or a log. */
export const newToken = (): string => "wfb_" + randomBytes(32).toString("base64url");

/** The token in an `Authorization` header, or none when the header is not `Bearer <token>`. */
export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m?.[1];
}

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
export const LongLived = z.object({
  /** The session name every write under this credential is recorded with. */
  session: z.string().trim().min(1).max(80).refine(s => !/\p{Cc}/u.test(s), "no control characters"),
  role: z.enum(LONG_LIVED_ROLES),
  /** The project the writes are recorded under (the commit author and the log's `by`). */
  project: z.string().min(1),
  /** The items the role's `subtree` parts are limited to; the resource agent's own records, say. */
  roots: z.array(Key).default([]),
  hash: Hash,
}).strict()
  .refine(c => c.role !== ARCHITECT_ROLE || (c.project === ARCHITECT && isArchitectName(c.session)), `the architect's credential is project ${ARCHITECT}, session ${ARCHITECT_SESSION} or ${ARCHITECT_TURN_SESSION}`)
  // Author Architect from either of these sessions is what the board takes for the architect (model isArchitect); no other role writes under them.
  .refine(c => c.role === ARCHITECT_ROLE || !isArchitectName(c.session), `the session names ${ARCHITECT_SESSION} and ${ARCHITECT_TURN_SESSION} are the architect's alone`)
  // The PM writes as author PM, the project of its own, from the session PM (model isPM), on the same terms.
  .refine(c => c.role !== PM_ROLE || (c.project === PM_AUTHOR && c.session === PM_SESSION), `the PM's credential is project ${PM_AUTHOR}, session ${PM_SESSION}`)
  .refine(c => c.role === PM_ROLE || c.session !== PM_SESSION, `the session name ${PM_SESSION} is the PM's alone`);
export type LongLived = z.infer<typeof LongLived>;
export const CredentialsFile = z.object({ credentials: z.array(LongLived) }).strict().superRefine((file, ctx) => {
  for (const key of ["session", "hash"] as const) if (new Set(file.credentials.map(c => c[key])).size !== file.credentials.length) ctx.addIssue(`two credentials have the same ${key}`);
});

/** Where the long-lived credentials are kept: outside the data directory, since only the service writes that. */
export const defaultCredentialsPath = (env: { WF_BOARD_CREDENTIALS?: string } = process.env): string => env.WF_BOARD_CREDENTIALS ?? join(homedir(), ".config", "wf-board", "credentials.json");

/**
 * The long-lived credentials file, read again whenever its modification time or size changes, so a credential the script issues
 * or revokes counts at the next request. A missing file holds none; a file that does not parse holds none either, and says why
 * (every request carrying a credential is refused with that, and the service log has it once).
 */
export class CredentialFile {
  #stamp: string | undefined;
  #read: { entries: LongLived[] } | { error: string } = { entries: [] };
  readonly path: string;
  readonly #log: (message: string) => void;
  constructor(path: string, log: (message: string) => void = console.error) { this.path = path; this.#log = log; }
  read(): { entries: LongLived[] } | { error: string } {
    let stamp: string;
    try { const st = statSync(this.path); stamp = `${st.mtimeMs}:${st.size}`; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return this.#set("missing", { error: `the credentials file cannot be read: ${(error as Error).message}` });
      return this.#set("missing", { entries: [] });
    }
    if (stamp === this.#stamp) return this.#read;
    try { return this.#set(stamp, { entries: CredentialsFile.parse(JSON.parse(readFileSync(this.path, "utf8"))).credentials }); }
    catch (error) { return this.#set(stamp, { error: `the credentials file is not valid: ${error instanceof z.ZodError ? error.issues.map(i => `${i.path.join(".") || "file"}: ${i.message}`).join("; ") : (error as Error).message}` }); }
  }
  #set(stamp: string, result: { entries: LongLived[] } | { error: string }): typeof result {
    if (stamp !== this.#stamp && "error" in result) this.#log(result.error);
    this.#stamp = stamp; this.#read = result;
    return result;
  }
}

/** A writer the connection identified: `author` and `session` are what its writes are recorded under, `access` what it may change. */
export interface Identified { author: string; session: string; access: Access }
/** The outcome of reading a request's credential: a writer, or why the credential is refused. */
export type Resolved = { ok: true; who: Identified } | { ok: false; problem: string };
export const REFUSED = "this connection's credential is not valid (unknown, or revoked when its dispatch ended); ask the PM for a new one, or remove it from the connection's configuration to read the board";

const dispatchIndexes = new WeakMap<object, Map<string, { id: string; item: Item; agent: string; role: Access["role"] }>>();
/** The open dispatches by the hash of their credential, built once per state of the items. */
function openDispatches(items: Snapshot["items"]) {
  let index = dispatchIndexes.get(items);
  if (!index) {
    index = new Map();
    for (const [id, item] of Object.entries(items)) for (const d of item.dispatches ?? []) if (d.credential && !d.finish) index.set(d.credential, { id, item, agent: d.agent, role: d.role });
  }
  dispatchIndexes.set(items, index);
  return index;
}

export class Credentials {
  readonly file: CredentialFile;
  constructor(file: CredentialFile) { this.file = file; }
  /** What a request's `Authorization` header says about the writer: none without a header; a refusal for one that names no valid credential. */
  resolve(authorization: string | undefined, s: Snapshot): Resolved | undefined {
    if (authorization === undefined) return undefined;
    const token = bearer(authorization);
    if (token === undefined) return { ok: false, problem: `the Authorization header is not "Bearer <token>"; ${REFUSED}` };
    const hash = hashToken(token), dispatch = openDispatches(s.items).get(hash);
    if (dispatch) return { ok: true, who: { author: dispatch.item.group, session: dispatch.agent, access: { role: dispatch.role, project: dispatch.item.group, roots: [dispatch.id] } } };
    const file = this.file.read();
    if ("error" in file) return { ok: false, problem: file.error };
    const entry = file.entries.find(c => c.hash === hash);
    if (!entry) return { ok: false, problem: REFUSED };
    return { ok: true, who: { author: entry.project, session: entry.session, access: { role: entry.role, project: entry.project, roots: entry.roots } } };
  }
}
