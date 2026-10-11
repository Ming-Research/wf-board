import { randomInt } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  setDraft(a: { target: string; kind: "choice" | "approve" | "done" | "explain"; on: boolean; text: string; choice?: string }): Promise<{ note: { id: string; doc: Note } | null; deleted: string[]; commit: string }>;
  deleteNote(a: { id: string }): Promise<void>;
  send(): Promise<{ sent: Array<{ id: string; target: string; kind: string; project: string }> }>;
  archive(a: { id: string; on: boolean }): void;
  read(a: { through: string }): Promise<void>;
}
const queues = new WeakMap<Store, Promise<unknown>>();
const DraftInput = Note.pick({ target: true, text: true, choice: true }).extend({ kind: z.enum(["choice", "approve", "done", "explain"]), on: z.boolean() }).strict();
export function ownerOps(store: Store, now = () => new Date().toISOString()): OwnerOps {
  function targetExists(s: Snapshot, target: string): string {
    const key = target.slice(target.indexOf(":") + 1);
    if (target.startsWith("it:") ? !Object.hasOwn(s.items, key) : !Object.hasOwn(s.decisions, key)) throw new NotFoundError(`Unknown target ${target}`);
    return key;
  }
  function validateChoice(s: Snapshot, doc: { target: string; kind: string; choice?: string }, key: string): void {
    if (doc.kind === "choice" && (!doc.target.startsWith("q:") || s.decisions[key]!.status !== "open" || !s.decisions[key]!.options.some(o => o.key === doc.choice))) throw new OpError("A choice needs an option on an open decision card");
  }
  function noteId(s: Snapshot): string {
    let id: string;
    do { id = Array.from({ length: 20 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[randomInt(36)]).join(""); } while (Object.hasOwn(s.notes, id));
    return id;
  }
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
      const key = targetExists(s, doc.target);
      if (doc.kind === "comment" && !doc.text.trim()) throw new OpError("A comment needs text");
      validateChoice(s, doc, key);
      const id = noteId(s);
      const result = await store.commit({ author: "owner", message: `create_note ${id}`, puts: [{ kind: "note", id, expectRev: null, doc: { ...doc, at: now(), state: "draft" } }] });
      return { id, commit: result.commit };
    }),
    setDraft: a => run(async s => {
      const parsed = DraftInput.safeParse(a);
      if (!parsed.success) throw new OpError(parsed.error.message);
      const { on, ...input } = parsed.data;
      const key = targetExists(s, input.target);
      if (on) validateChoice(s, input, key);
      const matching = Object.entries(s.notes).filter(([, n]) => n.target === input.target && n.kind === input.kind);
      const drafts = matching.filter(([, n]) => n.state === "draft");
      const retained = on ? drafts[0] : undefined;
      const deleted = (on ? drafts.slice(1) : drafts).map(([id]) => id);
      const id = on ? retained?.[0] ?? noteId(s) : undefined;
      const doc = on ? Note.parse({ ...retained?.[1], ...input, choice: input.choice, at: retained?.[1].at ?? now(), state: "draft", rev: retained?.[1].rev ?? 1 }) : undefined;
      if (doc && doc.choice === undefined) delete doc.choice;
      const changed = on && (!retained || !isDeepStrictEqual(retained[1], doc));
      if (!changed && !deleted.length) return { note: id && doc ? { id, doc } : null, deleted, commit: s.head };
      // Choice answers remain final even after handling. Item answers can be
      // queued again after handling; explain requests always remain repeatable.
      if (matching.some(([, n]) => input.kind === "choice" ? n.state !== "draft" : input.kind !== "explain" && n.state === "sent")) throw new OpError("This answer is already sent; its control is unavailable");
      const result = await store.commit({
        author: "owner", message: `set_draft ${input.target} ${input.kind} ${on ? "on" : "off"}`,
        // Even an unchanged retained note needs its revision checked while
        // deleting duplicates: it may have been sent before this commit runs.
        puts: id && doc ? [{ kind: "note", id, expectRev: retained?.[1].rev ?? null, doc }] : [],
        deletes: deleted.map(id => ({ kind: "note", id, expectRev: s.notes[id]!.rev })),
      });
      return { note: id && doc ? { id, doc: { ...doc, rev: result.revs[`note:${id}`] ?? doc.rev } } : null, deleted, commit: result.commit };
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
      // Item changes can commit while this send waits for the store.
      const committed = store.snapshot(), r = rules(committed);
      const sent = drafts.map(([id, n]) => ({ id, target: n.target, kind: n.kind, project: r.projectOf(n.target.startsWith("it:") ? n.target.slice(3) : committed.decisions[n.target.slice(2)]?.item ?? "") }));
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
