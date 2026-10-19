import { test } from "node:test";
import assert from "node:assert/strict";
import { PauseGraph, pauseSignature, sameShape } from "../src/pauses.ts";
import type { PauseEvent, PauseShape } from "../src/pauses.ts";
import { rules } from "../src/rules.ts";
import type { Item } from "../src/model.ts";

const at = (minute: number) => `2026-10-12T03:${String(minute % 60).padStart(2, "0")}:00.${String(minute % 1000).padStart(3, "0")}Z`;
const shape = (group: string, owned: string[] = [], fields: { record?: boolean; paused?: string } = {}): PauseShape => ({
  group, record: fields.record === true, ...(fields.paused ? { paused: { at: fields.paused, reason: "Waiting" } } : {}), owned,
});

/** The oracle: the pause of every item as the page's rules give it, for a board made of the shapes. */
function sources(shapes: ReadonlyMap<string, PauseShape>): Map<string, string | undefined> {
  const items = Object.fromEntries([...shapes].map(([id, s]) => [id, {
    title: id, group: s.group, ...(s.record ? { record: true } : {}), ...(s.paused ? { paused: s.paused } : {}),
    plan: s.owned.map(item => ({ id: item, item, own: true })), log: [], links: [], rev: 1, updated: at(0),
  } as unknown as Item]));
  const r = rules({ board: { title: "Board", projects: [] }, items, decisions: {}, notes: {}, owner: {} } as unknown as Parameters<typeof rules>[0]);
  return new Map([...shapes.keys()].map(id => [id, r.pausedBy(id)]));
}

/** What the events of one change must be, from the oracle's pause of every item before and after. */
function expectedEvents(before: ReadonlyMap<string, PauseShape>, after: ReadonlyMap<string, PauseShape>): PauseEvent[] {
  const was = sources(before), now = sources(after);
  const events: PauseEvent[] = [];
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const source = now.get(id), previous = was.get(id);
    if (!!source === !!previous) continue;
    if (!source) { events.push({ id, paused: false }); continue; }
    // The source is newly paused when it was not paused in the board before.
    events.push({ id, paused: true, ...(before.get(source)?.paused ? {} : { since: after.get(source)!.paused!.at }) });
  }
  return events.sort((a, b) => a.id < b.id ? -1 : 1);
}

const byId = (events: PauseEvent[]) => [...events].sort((a, b) => a.id < b.id ? -1 : 1);

test("a pause reaches what the item owns in its project, not through a record or another project", () => {
  const graph = PauseGraph.from([
    ["root", shape("P", ["a", "other"])], ["a", shape("P", ["b"])], ["b", shape("P")], ["other", shape("Q", ["deep"])], ["deep", shape("Q")],
  ]);
  assert.deepEqual(byId(graph.apply(new Map([["root", shape("P", ["a", "other"], { paused: at(1) })]]))),
    [{ id: "a", paused: true, since: at(1) }, { id: "b", paused: true, since: at(1) }, { id: "root", paused: true, since: at(1) }],
    "a pause source is itself paused, with what hangs under it in the same project");
  assert.equal(graph.pausedBy("other"), undefined, "an owned item of another project is out of the pause");
  assert.equal(graph.pausedBy("deep"), undefined);
  // A record pauses nothing, and a record that is paused is no source; the chain goes on above it.
  const recordGraph = PauseGraph.from([["top", shape("P", ["rec"], { paused: at(2) })], ["rec", shape("P", ["leaf"], { record: true, paused: at(3) })], ["leaf", shape("P")]]);
  assert.equal(recordGraph.pausedBy("leaf"), "top");
  assert.equal(recordGraph.pausedBy("rec"), "top");
});

test("an item that is gone, an owned item that does not exist and a ring of owners are not paused and do not loop", () => {
  const graph = PauseGraph.from([["a", shape("P", ["b", "missing"])], ["b", shape("P", ["a"])]]);
  assert.equal(graph.pausedBy("a"), undefined);
  assert.equal(graph.pausedBy("missing"), undefined);
  assert.deepEqual(byId(graph.apply(new Map([["a", shape("P", ["b", "missing"], { paused: at(1) })]]))), [{ id: "a", paused: true, since: at(1) }, { id: "b", paused: true, since: at(1) }]);
  assert.deepEqual(byId(graph.apply(new Map([["a", null]]))), [{ id: "a", paused: false }, { id: "b", paused: false }], "a deleted source frees what it paused");
  assert.equal(graph.shape("a"), null);
});

