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
import { ownerOps } from "../../src/owner-ops.ts";
import { createHttpServer } from "../../src/http.ts";
import { createMcpServer } from "../../src/mcp.ts";
import type { Store } from "../../src/store.ts";
import { generateBoard } from "./board-gen.ts";
import type { Generated } from "./board-gen.ts";
import { seedBoard } from "./seed.ts";
import { cleanup } from "../cleanup.ts";
import { timed } from "../tmp-timing.ts";

export const ROOT = join(import.meta.dirname, "../..");
export interface Hooks { after(fn: () => unknown): void }

/** `ops` and `live`: the operations the served daemon runs on and the store it keeps the runner's beats in, so a beat made through them reaches the page. */
export interface BoardServer { url: string; store: Store; gen: Generated; dir: string; webDir: string; ops: Ops; live: LiveStore }
/** Viewer state that draws every tree row: each item's sub-items unfolded. */
export function openAll(board: BoardServer): Record<string, unknown> {
  return { "board-open": Object.fromEntries(Object.keys(board.store.snapshot().items).map(id => [id, true])) };
}
/** Seeds a generated board into a temporary repository and serves it with the page from `webDir` (default web/). */
export function startBoard(t: Hooks, opts: { seed?: number; webDir?: string } = {}): Promise<BoardServer> { return timed("startBoard", () => startBoardUntimed(t, opts)); }
async function startBoardUntimed(t: Hooks, opts: { seed?: number; webDir?: string } = {}): Promise<BoardServer> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-e2e-"));
  cleanup(t, () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const gen = generateBoard(opts.seed ?? 1);
  const { store } = await timed("seedBoard", () => seedBoard(dir, gen));
  return serveBoard(t, { url: "", store, gen, dir, webDir: "" }, opts.webDir ?? join(ROOT, "web"));
}
/** The board served at an address of its own with the page from `webDir`: one board can be read through several pages. */
export async function serveBoard(t: Hooks, board: Omit<BoardServer, "ops" | "live">, webDir: string): Promise<BoardServer> {
  const { store } = board, live = new LiveStore(), op = ops(store, undefined, { live });
  const server: Server = createHttpServer({ store, ops: op, live, ownerOps: ownerOps(store), webDir, createMcp: () => createMcpServer({ store, ops: op }) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup(t, () => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { ...board, url: `http://127.0.0.1:${address.port}`, webDir, ops: op, live };
}
