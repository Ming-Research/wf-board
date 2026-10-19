// A CPU profile of a stretch of a benchmark, summarized as the functions with the most self time and the most total time per
// unit of work. Used by scripts/bench-writes.ts and scripts/bench-page.ts with their --profile option; the profiler slows the run,
// so the CPU numbers of a profiled run are not the ones to compare.
import { Session } from "node:inspector/promises";

interface Profile { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }>; samples: number[]; timeDeltas: number[] }

/** Starts the profiler; `stop` ends it and returns the summary, in milliseconds per `unit`. */
export async function profiled(): Promise<{ stop(units: number, unit: string): Promise<string> }> {
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 250 });
  await session.post("Profiler.start");
  return {
    async stop(units, unit) {
      const { profile } = await session.post("Profiler.stop");
      session.disconnect();
      return summarize(profile as unknown as Profile, units, unit);
    },
  };
}

function summarize(profile: Profile, units: number, unit: string): string {
  const parent = new Map<number, number>(), node = new Map(profile.nodes.map(n => [n.id, n]));
  for (const n of profile.nodes) for (const child of n.children ?? []) parent.set(child, n.id);
  const name = (id: number) => {
    const { functionName, url, lineNumber } = node.get(id)!.callFrame;
    return `${functionName || "(anonymous)"} ${url.replace(/^.*\/(src|web|test|scripts|node_modules)\//, "$1/")}:${lineNumber + 1}`;
  };
  const self = new Map<string, number>(), total = new Map<string, number>();
  for (const [k, id] of profile.samples.entries()) {
    const dt = (profile.timeDeltas[k] ?? 0) / 1000, seen = new Set<string>();
    self.set(name(id), (self.get(name(id)) ?? 0) + dt);
    // A function counts once per sample however often it recurs on the stack.
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const key = name(at);
      if (!seen.has(key)) { seen.add(key); total.set(key, (total.get(key) ?? 0) + dt); }
    }
  }
  const top = (map: Map<string, number>, n: number) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([key, ms]) => `    ${(ms / units).toFixed(2).padStart(7)} ms/${unit}  ${key}`).join("\n");
  return `  profile, self time:\n${top(self, 40)}\n  profile, total time:\n${top(total, 70)}`;
}
