// A write that was committed but not answered is sent again by the client; an append of the same text by the same session
// within a minute is that retry, and is not written twice (docs/design.md, section 4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ops } from "../src/ops.ts";
import { Store } from "../src/store.ts";
import { board, author } from "./helpers.ts";

async function clocked(t: Parameters<typeof board>[0]) {
  const fixture = await board(t);
  let clock = "2026-10-16T10:00:00Z";
  return { ...fixture, op: ops(fixture.store, () => clock), setClock: (value: string) => { clock = value; } };
}
const logOf = (store: Store) => store.snapshot().items.a!.log;

test("the same session appending the same text within a minute writes it once and answers with the first write", async t => {
  const { store, op, setClock } = await clocked(t);
  const first = await op.appendLog({ author, session: "S", id: "a", text: "done" });
  const [length, head] = [logOf(store).length, store.snapshot().head];
  setClock("2026-10-16T10:00:30Z");
  const second = await op.appendLog({ author, session: "S", id: "a", text: "done" });
  assert.equal(second.repeated, true);
  assert.equal(second.commit, first.commit);
  assert.equal(second.rev, first.rev);
  assert.equal(logOf(store).length, length, "the log has the entry once");
  assert.equal(store.snapshot().head, head, "and no commit was made");
  setClock("2026-10-16T10:01:00Z");
  assert.equal((await op.appendLog({ author, session: "S", id: "a", text: "done" })).repeated, true, "a minute after the first write still counts");
  assert.equal(logOf(store).length, length);
});

test("a write that differs in text, session, item or time is written", async t => {
  const { store, op, setClock } = await clocked(t);
  await op.appendLog({ author, session: "S", id: "a", text: "done" });
  const written = async (what: string, call: () => Promise<{ repeated?: true }>) => {
    const before = logOf(store).length + store.snapshot().items.b!.log.length;
    assert.equal((await call()).repeated, undefined, what);
    assert.equal(logOf(store).length + store.snapshot().items.b!.log.length, before + 1, what);
  };
  setClock("2026-10-16T10:00:10Z");
  await written("another text", () => op.appendLog({ author, session: "S", id: "a", text: "done again" }));
  await written("another session", () => op.appendLog({ author, session: "T", id: "a", text: "done" }));
  await written("another item", () => op.appendLog({ author, session: "S", id: "b", text: "done" }));
  setClock("2026-10-16T10:01:01Z");
  await written("more than a minute later", () => op.appendLog({ author, session: "S", id: "a", text: "done" }));
});

test("a caller that names no session has no identity to repeat", async t => {
  const { store, op } = await clocked(t);
  await op.appendLog({ author, id: "a", text: "done" });
  const length = logOf(store).length;
  assert.equal((await op.appendLog({ author, id: "a", text: "done" })).repeated, undefined);
  assert.equal(logOf(store).length, length + 1);
});

test("another session's identical entry is not this session's write, and does not hide this session's own", async t => {
  const { store, op, setClock } = await clocked(t);
  const own = await op.appendLog({ author, session: "S", id: "a", text: "done" });
  setClock("2026-10-16T10:00:05Z");
  const other = await op.appendLog({ author, session: "T", id: "a", text: "done" });
  assert.equal(other.repeated, undefined, "the entry at hand was written by S, not by T");
  setClock("2026-10-16T10:00:20Z");
  const retry = await op.appendLog({ author, session: "S", id: "a", text: "done" });
  assert.equal(retry.repeated, true, "S's retry is found behind T's newer entry");
  assert.equal(retry.commit, own.commit);
  assert.equal(logOf(store).filter(e => e.text === "done").length, 2);
});

test("the retry is found after the board restarted: the log and the commit say it, not memory", async t => {
  const { store, op, dir } = await clocked(t);
  const first = await op.appendLog({ author, session: "S", id: "a", text: "done" });
  const reopened = await Store.open(dir);
  const again = await ops(reopened, () => "2026-10-16T10:00:20Z").appendLog({ author, session: "S", id: "a", text: "done" });
  assert.equal(again.repeated, true);
  assert.equal(again.commit, first.commit);
  assert.equal(reopened.snapshot().items.a!.log.filter(e => e.text === "done").length, 1);
  assert.equal(store.snapshot().items.a!.log.filter(e => e.text === "done").length, 1);
});
