// Writes a generated board into a new data repository: one commit per batch, then the owner's read cursor at the last
// read batch, so later batches show as unread on the page.

import { Store } from "../../src/store.ts";
import type { DocKind, OpenOptions } from "../../src/store.ts";
import { ownerOps } from "../../src/owner-ops.ts";
import type { Ops } from "../../src/ops.ts";
import { ARCHITECT, ARCHITECT_SESSION } from "../../src/model.ts";
import type { Generated } from "./board-gen.ts";

export async function seedBoard(dir: string, gen: Generated, opts: Pick<OpenOptions, "maintenance"> = {}): Promise<{ store: Store; commits: string[] }> {
  const store = await Store.open(dir, { init: true, board: gen.board, ...opts });
  const commits: string[] = [];
  for (const batch of gen.batches) {
    const s = store.snapshot();
    const current = (kind: DocKind, id: string) => (kind === "item" ? s.items : kind === "decision" ? s.decisions : kind === "note" ? s.notes : s.glossaries)[id] as { rev: number } | undefined;
    const { commit } = await store.commit({ author: "Generator", message: batch.message, puts: batch.puts.map(put => ({ ...put, expectRev: current(put.kind, put.id)?.rev ?? null })) });
    commits.push(commit);
  }
  await ownerOps(store).read({ through: commits[gen.readBefore - 1]! });
  return { store, commits };
}

/** The generated board has no project for the architect, and a write by author Architect needs one (src/ops.ts, requireAuthor): adds it, once. */
export async function addArchitectProject(op: Pick<Ops, "createProject">, store: Store): Promise<void> {
  if (!store.snapshot().board.projects.some(p => p.name === ARCHITECT)) await op.createProject({ author: ARCHITECT, session: ARCHITECT_SESSION, name: ARCHITECT });
}

/** Rewrites one stored document through the store, as a session's write would: the page hears it on its event stream. */
export async function rewrite<T extends object>(store: Store, kind: "item" | "decision" | "note", id: string, change: (doc: T) => T, author = "Burst"): Promise<string> {
  const s = store.snapshot(), docs = (kind === "item" ? s.items : kind === "decision" ? s.decisions : s.notes) as unknown as Record<string, T & { rev: number }>;
  const before = docs[id];
  if (!before) throw new Error(`no ${kind} ${id}`);
  const { rev, ...rest } = before;
  const { commit } = await store.commit({ author, message: `burst ${kind} ${id}`, puts: [{ kind, id, doc: change(rest as unknown as T), expectRev: rev }] });
  return commit;
}
