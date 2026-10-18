// Temporary (ci-split-big-tests): lists the tests a run ran, for the before and after comparison in the pull request. Deleted
// before the last full CI.
interface Ev { type: string; data: { name?: string; nesting: number; message?: string; details?: { type?: string } } }

export default async function* (source: AsyncIterable<Ev>) {
  for await (const { type, data } of source) {
    if ((type === "test:pass" || type === "test:fail") && data.details?.type !== "suite" && !(data.nesting === 0 && data.name?.endsWith(".ts"))) yield `TEST|${type === "test:pass" ? "pass" : "FAIL"}|${data.nesting}|${data.name}\n`;
    if (type === "test:stdout" && /rules reuse:/.test(data.message ?? "")) yield `LOG|${data.message}`;
  }
}
