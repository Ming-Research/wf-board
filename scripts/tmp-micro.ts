// TMP-MEASURE (item ci-under-1min-study, never merged): fixed costs of the e2e harness, on one runner.
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { generateBoard } from "../test/e2e/board-gen.ts";
import { seedBoard } from "../test/e2e/seed.ts";
import { Store } from "../src/store.ts";

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
const fmt = (xs: number[]) => `median ${med(xs).toFixed(0)} ms (n=${xs.length}: ${xs.map(x => x.toFixed(0)).join(" ")})`;
async function time<T>(fn: () => Promise<T>): Promise<[T, number]> { const t = performance.now(); const v = await fn(); return [v, performance.now() - t]; }

const gen = generateBoard(1);
console.log("MICRO batches", gen.batches.length, "puts", gen.batches.reduce((a, b) => a + b.puts.length, 0));
for (const [label, base] of [["disk", tmpdir()], ["shm", "/dev/shm"]] as const) {
  const seeds: number[] = [], opens: number[] = [], copies: number[] = [];
  let template = "";
  for (let k = 0; k < 5; k++) {
    const dir = await mkdtemp(join(base, "micro-seed-"));
    const [res, ms] = await time(() => seedBoard(dir, gen));
    seeds.push(ms);
    if (k === 0) template = dir; else await rm(dir, { recursive: true, force: true });
    void res;
  }
  for (let k = 0; k < 5; k++) {
    const dir = await mkdtemp(join(base, "micro-copy-"));
    const [, cms] = await time(() => cp(template, dir, { recursive: true }));
    copies.push(cms);
    const [store, oms] = await time(() => Store.open(dir));
    opens.push(oms);
    void store;
    await rm(dir, { recursive: true, force: true });
  }
  console.log(`MICRO ${label} seedBoard ${fmt(seeds)}`);
  console.log(`MICRO ${label} cp -r of the seeded repository ${fmt(copies)}`);
  console.log(`MICRO ${label} Store.open of the copy ${fmt(opens)}`);
  await rm(template, { recursive: true, force: true });
}

const ARGS: Array<[string, string[]]> = [
  ["default", []],
  ["--disable-frame-rate-limit", ["--disable-frame-rate-limit"]],
  ["--disable-gpu-vsync", ["--disable-gpu-vsync"]],
  ["both", ["--disable-frame-rate-limit", "--disable-gpu-vsync"]],
  ["both+--run-all-compositor-stages-before-draw", ["--disable-frame-rate-limit", "--disable-gpu-vsync", "--run-all-compositor-stages-before-draw"]],
];
for (const [label, args] of ARGS) {
  const [browser, launchMs] = await time(() => chromium.launch({ args }));
  const page = await (await browser.newContext()).newPage();
  await page.goto("about:blank");
  const laps: number[] = [];
  for (let k = 0; k < 60; k++) laps.push((await time(() => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 20)))))))[1]);
  console.log(`MICRO frames ${label}: launch ${launchMs.toFixed(0)} ms; 2 rAF + 20 ms timer ${fmt(laps)}`);
  await browser.close();
}
