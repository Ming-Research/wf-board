// TEMPORARY (item mermaid-wide-open): screenshots of the drawn diagrams, for the review of the compact settings. Run by
// .github/workflows/shots.yml; both are removed before the pull request is ready.

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { ops } from "../../src/ops.ts";
import { startBoard, launch, BoardPage, ROOT } from "./harness.ts";
import { PIPELINE } from "./mermaid-charts.ts";

const cleanups: Array<() => unknown> = [];
const t = { after: (fn: () => unknown) => { cleanups.push(fn); } };
const fence = (code: string) => "```mermaid\n" + code + "\n```";
const OUT = join(process.cwd(), "shots");

const SAMPLES: Array<[string, string]> = [
  ["flow", ["flowchart LR", '  A["收到需求"] -->|通过| B{"要拆吗"}', '  B -->|要拆| C["分给组员"]', '  B -->|不拆| D["自己动手做"]', '  C -->|做完了| E(["合入"])', '  D -->|做完了，等审查| E', '  E -.->|发现问题| A'].join("\n")],
  ["sequence", ["sequenceDiagram", "  participant 工程师", "  participant 架构师", "  participant 审查", "  工程师->>架构师: 方向对吗？", "  架构师-->>工程师: 同意，动手吧", "  工程师->>审查: 草稿 PR 绿了，请审查", "  审查-->>工程师: 三条发现，都小", "  Note over 工程师,审查: 修完再审一轮"].join("\n")],
  ["state", ["stateDiagram-v2", "  [*] --> 待办", "  待办 --> 进行中: 有人接手", "  进行中 --> 等待: 等 CI 或主人", "  等待 --> 进行中: 收到结果", "  进行中 --> 完成: 合入", "  完成 --> [*]"].join("\n")],
  ["class", ["classDiagram", "  class 条目 {", "    +标题", "    +难度", "    +计划()", "  }", "  class 卡片 {", "    +问题", "    +选项", "  }", '  条目 "1" --> "*" 卡片 : 持有'].join("\n")],
  ["er", ["erDiagram", "  条目 ||--o{ 日志 : 记录", "  条目 ||--o{ 卡片 : 持有", "  条目 {", "    string 标题", "    int 难度", "  }"].join("\n")],
];

/** A page directory serving the current page, with the compact settings taken out of web/mermaid.ts while it is bundled when `old`. */
async function pageDir(old: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-shots-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "index.html"), await readFile(join(ROOT, "web/index.html"), "utf8"));
  await symlink(join(ROOT, "web/dist/mermaid.js"), join(dir, "dist/mermaid.js"));
  const plugin: Plugin = {
    name: "edit",
    setup(b) {
      b.onLoad({ filter: /[\\/]web[\\/]mermaid\.ts$/ }, async args => {
        const text = await readFile(args.path, "utf8");
        if (old && text.split("...COMPACT,").length !== 2) throw new Error("web/mermaid.ts no longer holds ...COMPACT, exactly once");
        return { contents: old ? text.replace("...COMPACT,", "") : text, loader: "ts" };
      });
    },
  };
  await build({ entryPoints: [join(ROOT, "web/app.ts")], bundle: true, format: "esm", target: "es2022", outfile: join(dir, "dist/app.js"), plugins: [plugin], logLevel: "silent" });
  return dir;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await launch(t);
  const head = [fence(PIPELINE), ...SAMPLES.flatMap(([name, code]) => ["", `**${name}**`, "", fence(code)])].join("\n");
  for (const old of [false, true]) {
    const tag = old ? "old" : "new";
    const board = await startBoard(t, { webDir: await pageDir(old) }), id = board.gen.witness.code;
    const it = board.store.snapshot().items[id]!;
    await ops(board.store).updateItem({ author: it.group, id, rev: it.rev, head, reason: "screenshots" });
    const bp = await BoardPage.open(browser, board);
    await bp.select(id);
    const drawn = () => bp.page.waitForFunction(count => {
      const blocks = [...document.querySelectorAll<HTMLElement>("#item-detail .mermaid-block")];
      return blocks.length === count && blocks.every(b => b.dataset.state === "done" || b.dataset.state === "error");
    }, SAMPLES.length + 1, { timeout: 60_000 });
    await drawn();
    for (const scheme of ["light", "dark"] as const) {
      await bp.page.emulateMedia({ colorScheme: scheme });
      await bp.page.waitForTimeout(3_000);
      await drawn();
      const blocks = bp.page.locator("#item-detail .mermaid-block");
      const names = ["pipeline", ...SAMPLES.map(([name]) => name)];
      for (let i = 0; i < names.length; i++) await blocks.nth(i).screenshot({ path: join(OUT, `${names[i]}-${tag}-${scheme}.png`) });
      const sizes = await bp.page.evaluate(() => [...document.querySelectorAll("#item-detail .mermaid-fig svg")].map(s => { const v = (s as SVGSVGElement).viewBox.baseVal; return `${Math.round(v.width)}x${Math.round(v.height)}`; }));
      console.log(`${tag} ${scheme}: ${names.map((n, i) => `${n} ${sizes[i]}`).join(", ")}`);
    }
    await bp.page.emulateMedia({ colorScheme: "light" });
    if (!old) {
      // The default view in a window 700 px wide, and the enlarged view at 1500 px, as the owner sees them.
      await bp.page.setViewportSize({ width: 700, height: 1000 });
      await bp.settle();
      await bp.page.screenshot({ path: join(OUT, "window-700.png") });
      await bp.page.setViewportSize({ width: 1500, height: 1000 });
      await bp.settle();
      for (let i = 0; i < 4; i++) await bp.page.locator('#item-detail .mermaid-tools button[aria-label="放大"]').first().click();
      await bp.page.screenshot({ path: join(OUT, "zoomed-1500.png") });
      await bp.page.emulateMedia({ colorScheme: "dark" });
      await bp.page.waitForTimeout(3_000);
      await bp.page.screenshot({ path: join(OUT, "zoomed-1500-dark.png") });
    }
  }
}

try { await main(); } finally { for (const fn of cleanups.reverse()) await fn(); }
