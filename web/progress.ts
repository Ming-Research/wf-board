// The progress line under an item's title in the detail column, as a plain function of the item's status and Rules.progress so
// tests can check it without a page. Status says whether someone is on the item; the line says how far it is and what holds it
// (docs/design.md, How the page shows a plan).
import type { Status } from "../src/model.ts";
import type { Progress } from "../src/rules.ts";

/** How the line names the rows an item waits on. */
export interface ProgressNames {
  /** The shown title of an item. */
  item(id: string): string;
  /** The shown question of a decision card. */
  card(key: string): string;
}
/** `next`: how far it is and the step to take. `blocked`: what it waits on. `doing`: who is on it and the row. */
export interface ProgressLine { kind: "next" | "blocked" | "doing"; text: string }

export function progressLine(status: Status | undefined, p: Progress, names: ProgressNames): ProgressLine | undefined {
  if (status === "todo" || status === "stalled") {
    if (!p.total) return undefined;
    return { kind: "next", text: `做完 ${p.done}/${p.total}${p.next ? `，下一步：${p.next.text}` : ""}` };
  }
  if (status === "blocked") {
    const parts = [
      ...(p.ask ? ["等主人"] : []),
      ...p.waiting.map(w => w.kind === "item" ? names.item(w.id) : names.card(w.id)),
      ...(p.behind ? ["上级计划里排在它前面的行没做完"] : []),
    ];
    return { kind: "blocked", text: `卡在：${parts.length ? parts.join("；") : "计划里互相等待的行"}` };
  }
  if (status === "wip") {
    const who = p.sessions.length ? `${p.sessions.join("、")} 在做` : "在做";
    return { kind: "doing", text: p.doing.length ? `${who}：${p.doing.map(d => d.text).join("；")}` : who };
  }
  return undefined;
}
