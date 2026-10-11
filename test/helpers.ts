import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { ops } from "../src/ops.ts";

export const at = "2026-10-11T01:02:03Z";
export const later = "2026-10-11T02:03:04Z";
export const author = "Whitefoot";
export async function board(t: { after(fn: () => void | Promise<void>): void }, options: { sharedProjects?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-agent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [{ name: "Whitefoot", repo: "Ming-Research/Whitefoot" }, { name: "Firn" }, { name: "跨项目" }] } });
  const item = (title: string, fields: object = {}) => ({ title, priority: "P1", status: "todo", updated: at, ...fields });
  await store.commit({ author: "Fixture", message: "Seed synthetic board", puts: [
    { kind: "item", id: "area", expectRev: null, doc: item("解释器工作", { group: "Whitefoot", deps: [{ id: "a", why: "需要检查结果" }, { id: "b", why: "需要语言证据" }] }) },
    { kind: "item", id: "other", expectRev: null, doc: item("其他项目", { group: options.sharedProjects ? "Whitefoot" : "Firn" }) },
    { kind: "item", id: "a", expectRev: null, doc: item("中文检查", { parent: "area", head: "稳定中文背景 Whitefoot#341", data: "中文数据", ask: { text: "批准中文检查" }, links: [{ label: "Pull request", url: "https://github.com/Ming-Research/Whitefoot/pull/341" }],
      log: Array.from({ length: 7 }, (_, i) => ({ at: `2026-10-11T01:02:0${i}Z`, by: i === 0 ? "中文作者" : author, text: i === 0 ? "早期中文记录" : i === 6 ? "最新中文记录" : `Progress ${i}` })) }) },
    { kind: "item", id: "b", expectRev: null, doc: item("阻塞证据", { parent: "area", status: "blocked", priority: "P0", head: "未注明仓库 #341; Other#341", deps: [{ id: "a", why: "需要检查" }, { card: "choice", why: "需要决策" }] }) },
    { kind: "decision", id: "choice", expectRev: null, doc: { item: "a", question: "中文方案？", background: "中文背景 Whitefoot PR #341", options: [{ key: "A", text: "中文选项", recommended: true }, { key: "B", text: "另一选项" }], confidence: { score: 4, reason: "Evidence" }, status: "open", at, updated: at } },
    { kind: "decision", id: "ruled", expectRev: null, doc: { item: "a", question: "旧方案？", background: "Old", options: [{ key: "A", text: "Old" }], status: "ruled", ruling: "中文裁决", ruledAt: later, updated: later } },
    { kind: "note", id: "note-1", expectRev: null, doc: { target: "it:a", kind: "comment", text: "中文意见 Whitefoot #341", at, sentAt: at, state: "sent" } },
    { kind: "note", id: "note-2", expectRev: null, doc: { target: "q:choice", kind: "explain", text: "解释 #341", at, state: "done", reply: "中文回复", repliedAt: later, repliedBy: author } },
  ] });
  return { dir, store, op: ops(store, () => later) };
}
