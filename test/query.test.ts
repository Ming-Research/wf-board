import { test } from "node:test";
import assert from "node:assert/strict";
import { rules } from "../src/rules.ts";
import * as q from "../src/query.ts";
import { board, at, later, author } from "./helpers.ts";

test("search finds each Chinese field, ranks title/head/cards/logs/notes, marks snippets and filters", async t => {
  const { store } = await board(t), s = store.snapshot(), r = rules(s);
  const hits = q.search(s, r, "中文", { limit: 100 });
  assert.deepEqual(hits.map(h => `${h.kind}:${h.id}:${h.field}`), ["item:a:title", "item:a:head", "item:a:data", "item:a:ask", "card:choice:question", "card:choice:background", "card:choice:option.A", "card:ruled:ruling", "item:a:log[6]", "item:a:log[0]", "note:note-2:reply", "note:note-1:text"]);
  // One hit per field: log[0] matches twice and reports the second as `more`.
  assert.equal(hits.find(h => h.field === "log[0]")!.more, 1);
  for (const hit of hits) { assert.ok(hit.snippet.includes("«中文»")); assert.equal(hit.area, "解释器工作"); }
  assert.equal(hits[8]!.time, "2026-10-11T01:02:06Z");
  assert.equal(q.search(s, r, "WHITEFOOT", { kind: ["item"] })[0]!.id, "a");
  assert.equal(q.search(s, r, "中文", { limit: 2 }).length, 2);
  assert.deepEqual(q.search(s, r, "中文", { group: "Firn" }), []);
  assert.equal(q.search(s, r, "中文", { under: "a", kind: ["note"], since: later }).length, 1);
  assert.deepEqual(q.search(s, r, "中文", { status: ["blocked"] }), []);
  assert.throws(() => q.search(s, r, " "), /query/);
  assert.throws(() => q.search(s, r, "中文", { under: "missing" }), /under/);
  const long = { ...s, items: { ...s.items, a: { ...s.items.a!, head: "前".repeat(90) + "中文" + "后".repeat(90) } } };
  const snippet = q.search(long, rules(long), "中文", { kind: ["item"], limit: 100 }).find(h => h.field === "head")!.snippet;
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…")); assert.ok(snippet.length <= 86);
});

