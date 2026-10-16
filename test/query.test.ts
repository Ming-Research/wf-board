import { test } from "node:test";
import assert from "node:assert/strict";
import { rules } from "../src/rules.ts";
import * as q from "../src/query.ts";
import { board, at, later, author, architect, asArchitect } from "./helpers.ts";
import type { PlanStepInput } from "../src/model.ts";
const acceptance = (text = "验收通过"): PlanStepInput => ({ id: "accept", accept: true, text, state: "todo" });

test("search finds each Chinese field, ranks title/head/cards/logs/notes, marks snippets and filters", async t => {
  const { store } = await board(t), s = store.snapshot(), r = rules(s);
  const hits = q.search(s, r, "中文", { limit: 100 });
  assert.deepEqual(hits.map(h => `${h.kind}:${h.id}:${h.field}`), ["item:a:title", "item:a:head", "item:a:data", "item:a:ask", "card:choice:question", "card:choice:option.A", "card:ruled:ruling", "item:a:log[6]", "item:a:log[0]", "note:note-2:reply", "note:note-1:text"]);
  // One hit per field: log[0] matches twice and reports the second as `more`.
  assert.equal(hits.find(h => h.field === "log[0]")!.more, 1);
  for (const hit of hits) { assert.ok(hit.snippet.includes("«中文»")); assert.equal(hit.area, "解释器工作"); }
  assert.equal(hits[7]!.time, "2026-10-11T01:02:06Z");
  assert.equal(q.search(s, r, "WHITEFOOT", { kind: ["item"] })[0]!.id, "a");
  assert.equal(q.search(s, r, "中文", { limit: 2 }).length, 2);
  assert.deepEqual(q.search(s, r, "中文", { group: "Firn" }), []);
  assert.equal(q.search(s, r, "中文", { under: "b", kind: ["note"], since: later }).length, 1);
  assert.deepEqual(q.search(s, r, "中文", { status: ["done"] }), []);
  assert.throws(() => q.search(s, r, " "), /query/);
  assert.throws(() => q.search(s, r, "中文", { under: "missing" }), /under/);
  const long = { ...s, items: { ...s.items, a: { ...s.items.a!, head: "前".repeat(90) + "中文" + "后".repeat(90) } } };
  const snippet = q.search(long, rules(long), "中文", { kind: ["item"], limit: 100 }).find(h => h.field === "head")!.snippet;
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…")); assert.ok(snippet.length <= 86);
});

test("search finds target goal, target value, current value and distinctive comparison baseline", async t => {
  const { store, op } = await board(t);
  const target = { id: "style", goal: "独特样式目标", target: "目标值123", current: "当前值456", baseline: "Chromium 同机独特基准" };
  await op.setTargets({ author, id: "a", target });
  const s = store.snapshot(), r = rules(s);
  for (const text of [target.goal, target.target, target.current, target.baseline]) {
    const hits = q.search(s, r, text);
    assert.deepEqual(hits.map(hit => `${hit.kind}:${hit.id}:${hit.field}`), ["item:a:target.style"]);
    assert.ok(hits[0]!.snippet.includes(`«${text}»`));
    assert.equal(hits[0]!.time, undefined, "target search follows item time like step search");
  }
});

test("context exposes the owner chain, compact plan, shared waiters, cards, replies, links and bounded logs", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "child-low", owner: "a", title: "Low", accept: "Low accepted" });
  await op.createItem({ ...asArchitect, key: "child-high", owner: "a", title: "High", accept: "High accepted" });
  const s = store.snapshot(), r = rules(s), c = q.context(s, r, "a");
  assert.ok("plan" in c);
  assert.equal(c.item.title, "中文检查"); assert.equal(c.item.rev, 3);
  assert.equal(c.item.priority, undefined); assert.equal(c.priority, "P1");
  assert.deepEqual(c.ancestors.map(it => it.id), ["area"]);
  assert.ok(c.plan[0]!.includes("child-low") && c.plan[0]!.includes("[own]"));
  assert.ok(c.plan[1]!.includes("child-high") && c.plan[1]!.includes("[own]"));
  assert.ok(c.plan.at(-1)!.includes("○") && c.plan.at(-1)!.includes("验收"));
  assert.deepEqual(c.dependents.map(d => d.id), ["b"], "owner belongs in its chain, shared waiter is separate");
  for (const removed of ["children", "deps", "steps", "migrated", "raisedBy"]) assert.equal(Object.hasOwn(c, removed), false);
  assert.deepEqual(c.cards, [], "the fixture's cards belong to b");
  assert.equal(c.notes.length, 1);
  const held = q.context(s, r, "b");
  assert.ok("plan" in held);
  assert.deepEqual(held.cards.map(card => card.key), ["ruled", "choice"], "cards follow the plan");
  const open = held.cards.find(card => card.key === "choice")!;
  assert.ok("options" in open); assert.equal(open.question, "中文方案？"); assert.equal(Object.hasOwn(open, "background"), false);
  const ruled = held.cards.find(card => card.key === "ruled")!;
  assert.equal(ruled.choice, "A"); assert.equal((ruled as { choiceText?: string }).choiceText, "Old"); assert.equal("options" in ruled, false, "a closed card is summarized by its pick");
  assert.equal(held.notes.length, 1); assert.equal(held.notes[0]!.reply, "中文回复");
  assert.equal(c.links[0]!.label, "Pull request"); assert.deepEqual(c.prs.qualified, [{ repo: "Whitefoot", number: 341 }]);
  const all = q.context(s, r, "a", { log: "all" }), none = q.context(s, r, "a", { log: 0 });
  assert.ok("earlierLogs" in all && "earlierLogs" in none);
  assert.equal(c.item.log.length, 5); assert.equal(c.earlierLogs, all.item.log.length - 5);
  assert.equal(all.earlierLogs, 0); assert.equal(none.earlierLogs, all.item.log.length);
  const card = q.context(s, r, "choice"); assert.equal(card.kind, "card");
  assert.equal(card.card!.options.length, 2); assert.equal(card.item.title, "阻塞证据");
  assert.throws(() => q.context(s, r, "missing"), /Unknown id/);
});


