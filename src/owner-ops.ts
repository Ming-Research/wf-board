import { randomInt } from "node:crypto";
import { z } from "zod";
import { Note, Key } from "./model.ts";
import type { Snapshot } from "./model.ts";
import { ConflictError } from "./store.ts";
import type { Store } from "./store.ts";
import { OpError } from "./ops.ts";
import { rules } from "./rules.ts";

export class NotFoundError extends Error {}
export interface OwnerOps {
  createNote(a: { target: string; kind: Note["kind"]; text: string; choice?: string; anchor?: Note["anchor"] }): Promise<{ id: string; commit: string }>;
  deleteNote(a: { id: string }): Promise<void>;
  send(): Promise<{ sent: Array<{ id: string; target: string; kind: string; agents: string[] }> }>;
  archive(a: { id: string; on: boolean }): void;
  read(a: { through: string }): Promise<void>;
}
const queues = new WeakMap<Store, Promise<unknown>>();
export function ownerOps(store: Store, now = () => new Date().toISOString()): OwnerOps {
  function run<T>(fn: (s: Snapshot) => Promise<T>): Promise<T> {
    const task = (queues.get(store) ?? Promise.resolve()).then(async () => {
      for (;;) {
        try { return await fn(store.snapshot()); }
        catch (e) { if (!(e instanceof ConflictError)) throw e; }
      }
    });
    queues.set(store, task.catch(() => {})); return task;
  }
  return {
    createNote: a => run(async s => {
      const parsed = Note.omit({ at: true, state: true, rev: true, sentAt: true, reply: true, repliedAt: true, repliedBy: true }).safeParse(a);
      if (!parsed.success) throw new OpError(parsed.error.message);
      const doc = parsed.data;
      const key = doc.target.slice(doc.target.indexOf(":") + 1);
      if (doc.target.startsWith("it:") ? !Object.hasOwn(s.items, key) : !Object.hasOwn(s.decisions, key)) throw new NotFoundError(`Unknown target ${doc.target}`);
      if (doc.kind === "comment" && !doc.text.trim()) throw new OpError("A comment needs text");
      if (doc.kind === "choice" && (!doc.target.startsWith("q:") || s.decisions[key]!.status !== "open" || !s.decisions[key]!.options.some(o => o.key === doc.choice))) throw new OpError("A choice needs an option on an open decision card");
      let id: string;
      do { id = Array.from({ length: 20 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[randomInt(36)]).join(""); } while (Object.hasOwn(s.notes, id));
      const result = await store.commit({ author: "owner", message: `create_note ${id}`, puts: [{ kind: "note", id, expectRev: null, doc: { ...doc, at: now(), state: "draft" } }] });
      return { id, commit: result.commit };
    }),
    deleteNote: a => run(async s => {
      const note = Object.hasOwn(s.notes, a.id) ? s.notes[a.id] : undefined;
      if (!note) throw new NotFoundError(`Unknown note ${a.id}`);
      if (note.state !== "draft") throw new OpError("Only draft notes can be deleted");
      await store.commit({ author: "owner", message: `delete_note ${a.id}`, deletes: [{ kind: "note", id: a.id, expectRev: note.rev }] });
    }),
    send: () => run(async s => {
      const drafts = Object.entries(s.notes).filter(([, n]) => n.state === "draft");
      const sentAt = now();
      if (drafts.length) await store.commit({ author: "owner", message: `send ${drafts.length} notes`, puts: drafts.map(([id, n]) => ({ kind: "note", id, expectRev: n.rev, doc: { ...n, state: "sent", sentAt } })) });
      // Claims use the agent queue and can commit while this send waits for the store.
      const committed = store.snapshot(), r = rules(committed);
      const sent = drafts.map(([id, n]) => ({ id, target: n.target, kind: n.kind, agents: r.agentsFor(n.target.startsWith("it:") ? n.target.slice(3) : committed.decisions[n.target.slice(2)]?.item ?? "") }));
      return { sent };
    }),
    archive: a => {
      if (!Key.safeParse(a.id).success || !z.boolean().safeParse(a.on).success) throw new OpError("archive needs an item id and boolean on");
      const s = store.snapshot();
      if (!Object.hasOwn(s.items, a.id)) throw new NotFoundError(`Unknown item ${a.id}`);
      const archived = { ...s.owner.archived };
      if (a.on) {
        const item = s.items[a.id]!;
        const times = [now(), item.updated, ...item.log.map(e => e.at), ...Object.values(s.notes).filter(n => n.target === `it:${a.id}` && n.reply).map(n => n.repliedAt || n.sentAt || n.at)];
        archived[a.id] = times.sort().at(-1)!;
      } else delete archived[a.id];
      store.setOwner({ ...s.owner, archived });
    },
    read: a => run(async () => {
      if (typeof a.through !== "string" || !/^[0-9a-f]{40}$/.test(a.through)) throw new OpError("through needs a full commit id");
      const through = await store.inHistory(a.through);
      if (!through) throw new OpError("Read cursor must be in board history");
      const old = store.snapshot().owner.cursor;
      if (old && (!(await store.inHistory(old)) || (await store.log({ since: through })).some(c => c.commit === old))) throw new OpError("Read cursor must advance from its current ancestor");
      // Preserve any archive updates that arrived during the history reads.
      store.setOwner({ ...store.snapshot().owner, cursor: through });
    }),
  };
}
