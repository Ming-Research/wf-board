// Temporary (item memory-flags-flake): the memory-flags test's probe with its readings printed, run beside the files of a busy shard.
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const probe = readFileSync(new URL("./series.cjs", import.meta.url), "utf8");
const flags = ["--max-semi-space-size=4", "--heap-growing-percent=50"];
const read = (nodeFlags: string[]) => JSON.parse(execFileSync(process.execPath, [...nodeFlags, "-e", probe], { encoding: "utf8" }).trim()) as { peak: number; series: string };

test("diag: the probe's readings with the service's flags", () => {
  for (let run = 1; run <= 3; run++) {
    const r = read(flags);
    console.log(`DIAG with flags run ${run}: peak ${r.peak}${r.peak > 10 ? " series " + r.series : ""}`);
  }
  console.log(`DIAG without flags: peak ${read([]).peak}`);
});