test("latest five context notes include notes on cards and item, not other targets", async t => {
  const { store } = await board(t);
  await store.commit({ author, message: "More notes", puts: Array.from({ length: 6 }, (_, i) => ({ kind: "note" as const, id: `extra-${i}`, expectRev: null, doc: { target: i === 5 ? "it:other" : "q:choice", kind: "comment", text: `Note ${i}`, at: `2026-10-12T00:00:0${i}Z`, state: "sent" } })) });
  const c = q.context(store.snapshot(), rules(store.snapshot()), "b");
  assert.deepEqual(c.notes.map(n => n.id), ["extra-4", "extra-3", "extra-2", "extra-1", "extra-0"]);
});

test("graph marks owned/shared edges, card states, cycles, blocked chains and depth limits", async t => {
  const { store } = await board(t), before = store.snapshot();
  await store.commit({ author, message: "Imported cycle witness", puts: [{ kind: "item", id: "a", expectRev: 1,
    doc: { ...before.items.a!, plan: [{ id: "b", item: "b", own: false, after: [] }, acceptance()] } }] });
  const s = store.snapshot(), r = rules(s), g = q.graph(s, r, "a", { direction: "both", depth: 4 });
  const upB = g.up!.next.find(n => n.id === "b")!;
  assert.equal(upB.own, false); assert.equal(upB.status, "blocked"); assert.equal(g.up!.blockedChain, true);
  assert.equal(upB.next.find(n => n.id === "a")!.cycle, true);
  assert.equal(upB.next.find(n => n.id === "choice")!.kind, "card");
  assert.equal(upB.next.find(n => n.id === "choice")!.blockedChain, true);
  assert.equal(g.down!.next.find(n => n.id === "area")!.own, true);
  assert.equal(g.down!.next.find(n => n.id === "b")!.own, false);
  assert.equal(q.graph(s, r, "choice", { direction: "down" }).down!.next[0]!.id, "b");
  const limited = q.graph(s, r, "a", { direction: "up", depth: 0 });
  assert.equal(limited.up!.truncated, true); assert.deepEqual(limited.up!.next, []);
});


test("overview/list/notes filter derived plan status, inherited priority, subtree and time", async t => {
  const { store, op } = await board(t);
  await op.clearAsk({author,id:"a",log:"Handled"});
  await op.setPlan({ author, id: "a", row: { id: "work", text: "Own work", state: "doing" } });
  const s = store.snapshot(), r = rules(s), areas = q.overview(s, r, { group: "Whitefoot" })[0]!.areas;
  assert.equal(areas.length, 1); assert.deepEqual(areas[0]!.counts, { todo: 0, wip: 1, blocked: 1, paused: 0, done: 0, cancelled: 0 });
  assert.deepEqual(areas[0]!.ownerActions.map(it => it.id), ["b"]); assert.deepEqual(areas[0]!.blocked.map(it => it.id), ["b"]);
  assert.deepEqual(q.list(s, r, { under: "area", status: ["blocked"], priority: ["P1"], group: "Whitefoot" }).map(it => it.id), ["b"]);
  assert.deepEqual(q.list(s, r, { priority: ["P0"] }), []);
  assert.deepEqual(q.list(s, r, { needsOwner: true }).map(it => it.id), ["b"]);
  assert.ok(q.list(s, r, { hasChecks: true }).some(it => it.id === "other" && it.checks.some(c => c.text.startsWith("只差验收"))));
  assert.equal(q.list(s, r, { group: "Firn", limit: 1 })[0]!.id, "other");
  assert.deepEqual(q.list(s, r, { updatedSince: "2999-01-01T00:00:00Z" }), []);
  assert.equal(q.notes(s, { state: ["sent"], kind: ["comment"], under: "area", since: at, limit: 1 })[0]!.id, "note-1");
  assert.deepEqual(q.notes(s, { under: "other" }), []);
});


