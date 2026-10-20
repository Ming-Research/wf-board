// Temporary (item memory-flags-flake): the memory-flags test's probe in three variants, readings printed, run beside the files of a busy shard.
import { test } from "node:test";
import { execFileSync } from "node:child_process";

const dir = new URL(".", import.meta.url).pathname;
const flags = ["--max-semi-space-size=4", "--heap-growing-percent=50"];
const variants: Record<string, string[]> = { sync: [], gcafter: ["--expose-gc"], yield: [] };

test("diag: the probes' readings", () => {
  for (const [variant, extra] of Object.entries(variants)) {
    for (const [label, nodeFlags] of [["flags", flags], ["flags", flags], ["none", []]] as const) {
      const out = execFileSync(process.execPath, [...nodeFlags, ...extra, `${dir}${variant === "gcafter" ? "gcafter" : variant === "yield" ? "yield" : "series"}.cjs`], { encoding: "utf8" });
      console.log(execFileSync(process.execPath, [`${dir}row.cjs`, variant, label], { encoding: "utf8", input: out }).trim());
    }
  }
});
