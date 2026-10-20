// The real server on a temporary data repository seeded with a generated board, with no browser in it: the browser layer's
// harness (harness.ts) and the page-in-a-DOM layer (test/dom) both serve their boards from here.

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { ops } from "../../src/ops.ts";
import type { Ops } from "../../src/ops.ts";
import { LiveStore } from "../../src/live.ts";
import { RunnerPools } from "../../src/runner-pools.ts";
import { ownerOps } from "../../src/owner-ops.ts";
import { createHttpServer } from "../../src/http.ts";
import { createMcpServer } from "../../src/mcp.ts";
import type { Store } from "../../src/store.ts";
import { generateBoard } from "./board-gen.ts";
import type { Generated } from "./board-gen.ts";
import { seedBoard } from "./seed.ts";
import { cleanup } from "../cleanup.ts";

export const ROOT = join(import.meta.dirname, "../..");
export interface Hooks { after(fn: () => unknown): void }

/** `ops`, `live` and `pools`: the operations the served daemon runs on and the stores it keeps the runner's beats and slots in, so a beat or a heartbeat with pools made through them reaches the page; `told` collects the notices the pools would give the owner. */
export interface BoardServer { url: string; store: Store; gen: Generated; dir: string; webDir: string; ops: Ops; live: LiveStore; pools: RunnerPools; told: Array<{ title: string; message: string }> }
/** Viewer state that draws every tree row: each item's sub-items unfolded. */
export function openAll(board: BoardServer): Record<string, unknown> {
  return { "board-open": Object.fromEntries(Object.keys(board.store.snapshot().items).map(id => [id, true])) };
}
/** Seeds a generated board into a temporary repository and serves it with the page from `webDir` (default web/). */
export async function startBoard(t: Hooks, opts: { seed?: number; webDir?: string } = {}): Promise<BoardServer> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-e2e-"));
  cleanup(t, () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const gen = generateBoard(opts.seed ?? 1);
  const { store } = await seedBoard(dir, gen);
  return serveBoard(t, { url: "", store, gen, dir, webDir: "" }, opts.webDir ?? join(ROOT, "web"));
}
/** The board served at an address of its own with the page from `webDir`: one board can be read through several pages. */
export async function serveBoard(t: Hooks, board: Omit<BoardServer, "ops" | "live" | "pools" | "told">, webDir: string): Promise<BoardServer> {
  const { store } = board, live = new LiveStore(), told: BoardServer["told"] = [], pools = new RunnerPools({ tell: (title, message) => { told.push({ title, message }); } }), op = ops(store, undefined, { live, pools });
  const server: Server = createHttpServer({ store, ops: op, live, pools, ownerOps: ownerOps(store), webDir, createMcp: () => createMcpServer({ store, ops: op, live, pools }) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup(t, () => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { ...board, url: `http://127.0.0.1:${address.port}`, webDir, ops: op, live, pools, told };
}