test("PR index separates qualified text, links, cards, notes and bare refs, avoids number-prefix matches", async t => {
  const { store } = await board(t), s = store.snapshot(), r = rules(s);
  const prs = q.prs(s, r, "Whitefoot", 341);
  assert.deepEqual(prs.qualified.map(it => `${it.kind}:${it.id}`), ["item:a", "card:ruled", "note:note-1"]);
  assert.deepEqual(prs.unknown.map(it => `${it.kind}:${it.id}`), ["item:b", "note:note-2"]);
  assert.deepEqual(q.prs(s, r, "Whitefoot", 34), { qualified: [], unknown: [] });
  const repos = new Set(["whitefoot", "other"]);
  assert.deepEqual(q.references("Whitefoot#341 Whitefoot #341 Whitefoot PR #341 https://github.com/Ming-Research/Whitefoot/pull/341 #341 #34 Other #3410", repos), { qualified: [{ repo: "Whitefoot", number: 341 }, { repo: "Other", number: 3410 }], unknown: [341, 34] });
  // A word before #N names a repository only when the board links to it.
  assert.deepEqual(q.references("see #341, Whitefoot #7", repos), { qualified: [{ repo: "Whitefoot", number: 7 }], unknown: [341] });
});

test("changes summarizes net fields over commits, groups areas, and history/diff reproduce evidence", async t => {
  const { store, op } = await board(t), baseline = store.snapshot().head;
  await op.setPlan({ author, id: "a", row: { id: "work", text: "Own work", state: "doing" } });
  await op.updateItem({ author, id: "a", rev: 2, head: "New stable context", reason: "Scope clarified" });
  await op.replyNote({ author, id: "note-1", reply: "Resolved" });
  await op.createItem({ ...asArchitect, key: "new", owner: "other", title: "New witness", accept: "Witness accepted" });
  await op.ruleCard({ author, key: "choice", choice: "A" });
  const s = store.snapshot(), changes = await q.changes(store, s, baseline);
  const whitefoot = changes.find(g => g.areaId === "area")!;
  const item = whitefoot.documents.find(d => d.id === "a")!;
  assert.deepEqual(item.summary.split(", ").sort(), ["plan changed", "head changed", "+1 log"].sort());
  assert.deepEqual(item.commits.map(c => c.message), ["set_plan a", "update_item a"]);
  assert.ok(item.commits.every(c => c.author === author && c.at.endsWith("Z")));
  assert.match(whitefoot.documents.find(d => d.id === "note-1")!.summary, /new reply/);
  assert.match(whitefoot.documents.find(d => d.id === "choice")!.summary, /status open→ruled/);
  assert.equal(changes.find(g => g.areaId === "other")!.documents.find(d => d.id === "new")!.summary, "new item");
  assert.deepEqual((await q.changes(store, s, baseline, { group: "Firn" })).map(g => g.areaId), ["other"]);
  assert.ok((await q.changes(store, s, baseline, { under: "a" }))[0]!.documents.every(d => ["a", "choice", "note-1"].includes(d.id)));
  assert.deepEqual(await q.changes(store, s, "2999-01-01T00:00:00Z"), []);
  assert.equal((await q.history(store, "item", "a", 1))[0]!.message, "update_item a");
  const diff = await q.diff(store, "item", "a", baseline, s.head);
  assert.match(diff, /\+.*state: doing/); assert.match(diff, /\+head: New stable context/);
  assert.equal(await q.diff(store, "item", "a", baseline, "2999-01-01T00:00:00Z"), diff);
  assert.equal(q.describeChanges({ log: [{ text: "original" }] }, { log: [{ text: "edited" }, { text: "new" }] }, "item"), "log changed");
  assert.equal(q.describeChanges({ head: "Text" }, {}, "item"), "head cleared");
});

test("changes stays anchored to its snapshot even if a later commit lands, and includes deleted documents", async t => {
  const { store, op } = await board(t), baseline = store.snapshot().head;
  await op.appendLog({ author, id: "a", text: "First" });
  const s = store.snapshot();
  await op.appendLog({ author, id: "a", text: "Second" });
  assert.equal((await q.changes(store, s, baseline))[0]!.documents[0]!.summary, "+1 log");
  await store.commit({ author, message: "Delete witness", deletes: [{ kind: "item", id: "b", expectRev: 1 }] });
  const deleted = (await q.changes(store, store.snapshot(), baseline))[0]!.documents.find(d => d.id === "b")!;
  assert.equal(deleted.summary, "deleted item"); assert.equal(deleted.title, "阻塞证据");
});

test("changes recovers no owner for a live root, so it rebuilds no earlier whole board", async t => {
  const { store, op } = await board(t);
  for (let i = 0; i < 5; i++) await op.appendLog({ author, id: "b", text: `Earlier ${i}` });
  const baseline = store.snapshot().head;
  await op.appendLog({ author, id: "a", text: "Recent" });
  const rebuilt = t.mock.method(store, "comparisonSnapshot");
  const changed = await q.changes(store, store.snapshot(), baseline);
  assert.equal(changed.length, 1); assert.equal(changed[0]!.areaId, "area");
  assert.deepEqual(changed[0]!.documents.map(d => d.id), ["a"]);
  assert.equal(rebuilt.mock.callCount(), 0, "the chain ends at a live root, which keeps the ownership its snapshot gives it");
});

