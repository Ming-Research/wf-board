import { randomInt } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { Note, Key, ReadDocument, CommitId } from "./model.ts";
import type { Snapshot } from "./model.ts";
import { ConflictError } from "./store.ts";
import type { Store } from "./store.ts";
import { OpError } from "./ops.ts";
import { draftEditable, noteTextProblem } from "./rules.ts";
import { unreadSteps, commitsSince, inHistory } from "./history.ts";
import type { DocKind } from "./store.ts";

export class NotFoundError extends Error {}
export interface OwnerOps {
  createNote(a: { target: string; kind: Note["kind"]; text: string; choice?: string; anchor?: Note["anchor"] }): Promise<{ id: string; commit: string }>;
  setDraft(a: { target: string; kind: "choice" | "approve" | "done" | "explain"; on: boolean; text: string; choice?: string }): Promise<{ note: { id: string; doc: Note } | null; deleted: string[]; commit: string }>;
  editDraft(a: { id: string; rev: number; text: string }): Promise<{ note: { id: string; doc: Note }; deleted: string[]; commit: string }>;
  deleteNote(a: { id: string }): Promise<void>;
  send(a?: { ids?: string[] }): Promise<{ sent: Array<{ id: string; target: string; kind: string; project: string }> }>;
  read(a: { through: string } | { doc: string; through?: string }): Promise<void>;
}
const queues = new WeakMap<Store, Promise<unknown>>();
const ReadInput = z.union([z.object({ through: CommitId }).strict(), z.object({ doc: ReadDocument, through: CommitId.optional() }).strict()]);
const DraftInput = Note.pick({ target: true, text: true, choice: true }).extend({ kind: z.enum(["choice", "approve", "done", "explain"]), on: z.boolean() }).strict();
const SendInput = z.object({ ids: z.array(Key).optional() }).strict();
const DraftEditInput = z.object({ id: Key, rev: z.number().int().positive(), text: z.string() }).strict();
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
  function run<T>(fn: (s: Snapshot) => Promise<T>, retryConflicts = true): Promise<T> {
    const task = (queues.get(store) ?? Promise.resolve()).then(async () => {
      for (;;) {
        try { return await fn(store.snapshot()); }
        catch (e) { if (!retryConflicts || !(e instanceof ConflictError)) throw e; }
      }
    });
    queues.set(store, task.catch(() => {})); return task;
  }
  return {
    createNote: a => run(async s => {
      const parsed = Note.omit({ at: true, state: true, rev: true, answerText: true, sentAt: true, reply: true, repliedAt: true, repliedBy: true }).safeParse(a);
      if (!parsed.success) throw new OpError(parsed.error.message);
      const doc = parsed.data;
      const key = targetExists(s, doc.target);
      const textProblem = noteTextProblem(doc);
      if (textProblem) throw new OpError(textProblem);
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
      // A control explicitly selects a new action; text edits alone preserve the old one.
      if (doc) delete doc.answerText;
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
    editDraft: a => run(async s => {
      const parsed = DraftEditInput.safeParse(a);
      if (!parsed.success) throw new OpError(parsed.error.message);
      const input = parsed.data, note = Object.hasOwn(s.notes, input.id) ? s.notes[input.id] : undefined;
      if (!note) throw new NotFoundError(`Unknown note ${input.id}`);
      if (!draftEditable(note)) throw new OpError("Only draft notes can be edited");
      if (note.rev !== input.rev) throw new ConflictError("note", input.id, input.rev, note);
      const originalAction = note.kind === "approve" || note.kind === "done" ? { answerText: note.answerText ?? note.text } : {};
      const doc = Note.parse({ ...note, text: input.text, ...originalAction }), textProblem = noteTextProblem(doc);
      if (textProblem) throw new OpError(textProblem);
      const result = await store.commit({ author: "owner", message: `edit_draft ${input.id}`, puts: [{ kind: "note", id: input.id, expectRev: input.rev, doc }] });
      return { note: { id: input.id, doc: { ...doc, rev: result.revs[`note:${input.id}`] ?? doc.rev } }, deleted: [], commit: result.commit };
    }, false),
    deleteNote: a => run(async s => {
      const note = Object.hasOwn(s.notes, a.id) ? s.notes[a.id] : undefined;
      if (!note) throw new NotFoundError(`Unknown note ${a.id}`);
      if (!draftEditable(note)) throw new OpError("Only draft notes can be deleted");
      await store.commit({ author: "owner", message: `delete_note ${a.id}`, deletes: [{ kind: "note", id: a.id, expectRev: note.rev }] });
    }),
    send: a => run(async s => {
      const parsed = SendInput.safeParse(a ?? {});
      if (!parsed.success) throw new OpError("send takes an optional list of note ids");
      const only = parsed.data.ids === undefined ? undefined : new Set(parsed.data.ids);
      for (const id of only ?? []) {
        if (!Object.hasOwn(s.notes, id)) throw new NotFoundError(`Unknown note ${id}`);
        if (s.notes[id]!.state !== "draft") throw new OpError(`Only draft notes can be sent: ${id}`);
      }
      const drafts = Object.entries(s.notes).filter(([id, n]) => n.state === "draft" && (!only || only.has(id)));
      const sentAt = now();
      if (drafts.length) await store.commit({ author: "owner", message: `send ${drafts.length} notes`, puts: drafts.map(([id, n]) => ({ kind: "note", id, expectRev: n.rev, doc: { ...n, state: "sent", sentAt } })) });
      // Item changes can commit while this send waits for the store.
      const committed = store.snapshot(), r = store.derived.rules(committed);
      const sent = drafts.map(([id, n]) => ({ id, target: n.target, kind: n.kind, project: r.projectOf(n.target.startsWith("it:") ? n.target.slice(3) : committed.decisions[n.target.slice(2)]?.item ?? "") }));
      return { sent };
    }),
    read: a => run(async () => {
      const parsed = ReadInput.safeParse(a);
      if (!parsed.success) throw new OpError(`Invalid read document or full commit id: ${parsed.error.message}`);
      const input = parsed.data;
      // The read is one pass over the board as published when it starts, bounded by that head even while git or the
      // snapshot moves on. A change another session commits meanwhile lies after that head, so it is neither read nor
      // crossed by compaction, and the read need not start over for it.
      const s = store.snapshot(), through = input.through;
      if (through && !(await inHistory(store, through, s.head))) throw new OpError("Read mark or cursor must be in board history");
      const old = s.owner.cursor;
      async function canAdvance(from: string | undefined, to: string): Promise<boolean> {
        return !from || await inHistory(store, from, to);
      }
      async function advances(from: string | undefined, to: string): Promise<void> {
        if (!(await canAdvance(from, to))) throw new OpError("Read mark or cursor must advance from its current ancestor");
      }
      if (through) await advances(old, through);
      let cursor = old;
      const readMarks = { ...s.owner.readMarks };
      if ("doc" in input) {
        const [kind, id] = input.doc.split(":") as [DocKind, string];
        const collection = kind === "item" ? s.items : kind === "decision" ? s.decisions : s.notes;
        if (!Object.hasOwn(collection, id) && !(await store.log({ kind, id, limit: 1, at: s.head })).length) throw new OpError(`Unknown read document ${input.doc}`);
        // A bounded read can split a coalesced step: use its displayed commit,
        // rather than requiring the current step's final commit to match it.
        if (through) {
          await advances(readMarks[input.doc], through);
          readMarks[input.doc] = through;
        } else {
          const unread = await unreadSteps(store, old, readMarks, s.head);
          const latest = unread.filter(step => step.docs.some(doc => doc.kind === kind && doc.id === id)).at(-1);
          if (!latest) return;
          await advances(old, latest.id);
          await advances(readMarks[input.doc], latest.id);
          readMarks[input.doc] = latest.id;
        }
      } else cursor = through!;
      // Compact only the completely read prefix. In a shared commit any unread
      // document keeps that entire commit ahead of the cursor.
      const remaining = await unreadSteps(store, cursor, readMarks, s.head);
      const history = await commitsSince(store, cursor, s.head);
      const firstUnread = remaining[0]?.commits[0];
      const stop = firstUnread ? history.findIndex(commit => commit.commit === firstUnread) : history.length;
      const compacted = stop > 0 ? history[stop - 1]!.commit : cursor;
      // Git histories may merge siblings; a chronological prefix need not end
      // at a descendant of the cursor. Leave compaction for a later descendant.
      if (compacted && await canAdvance(cursor, compacted)) {
        cursor = compacted;
        const afterCursor = new Set(history.slice(stop).map(c => c.commit));
        for (const [doc, mark] of Object.entries(readMarks)) if (!afterCursor.has(mark)) delete readMarks[doc];
      }
      // Preserve owner state that arrived during the asynchronous history reads.
      const owner = { ...store.snapshot().owner, cursor };
      if (Object.keys(readMarks).length) owner.readMarks = readMarks;
      else delete owner.readMarks;
      store.setOwner(owner);
    }),
  };
}