test("context includes relationships, page order, open/ruled cards, replies, checks, links, PRs and bounded logs", async t => {
  const { store, op } = await board(t);
  const leaf = q.context(store.snapshot(), rules(store.snapshot()), "a");
  // Neither a nor b is a root, so neither stores a priority; area (P1) is the only open root above them.
  const waiter = q.context(store.snapshot(), rules(store.snapshot()), "b");
  assert.ok("ancestors" in leaf && "ancestors" in waiter); assert.equal(leaf.migrated, true); assert.equal(leaf.raisedBy, null);
  assert.equal(leaf.item.priority, undefined); assert.equal(leaf.priority, "P1"); assert.equal(waiter.item.priority, undefined); assert.equal(waiter.priority, "P1");
  await op.createItem({ author, key: "child-low", parent: "a", parentWhy: "Low priority evidence", title: "Low", order: 0, parentOwnWork: { key: "a-own", title: "a own work" } });
  await op.createItem({ author, key: "child-high", parent: "a", parentWhy: "High priority evidence", title: "High", order: 5 });
  const s = store.snapshot(), r = rules(s), c = q.context(s, r, "a");
  assert.ok("children" in c);
  assert.equal(c.item.title, "中文检查"); assert.equal(c.item.rev, 3);
  // a is not a root, so the split drops its ignored stored priority and the own-work sub-item takes none.
  assert.equal(c.item.priority, undefined); assert.equal(s.items["a-own"]!.priority, undefined); assert.equal(c.priority, "P1");
  assert.equal(c.item.log.length, 5); assert.equal(c.earlierLogs, 3); // 7 seeded + the first-child entry
  assert.deepEqual(c.ancestors.map(it => it.id), ["area"]);
  assert.deepEqual(c.children.map(it => [it.id, it.priority]), [["child-low", "P1"], ["a-own", "P1"], ["child-high", "P1"]]); // inherited priority ties, so page order breaks the tie
  assert.ok(c.deps.some(d => d.id === "child-high" && d.why === "High priority evidence"));
  assert.deepEqual(c.dependents.map(d => [d.id, d.why]), [["area", "需要检查结果"], ["b", "需要检查"]]);
  const open = c.cards.find(card => card.key === "choice")!;
  assert.ok("background" in open); assert.equal(open.background, "中文背景 Whitefoot PR #341"); assert.equal(open.options.length, 2);
  const ruled = c.cards.find(card => card.key === "ruled")!;
  assert.equal(ruled.ruling, "中文裁决"); assert.equal("background" in ruled, false);
  assert.equal(c.notes.length, 2); assert.equal(c.notes[0]!.reply, "中文回复");
  assert.equal(c.links[0]!.label, "Pull request"); assert.deepEqual(c.prs.qualified, [{ repo: "Whitefoot", number: 341 }]);
  const all = q.context(s, r, "a", { log: "all" }), none = q.context(s, r, "a", { log: 0 });
  assert.ok("earlierLogs" in all && "earlierLogs" in none); assert.equal(all.earlierLogs, 0); assert.equal(none.earlierLogs, 8);
  const card = q.context(s, r, "choice"); assert.equal(card.kind, "card");
  assert.equal(card.card!.confidence!.score, 4); assert.equal(card.item.title, "中文检查"); assert.equal(card.notes[0]!.id, "note-2");
  assert.throws(() => q.context(s, r, "missing"), /Unknown id/);
  await op.setStatus({ author, id: "b", status: "wip", log: "Parallel work" });
  const checked = q.context(store.snapshot(), rules(store.snapshot()), "b");
  assert.ok("checks" in checked); assert.ok(checked.checks.some(c => c.text.includes("进行中")));
});

test("latest five context notes include notes on cards and item, not other targets", async t => {
  const { store } = await board(t);
  await store.commit({ author, message: "More notes", puts: Array.from({ length: 6 }, (_, i) => ({ kind: "note" as const, id: `extra-${i}`, expectRev: null, doc: { target: i === 5 ? "it:other" : "q:choice", kind: "comment", text: `Note ${i}`, at: `2026-10-12T00:00:0${i}Z`, state: "sent" } })) });
  const c = q.context(store.snapshot(), rules(store.snapshot()), "a");
  assert.deepEqual(c.notes.map(n => n.id), ["extra-4", "extra-3", "extra-2", "extra-1", "extra-0"]);
});

test("graph follows up/down item and card deps, marks cycles and open blocked chains, bounds depth", async t => {
  const { store, op } = await board(t);
  await op.updateItem({ author, id: "a", rev: 1, deps: [{ id: "b", why: "Cycle witness" }] });
  const s = store.snapshot(), r = rules(s), g = q.graph(s, r, "a", { direction: "both", depth: 4 });
  const upB = g.up!.next.find(n => n.id === "b")!;
  assert.equal(upB.why, "Cycle witness"); assert.equal(upB.status, "blocked"); assert.equal(g.up!.blockedChain, true);
  assert.equal(upB.next.find(n => n.id === "a")!.cycle, true);
  assert.equal(upB.next.find(n => n.id === "choice")!.kind, "card");
  assert.equal(upB.next.find(n => n.id === "choice")!.blockedChain, true);
  const downB = g.down!.next.find(n => n.id === "b")!;
  assert.equal(downB.why, "需要检查"); assert.equal(downB.next.find(n => n.id === "a")!.cycle, true);
  assert.equal(q.graph(s, r, "choice", { direction: "down" }).down!.next[0]!.id, "b");
  assert.equal(q.graph(s, r, "b", { direction: "down" }).down!.next.find(n => n.id === "a")!.blockedChain, true);
  const limited = q.graph(s, r, "a", { direction: "up", depth: 0 });
  assert.equal(limited.up!.truncated, true); assert.deepEqual(limited.up!.next, []);
});