test("created-then-deleted items, cards and notes retain intermediate identity and ownership in changes", async t => {
  const { store, op } = await board(t), baseline = store.snapshot().head;
  await op.createItem({ ...asArchitect, key: "temporary", owner: "area", title: "Temporary item", accept: "Temporary witness passes" });
  await op.writeCard({ author, key: "temporary-card", item: "temporary", question: "Temporary question?", blocks: "Waits", confidence: { reason: "Guess" }, options: [{ text: "A", detail: "Does A" }] });
  await store.commit({ author, message: "Temporary note", puts: [{ kind: "note", id: "temporary-note", expectRev: null, doc: { target: "q:temporary-card", kind: "comment", text: "Temporary note", at, state: "sent" } }] });
  await store.commit({ author, message: "Delete temporary documents", deletes: [
    { kind: "item", id: "temporary", expectRev: 2 }, { kind: "decision", id: "temporary-card", expectRev: 1 }, { kind: "note", id: "temporary-note", expectRev: 1 },
  ] });
  const changed = await q.changes(store, store.snapshot(), baseline, { group: "Whitefoot" });
  assert.equal(changed.length, 1); assert.equal(changed[0]!.areaId, "area");
  const docs = changed[0]!.documents.filter(d => d.id.startsWith("temporary"));
  assert.deepEqual(docs.map(d => [d.kind, d.title, d.summary]), [["item", "Temporary item", "created and deleted item"], ["card", "Temporary question?", "created and deleted card"], ["note", "Temporary question?", "created and deleted note"]]);
  assert.deepEqual(docs.map(d => d.commits.length), [3, 2, 2], "the item also changed when its card's row joined its plan");
});

test("deleting an area and its whole ownership chain preserves area grouping and group-filtered changes", async t => {
  const { store } = await board(t), baseline = store.snapshot().head;
  await store.commit({ author, message: "Delete area and ownership chain", deletes: [
    ...["area", "a", "b"].map(id => ({ kind: "item" as const, id, expectRev: 1 })),
    ...["choice", "ruled"].map(id => ({ kind: "decision" as const, id, expectRev: 1 })),
    ...["note-1", "note-2"].map(id => ({ kind: "note" as const, id, expectRev: 1 })),
  ] });
  const changed = await q.changes(store, store.snapshot(), baseline, { group: "Whitefoot" });
  assert.equal(changed.length, 1); assert.equal(changed[0]!.areaId, "area"); assert.equal(changed[0]!.area, "解释器工作");
  assert.equal(changed[0]!.documents.length, 7);
  assert.equal(changed[0]!.documents.find(d => d.id === "note-2")!.title, "中文方案？");
});

test("sequential ownership deletions retain each document's last known area and allow historical subtree filters", async t => {
  const { store } = await board(t), baseline = store.snapshot().head;
  await store.commit({ author, message: "Delete area first", deletes: [{ kind: "item", id: "area", expectRev: 1 }] });
  await store.commit({ author, message: "Delete cards before notes", deletes: [{ kind: "decision", id: "choice", expectRev: 1 }, { kind: "decision", id: "ruled", expectRev: 1 }] });
  await store.commit({ author, message: "Delete children and notes later", deletes: [
    ...["a", "b"].map(id => ({ kind: "item" as const, id, expectRev: 1 })), ...["note-1", "note-2"].map(id => ({ kind: "note" as const, id, expectRev: 1 })),
  ] });
  const changed = await q.changes(store, store.snapshot(), baseline, { group: "Whitefoot", under: "area" });
  assert.equal(changed.length, 1); assert.equal(changed[0]!.areaId, "area"); assert.equal(changed[0]!.documents.length, 7);
  assert.equal(changed[0]!.documents.find(d => d.id === "note-2")!.title, "中文方案？");
  await assert.rejects(q.changes(store, store.snapshot(), baseline, { under: "never-existed" }), /under.*historical item/);
  assert.equal((await q.history(store, "item", "a", 1))[0]!.message, "Delete children and notes later");
  assert.deepEqual(await q.history(store, "item", "a", 0), []);
  await assert.rejects(q.history(store, "item", "never-existed"), /Unknown item id/);
  await assert.rejects(q.diff(store, "note", "never-existed", baseline), /Unknown note id/);
});

test("timestamp filters and newest-first order honor milliseconds, with later append order for tied log times", async t => {
  const { store } = await board(t), s = store.snapshot();
  const fractional = "2026-10-11T01:02:03.500Z", threshold = "2026-10-11T01:02:03.250Z";
  await store.commit({ author, message: "Mixed precision clocks", puts: [
    { kind: "item", id: "a", expectRev: 1, doc: { ...s.items.a!, updated: at, log: [{ at, text: "混合 earlier" }, { at: fractional, text: "混合 newer" }, { at: fractional, text: "混合 latest append" }] } },
    { kind: "item", id: "b", expectRev: 1, doc: { ...s.items.b!, updated: fractional } },
    { kind: "note", id: "note-1", expectRev: 1, doc: { ...s.notes["note-1"]!, at, sentAt: at } },
    { kind: "note", id: "note-2", expectRev: 1, doc: { ...s.notes["note-2"]!, at, repliedAt: fractional } },
  ] });
  const mixed = store.snapshot(), r = rules(mixed);
  assert.deepEqual(q.search(mixed, r, "混合").map(h => h.field), ["log[2]", "log[1]", "log[0]"]);
  assert.deepEqual(q.search(mixed, r, "混合", { since: threshold }).map(h => h.field), ["log[2]", "log[1]"]);
  assert.deepEqual(q.list(mixed, r, { updatedSince: threshold }).map(it => it.id), ["b"]);
  assert.deepEqual(q.notes(mixed).map(n => n.id), ["note-2", "note-1"]);
  assert.deepEqual(q.notes(mixed, { since: threshold }).map(n => n.id), ["note-2"]);
});

