// TMP-MEASURE (item ci-under-1min-study, never merged): one JSON line per finished test with its file, name, nesting and wall times.
export default async function* (source) {
  const t0 = Date.now();
  for await (const e of source) {
    if (e.type === "test:pass" || e.type === "test:fail") {
      const d = e.data;
      yield JSON.stringify({ at: Date.now() - t0, file: (d.file ?? "").split("/").slice(-2).join("/"), name: d.name, nesting: d.nesting, ms: Math.round(d.details.duration_ms), ok: e.type === "test:pass" }) + "\n";
    }
  }
}