test("overview/list/notes honor derived statuses, priority from dependents, inheritance and each filter", async t => {
  const { store, op } = await board(t);
  await op.setStatus({ author, id: "a", status: "wip", log: "Started" });
  const s = store.snapshot(), r = rules(s), areas = q.overview(s, r, { group: "Whitefoot" })[0]!.areas;
  assert.equal(areas.length, 1); assert.deepEqual(areas[0]!.counts, { todo: 0, wip: 1, blocked: 1, done: 0, cancelled: 0 });
  assert.deepEqual(areas[0]!.ownerActions.map(it => it.id), ["a"]); assert.deepEqual(areas[0]!.blocked.map(it => it.id), ["b"]);
  assert.deepEqual(q.list(s, r, { under: "area", status: ["blocked"], priority: ["P1"], group: "Whitefoot" }).map(it => it.id), ["b"]);
  assert.deepEqual(q.list(s, r, { priority: ["P0"] }), []); // b's stored P0 is ignored: area depends on it
  assert.deepEqual(q.list(s, r, { needsOwner: true }).map(it => it.id), ["a"]);
  // The fixture's heads state no completion condition.
  assert.deepEqual(q.list(s, r, { hasChecks: true }).map(it => [it.id, it.checks.map(c => c.text)]), ["area", "a", "b", "other"].map(id => [id, ["正文没写完成条件"]]));
  assert.equal(q.list(s, r, { group: "Firn", limit: 1 })[0]!.id, "other");
  assert.deepEqual(q.list(s, r, { updatedSince: "2999-01-01T00:00:00Z" }), []);
  assert.equal(q.notes(s, { state: ["sent"], kind: ["comment"], under: "area", since: at, limit: 1 })[0]!.id, "note-1");
  assert.deepEqual(q.notes(s, { under: "other" }), []);
});

test("PR index separates qualified text, links, cards, notes and bare refs, avoids number-prefix matches", async t => {
  const { store } = await board(t), s = store.snapshot(), r = rules(s);
  const prs = q.prs(s, r, "Whitefoot", 341);
  assert.deepEqual(prs.qualified.map(it => `${it.kind}:${it.id}`), ["item:a", "card:choice", "note:note-1"]);
  assert.deepEqual(prs.unknown.map(it => `${it.kind}:${it.id}`), ["item:b", "note:note-2"]);
  assert.deepEqual(q.prs(s, r, "Whitefoot", 34), { qualified: [], unknown: [] });
  const repos = new Set(["whitefoot", "other"]);
  assert.deepEqual(q.references("Whitefoot#341 Whitefoot #341 Whitefoot PR #341 https://github.com/Ming-Research/Whitefoot/pull/341 #341 #34 Other #3410", repos), { qualified: [{ repo: "Whitefoot", number: 341 }, { repo: "Other", number: 3410 }], unknown: [341, 34] });
  // A word before #N names a repository only when the board links to it.
  assert.deepEqual(q.references("see #341, Whitefoot #7", repos), { qualified: [{ repo: "Whitefoot", number: 7 }], unknown: [341] });
});