test("search finds a document by its key, and a PR-shaped query through the PR index", async t => {
  const { store } = await board(t), s = store.snapshot(), r = rules(s);
  const byKey = q.search(s, r, "choice");
  assert.equal(byKey[0]!.id, "choice"); assert.equal(byKey[0]!.field, "id");
  // "Whitefoot#341" appears verbatim only in a's head; the PR index also attributes
  // "Whitefoot PR #341" (a card's old background) and "Whitefoot #341" (note) to it, and b's bare #341 to an unknown repository.
  const pr = q.search(s, r, "Whitefoot#341", { limit: 50 }).filter(h => h.field === "pr");
  assert.deepEqual(pr.filter(h => h.snippet === "«Whitefoot#341»").map(h => `${h.kind}:${h.id}`).sort(), ["card:ruled", "item:a", "note:note-1"]);
  assert.ok(pr.some(h => h.id === "b" && h.snippet.includes("未写仓库")));
  assert.deepEqual(q.search(s, r, "Whitefoot #341", { kind: ["note"] }).filter(h => h.field === "pr").map(h => h.id), ["note-1", "note-2"]);
});

test("context names the responsible project without agents", async t => {
  const { formatContext } = await import("../src/mcp.ts");
  const { store } = await board(t), s = store.snapshot(), r = rules(s);
  for (const id of ["a", "area"]) {
    const text = formatContext(q.context(s, r, id));
    assert.match(text, /Whitefoot › area/);
    assert.doesNotMatch(text, /agents:/);
  }
});

test("brief queues own work and frontier steps, folds resolved rows and projects count all open items", async t => {
  const {store,op} = await board(t);
  await op.clearAsk({author,id:"a",log:"Handled"});
  await op.createRequest({author:"Firn",project:"Whitefoot",key:"incoming",title:"Incoming",head:"Detail",accept:"Incoming accepted",priority:"P0",why:"Need help"});
  await op.createRequest({author,project:"Firn",key:"outgoing",title:"Outgoing",head:"Detail",accept:"Outgoing accepted",why:"Need feature",from:"a"});
  await op.setPlan({author,id:"a",row:{id:"doing",text:"Own current work",state:"doing",after:[]}});
  await op.setPlan({author,id:"area",row:{id:"own",text:"Parent current work",state:"doing",after:[]}});
  await op.createItem({...asArchitect,key:"backlog",title:"Backlog",group:author,record:true});
  await op.createItem({...asArchitect,key:"parked",title:"Parked",owner:"backlog",accept:"Parked accepted"});
  await op.setPlan({author,id:"parked",row:{id:"future",text:"Future work",state:"todo"}});
  const s=store.snapshot(),r=rules(s),brief=q.brief(s,r,author);
  assert.deepEqual(brief.inbox.map(x=>({id:x.id,by:x.by,why:x.why})),[{id:"incoming",by:"Firn",why:"Need help"}]);
  assert.deepEqual(brief.wip.map(x=>x.id).sort(),["a","area"],"a parent with its own doing step is queued");
  assert.ok(!brief.todo.some(x=>x.id==="parked"),"backlog is no commitment");
  assert.deepEqual(brief.outgoing.map(x=>x.id),["outgoing"]);
  assert.ok(brief.progress.some(x=>x.id==="backlog"),"even an empty record may be inspected");
  const project=q.projects(s,r)[0]!;
  assert.equal(project.inbox,1); assert.equal(project.openItems.wip,2); assert.equal(project.openItems.blocked,1);
  assert.equal(Object.hasOwn(project,"migrated"),false); assert.equal(Object.hasOwn(project,"agents"),false);
  assert.throws(()=>q.brief(s,r,"Missing"),/project/);
});

test("brief excludes an ask-blocked frontier but retains ready parallel work beside a doing step", async t => {
  const {store,op}=await board(t);
  const blocked=store.snapshot();
  assert.equal(rules(blocked).statusOf("a"),"blocked");
  assert.ok(!q.brief(blocked,rules(blocked),author).todo.some(row=>row.id === "a"));
  await op.clearAsk({author,id:"a",log:"Handled"});
  await op.setPlan({author,id:"a",rows:[{id:"doing",text:"Current work",state:"doing",after:[]},{id:"ready",text:"Independent next work",state:"todo",after:[]},acceptance()]});
  const running=store.snapshot(),r=rules(running);
  assert.equal(r.statusOf("a"),"wip");
  assert.ok(q.brief(running,r,author).todo.some(row=>row.id === "a"));
  assert.ok(q.brief(running,r,author).wip.some(row=>row.id === "a"));
});

