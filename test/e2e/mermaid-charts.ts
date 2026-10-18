// Diagram sources for the mermaid checks (test/e2e/mermaid.e2e.ts, and test/dom/mermaid-*.test.ts, where a stand-in library draws
// them). Synthetic: invented text, no board data.

export const fence = (code: string) => "```mermaid\n" + code + "\n```";

export const GOOD = "flowchart LR\n  A[需求] --> B[设计]\n  B --> C[实现]";
export const SEQUENCE = "sequenceDiagram\n  参与者甲->>参与者乙: 你好\n  参与者乙-->>参与者甲: 收到";
// Two arrows in a row: a syntax error.
export const BAD = "flowchart LR\n  A --> --> B";
/** A head with a good diagram, a bad one, another good one after it and a code block that is no diagram. */
export const HEAD = ["先看这张图：", "", fence(GOOD), "", "下面这张是错的：", "", fence(BAD), "", "错的后面还有一张：", "", fence(SEQUENCE), "", "```wf\nfn main() {}\n```"].join("\n");
// Asks for the dark theme in its own frontmatter, on a page that shows the light colors.
export const OWN = "---\nconfig:\n  theme: dark\n---\nflowchart LR\n  A[需求] --> B[设计]";
export const WIDE = "flowchart LR\n  " + Array.from({ length: 30 }, (_, i) => `N${i}[第${i}步]`).join(" --> ");
export const SMALL = "flowchart LR\n  A[甲] --> B[乙]";

/** A flowchart of the shape a role's flow chart on the board has: top to bottom, about thirty nodes, decisions, a rounded end, labelled and
 * dashed edges, a subgraph holding nine nodes in three columns, and a loop back. The text is a bakery taking an order, and each label is
 * as long as the label it stands for. The library draws it tall and wider than the text column of a window 1500 px wide, so the checks
 * see a diagram that is shrunk to its box and has much to scroll to when enlarged. */
export const PIPELINE = [
  "flowchart TD",
  '  N1["1 接到订单"] --> N2["2 备好所需食材"]',
  '  N2 --> N3["3 试做样品，定下配方"]',
  '  N3 --> N4{"4 样品够好吃吗"}',
  '  N4 -->|不合格| N5["5 倒掉重来，不硬卖"]',
  '  N4 -->|合格了| N6{"6 要加装饰吗"}',
  '  N6 -->|要| N7["7 画装饰图样"]',
  '  N7 -.-> N8(["8 老板随时过来看、点评"])',
  '  N7 --> N9{"9 要分成几炉吗"}',
  '  N6 -->|不要| N9',
  '  N9 -->|要分| N10["10 分给帮手，各烤一炉"]',
  '  N9 -->|数量太多| N11["11 回头跟老板商量"]',
  '  N9 -->|不分| N12["12 开始烤"]',
  "  N10 --> N12",
  "  N3 -.->|试吃完大多能看出| P",
  "  N12 -.->|烘焙途中也会碰上| P",
  '  subgraph P["试做或烘焙途中会碰上的情况"]',
  '    N13["13 要先称量才能定"]',
  '    N14["14 发现烤箱坏"]',
  '    N15["15 要等面团醒"]',
  '    N16["16 面粉快用完了"]',
  '    N17["17 模具不够用"]',
  '    N18["18 烤过头没法救"]',
  '    N19["19 拿不准火候"]',
  '    N20["20 成本太高"]',
  '    N21["21 太费功夫"]',
  "    N13 ~~~ N16 ~~~ N19",
  "    N14 ~~~ N17 ~~~ N20",
  "    N15 ~~~ N18 ~~~ N21",
  "  end",
  '  N12 --> N22{"22 烤坏了，要重做吗"}',
  "  N22 -->|是| N3",
  '  N22 -->|否| N23["23 装盒贴签，拍照片"]',
  '  N23 --> N24["24 师傅过目"]',
  '  N24 --> N25{"25 和订单图样对得上吗"}',
  '  N25 -->|对不上| N26["26 补装饰，重新验"]',
  "  N26 --> N27",
  '  N25 -->|对得上| N27["27 包好了，等取货"]',
  "  N8 -.-> N27",
  '  N27 --> N28["28 客人取走"]',
  "  classDef settled stroke:#2f8a5f,stroke-width:2px",
  "  classDef pending stroke:#b8661c,stroke-width:2px,stroke-dasharray:5 3",
  "  class N1,N2,N3,N4,N5,N6,N7,N8,N9,N10,N12,N13,N14,N15 settled",
  "  class N11,N22,N23 pending",
].join("\n");
/** A small diagram, a wide one and the tall chart, in one head. */
export const FIT_HEAD = ["一张窄的：", "", fence(SMALL), "", "一张很宽的：", "", fence(WIDE), "", "一张又高又宽的：", "", fence(PIPELINE)].join("\n");
