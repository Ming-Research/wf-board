// A generated board of the live board's weight, for the n-key lane (test/nkey): about 1,600 items,
// 770 cards and 780 comments, heads padded until the snapshot is as heavy as the live board's (about 15 MB on the wire),
// and hundreds of unread commits, so that n walks a long list. The generator's default board has 176 items; one press of
// n there takes about a quarter of what it takes here, so it cannot show a page that is too slow for the real board.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rules } from "../../src/rules.ts";
import { ownerOps } from "../../src/owner-ops.ts";
import { generateBoard, prng } from "./board-gen.ts";
import { seedBoard } from "./seed.ts";
import { serveBoard, ROOT } from "./board-server.ts";
import type { BoardServer } from "./board-server.ts";

/** The generator's scale: 12 times its default of about 160 items per project set. */
const SCALE = 12;
/** Kilobytes of text each head is padded to; with the generated structure this makes the snapshot as heavy as the live board's. */
const HEAD_KB = 8;
/** Commits after the owner's read cursor: sessions' writes to open items and replies to the owner's comments. */
const UNREAD_COMMITS = 330;

const SENTENCE = "解释器通过长脚本时，检查器先把计划里每一行的状态算出来，再和上一次的结果比对，只重画变了的部分。";

export async function startLiveBoard(t: { after(fn: () => unknown): void }): Promise<BoardServer> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-live-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const gen = generateBoard(1, SCALE);
  for (const batch of gen.batches) for (const put of batch.puts) if (put.kind === "item") {
    const doc = put.doc as { head?: string };
    let head = doc.head ?? "", k = 0;
    while (head.length * 3 < HEAD_KB * 1024) head += `\n\n**第 ${++k} 段**：${SENTENCE}${SENTENCE}\n- 要点一：${SENTENCE}\n- 要点二：${SENTENCE}`;
    doc.head = head;
  }
  const { store } = await seedBoard(dir, gen);
  const snap = store.snapshot(), r = rules(snap);
  const open = Object.keys(snap.items).filter(id => !snap.items[id]!.record && !/^(done|cancelled)$/.test(r.statusOf(id) ?? ""));
  const rnd = prng(4242), pool = Array.from({ length: Math.round(UNREAD_COMMITS * 0.7) }, () => rnd.pick(open));
  const replied = Object.entries(snap.notes).filter(([, n]) => n.kind === "comment" && n.reply).map(([id]) => id);
  for (let k = 0; k < UNREAD_COMMITS; k++) {
    const s = store.snapshot(), at = new Date(Date.now() + k * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    if (k % 10 === 9 && replied.length) {
      const id = rnd.pick(replied), n = s.notes[id]!, { rev, ...doc } = n;
      await store.commit({ author: n.repliedBy ?? "Kestrel", message: "unread: reply", puts: [{ kind: "note", id, expectRev: rev, doc: { ...doc, reply: n.reply + " 补充。", repliedAt: at } }] });
      continue;
    }
    const id = rnd.pick(pool), it = s.items[id]!, { rev, ...doc } = it;
    // Some writes also start a step, which the page shows as a new place in the item.
    let plan = it.plan;
    if (k % 10 === 7 || k % 10 === 8) {
      let started = false;
      plan = it.plan.map(row => !started && "state" in row && row.state === "todo" && !row.accept ? (started = true, { ...row, state: "doing" as const, since: at }) : row);
    }
    await store.commit({ author: it.group, message: "unread: progress", puts: [{ kind: "item", id, expectRev: rev, doc: { ...doc, plan, log: [...it.log, { at, by: it.group, text: "未读的进展 " + k + "。" }], updated: at } }] });
  }
  // The server of the board, with the page of this checkout.
  return serveBoard(t, { url: "", store, gen, dir, webDir: "" }, join(ROOT, "web"));
}