test("project followups use strict age boundary and omit drafts, replies, closures and triaged requests", async t => {
  const {store,op} = await board(t);
  await op.createRequest({author,project:"Firn",key:"old-request",title:"Old",head:"Detail",accept:"Request accepted",priority:"P1",why:"Need"});
  await op.createRequest({author,project:"Firn",key:"handled-request",title:"Handled",head:"Detail",accept:"Request accepted",priority:"P1",why:"Need"});
  await op.triageRequest({author:"Firn",id:"handled-request",priority:"P2",log:"Taken as an area"});
  const s = structuredClone(store.snapshot());
  s.items["handled-request"]!.log[0]!.at=at;
  s.notes.closed={...s.notes["note-1"]!,state:"done",repliedAt:later,repliedBy:"Firn"};
  assert.ok(!q.list(s,rules(s),{}).some(x=>x.id==="old-request"),"an untriaged request is not listed as work");
  assert.ok(q.list(s,rules(s),{}).some(x=>x.id==="handled-request"),"a triaged request is ordinary work");
  s.items["old-request"]!.request!.at=at;
  s.notes.fresh={...s.notes["note-1"]!,sentAt:later};
  s.notes.draft={...s.notes["note-1"]!,state:"draft"};
  const r=rules(s), cutoff = new Date(Date.parse(at)+60*60000).toISOString();
  assert.deepEqual(q.followups(s,r,{minutes:60},cutoff),{notes:[],requests:[]});
  const f=q.followups(s,r,{minutes:59},cutoff);
  assert.deepEqual(f.notes.map(n=>n.id),["note-1"]);
  assert.deepEqual(f.requests.map(n=>[n.id,n.project,n.by]),[["old-request","Firn",author]]);
  for (const entry of [...f.notes,...f.requests]) assert.equal(Object.hasOwn(entry,"agents"),false);
  assert.throws(()=>q.followups(s,r,{minutes:-1},cutoff),/minutes/);
});


test("project identity read shapes omit agents and outgoing requests use requesting project without a dependency", async t => {
  const { store } = await board(t);
  const s = structuredClone(store.snapshot());
  s.items["outgoing-alone"] = { ...s.items.other!, title: "Unlinked request", log: [{ at, by: "Whitefoot", text: "Whitefoot 提出：Needed" }], request: { by: "Whitefoot", at } };
  s.items["foreign-request"] = { ...s.items.other!, title: "Other project's request", log: [], request: { by: "Firn", at } };
  const r = rules(s), summary = q.brief(s, r, "Whitefoot");
  await t.test("outgoing selection", () => assert.deepEqual(summary.outgoing.map(it => it.id), ["outgoing-alone"]));
  await t.test("brief shape", () => assert.equal(Object.hasOwn(summary, "agents"), false));
  const followups = q.followups(s, r, { minutes: 0 }, later);
  const groups = { row: [q.row(s, r, "item", "a")], list: q.list(s, r), projects: q.projects(s, r), overview: q.overview(s, r), notes: followups.notes, requests: followups.requests };
  for (const [name, rows] of Object.entries(groups)) {
    await t.test(`${name} shape`, () => {
      assert.ok(rows.length > 0, "the shape guard observes at least one result");
      for (const result of rows) assert.equal(Object.hasOwn(result, "agents"), false);
    });
  }
  await t.test("projects output", () => assert.deepEqual(q.projects(s, r)[0], { name: "Whitefoot", repo: "Ming-Research/Whitefoot", areas: 1, openItems: { todo: 0, wip: 0, blocked: 3, paused: 0 }, inbox: 0 }));
});

test("records are labeled separately in query rows and absent from status queues; stalled leaves appear in hasChecks", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "record", group: author, title: "Queue", priority: "P1", record: true });
  const s = structuredClone(store.snapshot()), now = Date.parse("2026-10-11T06:00:00Z");
  s.items.a!.plan.unshift({id:"doing",text:"Own work",state:"doing",since:at}); s.items.a!.ask = undefined; s.decisions = {}; s.notes = {};
  s.activity = { writes: Array.from({length: 7}, (_, i) => new Date(now - i * 30 * 60 * 1000).toISOString()), items: {} };
  const r = rules(s, now), record = q.row(s, r, "item", "record");
  assert.equal(record.record, true); assert.equal(record.status, undefined);
  assert.ok(!q.list(s, r, {status: ["todo", "wip", "blocked", "done", "cancelled"]}).some(v => v.id === "record"));
  assert.ok(!q.brief(s, r, author).todo.some(v => v.id === "record"));
  const flagged = q.list(s, r, {hasChecks: true}).find(v => v.id === "a");
  assert.ok(flagged?.checks.some(c => c.text.includes("活跃时间")));
});


test("context and brief show plan levels, parallel marks, acceptance and resolved counts; search covers plan text", async t => {
  const { store, op } = await board(t);
  await op.clearAsk({author,id:"a",log:"Handled"});
  await op.setPlan({ author, id: "a", rows: [
    { id: "compile", text: "Step evidence Whitefoot#777", state: "done", after: [] },
    { id: "review", text: "Step review", state: "doing", waits: "Review committee", after: [] },
    { id: "drop", text: "Old proposal", state: "dropped", reason: "Alternative selected" },
    acceptance(),
  ] });
  const s=store.snapshot(),r=rules(s,Date.parse("2026-10-13T02:03:04Z")),context=q.context(s,r,"a");
  assert.ok("plan" in context);
  assert.match(context.plan[0]!,/^L0 ‖ ✓ compile /);
  assert.match(context.plan[1]!,/^L0 ‖ ● review /); assert.match(context.plan[1]!,/2 天.*Review committee/);
  assert.match(context.plan.at(-1)!,/○ accept .*验收/);
  const brief=q.brief(s,r,author),current=brief.wip.find(row=>row.id==="a")!;
  assert.ok(current.plan!.includes("✓ 1 项已完成"),"brief counts only the done row as completed");
  assert.ok(current.plan!.includes("✗ 1 项已放弃"),"brief counts the dropped row separately");
  assert.equal(Object.hasOwn(q.row(s,r,"item","a"),"plan"),false,"ordinary list row remains compact");
  assert.ok(q.search(s,r,"Review committee").some(hit=>hit.id==="a"&&hit.field==="plan.review"));
  assert.ok(q.search(s,r,"Alternative selected").some(hit=>hit.id==="a"&&hit.field==="plan.drop"));
  assert.ok(q.search(s,r,"验收通过").some(hit=>hit.id==="a"&&hit.field==="plan.accept"));
  assert.ok(q.prs(s,r,"Whitefoot",777).qualified.some(hit=>hit.id==="a"));
  assert.equal(q.describeChanges({plan:s.items.a!.plan},{plan:s.items.a!.plan.slice(0,-1)},"item"),"plan changed");
});

