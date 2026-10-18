// Pre-fix variants of the page, for showing that a check catches a bug that once shipped: the current page with a fix reversed.
// The browser layer serves a variant from a temporary directory (variantWeb); the page-in-a-DOM layer bundles one in memory
// (test/dom/page.ts). Neither needs a browser.

import { mkdtemp, rm, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { ROOT } from "./board-server.ts";
import type { Hooks } from "./board-server.ts";

// A variant is the current file with edits applied in order to a copy: either the named hunks of a fix commit's diff
// reversed, or a targeted edit (literal text replaced) where later work moved the fix's surrounding lines. The repository
// is never written.
export type Revert =
  | { commit: string; file: "web/app.ts" | "web/index.html"; hunks?: number[] }
  | { file: "web/app.ts" | "web/index.html" | "web/mermaid.ts" | "web/mermaid-entry.ts" | "web/highlight.ts"; edit: string; find: string; replace: string };
/** The hunks of one file's diff in a commit, each as its old and new text. */
function hunks(commit: string, file: string): Array<{ before: string; after: string }> {
  const diff = execFileSync("git", ["show", "--format=", "--no-color", "-U3", commit, "--", file], { cwd: ROOT, encoding: "utf8" });
  const out: Array<{ before: string[]; after: string[] }> = [];
  for (const line of diff.split("\n")) {
    const cur = out.at(-1);
    if (line.startsWith("@@")) out.push({ before: [], after: [] });
    else if (!cur) continue;
    else if (line.startsWith(" ")) { cur.before.push(line.slice(1)); cur.after.push(line.slice(1)); }
    else if (line.startsWith("-")) cur.before.push(line.slice(1));
    else if (line.startsWith("+")) cur.after.push(line.slice(1));
  }
  return out.map(h => ({ before: h.before.join("\n"), after: h.after.join("\n") }));
}
/** Replaces `find` with `replace` in `text`; throws unless `find` occurs exactly once. */
function replaceOnce(text: string, find: string, replace: string, what: string): string {
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + 1) >= 0) throw new Error(`${what} no longer matches the current file once; retire or update this regression witness`);
  return text.slice(0, at) + replace + text.slice(at + find.length);
}
/** `text` with one revert applied. */
function revertText(text: string, revert: Revert): string {
  if ("edit" in revert) return replaceOnce(text, revert.find, revert.replace, `${revert.file} edit "${revert.edit}"`);
  const all = hunks(revert.commit, revert.file);
  for (const k of revert.hunks ?? all.map((_, k) => k)) {
    const h = all[k];
    if (!h) throw new Error(`${revert.commit} ${revert.file}: no hunk ${k}`);
    text = replaceOnce(text, h.after, h.before, `${revert.commit} ${revert.file} hunk ${k}`);
  }
  return text;
}
/** The current text of `file` with every revert naming it applied, in order. */
export async function reverted(file: Revert["file"], reverts: Revert[]): Promise<string> {
  let text = await readFile(join(ROOT, file), "utf8");
  for (const revert of reverts) if (revert.file === file) text = revertText(text, revert);
  return text;
}
/** A page directory serving the current page with the given reverts applied. */
export async function variantWeb(t: Hooks, reverts: Revert[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-variant-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "index.html"), await reverted("web/index.html", reverts));
  // The diagram library is a file beside the page bundle; the variant serves the built one, or builds it again when a revert names its entry.
  if (reverts.some(r => r.file === "web/mermaid-entry.ts")) {
    const entry = await reverted("web/mermaid-entry.ts", reverts);
    await build({ stdin: { contents: entry, resolveDir: join(ROOT, "web"), sourcefile: "mermaid-entry.ts", loader: "ts" }, bundle: true, format: "esm", target: "es2022", minify: true, outfile: join(dir, "dist/mermaid.js"), logLevel: "silent" });
  } else await symlink(join(ROOT, "web/dist/mermaid.js"), join(dir, "dist/mermaid.js"));
  const contents = await reverted("web/app.ts", reverts);
  // A fix reversed in another source file of the page (web/mermaid.ts) is applied as the file is read.
  const others = new Set<string>(reverts.map(r => r.file).filter(f => f !== "web/app.ts" && f !== "web/index.html" && f !== "web/mermaid-entry.ts"));
  const plugin: Plugin = {
    name: "reverted",
    setup(b) {
      b.onLoad({ filter: /[\\/]web[\\/][\w-]+\.ts$/ }, async args => {
        const file = ("web/" + basename(args.path)) as Revert["file"];
        return others.has(file) ? { contents: await reverted(file, reverts), loader: "ts" } : undefined;
      });
    },
  };
  // The same options as the build:web script, reading the variant from stdin so its imports resolve from web/.
  await build({ stdin: { contents, resolveDir: join(ROOT, "web"), sourcefile: "app.ts", loader: "ts" }, bundle: true, format: "esm", target: "es2022", outfile: join(dir, "dist/app.js"), plugins: [plugin], logLevel: "silent" });
  return dir;
}
