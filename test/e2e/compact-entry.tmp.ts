// TEMPORARY (study mermaid-compact-study): the mermaid library with a hook on the ELK layout call, for the layout measurements in
// test/e2e/compact.tmp.ts. Removed with it. The page sets globalThis.__elk before a render; the hook merges `root` into the layout
// options of the graph's root, `group` into those of every subgraph, and keeps a copy of what ELK was given and what it returned;
// globalThis.__mcfg is merged over the page's library configuration.

import mermaid from "mermaid";
import ELK from "elkjs/lib/elk.bundled.js";

type Graph = { layoutOptions?: Record<string, unknown>; children?: Graph[]; edges?: Array<{ labels?: Array<{ layoutOptions?: Record<string, unknown> }> }> };
type Hook = { root?: Record<string, unknown>; group?: Record<string, unknown>; label?: Record<string, unknown> };
const g = globalThis as unknown as { __elk?: Hook; __mcfg?: Record<string, Record<string, unknown>>; __elkIn?: unknown; __elkOut?: unknown };
// The variant's library configuration, merged over the page's (one level deep).
const initialize = mermaid.initialize.bind(mermaid);
mermaid.initialize = (config: Record<string, unknown>) => {
  const extra = g.__mcfg ?? {}, merged: Record<string, unknown> = { ...config };
  for (const [k, v] of Object.entries(extra)) merged[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...(config[k] as object ?? {}), ...v } : v;
  initialize(merged);
};
const layout = ELK.prototype.layout;
ELK.prototype.layout = async function (graph: Graph, options?: unknown) {
  const hook = g.__elk;
  if (hook) {
    if (hook.root) Object.assign(graph.layoutOptions ??= {}, hook.root);
    const walk = (node: Graph) => { for (const child of node.children ?? []) if (child.children?.length) { if (hook.group) Object.assign(child.layoutOptions ??= {}, hook.group); walk(child); } };
    walk(graph);
    if (hook.label) for (const edge of graph.edges ?? []) for (const label of edge.labels ?? []) Object.assign(label.layoutOptions ??= {}, hook.label);
  }
  g.__elkIn = JSON.parse(JSON.stringify(graph));
  const out = await layout.call(this, graph as never, options as never);
  g.__elkOut = JSON.parse(JSON.stringify(out));
  return out;
} as typeof layout;

export default mermaid;
