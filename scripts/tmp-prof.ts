// Temporary (item ci-gate-45, deleted before review): sums the CPU profiles of one test file's processes into a JSON summary:
// self time by package or source file, self and inclusive time by function.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface Profile { nodes: Node[]; samples: number[]; timeDeltas: number[] }

const [dir, out, file, wall, user, sys] = process.argv.slice(2);
const bucket = (url: string, fn: string) => {
  if (url === "") return fn.startsWith("(") ? fn : "(native)";
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(url);
  if (m) return `npm:${m[1]}`;
  if (url.startsWith("node:")) return "node:internal";
  const r = /\/(src|web|test|scripts)\/(.*)$/.exec(url);
  return r ? `${r[1]}/${r[2]}` : url;
};
const buckets = new Map<string, number>(), self = new Map<string, number>(), total = new Map<string, number>();
const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
let processes = 0, sampled = 0;
for (const name of readdirSync(dir).filter(n => n.endsWith(".cpuprofile"))) {
  const profile = JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as Profile;
  processes++;
  const parent = new Map<number, number>(), node = new Map(profile.nodes.map(n => [n.id, n]));
  for (const n of profile.nodes) for (const child of n.children ?? []) parent.set(child, n.id);
  const key = (id: number) => {
    const { functionName, url, lineNumber } = node.get(id)!.callFrame;
    return `${functionName || "(anonymous)"} ${url.replace(/^.*\/(src|web|test|scripts|node_modules)\//, "$1/")}:${lineNumber + 1}`;
  };
  for (const [k, id] of profile.samples.entries()) {
    const dt = (profile.timeDeltas[k] ?? 0) / 1000;
    const { functionName, url } = node.get(id)!.callFrame;
    if (functionName === "(idle)") continue;
    sampled += dt;
    add(buckets, bucket(url, functionName), dt);
    add(self, key(id), dt);
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const name = key(at);
      if (!seen.has(name)) { seen.add(name); add(total, name, dt); }
    }
  }
}
const top = (m: Map<string, number>, n: number) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, Math.round(v)]));
writeFileSync(out, JSON.stringify({ file, wall: Number(wall), user: Number(user), sys: Number(sys), processes, sampled: Math.round(sampled), buckets: top(buckets, 200), self: top(self, 300), total: top(total, 600) }));
