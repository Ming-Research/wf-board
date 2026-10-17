import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macNotify, notifyArgs, NOTIFY_SCRIPT } from "../src/notify.ts";

async function scratch(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-notify-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** An osascript stand-in: it appends its arguments, as JSON, to a log, and fails while a counter file says so. */
async function fakeOsascript(dir: string, failures = 0) {
  const command = join(dir, "osascript"), log = join(dir, "osascript.log"), count = join(dir, "osascript.count");
  await writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const seen = fs.existsSync(${JSON.stringify(count)}) ? Number(fs.readFileSync(${JSON.stringify(count)}, "utf8")) : 0;
fs.writeFileSync(${JSON.stringify(count)}, String(seen + 1));
process.exit(seen < ${failures} ? 1 : 0);
`);
  await chmod(command, 0o755);
  return { command, calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(l => JSON.parse(l) as string[]) };
}

test("the notification runs osascript with the script lines, then the title and the message as plain arguments", async t => {
  const fake = await fakeOsascript(await scratch(t));
  const message = '问题 "含引号" \\ 反斜杠\n第二行 -开头';
  await macNotify({ command: fake.command, retryMs: 0 })("挡事的卡 · Whitefoot", message);
  const [call, ...more] = await fake.calls();
  assert.deepEqual(more, []);
  assert.deepEqual(call, notifyArgs("挡事的卡 · Whitefoot", message));
  assert.deepEqual(call!.slice(0, NOTIFY_SCRIPT.length * 2), NOTIFY_SCRIPT.flatMap(line => ["-e", line]));
  assert.deepEqual(call!.slice(-3), ["--", "挡事的卡 · Whitefoot", message], "quotes, backslashes and the newline arrive whole as the last argument, not inside the script");
  assert.ok(NOTIFY_SCRIPT.every(line => !line.includes("挡事") && !line.includes("反斜杠")), "the script holds no text of the message");
  assert.equal(notifyArgs("t", "x".repeat(1000)).at(-1)!.length, 240, "a long message is cut");
});

test("a failed osascript run is tried again up to the attempts, then the error comes out", async t => {
  const dir = await scratch(t), fake = await fakeOsascript(dir, 2);
  await macNotify({ command: fake.command, attempts: 3, retryMs: 0 })("t", "m");
  assert.equal((await fake.calls()).length, 3, "two failures, then the one that worked");
  const stubborn = await fakeOsascript(await scratch(t), 5);
  await assert.rejects(macNotify({ command: stubborn.command, attempts: 2, retryMs: 0 })("t", "m"));
  assert.equal((await stubborn.calls()).length, 2);
  await assert.rejects(macNotify({ command: join(dir, "no-such-osascript"), attempts: 1 })("t", "m"));
});