test("a change that moves nothing in or out of a pause says nothing, and a nearer pause source does not split the span", () => {
  const graph = PauseGraph.from([["root", shape("P", ["child"], { paused: at(1) })], ["child", shape("P")]]);
  assert.deepEqual(graph.apply(new Map([["child", shape("P", [], { paused: at(2) })]])), [], "an item already paused by an owner stays in the same span");
  assert.deepEqual(graph.apply(new Map([["root", shape("P", ["child"])]])), [{ id: "root", paused: false }], "the nearer source keeps the item paused");
  assert.deepEqual(graph.apply(new Map([["root", shape("P", ["child"], { paused: at(3) })]])), [{ id: "root", paused: true, since: at(3) }]);
  assert.deepEqual(graph.apply(new Map([["root", { ...shape("P", ["child"], { paused: at(3) }), paused: { at: at(3), reason: "Another reason" } }]])), [], "a new reason is no event");
});

test("moving an item under a paused owner opens its span at the commit, and out of it closes there", () => {
  const graph = PauseGraph.from([["paused", shape("P", [], { paused: at(1) })], ["free", shape("P", ["moved"])], ["moved", shape("P", ["leaf"])], ["leaf", shape("P")]]);
  assert.deepEqual(byId(graph.apply(new Map([["free", shape("P")], ["paused", shape("P", ["moved"], { paused: at(1) })]]))),
    [{ id: "leaf", paused: true }, { id: "moved", paused: true }], "the source was paused before: no start time of its own");
  assert.deepEqual(byId(graph.apply(new Map([["free", shape("P", ["moved"])], ["paused", shape("P", [], { paused: at(1) })]]))),
    [{ id: "leaf", paused: false }, { id: "moved", paused: false }]);
});

test("the events of random changes are those of the page's own rules on the whole board, before and after", () => {
  let seed = 7;
  const random = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };
  const pick = <T>(list: readonly T[]): T => list[random(list.length)]!;
  for (let walk = 0; walk < 40; walk++) {
    const model = new Map<string, PauseShape>(), owner = new Map<string, string>();
    const graph = new PauseGraph();
    let next = 0, minute = 1;
    for (let step = 0; step < 150; step++) {
      const before = new Map(model), changes = new Map<string, PauseShape | null>();
      const set = (id: string, change: Partial<Omit<PauseShape, "paused">> & { paused?: string | null }) => {
        const old = model.get(id)!;
        const paused = change.paused === undefined ? old.paused : change.paused === null ? undefined : { at: change.paused, reason: "Waiting" };
        const updated: PauseShape = { group: change.group ?? old.group, record: change.record ?? old.record, owned: change.owned ?? old.owned, ...(paused ? { paused } : {}) };
        changes.set(id, updated); model.set(id, updated);
      };
      const ids = [...model.keys()];
      const kind = ids.length < 4 ? "create" : pick(["create", "create", "move", "move", "pause", "pause", "resume", "delete", "group", "record", "reason"]);
      const target = pick(ids.length ? ids : [""]);
      if (kind === "create") {
        const id = `i${next++}`, parent = ids.length && random(5) ? pick(ids) : undefined;
        const created = shape(parent ? model.get(parent)!.group : pick(["P", "Q"]), [], { record: random(8) === 0, ...(random(6) === 0 ? { paused: at(minute) } : {}) });
        model.set(id, created); changes.set(id, created);
        if (parent) { owner.set(id, parent); set(parent, { owned: [...model.get(parent)!.owned, id] }); }
      } else if (kind === "move") {
        const to = pick(ids), from = owner.get(target);
        if (to === target || (from === to)) continue;
        // Out of every ring: the board stays a forest, as a write keeps it.
        let ring = false;
        for (let up: string | undefined = to; up !== undefined; up = owner.get(up)) if (up === target) ring = true;
        if (ring) continue;
        if (from) set(from, { owned: model.get(from)!.owned.filter(id => id !== target) });
        set(to, { owned: [...model.get(to)!.owned, target] });
        owner.set(target, to);
      } else if (kind === "pause") set(target, { paused: at(minute) });
      else if (kind === "resume") set(target, { paused: null });
      else if (kind === "reason") { const old = model.get(target)!; if (old.paused) { const reasoned = { ...old, paused: { at: old.paused.at, reason: "Other" } }; changes.set(target, reasoned); model.set(target, reasoned); } else continue; }
      else if (kind === "group") set(target, { group: pick(["P", "Q", "R"]) });
      else if (kind === "record") set(target, { record: !model.get(target)!.record });
      else if (kind === "delete") {
        const from = owner.get(target);
        if (from) set(from, { owned: model.get(from)!.owned.filter(id => id !== target) });
        for (const [child, parent] of owner) if (parent === target) owner.delete(child);
        owner.delete(target); model.delete(target); changes.set(target, null);
      }
      minute++;
      const wanted = new Map([...changes].filter(([id, now]) => !sameShape(before.get(id) ?? null, now)));
      assert.deepEqual(byId(graph.apply(wanted)), expectedEvents(before, model), `walk ${walk} step ${step} (${kind} ${target})`);
      const oracle = sources(model);
      for (const id of model.keys()) assert.equal(graph.pausedBy(id), oracle.get(id), `walk ${walk} step ${step}: pausedBy ${id}`);
    }
  }
});