test("changes summarizes net fields over commits, groups areas, and history/diff reproduce evidence", async t => {
  const { store, op } = await board(t), baseline = store.snapshot().head;
  await op.setStatus({ author, id: "a", status: "wip", log: "Started" });
  await op.updateItem({ author, id: "a", rev: 2, head: "New stable context", reason: "Scope clarified" });
  await op.replyNote({ author, id: "note-1", reply: "Resolved" });
  await op.createItem({ author: "Firn", key: "new", parent: "other", parentWhy: "Evidence", title: "New witness", parentOwnWork: { key: "other-own", title: "other own work" } });
  await op.ruleCard({ author, key: "choice", choice: "A", ruling: "Owner picked A" });
  const s = store.snapshot(), changes = await q.changes(store, s, baseline);
  const whitefoot = changes.find(g => g.areaId === "area")!;
  const item = whitefoot.documents.find(d => d.id === "a")!;
  assert.equal(item.summary, "status todo→wip, head changed, +2 log");
  assert.deepEqual(item.commits.map(c => c.message), ["set_status a wip", "update_item a"]);
  assert.ok(item.commits.every(c => c.author === author && c.at.endsWith("Z")));
  assert.match(whitefoot.documents.find(d => d.id === "note-1")!.summary, /new reply/);
  assert.match(whitefoot.documents.find(d => d.id === "choice")!.summary, /status open→ruled/);
  assert.equal(changes.find(g => g.areaId === "other")!.documents.find(d => d.id === "new")!.summary, "new item");
  assert.deepEqual((await q.changes(store, s, baseline, { group: "Firn" })).map(g => g.areaId), ["other"]);
  assert.ok((await q.changes(store, s, baseline, { under: "a" }))[0]!.documents.every(d => ["a", "choice", "note-1"].includes(d.id)));
  assert.deepEqual(await q.changes(store, s, "2999-01-01T00:00:00Z"), []);
  assert.equal((await q.history(store, "item", "a", 1))[0]!.message, "update_item a");
  const diff = await q.diff(store, "item", "a", baseline, s.head);
  assert.match(diff, /\+status: wip/); assert.match(diff, /\+head: New stable context/);
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

test("created-then-deleted items, cards and notes retain intermediate identity and ownership in changes", async t => {
  const { store, op } = await board(t), baseline = store.snapshot().head;
  await op.createItem({ author, key: "temporary", parent: "area", parentWhy: "Temporary witness", title: "Temporary item" });
  await op.writeCard({ author, key: "temporary-card", item: "temporary", question: "Temporary question?", background: "Evidence", options: [{ key: "A", text: "A" }] });
  await store.commit({ author, message: "Temporary note", puts: [{ kind: "note", id: "temporary-note", expectRev: null, doc: { target: "q:temporary-card", kind: "comment", text: "Temporary note", at, state: "sent" } }] });
  await store.commit({ author, message: "Delete temporary documents", deletes: [
    { kind: "item", id: "temporary", expectRev: 1 }, { kind: "decision", id: "temporary-card", expectRev: 1 }, { kind: "note", id: "temporary-note", expectRev: 1 },
  ] });
  const changed = await q.changes(store, store.snapshot(), baseline, { group: "Whitefoot" });
  assert.equal(changed.length, 1); assert.equal(changed[0]!.areaId, "area");
  const docs = changed[0]!.documents.filter(d => d.id.startsWith("temporary"));
  assert.deepEqual(docs.map(d => [d.kind, d.title, d.summary]), [["item", "Temporary item", "created and deleted item"], ["card", "Temporary question?", "created and deleted card"], ["note", "Temporary question?", "created and deleted note"]]);
  assert.ok(docs.every(d => d.commits.length === 2));
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
  // "Whitefoot PR #341" (card) and "Whitefoot #341" (note) to it, and b's bare #341 to an unknown repository.
  const pr = q.search(s, r, "Whitefoot#341", { limit: 50 }).filter(h => h.field === "pr");
  assert.deepEqual(pr.filter(h => h.snippet === "«Whitefoot#341»").map(h => `${h.kind}:${h.id}`).sort(), ["card:choice", "item:a", "note:note-1"]);
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

test("project brief and projects include inbox, sent notes, checks, work and outgoing requests", async t => {
  const {store,op} = await board(t);
  await op.createRequest({author:"Firn",project:"Whitefoot",key:"incoming",title:"Incoming",head:"Detail",priority:"P0",why:"Need help"});
  await op.createRequest({author,project:"Firn",key:"outgoing",title:"Outgoing",head:"Detail",why:"Need feature",from:"a"});
  await op.setStatus({author,id:"a",status:"done",log:"Ready"});
  await op.ruleCard({author,key:"choice",choice:"A",ruling:"Chosen"});
  await store.commit({author:"Fixture",message:"Card note and work",puts:[
    {kind:"note",id:"sent-card",expectRev:null,doc:{target:"q:choice",kind:"done",text:"Card handled?",state:"sent",at,sentAt:at}},
    ...Array.from({length:12},(_,i)=>({kind:"item" as const,id:`todo-${i}`,expectRev:null,doc:{title:`Todo ${i}`,group:"Whitefoot",status:"todo",priority:i===11?"P0":"P2",updated:at}})),
    {kind:"item",id:"working",expectRev:null,doc:{title:"Working",group:"Whitefoot",status:"wip",priority:"P1",updated:at}},
  ]});
  await op.writeCard({author,key:"open-card",item:"working",question:"Choose?",background:"Why",options:[{key:"A",text:"A"}]});
  const s = store.snapshot(), r = rules(s);
  const brief = q.brief(s,r,"Whitefoot");
  assert.equal(Object.hasOwn(brief,"agents"),false);
  assert.deepEqual(brief.inbox.map(x=>({id:x.id,by:x.by,why:x.why})),[{id:"incoming",by:"Firn",why:"Need help"}]);
  assert.deepEqual(brief.notes.map(x=>x.id).sort(),["note-1","sent-card"]);
  assert.equal(brief.notes.find(x=>x.id==="sent-card")!.title,"中文方案？");
  assert.ok(brief.checks.some(x=>x.id==="b" && x.checks.some(c=>c.text.startsWith("可解除阻塞"))));
  assert.deepEqual(brief.cards.map(x=>x.id),["open-card"]);
  assert.deepEqual(brief.wip.map(x=>x.id),["working"]);
  assert.equal(brief.todo.length,10); assert.equal(brief.todo[0]!.id,"todo-11");
  assert.deepEqual(brief.outgoing.map(x=>x.id),["outgoing"]);
  const project = q.projects(s,r)[0]!;
  assert.equal(project.repo,"Ming-Research/Whitefoot"); assert.equal(project.inbox,1); assert.equal(project.areas,14);
  assert.deepEqual(project.openLeaves,{todo:12,wip:1,blocked:1});
  assert.throws(()=>q.brief(s,r,"Missing"),/project/);
  assert.ok(q.list(s,r,{group:author}).every(x=>x.group===author));
});

test("project followups use strict age boundary and omit drafts, replies, closures and triaged requests", async t => {
  const {store,op} = await board(t);
  await op.createRequest({author,project:"Firn",key:"old-request",title:"Old",head:"Detail",priority:"P1",why:"Need"});
  await op.createRequest({author,project:"Firn",key:"handled-request",title:"Handled",head:"Detail",priority:"P1",why:"Need"});
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
  await t.test("projects output", () => assert.deepEqual(q.projects(s, r)[0], { name: "Whitefoot", repo: "Ming-Research/Whitefoot", migrated: true, areas: 1, openLeaves: { todo: 1, wip: 0, blocked: 1 }, inbox: 0 }));
});

test("records are labeled separately in query rows and absent from status queues; stalled leaves appear in hasChecks", async t => {
  const { store, op } = await board(t);
  await op.createItem({ author, key: "record", group: author, title: "Queue", priority: "P1", record: true });
  const s = structuredClone(store.snapshot()), now = Date.parse("2026-10-11T06:00:00Z");
  s.items.a!.status = "wip"; s.items.a!.ask = undefined; s.decisions = {}; s.notes = {};
  s.activity = { writes: Array.from({length: 7}, (_, i) => new Date(now - i * 30 * 60 * 1000).toISOString()), items: {} };
  const r = rules(s, now), record = q.row(s, r, "item", "record");
  assert.equal(record.record, true); assert.equal(record.status, undefined);
  assert.ok(!q.list(s, r, {status: ["todo", "wip", "blocked", "done", "cancelled"]}).some(v => v.id === "record"));
  assert.ok(!q.brief(s, r, author).todo.some(v => v.id === "record"));
  const flagged = q.list(s, r, {hasChecks: true}).find(v => v.id === "a");
  assert.ok(flagged?.checks.some(c => c.text.includes("活跃时间")));
});