test("brief counts owned records as completed and cancelled owned items as dropped", async t => {
  const { store } = await board(t), s = structuredClone(store.snapshot());
  s.items.queue = { ...s.items.other!, group: author, record: true, plan: [
    { id: "finished", text: "Finished work", state: "done", doneAt: "2026-10-13T00:00:00Z", after: [] },
    { id: "abandoned", text: "Abandoned work", state: "dropped", reason: "Superseded", droppedAt: "2026-10-13T00:00:00Z", after: [] },
    { id: "record", item: "record", own: true, after: [] },
    { id: "cancelled", item: "cancelled", own: true, after: [] },
    { id: "pending", text: "Next work", state: "todo", after: [] },
  ] };
  s.items.record = { ...s.items.other!, group: author, record: true, plan: [] };
  s.items.cancelled = { ...s.items.other!, group: author, status: "cancelled" };
  const r = rules(s), progress = q.brief(s, r, author).progress.find(row => row.id === "queue");
  assert.ok(progress);
  assert.deepEqual(progress.plan, ["✓ 2 项已完成", "✗ 2 项已放弃", "L0 ‖ ○ pending Next work"]);
  const context = q.context(s, r, "queue");
  assert.ok(context.kind === "item");
  assert.equal(context.plan.length, 5, "context retains every row");
});

test("context warns about non-adjacent same-level rows without sorting them", async t => {
  const {store,op}=await board(t);
  await op.setPlan({author,id:"a",rows:[
    {id:"first",text:"First",state:"todo",after:[]},
    {id:"second",text:"Second",state:"todo"},
    {id:"parallel",text:"Stored third",state:"todo",after:[]},acceptance(),
  ]});
  const s=store.snapshot(),c=q.context(s,rules(s),"a"); assert.ok("plan" in c);
  assert.deepEqual(c.plan.slice(0,3).map(line=>line.split(" ")[2]),["first","second","parallel"]);
  assert.deepEqual(c.planWarnings,[
    "level 0: non-adjacent parallel rows are shown in stored order",
    "level 1: non-adjacent parallel rows are shown in stored order",
  ], "the ordinary acceptance row follows Stored third at level 1");
});

test("context and brief retain multiple acceptance rows before delivery with ordinary parallel marks", async t => {
  const { store } = await board(t), s = structuredClone(store.snapshot());
  delete s.items.a!.ask;
  s.items.a!.plan = [
    { id: "compile", text: "Compile result", state: "done", doneAt: "2026-10-13T00:00:00Z" },
    { id: "accept", text: "Check scenario one", state: "doing", since: "2026-10-13T00:00:00Z", accept: true, after: ["compile"] },
    { id: "scenario", text: "Check scenario two", state: "todo", accept: true, after: ["compile"] },
    { id: "merge", text: "Merge accepted work", state: "todo", after: ["accept", "scenario"] },
  ];
  const r = rules(s), context = q.context(s, r, "a");
  assert.ok("plan" in context);
  assert.deepEqual(context.plan.map(line => line.match(/^L\d (?:‖ )?[✓●○] \S+/)?.[0]), [
    "L0 ✓ compile", "L1 ‖ ● accept", "L1 ‖ ○ scenario", "L2 ○ merge",
  ]);
  assert.equal(context.plan.filter(line => line.includes("[验收]")).length, 2);
  const current = q.brief(s, r, author).wip.find(row => row.id === "a");
  assert.ok(current);
  assert.deepEqual(current.plan, ["✓ 1 项已完成", ...context.plan.slice(1)]);
  assert.match(current.plan!.at(-1)!, /merge Merge accepted work/);
});

test("brief progress retains records and blocked work without repeating queues or adding closed/todo backlog", async t => {
  const {store,op}=await board(t);
  await op.createItem({...asArchitect,key:"record",title:"Reference",group:author,record:true});
  await op.createItem({...asArchitect,key:"closed",title:"Closed",group:author,accept:"Closed accepted",priority:"P1"});
  await op.setPlan({author,id:"closed",row:{...acceptance("Closed accepted"),state:"done"}});
  const s=structuredClone(store.snapshot()); delete s.items.a!.ask;
  s.items.b!.plan=[{id:"other",item:"other",own:false,after:[]}, {id:"ruled",card:"ruled",after:[]}, {id:"choice",card:"choice",after:[]}, {...acceptance(),id:"accept"}];
  s.items.a!.plan=[{id:"ready",text:"Ready work",state:"todo"}, {...acceptance(),id:"accept"}];
  // Three options, so the card raises no 选项不足 check that would list its item under checks instead.
  s.decisions.choice!.options=[...s.decisions.choice!.options,{key:"C",text:"第三个做法"}];
  const brief=q.brief(s,rules(s),author);
  assert.ok(brief.todo.some(row=>row.id==="a"));
  assert.ok(brief.progress.some(row=>row.id==="record"));
  assert.ok(brief.progress.some(row=>row.id==="b"));
  assert.ok(!brief.progress.some(row=>row.id==="closed"||row.id==="a"));
});

