// What test/startup-cache.test.ts and test/startup-time.test.ts share: a board in a temporary directory and its documents, git in it,
// and the path of the startup cache.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Store } from "../src/store.ts";
import { cleanup } from "./cleanup.ts";

const exec = promisify(execFile);
export const at = "2026-10-11T01:02:03Z";
export const item = (title = "An item") => ({ title, group: "P", head: "A head", plan: [{ id: "accept", text: "Accepted", state: "todo" as const, accept: true as const }], updated: at });
export const owns = (id: string) => ({ id, item: id, own: true });
export const put = (id: string, doc: unknown, expectRev: number | null = null) => ({ kind: "item" as const, id, doc, expectRev });
export async function git(dir: string, ...args: string[]): Promise<string> { return (await exec("git", args, { cwd: dir })).stdout.trim(); }
export async function setup(t: { after(fn: () => Promise<void>): void }, opts: { cacheDelayMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-cache-"));
  cleanup(t, () => rm(dir, { recursive: true, force: true }));
  return { dir, store: await Store.open(dir, { init: true, board: { title: "Board" }, ...opts }) };
}
export const cacheFile = async (dir: string) => join(dir, await git(dir, "rev-parse", "--git-path", "wf-board-startup-cache.json"));