test("the signature of an item file changes with each field the pause spans read, in each way a file may write it, and with no other edit", () => {
  const base = "title: A\ngroup: P\nhead: text\nlog:\n  - at: 2026-10-11T01:00:00Z\n    text: entry\nplan:\n  - id: accept\n    text: Accepted\n    state: todo\n    accept: true\nupdated: 2026-10-11T01:00:00Z\nrev: 1\n";
  const changes: Record<string, string> = {
    group: base.replace("group: P", "group: Q"),
    "quoted group": base.replace("group: P", "\"group\": P"),
    record: base.replace("group: P\n", "group: P\nrecord: true\n"),
    pause: base.replace("group: P\n", "group: P\npaused:\n  reason: Deferred\n  at: 2026-10-11T04:00:00.125Z\n"),
    "pause in flow style": base.replace("group: P\n", "group: P\npaused: {reason: Deferred, at: 2026-10-11T04:00:00.125Z}\n"),
    "owned row": base.replace("plan:\n", "plan:\n  - id: c\n    item: c\n    own: true\n"),
    "owned row in flow style": base.replace("plan:\n", "plan:\n  - {id: c, item: c, own: true}\n"),
    "owned row made shared in flow style": base.replace("plan:\n", "plan:\n  - {id: c, item: c, own: false}\n"),
    "quoted row keys": base.replace("plan:\n", "plan:\n  - \"id\": c\n    'item': c\n    \"own\": true\n"),
    "a row moved to another item": base.replace("plan:\n", "plan:\n  - id: c\n    item: d\n    own: true\n"),
  };
  const ordinary: Record<string, string> = {
    "a log entry": base.replace("    text: entry\nplan:", "    text: entry\n  - at: 2026-10-11T02:00:00Z\n    text: Progress on the item\nplan:"),
    "a head edit": base.replace("head: text", "head: other text"),
    "a step done": base.replace("state: todo", "state: done"),
    "a title": base.replace("title: A", "title: B"),
    "a row of text that only contains a key's name": base.replace("text: Accepted", "text: Accepted by the subgroup: yes"),
  };
  const original = pauseSignature(base);
  assert.equal(original.paused, false);
  for (const [name, body] of Object.entries(changes)) assert.notEqual(pauseSignature(body).key, original.key, `${name}: the signature changes`);
  for (const [name, body] of Object.entries(ordinary)) assert.equal(pauseSignature(body).key, original.key, `${name}: the signature stays`);
  // The time and the reason of a pause stand on the lines under `paused:`, and a pause's shape holds them.
  const paused = changes.pause!;
  assert.notEqual(pauseSignature(paused.replace("04:00:00.125Z", "05:00:00.250Z")).key, pauseSignature(paused).key, "the time of a pause");
  assert.notEqual(pauseSignature(paused.replace("Deferred", "Other")).key, pauseSignature(paused).key, "the reason of a pause");
  assert.equal(pauseSignature(paused.replace("head: text", "head: other text")).key, pauseSignature(paused).key, "a head edit of a paused item");
  // `subgroup:` is not `group:`.
  assert.equal(pauseSignature("title: A\nsubgroup: P\nxrecord: true\n").key, "");
  // A line of text that ends in `paused:` is not a pause, and the lines after it still count, whether or not the word before it joins it
  // to a letter (`unpaused:`) or the line is indented.
  const owning = (before: string, item: string) => `title: A\ngroup: P\nplan:\n  - id: w\n    text: "${before}"\n  - id: c\n    item: ${item}\n    own: true\nupdated: x\n`;
  for (const before of ["Wait until unpaused: then rerun", "Wait until paused: then rerun", "A note about subpaused: here"]) {
    assert.notEqual(pauseSignature(owning(before, "c")).key, pauseSignature(owning(before, "d")).key, `${before}: the owned row after it is in the signature`);
    assert.equal(pauseSignature(owning(before, "c")).paused, false);
  }
  // The lines under a pause at the margin belong to it, also when its key is quoted, and stop at the next key at the margin.
  const quoted = "group: P\n\"paused\":\n  reason: R\n  at: 2026-10-11T04:00:00Z\nplan:\n  - item: c\n    own: true\n";
  assert.notEqual(pauseSignature(quoted).key, pauseSignature(quoted.replace("reason: R", "reason: S")).key);
  assert.notEqual(pauseSignature(quoted).key, pauseSignature(quoted.replace("item: c", "item: d")).key);
});

test("a file has a pause when a `paused:` line stands at the left margin, however the pause is written", () => {
  assert.equal(pauseSignature("group: P\npaused:\n  reason: R\n  at: 2026-10-11T04:00:00Z\n").paused, true);
  assert.equal(pauseSignature("paused: {reason: R, at: 2026-10-11T04:00:00Z}\ngroup: P\n").paused, true);
  assert.equal(pauseSignature("group: P\nlog:\n  - text: x\n    paused: not at the margin\n").paused, false);
  assert.equal(pauseSignature("group: P\nunpaused: 1\n").paused, false);
});
