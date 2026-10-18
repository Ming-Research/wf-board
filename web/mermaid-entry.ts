// The mermaid library as one file, web/dist/mermaid.js, which the page loads only when it shows a mermaid block (web/mermaid.ts).
// It also makes ELK, the layout the library draws flowcharts and the state, class and ER diagrams with, use the gaps the diagram's
// configuration asks for (docs/design.md, section 7, Diagrams): the library writes its own gaps into the graph it hands ELK and leaves
// flowchart.nodeSpacing and flowchart.rankSpacing to the layout it no longer draws with.
import mermaid from "mermaid";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ELK as Elk, ElkNode } from "elkjs/lib/elk.bundled.js";

/** The straight run an edge keeps before the box it enters, in px: it is where the arrowhead sits, and a shorter one leaves the head on a bend. */
const APPROACH = 12;
/** The distance between edges that run side by side, in px. */
const PARALLEL = 10;

/** The graph and every subgraph in it: the nodes that hold others. */
const containers = (node: ElkNode): ElkNode[] => node.children?.length ? [node, ...node.children.flatMap(containers)] : [];

// The library makes an ELK for each diagram, so the call is wrapped on the class, not on an instance.
const elk = (ELK as unknown as { prototype: Elk }).prototype;
const layout = elk.layout;
elk.layout = function (this: Elk, graph, args) {
  // The configuration of the diagram being drawn: the page's, with the settings block at the diagram's start over it.
  const { nodeSpacing = 50, rankSpacing = 50 } = mermaid.mermaidAPI.getConfig().flowchart ?? {};
  const gaps = {
    "elk.spacing.nodeNode": nodeSpacing,
    "elk.layered.spacing.nodeNodeBetweenLayers": rankSpacing,
    "elk.layered.spacing.edgeNodeBetweenLayers": APPROACH,
    "elk.spacing.edgeNode": APPROACH,
    "elk.layered.spacing.edgeEdgeBetweenLayers": PARALLEL,
    "elk.spacing.edgeEdge": PARALLEL,
  };
  for (const box of containers(graph)) {
    const options = box.layoutOptions ??= {};
    for (const [key, gap] of Object.entries(gaps)) {
      // The library names some of its own without "elk." (a subgraph's spacing.nodeNode). ELK reads both names as one option and
      // the two values would compete, so the library's goes.
      delete options[key.slice("elk.".length)];
      options[key] = String(gap);
    }
  }
  return layout.call(this, graph, args);
};

export default mermaid;
