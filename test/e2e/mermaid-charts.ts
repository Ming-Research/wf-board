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

// The two charts that the compactness checks (test/e2e/mermaid-compact.e2e.ts) draw. Synthetic: every letter of the text is filler, so
// no board text is in this repository.

/** A flowchart of the shape of the engineer's flow chart on the board, which the page draws too tall and too loose: the same nodes,
 * node shapes, line breaks, line lengths, edges, edge labels and settings block, with lines of nonsense verse for the text. */
export const ENGINEER = [
  "---",
  "config:",
  "  flowchart:",
  "    wrappingWidth: 640",
  "---",
  "flowchart TD",
  "  N1[\"<b>1 KRV 春江潮水</b><br/>连海平：海上明月共潮生，滟滟随波千<br/>万里何处 WHL 春江无，月明江流\"]",
  "  N2[\"<b>2 宛转</b><br/>绕芳甸、月照花林皆、MDGSKR.ma、似霰空里<br/>流霜不觉飞汀 HL 上白沙看不\"]",
  "  N3[\"<b>3 见江天一色无纤，尘皎皎空</b><br/>中孤月轮江畔何人初见月<br/>江月何年初照，人人生代代<br/>无穷已江月年年望相似不<br/>知江月待，何人但见「长江」\"]",
  "  N4{{\"4 送流水白云一片去\"}}",
  "  N5[\"<b>5 悠悠，青枫浦上不胜愁</b><br/>春江潮，水连海平海<br/>上明月共潮生滟滟随波千\"]",
  "  N6{{\"6 万里何处春江\"}}",
  "  N7[\"<b>7 无月明江</b><br/>流宛转绕，芳甸月照<br/>花林皆似霰空，里流霜不觉飞汀<br/>上白沙看不见江天，一色无纤\"]",
  "  N8([\"<b>8 尘皎皎空中孤、月轮</b><br/>江畔何人：初见月江月<br/>何年初：照 3 人人生代\"])",
  "  N9{{\"9 代无穷已江月\"}}",
  "  N10[\"<b>10 年年望相，似不知江</b><br/>月待何人但见长江送<br/>流水白云一片去悠悠青枫\"]",
  "  N11[\"<b>11 浦上</b><br/>不胜愁春，江潮水连海平海<br/>上明月共潮生滟滟，随波 5 千<br/>2 万里何处春江无 3 月\"]",
  "  N12[\"<b>12 明江流宛转绕</b><br/>芳甸月照，花林皆似霰<br/>空里流霜，不觉飞<br/>汀上白沙，看不见江天一色\"]",
  "  P[\"<b>22–29 无纤尘皎皎空中孤月轮：江畔何人初，见月江月何年初</b><br/>22 照人人生代代　23 无穷已江　24 月年年望相似　25 不知江月待、何人、但见长江<br/>26 Mslunomar 送流　27 水白云一、片去悠、悠青枫　28 浦上不、胜愁春江潮　29 水连海平、海上明<br/>月共潮生滟滟随波千万里何，处春江无月\"]",
  "  N13{{\"13 明江，流宛转绕芳甸\"}}",
  "  N13A[\"月照花林皆似霰<br/>空里流霜 3 不觉飞汀\"]",
  "  N14[\"<b>14 上白 LM 沙 DG</b><br/>看不见江天一色无 SK，纤「尘皎」<br/>皎空中 RV，孤月轮江畔<br/>何人初、见月江：月何年初照人人生代代\"]",
  "  N15[\"<b>15 无穷</b><br/>已江月年年望，相似不知江月待何<br/>人但见长江送，流水白云一片去\"]",
  "  N16[\"<b>16 悠悠</b><br/>青枫浦上不、WH 胜、愁春江潮、「水连」海平海<br/>上明月共潮生，滟 LM 滟随波千万里何\"]",
  "  N17{{\"17 处春江无月明江流\"}}",
  "  N18[\"<b>18 宛转绕芳</b><br/>甸月照，花林皆似霰\"]",
  "  N19{{\"19 空里流霜 8 不觉、<br/>飞汀上白沙\"}}",
  "  N20[\"<b>20 看不见江天一色</b><br/>无纤尘皎皎空中孤<br/>月轮江畔何人\"]",
  "  N21[\"<b>21 DGS 初见</b><br/>月江月何年初照人人，生代代无穷<br/>已江月年年望相似不知江月\"]",
  "  N1 --> N2 --> N3 --> N4",
  "  N4 -->|待何人但见长| N5",
  "  N4 -->|江送| N6",
  "  N6 -->|流| N7",
  "  N6 -->|水白，云一片去悠悠| N9",
  "  N7 -.-> N8",
  "  N7 --> N9",
  "  N9 -->|青枫| N10 --> N11",
  "  N9 -->|浦上| N11",
  "  N11 -->|不胜愁春江潮| N12",
  "  N12 -->|水连海| N11",
  "  N3 -.-> P",
  "  N11 -.-> P",
  "  N11 --> N13",
  "  N13 -->|平| N13A",
  "  N13 -->|海| N14 --> N15 --> N16 --> N17",
  "  N17 -->|上明月| N19",
  "  N17 -->|共潮生| N18 -->|滟滟随| N19",
  "  N19 -->|波，千万里何处春| N21",
  "  N19 -->|江无月，明江流宛转| N20 -->|绕芳甸月| N21",
  "  classDef settled stroke:#2f8a5f,stroke-width:2px",
  "  class N1,N2,N3,N4,N5,N6,N7,N8,N9,N10,N11,N12,N13,N13A,N14,N15,N16,N17,N18,N19,N20,N21,P settled",
].join("\n");

