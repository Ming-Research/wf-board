// Temporary (ci-gate-margin): where the time of one runner-table scenario goes, on a hosted runner.
import { performance } from "node:perf_hooks";
import { generateBoard } from "../test/e2e/board-gen.ts";
import { seedBoard } from "../test/e2e/seed.ts";
import { startBoard } from "../test/e2e/board-server.ts";
import { DomPage, pageScript, pageHtml } from "../test/dom/page.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profiled } from "./profile-summary.ts";

const hooks: Array<() => unknown> = [];
const t = { after(fn: () => unknown) { hooks.push(fn); } };
const lines: string[] = [];
async function time<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  const t0 = performance.now(), v = await fn();
  lines.push(`${label.padEnd(44)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms`);
  return v;
}
const revert = (n: number) => ({ file: "web/app.ts" as const, edit: "x" + n, find: 'const title = el("button", "agitem-title rt-name", it ? inline(it.title) : esc(x.item));', replace: 'const title = el("button", "agitem-title rt-name", it ? inline(it.title) : esc(x.item)); /*' + n + '*/' });

const prof = process.argv.includes("--profile") ? await profiled() : null;
await time("generateBoard(1)", () => generateBoard(1));
for (let k = 0; k < 2; k++) {
  const dir = await mkdtemp(join(tmpdir(), "phases-"));
  const gen = generateBoard(1);
  await time(`seedBoard #${k + 1}`, () => seedBoard(dir, gen));
  await rm(dir, { recursive: true, force: true });
}
const boards = [];
for (let k = 0; k < 3; k++) boards.push(await time(`startBoard #${k + 1}`, () => startBoard(t)));
await time("pageScript() first, no revert", () => pageScript());
await time("pageHtml() first", () => pageHtml());
await time("pageScript() again (cached)", () => pageScript());
for (let k = 1; k <= 3; k++) await time(`pageScript(revert ${k}) a new bundle`, () => pageScript([revert(k)]));
for (let k = 0; k < 3; k++) {
  const page = await time(`DomPage.open #${k + 1} (no revert)`, () => DomPage.open(t, boards[k]!));
  await time(`  settle`, () => page.settle());
}
await time("DomPage.open with revert 1 (cached bundle)", () => DomPage.open(t, boards[0]!, { reverts: [revert(1)] }));
if (prof) lines.push(await prof.stop(1, "run"));
for (const fn of hooks.reverse()) await fn();
console.log(lines.join("\n"));
process.exit(0);
