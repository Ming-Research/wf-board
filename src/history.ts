import { stringify } from "yaml";
import type { Store, DocKind } from "./store.ts";
import { describeChanges } from "./query.ts";

export interface Step {
  id: string;
  commits: string[];
  author: string;
  at: string;
  docs: Array<{ kind: DocKind; id: string; summary: string }>;
}

export async function unreadSteps(store: Store, cursor: string | undefined): Promise<Step[]> {
  if (cursor && !(await store.inHistory(cursor))) throw new Error(`Read cursor ${cursor} is not in board history`);
  const commits = (await store.log(cursor ? { since: cursor } : {})).reverse();
  const steps: Step[] = [];
  let previous: Step | undefined;
  for (const commit of commits) {
    // An owner action breaks consecutiveness even though it is not a step.
    if (commit.author === "owner") { previous = undefined; continue; }
    const docs: Step["docs"] = commit.files.flatMap(file => {
      const m = /^(items|decisions|notes)\/(.+)\.yaml$/.exec(file);
      if (!m) return [];
      const kind = ({ items: "item", decisions: "decision", notes: "note" } as const)[m[1] as "items" | "decisions" | "notes"];
      return [{ kind, id: m[2]!, summary: "" }];
    });
    const single = docs.length === 1 && commit.files.every(f => f === "state/owner.yaml" || /^(items|decisions|notes)\//.test(f));
    if (single && previous?.docs.length === 1 && previous.author === commit.author && previous.docs[0]!.kind === docs[0]!.kind && previous.docs[0]!.id === docs[0]!.id) {
      previous.commits.push(commit.commit); previous.id = commit.commit; previous.at = commit.at;
    } else {
      previous = { id: commit.commit, commits: [commit.commit], author: commit.author, at: commit.at, docs };
      steps.push(previous);
    }
    if (!single) previous = undefined;
  }
  for (const step of steps) for (const doc of step.docs) {
    const { before, after } = await endpoints(store, step, doc.kind, doc.id);
    doc.summary = describeChanges(before, after, doc.kind);
  }
  return steps;
}

async function endpoints(store: Store, step: Step, kind: DocKind, id: string) {
  const first = step.commits[0];
  if (!first) throw new Error("Step has no commits");
  const parent = await store.inHistory(`${first}^`);
  return { parent, before: parent ? await store.show(kind, id, parent) : null, after: await store.show(kind, id, step.id) };
}

export async function stepDiff(store: Store, step: Step, kind: string, id: string): Promise<{ before: unknown | null; after: unknown | null; diff: string }> {
  if (kind !== "item" && kind !== "decision" && kind !== "note") throw new Error(`Unknown document kind ${kind}`);
  if (!step.docs.some(d => d.kind === kind && d.id === id)) throw new Error(`Document ${kind}:${id} is not in this step`);
  const { parent, before, after } = await endpoints(store, step, kind, id);
  // A root commit has no parent for Store.diff. Render its complete addition.
  const diff = parent ? await store.diff(kind, id, parent, step.id) : after === null ? "" :
    `--- /dev/null\n+++ ${kind}:${id}\n` + stringify(after, { lineWidth: 0, blockQuote: "literal" }).trimEnd().split("\n").map(l => `+${l}\n`).join("");
  return { before, after, diff };
}
