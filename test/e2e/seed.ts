// Writes a generated board into a new data repository: one commit per batch, then the owner's read cursor at the last
// read batch, so later batches show as unread on the page.

import { Store } from "../../src/store.ts";
import type { DocKind } from "../../src/store.ts";
import { ownerOps } from "../../src/owner-ops.ts";
import type { Generated } from "./board-gen.ts";

export async function seedBoard(dir: string, gen: Generated): Promise<{ store: Store; commits: string[] }> {
  const store = await Store.open(dir, { init: true, board: gen.board });
  const commits: string[] = [];
  for (const batch of gen.batches) {
    const s = store.snapshot();
    const current = (kind: DocKind, id: string) => (kind === "item" ? s.items : kind === "decision" ? s.decisions : kind === "note" ? s.notes : kind === "notice" ? s.notices : s.glossaries)[id] as { rev: number } | undefined;
    const { commit } = await store.commit({ author: "Generator", message: batch.message, puts: batch.puts.map(put => ({ ...put, expectRev: current(put.kind, put.id)?.rev ?? null })) });
    commits.push(commit);
  }
  await ownerOps(store).read({ through: commits[gen.readBefore - 1]! });
  return { store, commits };
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
