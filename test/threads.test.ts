import { test } from "node:test";
import assert from "node:assert/strict";
import { threadOrder } from "../web/threads.ts";

type N = { id: string; at: string; anchor?: { kind: "log"; at: string } | { kind: "note"; id: string } };
const note = (id: string, minute: number, anchor?: N["anchor"]): N => ({ id, at: `2026-10-11T01:${String(minute).padStart(2, "0")}:00Z`, ...(anchor ? { anchor } : {}) });
const follows = (id: string): N["anchor"] => ({ kind: "note", id });
const shape = (list: N[]) => threadOrder(list).map(({ note, depth }) => `${note.id}:${depth}`);

test("comments with no anchor are listed in the order written, whatever order they come in", () => {
  assert.deepEqual(shape([note("c", 3), note("a", 1), note("b", 2)]), ["a:0", "b:0", "c:0"]);
  assert.deepEqual(shape([]), []);
});

test("a comment that follows another is listed right under it, and one that follows that is one step further in", () => {
  // Written in the order first, other, second, third; the owner meant second to answer first and third to answer second.
  const list = [note("first", 1), note("other", 2), note("second", 3, follows("first")), note("third", 4, follows("second"))];
  assert.deepEqual(shape(list), ["first:0", "second:1", "third:2", "other:0"]);
});

test("several comments that follow one comment are listed under it in the order written, each with its own followers under it", () => {
  const list = [note("p", 1), note("x", 2, follows("p")), note("y", 3, follows("p")), note("x1", 4, follows("x")), note("q", 5)];
  assert.deepEqual(shape(list), ["p:0", "x:1", "x1:2", "y:1", "q:0"]);
});

test("a comment is threaded only under a comment that is in the list: a log anchor, a missing or itself leave it where its time puts it", () => {
  const list = [note("a", 1), note("onLog", 2, { kind: "log", at: "2026-10-11T00:00:00Z" }), note("gone", 3, follows("nowhere")), note("self", 4, follows("self"))];
  assert.deepEqual(shape(list), ["a:0", "onLog:0", "gone:0", "self:0"]);
});

test("comments that follow each other in a ring are each listed once, after the comments that are not in it, from the earliest", () => {
  assert.deepEqual(shape([note("a", 1, follows("b")), note("b", 2, follows("a")), note("c", 3)]), ["c:0", "a:0", "b:1"]);
});

test("the list is the same comments, none lost and none repeated", () => {
  const list = [note("a", 1), note("b", 2, follows("a")), note("c", 3, follows("b")), note("d", 4, follows("c")), note("e", 5, follows("d")), note("f", 6, follows("zzz"))];
  const out = threadOrder(list);
  assert.deepEqual(out.map(x => x.note.id).sort(), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(out.map(x => x.depth), [0, 1, 2, 3, 4, 0], "the depth is the true depth; the page caps the indent");
});
