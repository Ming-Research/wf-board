// Temporary (ci-gate-margin): seconds a test process spends in the set-up shared by the DOM tests.
const totals = new Map<string, { n: number; ms: number }>();
let hooked = false;
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try { return await fn(); } finally {
    const x = totals.get(label) ?? { n: 0, ms: 0 };
    x.n++; x.ms += performance.now() - t0; totals.set(label, x);
    if (!hooked) {
      hooked = true;
      process.on("exit", () => console.log("TMPTIME " + process.argv[1] + " " + [...totals].map(([k, v]) => `${k}=${v.n}x${v.ms.toFixed(0)}ms`).join(" ")));
    }
  }
}
