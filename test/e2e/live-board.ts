// A generated board of the live board's weight, for the n-key lane (test/nkey): about 1,600 items,
// 770 cards and 780 comments, heads padded until the snapshot is as heavy as the live board's (about 15 MB on the wire),
// and hundreds of unread commits, so that n walks a long list. The generator's default board has 176 items; one press of
// n there takes about a quarter of what it takes here, so it cannot show a page that is too slow for the real board.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { rules } from "../../src/rules.ts";
import { Store } from "../../src/store.ts";
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

/** One of the unread commits: the document it writes (the whole file) and who wrote it. */
interface Tail { author: string; message: string; path: string; doc: Record<string, unknown>; at: number }

/** The files as the store writes them (its `yaml`, which is not exported). */
const yamlText = (doc: unknown) => stringify(doc, { version: "1.2", schema: "core", lineWidth: 0, blockQuote: "literal" });

/** The commits of `writes` after the head of the data repository, made by one `git fast-import`, and the working tree brought to the new head. */
async function commitTail(dir: string, writes: readonly Tail[]): Promise<void> {
  const git = (args: string[], input?: Buffer) => new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out) : reject(new Error(`git ${args.join(" ")} exited with ${code}: ${err}`)));
    child.stdin.end(input);
  });
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const stream: Buffer[] = [];
  const text = (s: string) => stream.push(Buffer.from(s));
  const data = (s: string) => { const b = Buffer.from(s); text(`data ${b.length}\n`); stream.push(b); text("\n"); };
  writes.forEach((w, k) => {
    const slug = w.author.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
    text(`commit refs/heads/main\nauthor ${w.author} <${slug}@wf-board.invalid> ${w.at} +0000\ncommitter ${w.author} <${slug}@wf-board.invalid> ${w.at} +0000\n`);
    data(w.message);
    if (k === 0) text(`from ${head}\n`);
    text(`M 100644 inline ${w.path}\n`);
    data(yamlText(w.doc));
  });
  await git(["fast-import", "--quiet"], Buffer.concat(stream));
  await git(["reset", "--hard", "--quiet", "HEAD"]);
}

const SENTENCE = "解释器通过长脚本时，检查器先把计划里每一行的状态算出来，再和上一次的结果比对，只重画变了的部分。";

export async function startLiveBoard(t: { after(fn: () => unknown): void }): Promise<BoardServer> {
  const began = performance.now(), steps: string[] = [];
  const lap = (what: string) => steps.push(`${what} ${((performance.now() - began) / 1000).toFixed(1)} s`);
  const dir = await mkdtemp(join(tmpdir(), "wf-board-live-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const gen = generateBoard(1, SCALE);
  for (const batch of gen.batches) for (const put of batch.puts) if (put.kind === "item") {
    const doc = put.doc as { head?: string };
    let head = doc.head ?? "", k = 0;
    while (head.length * 3 < HEAD_KB * 1024) head += `\n\n**第 ${++k} 段**：${SENTENCE}${SENTENCE}\n- 要点一：${SENTENCE}\n- 要点二：${SENTENCE}`;
    doc.head = head;
  }
  const seeded = await seedBoard(dir, gen);
  lap("generated and written by the store");
  const snap = seeded.store.snapshot(), r = rules(snap);
  const open = Object.keys(snap.items).filter(id => !snap.items[id]!.record && !/^(done|cancelled)$/.test(r.statusOf(id) ?? ""));
  const rnd = prng(4242), pool = Array.from({ length: Math.round(UNREAD_COMMITS * 0.7) }, () => rnd.pick(open));
  const replied = Object.entries(snap.notes).filter(([, n]) => n.kind === "comment" && n.reply).map(([id]) => id);
  // The unread commits are the sessions' writes after the owner's cursor. Through the store each is four git processes, 330 of them
  // take as long as the rest of the board; here they are one `git fast-import`, the documents written as the store writes them.
  const latest = new Map<string, Record<string, unknown>>(), writes: Tail[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (let k = 0; k < UNREAD_COMMITS; k++) {
    const at = new Date((now + k) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    if (k % 10 === 9 && replied.length) {
      const id = rnd.pick(replied), n = (latest.get("notes/" + id) ?? snap.notes[id]!) as typeof snap.notes[string];
      const doc = { ...n, reply: n.reply + " 补充。", repliedAt: at, rev: n.rev + 1 };
      latest.set("notes/" + id, doc);
      writes.push({ author: n.repliedBy ?? "Kestrel", message: "unread: reply", path: `notes/${id}.yaml`, doc, at: now + k });
      continue;
    }
    const id = rnd.pick(pool), it = (latest.get("items/" + id) ?? snap.items[id]!) as typeof snap.items[string];
    // Some writes also start a step, which the page shows as a new place in the item.
    let plan = it.plan;
    if (k % 10 === 7 || k % 10 === 8) {
      let started = false;
      plan = it.plan.map(row => !started && "state" in row && row.state === "todo" && !row.accept ? (started = true, { ...row, state: "doing" as const, since: at }) : row);
    }
    const doc = { ...it, plan, log: [...it.log, { at, by: it.group, text: "未读的进展 " + k + "。" }], updated: at, rev: it.rev + 1 };
    latest.set("items/" + id, doc);
    writes.push({ author: it.group, message: "unread: progress", path: `items/${id}.yaml`, doc, at: now + k });
  }
  lap("unread commits worked out");
  await seeded.store.flushOwner("owner");
  seeded.store.stopMaintenance();
  await commitTail(dir, writes);
  lap("unread commits made");
  // The store that wrote the board does not know the commits made beside it: the board is opened again, as a daemon starts.
  const store = await Store.open(dir, { maintenance: { every: 1_000_000, log: () => {} } });
  lap("opened again");
  console.log(`live board: ${steps.join(", ")}`);
  // The server of the board, with the page of this checkout.
  return serveBoard(t, { url: "", store, gen, dir, webDir: "" }, join(ROOT, "web"));
}