/** ENGINEER with gaps of its own in its settings block, which must win over the page's. */
export const ENGINEER_OWN = ENGINEER.replace("    wrappingWidth: 640", "    wrappingWidth: 640\n    nodeSpacing: 60\n    rankSpacing: 60");

/** A chart with three lanes, each a subgraph, joined by edges that cross from lane to lane. */
export const LANES = [
  "flowchart TD",
  '  subgraph 前厅["前厅"]',
  '    A1["<b>1 客人进门</b><br/>迎客，问人数，看有没有订座"] --> A2{{"2 有空桌吗"}}',
  '    A2 -->|有| A3["<b>3 带位</b><br/>递菜单，倒茶水"]',
  '    A2 -->|没有| A4["<b>4 排号等位</b><br/>记下电话，估一个时间"]',
  '    A4 -.->|叫到号| A3',
  '    A3 --> A5["<b>5 点菜</b><br/>记下忌口和辣度<br/>推荐当天的时令菜"]',
  "  end",
  '  subgraph 后厨["后厨"]',
  '    B1["<b>6 配菜</b><br/>按单取料，切好摆盘"] --> B2{{"7 食材够吗"}}',
  '    B2 -->|够| B3["<b>8 下锅</b><br/>按单上的顺序炒"]',
  '    B2 -->|不够| B4["<b>9 告诉前厅换菜</b><br/>说清缺什么、能换什么"]',
  '    B3 --> B5["<b>10 出菜</b><br/>检查份量和摆盘"]',
  "  end",
  '  subgraph 收银["收银"]',
  '    C1["<b>11 结账</b><br/>核对菜单，算折扣"] --> C2{{"12 要发票吗"}}',
  '    C2 -->|要| C3["<b>13 开发票</b><br/>写抬头和税号"]',
  '    C2 -->|不要| C4(["<b>14 送客</b><br/>欢迎下次再来"])',
  '    C3 --> C4',
  "  end",
  "  A5 -->|下单| B1",
  "  B4 -.->|换菜| A5",
  "  B5 -->|上菜| A6[\"<b>15 上菜</b><br/>报菜名，提醒小心烫\"]",
  "  A6 --> C1",
].join("\n");

