import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { Store, parseDocument } from "../src/store.ts";

// The heap a parsed document keeps (docs/design.md, section 4, Parsed documents). A collection is what node gives only to a process
// started with the flag, so the flag is turned on here.
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
/** The heap in use after two full collections. */
const heap = (): number => { collect(); collect(); return getHeapStatistics().used_heap_size; };

// The live board's text: lines of about 81 bytes (18 Chinese characters and 27 ASCII bytes), a blank line after every sixth.
const CJK = "看板服务读历史时只读需要的文件查清楚堆为什么会这么大的原因和各种改法的代价与风险验收数字";
const WORDS = ["board", "parse", "heap", "cost", "range", "commit", "item", "plan", "card", "note", "merge", "check"];
function lines(bytes: number, seed: number): string[] {
  const out: string[] = [];
  for (let i = 0, made = 0; made < bytes; i++) {
    if (i % 7 === 6) { out.push(""); made += 1; continue; }
    const from = (i * 7 + seed) % (CJK.length - 18);
    let ascii = "";
    for (let k = 0; ascii.length < 27; k++) ascii += WORDS[(i + k + seed) % WORDS.length] + " ";
    const text = `${CJK.slice(from, from + 18)} ${ascii.trim()}`;
    out.push(text);
    made += Buffer.byteLength(text) + 1;
  }
  return out;
}
/** Several lines, as a literal block scalar holds them. */
const block = (bytes: number, seed: number): string => lines(bytes, seed).join("\n");
/** One line ending in a space, which the library writes as a double-quoted scalar. */
const quoted = (bytes: number, seed: number): string => lines(bytes, seed).filter(Boolean).join(" ") + " ";

test("a parsed scalar keeps at most 8 bytes of heap for each character, in every style of scalar", t => {
  const text = quoted(6000, 3).trim(), multi = lines(6000, 3);
  // The same text in each style the library reads. A comment line after it gives each copy a source of its own, as every file of a board has.
  const styles: Record<string, string> = {
    "double-quoted, one line": `k: "${text} "\n`,
    "plain, one line": `k: ${text}\n`,
    "single-quoted, one line": `k: '${text}'\n`,
    "block literal": `k: |-\n${multi.map(line => (line ? "  " + line : "")).join("\n")}\n`,
  };
  for (const [name, source] of Object.entries(styles)) {
    const chars = (parseDocument(source) as { k: string }).k.length;
    assert.ok(chars >= 2000, `${name}: the scalar read back is the text, ${chars} characters`);
    const base = heap();
    const kept = Array.from({ length: 300 }, (_, i) => parseDocument(`${source}# ${i}\n`));
    const perChar = (heap() - base) / (300 * chars);
    assert.equal(kept.length, 300);
    t.diagnostic(`${name}: ${perChar.toFixed(1)} bytes of heap for each character`);
    assert.ok(perChar <= 8, `${name}: ${perChar.toFixed(1)} bytes of heap for each character`);
  }
});

test("the copy changes nothing a document says: values, shared nodes and their order", () => {
  const source = [
    "a: 1", "b: 1.5", "c: true", "d: null", "e: [1, two, \"three\", 2026-10-11T01:02:03Z]", "f: {g: h, i: [j, {k: l}]}",
    "m: &x [1, 2]", "n: *x", "o: |-", "  first", "", "  second", "p: \"quoted \"", "",
  ].join("\n");
  const parsed = parse(source, { version: "1.2", schema: "core" }), copied = parseDocument(source) as typeof parsed;
  assert.deepStrictEqual(copied, parsed);
  assert.deepEqual(Object.keys(copied), Object.keys(parsed), "keys keep their order");
  assert.strictEqual(copied.m, copied.n, "an alias is still the one array");
  assert.equal(parseDocument("just text"), "just text");
  assert.equal(parseDocument(""), null);
});

/** A board of `count` items written by the store itself, whose long texts `text` makes, and the bytes of its files. */
async function seeded(t: { after(fn: () => Promise<void>): void }, count: number, text: (i: number) => { head: string; log: string[] }): Promise<{ dir: string; bytes: number }> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-heap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writer = await Store.open(dir, { init: true, board: { title: "Heap" } });
  const at = "2026-10-11T01:02:03Z";
  const puts = Array.from({ length: count }, (_, i) => {
    const { head, log } = text(i);
    const doc = { title: `Item ${i}`, group: "P", head, log: log.map(entry => ({ at, by: "P", text: entry })), plan: [{ id: "accept", text: "Accepted", state: "todo" as const, accept: true as const }], updated: at };
    return { kind: "item" as const, id: `i${i}`, doc, expectRev: null };
  });
  await writer.commit({ author: "P", message: "Seed", puts });
  let bytes = 0;
  for (const file of await readdir(join(dir, "items"))) bytes += (await stat(join(dir, "items", file))).size;
  return { dir, bytes };
}

/** The heap that opening the board at `dir` keeps, in bytes, and the store (held, so that the figure is of what it keeps). */
async function opened(dir: string): Promise<{ kept: number; store: Store }> {
  const base = heap();
  const store = await Store.open(dir);
  return { kept: heap() - base, store };
}

const shapes: Array<{ name: string; count: number; limit: number; text: (i: number) => { head: string; log: string[] } }> = [
  // The live board's shape: long texts are literal blocks.
  { name: "literal blocks (the live board's shape)", count: 500, limit: 2, text: i => ({ head: block(4200, i), log: Array.from({ length: 12 }, (_, k) => block(240, i * 13 + k)) }) },
  // The shape of the first study: every long text is one line ending in a space, written and read as a double-quoted scalar.
  { name: "single-line quoted texts", count: 300, limit: 3, text: i => ({ head: quoted(7600, i), log: [] }) },
];
for (const shape of shapes) {
  test(`opening a board of ${shape.name} keeps at most ${shape.limit} times the bytes of its files as heap`, async t => {
    const { dir, bytes } = await seeded(t, shape.count, shape.text);
    const { kept, store } = await opened(dir);
    assert.equal(Object.keys(store.snapshot().items).length, shape.count);
    const said = `${(kept / bytes).toFixed(2)} times: ${(kept / 1048576).toFixed(1)} MB of heap for ${(bytes / 1048576).toFixed(1)} MB of files`;
    t.diagnostic(said);
    assert.ok(kept <= shape.limit * bytes, said);
  });
}

test("only the store parses YAML: no other source file imports the library's parse", () => {
  const dir = join(import.meta.dirname, "../src");
  const importers: string[] = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith(".ts")).sort()) {
    for (const [, clause] of readFileSync(join(dir, file), "utf8").matchAll(/import\s+([^;]*?)\s+from\s+["']yaml["']/g)) {
      if (/\*|\bparse\w*\b|\bdefault\b/.test(clause!) || !clause!.startsWith("{")) importers.push(file);
    }
  }
  // store.ts holds parseDocument, the one function through which every document is read (a CLI imports that, not the library).
  assert.deepEqual(importers, ["store.ts"]);
  // And store.ts itself calls the library's parse once, there: a bare `parse(` (not Date.parse, JSON.parse or a schema's parse).
  const calls = [...readFileSync(join(dir, "store.ts"), "utf8").matchAll(/(?<![\w.$])parse\(/g)];
  assert.equal(calls.length, 1, "store.ts calls the library's parse once, in parseDocument");
});
