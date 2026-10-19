// Temporary (item ci-gate-45, deleted before review): the time of starting a git process from this process at three heap
// sizes, and the same through a small helper process started while this one was small.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

const run = promisify(execFile);
const N = 200;
const helper = spawn(process.execPath, ["-e", `
  const { execFile } = require("node:child_process");
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const { id, args } = JSON.parse(line);
    execFile("git", args, (error, stdout) => process.stdout.write(JSON.stringify({ id, ok: !error, stdout }) + "\\n"));
  });
`], { stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map<number, (v: unknown) => void>();
createInterface({ input: helper.stdout! }).on("line", line => { const r = JSON.parse(line); waiting.get(r.id)!(r); waiting.delete(r.id); });
let next = 0;
const viaHelper = (args: string[]) => new Promise(resolve => { const id = next++; waiting.set(id, resolve); helper.stdin!.write(JSON.stringify({ id, args }) + "\n"); });

const keep: unknown[] = [];
const grow = (mb: number) => { for (let i = 0; i < mb; i++) keep.push(Array.from({ length: 1024 * 16 }, (_, k) => ({ k, s: "x" + k }))); };
const time = async (what: string, fn: () => Promise<unknown>) => {
  const cpu0 = process.cpuUsage(), t0 = performance.now();
  for (let i = 0; i < N; i++) await fn();
  const ms = (performance.now() - t0) / N, cpu = process.cpuUsage(cpu0);
  console.log(`${what}: ${ms.toFixed(2)} ms a call, this process's CPU ${((cpu.user + cpu.system) / 1000 / N).toFixed(2)} ms a call (system ${(cpu.system / 1000 / N).toFixed(2)}), rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB`);
};
for (const mb of [0, 150, 600]) {
  grow(mb - keep.length);
  await time(`direct, heap step ${mb}`, () => run("git", ["--version"]));
  await time(`helper, heap step ${mb}`, () => viaHelper(["--version"]));
}
helper.kill();