test("context and brief retain compact target lines beside plans", async t => {
  const {store,op}=await board(t);
  await op.clearAsk({author,id:"a",log:"Handled"});
  const target={id:"style",goal:"apollo11\n样式计算耗时",target:"≤ 1 倍 Chromium",current:"12 倍\nChromium",baseline:"Chromium 同机同页"};
  await op.setTargets({author,id:"a",targets:[target]});
  const s=store.snapshot(),r=rules(s),c=q.context(s,r,"a"); assert.ok("targets" in c);
  assert.deepEqual(c.targets,["apollo11 样式计算耗时: 12 倍 Chromium (vs Chromium 同机同页) → ≤ 1 倍 Chromium, 2026-10-11"]);
  assert.deepEqual(q.brief(s,r,author).todo.find(row=>row.id==="a")!.targets,c.targets);
  assert.equal(q.describeChanges({}, {targets:[]},"item"),"metadata changed");
  assert.equal(q.describeChanges({}, {targets:s.items.a!.targets},"item"),"targets changed");
  assert.equal(q.describeChanges({targets:s.items.a!.targets},{targets:[{...s.items.a!.targets![0]!,current:"4 倍 Chromium"}]},"item"),"targets changed");
});


test("default lists omit done and cancelled items, while explicit status filters and plan rows retain them", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "done-result", owner: "a", title: "Finished result", accept: "Result passes" });
  await op.setPlan({ author, id: "done-result", row: { id: "accept", text: "Result passes", accept: true, state: "done" } });
  await op.createItem({ ...asArchitect, key: "cancelled-result", owner: "a", title: "Cancelled result", accept: "Result passes" });
  await op.setStatus({ ...asArchitect, id: "cancelled-result", status: "cancelled", log: "Superseded" });
  const s = store.snapshot(), r = rules(s);
  const visible = q.list(s, r).map(item => item.id);
  assert.ok(!visible.includes("done-result")); assert.ok(!visible.includes("cancelled-result"));
  assert.deepEqual(q.list(s, r, { status: ["done", "cancelled"] }).map(item => item.id), ["done-result", "cancelled-result"]);
  const plan = q.context(s, r, "a");
  assert.ok("plan" in plan && plan.plan.some(line => line.includes("Finished result")));
  assert.ok("plan" in plan && plan.plan.some(line => line.includes("Cancelled result")));
  assert.equal(q.context(s, r, "done-result").id, "done-result", "a hidden item can still be opened directly");
  const overview = q.overview(s, r).flatMap(project => project.areas);
  assert.ok(!overview.some(item => ["done-result", "cancelled-result"].includes(item.id)));
  assert.equal(overview.find(item => item.id === "area")!.counts.done, 1, "completion totals still include hidden work");
  assert.equal(overview.find(item => item.id === "area")!.counts.cancelled, 1);
});

test("paused items have explicit list, overview and project counts and are absent from brief work queues", async t => {
  const { store, op } = await board(t);
  await op.clearAsk({ author, id: "a", log: "Owner approval complete" });
  await op.setPlan({ author, id: "a", row: { id: "doing", text: "Implementation", state: "doing" } });
  await op.setPause({ ...asArchitect, id: "area", paused: true, reason: "After the next release" });
  const s = store.snapshot(), r = rules(s);
  assert.deepEqual(q.list(s, r, { group: author, status: ["paused"] }).map(row => row.id).sort(), ["a", "area", "b"]);
  assert.deepEqual(q.list(s, r, { group: author, status: ["wip", "todo", "blocked"] }), []);
  const area = q.overview(s, r, { group: author, status: ["paused"] })[0]!.areas[0]!;
  assert.equal(area.counts.paused, 2); assert.equal(area.counts.wip, 0); assert.equal(area.counts.blocked, 0);
  const project = q.projects(s, r).find(project => project.name === author)!;
  assert.equal(project.openItems.paused, 3); assert.equal(project.openItems.wip, 0);
  const brief = q.brief(s, r, author);
  assert.deepEqual(brief.paused.map(row => row.id).sort(), ["a", "area", "b"]);
  assert.deepEqual(brief.wip, []); assert.deepEqual(brief.todo, []);
  const context = q.context(s, r, "a");
  assert.ok("pausedBy" in context);
  assert.deepEqual(context.pausedBy, { id: "area", title: "解释器工作", reason: "After the next release", at: later });
});

test("describeChanges ignores a changed num, as it does rev and updated", () => {
  assert.equal(q.describeChanges({ title: "T", num: 3 }, { title: "T", num: 9 }, "item"), "metadata changed", "a num-only difference names no field");
  assert.equal(q.describeChanges({ title: "T", num: 3 }, { title: "U", num: 9 }, "item"), "title changed");
});
