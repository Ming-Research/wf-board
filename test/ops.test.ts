import { test } from "node:test";
import assert from "node:assert/strict";
import { ops, OpError } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import type { Ops, Result } from "../src/ops.ts";
import { Store } from "../src/store.ts";
import type { Txn } from "../src/store.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { board, at, later, author } from "./helpers.ts";

const goalNumbers = { id: "style", goal: "apollo11 样式计算耗时", target: "≤ 1 倍 Chromium", current: "12 倍 Chromium", baseline: "Chromium 同机同页" };

test("creation, revision, dependency, status, movement and card checks name a fix and leave the board unchanged", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const create = { author, key: "new", owner: "area", title: "New", accept: "New result passes" };
  const card = { author, key: "new-card", item: "a", question: "Choose?", background: "Why", options: [{ key: "A", text: "A" }] };
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.createItem({ ...create, key: "../escape" }), /key.*use/],
    [() => op.createItem({ ...create, key: "a" }), /key.*new/],
    [() => op.createItem({ ...create, key: "choice" }), /key.*new/],
    [() => op.createItem({ ...create, owner: undefined, priority: "P1" }), /group.*requires/],
    [() => op.createItem({ ...create, owner: "missing" }), /owner.*existing/],
    [() => op.createItem({ ...create, accept: undefined }), /accept.*required/],
    [() => op.createItem({ ...create, plan: [{ item: "missing", own: false }] }), /依赖的条目不存在.*missing.*set_plan.*remove or replace/],
    [() => op.createItem({ ...create, plan: [{ card: "missing" }] }), /依赖的决策卡不存在.*missing.*set_plan.*remove or replace/],
    [() => op.updateItem({ author, id: "a", rev: 0, title: "Bad" }), /rev.*positive.*context/],
    [() => op.updateItem({ author, id: "a", rev: 1, head: "Changed" }), /reason.*explain.*head/],
    [() => op.updateItem({ author, id: "a", rev: 1, links: [{ label: "Invalid", url: "invalid" }] }), /links.*fix/],
    [() => op.updateItem({ author, id: "a", rev: 1, order: 2 }), /order.*only top items.*plan/],
    [() => op.setPlan({ author, id: "a", row: { card: "missing" } }), /依赖的决策卡不存在.*missing.*set_plan.*remove or replace/],
    [() => op.setPlan({ author, id: "other", row: { item: "a", own: true } }), /被多个条目拥有.*current owner area.*move_item/],
    [() => op.setPlan({ author, id: "area", remove: "a" }), /a is open.*move_item or cancel/],
    [() => op.setPlan({ author, id: "a", row: { id: "later", text: "Later work", state: "todo", after: ["accept"] } }), /after.*earlier/],
    [() => op.setPlan({ author, id: "a", row: { id: "drop", text: "Dropped work", state: "dropped" } }), /reason.*fix/],
    [() => op.setStatus({ author, id: "area", status: "done", log: "Done" } as unknown as Parameters<Ops["setStatus"]>[0]), /status.*only cancelled or open.*derived from the plan/],
    [() => op.setStatus({ author, id: "other", status: "blocked", log: "Wait" } as unknown as Parameters<Ops["setStatus"]>[0]), /status.*only cancelled or open.*derived from the plan/],
    [() => op.setStatus({ author, id: "area", status: "cancelled", log: "Drop" }), /owned items.*a.*b.*cancel or move each part first/],
    [() => op.setStatus({ author, id: "a", status: "open", log: "Resume" }), /only a cancelled item can be reopened/],
    [() => op.moveItem({ author, id: "a", owner: "a" }), /依赖成环.*set_plan or move_item.*remove/],
    [() => op.moveItem({ author, id: "area", owner: "a" }), /依赖成环.*set_plan or move_item.*remove/],
    [() => op.moveItem({ author, id: "a", owner: "missing" }), /owner.*existing/],
    [() => op.moveItem({ author, id: "a", owner: "other", priority: "P2" }), /priority.*refused with owner/],
    [() => op.writeCard({ ...card, key: "a" }), /key.*new/],
    [() => op.writeCard({ ...card, key: "choice" }), /key.*new/],
    [() => op.writeCard({ ...card, options: [] }), /options.*fix/],
    [() => op.writeCard({ ...card, options: [{ key: "A", text: "A" }, { key: "A", text: "B" }] }), /options.key.*unique/],
    [() => op.writeCard({ ...card, options: [{ key: "A", text: "A", recommended: true }, { key: "B", text: "B", recommended: true }] }), /recommended.*at most one/],
    [() => op.writeCard({ ...card, confidence: { score: 6, reason: "Evidence" } }), /confidence.score.*fix/],
    [() => op.writeCard({ ...card, key: "ruled", rev: 1 }), /status.*open card.*create a new card/],
    [() => op.ruleCard({ author, key: "ruled", ruling: "Again" }), /status.*open card/],
    [() => op.ruleCard({ author, key: "choice", choice: "C", ruling: "Bad option" }), /choice.*option key.*omit choice/],
    [() => op.appendLog({ author: "bad\nname", id: "a", text: "Bad author" }), /author.*newlines/],
  ];
  for (const [call, message] of cases) {
    const before = store.snapshot(), count = (await store.log()).length;
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before,"a refusal leaves the complete in-memory board untouched");
    assert.deepEqual((await Store.open(dir)).snapshot(), before,"a refusal leaves every stored document and owner state untouched");
    assert.equal(store.snapshot().head,before.head); assert.equal((await store.log()).length,count,"a refusal makes no commit");
  }
});

test("each operation records its effects, author and single atomic commit", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  async function committed(call: () => Promise<Result>, message: string, files: string[], kind: "item" | "decision" | "note", id: string) {
    const count = (await store.log()).length, previous = store.snapshot().head, result = await call(), after = store.snapshot(), log = await store.log({ limit: 1 });
    const doc = kind === "item" ? after.items[id]! : kind === "decision" ? after.decisions[id]! : after.notes[id]!;
    assert.equal((await store.log()).length,count+1,"all document effects enter one atomic commit");
    assert.notEqual(after.head,previous); assert.equal(result.commit,after.head); assert.equal(result.commit,log[0]!.commit);
    assert.deepEqual(result,{commit:after.head,id,rev:doc.rev,summary:message},"the result names the revision and commit actually produced");
    assert.equal(log[0]!.author,author); assert.equal(log[0]!.message,message);
    assert.deepEqual(log[0]!.files.slice().sort(),files.slice().sort(),"the commit contains every effect and no unrelated document");
    assert.deepEqual(await store.show(kind,id,result.commit),doc,"the returned revision is stored in that exact commit");
    assert.deepEqual((await Store.open(dir)).snapshot(),after,"all atomic effects survive reopen");
  }
  const itemCommit = (call: () => Promise<Result>, message: string, files=["items/new.yaml"]) => committed(call,message,files,"item","new");
  await itemCommit(() => op.createItem({ author, key: "new", owner: "area", title: "New", head: "Stable", accept: "New result passes", plan: [{id:"work",text:"Deliver result",state:"todo"}], links: [], data: "4 cases" }),"create_item new",["items/new.yaml","items/area.yaml"]);
  assert.deepEqual(store.snapshot().items.area!.plan.find(row=>row.id === "new"),{id:"new",item:"new",own:true});
  const created=store.snapshot().items.new!; assert.equal(created.created,later); assert.equal(created.updated,later); assert.equal(rules(store.snapshot()).statusOf("new"),"todo");
  assert.deepEqual(created.plan,[{id:"work",text:"Deliver result",state:"todo"},{id:"accept",accept:true,text:"New result passes",state:"todo"}]);
  await itemCommit(() => op.appendLog({ author, id: "new", text: "Evidence" }),"append_log new");
  assert.deepEqual(store.snapshot().items.new!.log[0],{at:later,by:author,text:"Evidence"});
  await itemCommit(() => op.updateItem({ author, id: "new", rev: 2, head: "Revised", reason: "Scope settled", title: "Revised title", links: [{label:"PR",url:"https://github.com/Ming-Research/Whitefoot/pull/1"}], data: null }),"update_item new");
  const revised=store.snapshot().items.new!; assert.equal(revised.head,"Revised"); assert.equal(revised.title,"Revised title"); assert.equal(revised.data,undefined); assert.equal(Object.hasOwn(revised,"agent"),false);
  assert.deepEqual(revised.plan,created.plan); assert.deepEqual(revised.log.at(-1),{at:later,by:author,text:"改了 head：Scope settled"});
  await committed(() => op.updateItem({author,id:"other",rev:store.snapshot().items.other!.rev,order:2}),"update_item other",["items/other.yaml"],"item","other");
  assert.equal(store.snapshot().items.other!.order,2,"top-item order remains editable while owned order is the plan's");
  await itemCommit(() => op.setPlan({ author, id: "new", row: {card:"choice",after:[]} }),"set_plan new");
  assert.deepEqual(store.snapshot().items.new!.plan.map(row=>row.id),["work","choice","accept"]);
  await itemCommit(() => op.setTargets({ author, id: "new", target: goalNumbers }),"set_targets new");
  assert.deepEqual(store.snapshot().items.new!.targets,[{...goalNumbers,date:later}]);
  await itemCommit(() => op.setPlan({ author, id: "new", row: {id:"work",text:"Deliver result",state:"doing"} }),"set_plan new");
  assert.equal(rules(store.snapshot()).statusOf("new"),"wip");
  await itemCommit(() => op.setPlan({ author, id: "new", row: {id:"work",text:"Deliver result",state:"done"} }),"set_plan new");
  assert.equal(rules(store.snapshot()).statusOf("new"),"blocked");
  const waiting=store.snapshot().items.new!;
  await store.commit({author:"Fixture",message:"Legacy ask",puts:[{kind:"item",id:"new",expectRev:waiting.rev,doc:{...waiting,ask:{text:"Approve",url:"https://example.com/approve",chat:true}}}]});
  const beforeCancel=store.snapshot().items.new!;
  await itemCommit(() => op.setStatus({ author, id: "new", status: "cancelled", log: "Superseded" }),"set_status new cancelled");
  assert.equal(rules(store.snapshot()).statusOf("new"),"cancelled"); assert.deepEqual(store.snapshot().items.new!.plan,beforeCancel.plan); assert.deepEqual(store.snapshot().items.new!.ask,beforeCancel.ask);
  assert.deepEqual(store.snapshot().items.new!.log.at(-1),{at:later,by:author,text:"Superseded"});
  await itemCommit(() => op.setStatus({ author, id: "new", status: "open", log: "Resume" }),"set_status new open");
  assert.equal(store.snapshot().items.new!.status,undefined); assert.equal(rules(store.snapshot()).statusOf("new"),"blocked");
  await itemCommit(() => op.clearAsk({ author, id: "new", log: "Owner approved" }),"clear_ask new");
  assert.equal(store.snapshot().items.new!.ask,undefined); assert.equal(store.snapshot().items.new!.log.at(-1)!.text,"Owner approved");
  await itemCommit(() => op.moveItem({ author, id: "new", owner: "other" }),"move_item new",["items/new.yaml","items/area.yaml","items/other.yaml"]);
  const moved=store.snapshot(); assert.equal(rules(moved).parentOf("new"),"other"); assert.ok(!moved.items.area!.plan.some(row=>row.id === "new"));
  assert.deepEqual(moved.items.other!.plan.find(row=>row.id === "new"),{id:"new",item:"new",own:true});
  assert.match(moved.items.area!.log.at(-1)!.text,/Revised title.*其他项目/); assert.match(moved.items.other!.log.at(-1)!.text,/Revised title/); assert.match(moved.items.new!.log.at(-1)!.text,/解释器工作.*其他项目/);
  const cardCommit=(call: () => Promise<Result>,message:string,key="new-card")=>committed(call,message,["decisions/"+key+".yaml"],"decision",key);
  await cardCommit(() => op.writeCard({author,key:"new-card",item:"new",question:"Choose?",background:"Evidence",options:[{key:"A",text:"A",recommended:true}],confidence:{score:3,reason:"Exploratory"}}),"write_card new-card");
  const originalAt=store.snapshot().decisions["new-card"]!.at;
  await cardCommit(() => op.writeCard({author,key:"new-card",rev:1,item:"new",question:"Choose revised?",background:"More evidence",options:[{key:"B",text:"B"}]}),"write_card new-card");
  assert.equal(store.snapshot().decisions["new-card"]!.at,originalAt);
  await cardCommit(() => op.ruleCard({author,key:"new-card",choice:"B",ruling:"Owner picked B"}),"rule_card new-card");
  assert.equal(store.snapshot().decisions["new-card"]!.choice,"B"); assert.equal(store.snapshot().decisions["new-card"]!.ruledAt,later);
  await cardCommit(() => op.ruleCard({author,key:"choice",choice:"A",ruling:"Required result settled"}),"rule_card choice","choice");
  await itemCommit(() => op.setPlan({author,id:"new",row:{id:"accept",accept:true,text:"New result passes",state:"done"}}),"set_plan new");
  assert.equal(rules(store.snapshot()).statusOf("new"),"done");
  await committed(() => op.replyNote({author,id:"note-1",reply:"Answer"}),"reply_note note-1",["notes/note-1.yaml"],"note","note-1");
  assert.deepEqual(store.snapshot().notes["note-1"],{target:"it:a",kind:"comment",text:"中文意见 Whitefoot #341",at,sentAt:at,state:"done",reply:"Answer",repliedAt:later,repliedBy:author,rev:2});
});

test("stale item/card revisions summarize intervening changes and never overwrite", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.appendLog({ author, id: "a", text: "Concurrent evidence" });
  const before = store.snapshot();
  await assert.rejects(op.updateItem({ author, id: "a", rev: 1, title: "Stale" }), /rev 1: current rev 2; \+1 log.*redo.*rev 2/);
  assert.deepEqual(store.snapshot(), before);
  const args = { author, key: "choice", item: "a", question: "Changed?", background: "Changed", options: [{ key: "A", text: "A" }] };
  await op.writeCard({ ...args, rev: 1 });
  const cardBefore = store.snapshot();
  await assert.rejects(op.writeCard({ ...args, rev: 1 }), /current rev 2.*question changed.*background changed/);
  assert.deepEqual(store.snapshot(), cardBefore);
});

test("concurrent appends across Ops instances and a genuine store conflict lose no entries", async t => {
  const { store, op } = await board(t, { sharedProjects: true }), second = ops(store, () => later);
  await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? op : second).appendLog({ author, id: "a", text: `Concurrent ${i}` })));
  assert.deepEqual(store.snapshot().items.a!.log.slice(7).map(e => e.text).sort(), Array.from({ length: 10 }, (_, i) => `Concurrent ${i}`).sort());
  const original = store.commit.bind(store);
  let raced = false;
  t.mock.method(store, "commit", async (txn: Txn) => {
    if (!raced) {
      raced = true;
      const current = store.snapshot().items.a!;
      await original({ author: "Direct writer", message: "Concurrent direct append", puts: [{ kind: "item", id: "a", expectRev: current.rev, doc: { ...current, log: [...current.log, { at: later, text: "Direct evidence" }] } }] });
    }
    return original(txn);
  });
  await op.appendLog({ author, id: "a", text: "Retried evidence" });
  assert.ok(raced); assert.deepEqual(store.snapshot().items.a!.log.slice(-2).map(e => e.text), ["Direct evidence", "Retried evidence"]);
});

test("an update racing a Store write returns an OpError with current revision and actual changes", async t => {
  const { store, op } = await board(t, { sharedProjects: true }), original = store.commit.bind(store);
  let raced = false;
  t.mock.method(store, "commit", async (txn: Txn) => {
    if (!raced) {
      raced = true;
      const current = store.snapshot().items.a!;
      await original({ author: "Direct writer", message: "Intervening title", puts: [{ kind: "item", id: "a", expectRev: 1, doc: { ...current, title: "Intervening title" } }] });
    }
    return original(txn);
  });
  await assert.rejects(op.updateItem({ author, id: "a", rev: 1, title: "Would overwrite" }), e => {
    assert.ok(e instanceof OpError); assert.match(e.message, /current rev 2; title changed.*redo.*rev 2/); return true;
  });
  assert.equal(store.snapshot().items.a!.title, "Intervening title");
  assert.equal((await store.log({ kind: "item", id: "a" })).length, 2);
  await op.appendLog({ author, id: "a", text: "Queue recovered" });
  assert.equal(store.snapshot().items.a!.log.at(-1)!.text, "Queue recovered");
});

test("R4 concurrent replies refuse replacement unless explicitly requested", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  const results = await Promise.allSettled([
    op.replyNote({ author, id: "note-1", reply: "First answer" }),
    ops(store, () => later).replyNote({ author, id: "note-1", reply: "Second answer" }),
  ]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected"]);
  assert.match(String((results[1] as PromiseRejectedResult).reason), /Whitefoot.*2026-10-11T02:03:04Z/);
  assert.equal(store.snapshot().notes["note-1"]!.reply, "First answer");
  await op.replyNote({ author, id: "note-1", reply: "Correction", replace: true });
  assert.equal(store.snapshot().notes["note-1"]!.reply, "Correction");
  assert.equal((await store.log({ kind: "note", id: "note-1" })).length, 3);
});

test("project closeNote handles sent card/item notes atomically and refuses drafts", async t => {
  const {store,op} = await board(t);
  for (const target of ["it:a","q:choice"]) {
    const id = target === "it:a" ? "close-item" : "close-card";
    await store.commit({author:"Fixture",message:"Note",puts:[{kind:"note",id,expectRev:null,doc:{target,kind:"done",text:"Done",state:"draft",at}}]});
    const before = store.snapshot();
    await assert.rejects(op.closeNote({author,id,log:"Handled"}),/draft/); assert.deepEqual(store.snapshot(),before);
    await store.commit({author:"Fixture",message:"Send",puts:[{kind:"note",id,expectRev:1,doc:{...before.notes[id],state:"sent",sentAt:at}}]});
    const count = (await store.log()).length;
    await op.closeNote({author,id,log:"Handled"});
    assert.equal((await store.log()).length,count+1);
    assert.deepEqual(store.snapshot().notes[id],{...before.notes[id],rev:3,state:"done",sentAt:at,repliedBy:author,repliedAt:later});
    assert.equal(store.snapshot().items.a!.log.at(-1)!.text,"关闭评论：Handled");
    await op.closeNote({author,id,log:"Recorded follow-up"});
    assert.equal(store.snapshot().notes[id]!.state,"done");
    assert.equal(store.snapshot().items.a!.log.at(-1)!.text,"关闭评论：Recorded follow-up");
  }
});

test("project creation accepts any author and repo updates require the project or coordinator", async t => {
  const { store, op, dir } = await board(t);
  await op.createProject({ author: "Unconfigured caller", name: "New project", repo: "Org/New" });
  assert.deepEqual(store.snapshot().board.projects.at(-1), { name: "New project", repo: "Org/New" });
  await assert.rejects(op.createProject({ author: "Unconfigured caller", name: "New project" }), /already/);
  await op.createProject({ author: "Unconfigured caller", name: "No repository" });
  assert.deepEqual(store.snapshot().board.projects.at(-1), { name: "No repository" });
  const before = store.snapshot();
  for (const writer of ["Firn", "Outsider"]) {
    await assert.rejects(op.updateProject({ author: writer, name: "Whitefoot", repo: "Org/Changed" }), e => {
      assert.ok(e instanceof OpError); assert.match(e.message, /project Whitefoot/);
      if (writer === "Outsider") assert.match(e.message, /configured project.*call projects.*repo.*repository/);
      return true;
    });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
  }
  await op.updateProject({ author: "No repository", name: "No repository", repo: "Org/First" });
  assert.deepEqual(store.snapshot().board.projects.at(-1), { name: "No repository", repo: "Org/First" });
  await op.updateProject({ author: "Whitefoot", name: "Whitefoot", repo: "Org/Changed" });
  assert.equal(store.snapshot().board.projects[0]!.repo, "Org/Changed");
  assert.equal((await store.log({ limit: 1 }))[0]!.message, "update_project Whitefoot");
  await op.updateProject({ author: "总管", name: "Whitefoot", repo: "Org/Coordinated" });
  assert.equal(store.snapshot().board.projects[0]!.repo, "Org/Coordinated");
  assert.equal((await store.log({ limit: 1 }))[0]!.author, "总管");
  const unchanged = store.snapshot();
  await assert.rejects(op.updateProject({ author: "Whitefoot", name: "Missing", repo: "Org/Missing" }), /project Missing.*configured/);
  assert.deepEqual(store.snapshot(), unchanged);
  await op.createItem({ author: "New project", key: "new-area", title: "Area", accept: "Pass", group: "New project", priority: "P2" });
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("总管 reorders and creates projects after an existing project in one commit, while omitted after preserves defaults", async t => {
  const { store, op, dir } = await board(t);
  const names = () => store.snapshot().board.projects.map(p => p.name);
  const initial = store.snapshot();
  let count = (await store.log()).length;
  await op.updateProject({ author: "总管", name: "Whitefoot", after: "Firn" });
  assert.deepEqual(names(), ["Firn", "Whitefoot", "总管"]);
  assert.deepEqual(store.snapshot().items, initial.items);
  assert.equal((await store.log()).length, ++count);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files, ["board.yaml"]);
  await op.updateProject({ author: "总管", name: "总管", repo: "Org/Coordinator", after: "Firn" });
  assert.deepEqual(names(), ["Firn", "总管", "Whitefoot"]);
  assert.equal(store.snapshot().board.projects[1]!.repo, "Org/Coordinator");
  assert.equal((await store.log()).length, ++count);
  await op.createProject({ author: "总管", name: "Inserted", repo: "Org/Inserted", after: "Firn" });
  assert.deepEqual(names(), ["Firn", "Inserted", "总管", "Whitefoot"]);
  assert.deepEqual(store.snapshot().board.projects[1], { name: "Inserted", repo: "Org/Inserted" });
  assert.equal((await store.log()).length, ++count);
  await op.createProject({ author: "Any caller", name: "Last" });
  assert.deepEqual(names(), ["Firn", "Inserted", "总管", "Whitefoot", "Last"]);
  assert.equal((await store.log()).length, ++count);
  await op.updateProject({ author: "Whitefoot", name: "Whitefoot", repo: "Org/Changed" });
  assert.deepEqual(names(), ["Firn", "Inserted", "总管", "Whitefoot", "Last"]);
  assert.equal((await store.log()).length, ++count);
  await op.updateProject({ author: "总管", name: "Firn", after: "Last" });
  assert.deepEqual(names(), ["Inserted", "总管", "Whitefoot", "Last", "Firn"]);
  assert.equal((await store.log()).length, ++count);
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("project after rejects noncoordinators, unknown projects and self placement atomically", async t => {
  const { store, op, dir } = await board(t), before = store.snapshot(), count = (await store.log()).length;
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.updateProject({ author: "Whitefoot", name: "Whitefoot", after: "Firn" }), /after: only.*总管/],
    [() => op.updateProject({ author: "Whitefoot", name: "Whitefoot", repo: "Org/Changed", after: "Firn" }), /after: only.*总管/],
    [() => op.updateProject({ author: "Firn", name: "Whitefoot", repo: "Org/Changed", after: "Firn" }), /only that project or 总管 may update its repo/],
    [() => op.createProject({ author: "Whitefoot", name: "New", after: "Firn" }), /after: only.*总管/],
    [() => op.createProject({ author: "Any caller", name: "New", after: "Firn" }), /after: only.*总管/],
    [() => op.updateProject({ author: "总管", name: "Whitefoot", repo: "Org/Changed", after: "Missing" }), /after Missing.*configured/],
    [() => op.createProject({ author: "总管", name: "New", after: "Missing" }), /after Missing.*configured/],
    [() => op.updateProject({ author: "总管", name: "Missing", after: "Firn" }), /project Missing.*configured/],
    [() => op.updateProject({ author: "总管", name: "Whitefoot", after: "Whitefoot" }), /after.*cannot follow itself/],
    [() => op.createProject({ author: "总管", name: "New", after: "New" }), /after.*cannot follow itself/],
    [() => op.updateProject({ author: "Whitefoot", name: "Whitefoot" }), /repo.*provide/],
  ];
  for (const [call, message] of cases) {
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
});

test("set_term adds and replaces a term in the author's own glossary and delete_term removes it, one commit each, surviving reopen", async t => {
  const { store, op, dir } = await board(t);
  async function committed(call: () => Promise<Result>, by: string, message: string, file: string) {
    const result = await call(), log = await store.log({ limit: 1 });
    assert.equal(result.commit, log[0]!.commit); assert.equal(log[0]!.author, by); assert.equal(log[0]!.message, message);
    assert.deepEqual(log[0]!.files, [file]);
  }
  await committed(() => op.setTerm({ author, term: "孪生对照", definition: "同一构建的第二份副本，一起跑来显示噪声。" }), author, "set_term 孪生对照", "glossaries/Whitefoot.yaml");
  await committed(() => op.setTerm({ author, term: "否决线", definition: "旧的说法" }), author, "set_term 否决线", "glossaries/Whitefoot.yaml");
  await committed(() => op.setTerm({ author: "总管", term: "否决线", definition: "总管的说法" }), "总管", "set_term 否决线", "glossaries/总管.yaml");
  await committed(() => op.setTerm({ author, term: "否决线", definition: "性能比较里判定变慢的界线。" }), author, "set_term 否决线", "glossaries/Whitefoot.yaml");
  const entry = (term: string, definition: string, by = author) => ({ term, definition, updated: later, by });
  assert.deepEqual(store.snapshot().glossaries, {
    Whitefoot: { terms: [entry("孪生对照", "同一构建的第二份副本，一起跑来显示噪声。"), entry("否决线", "性能比较里判定变慢的界线。")], rev: 3 },
    总管: { terms: [entry("否决线", "总管的说法", "总管")], rev: 1 },
  }, "a replaced term keeps its place, and another project's same term stays in its own glossary");
  assert.match(await readFile(join(dir, "glossaries/Whitefoot.yaml"), "utf8"), /term: 否决线\n {4}definition: 性能比较里判定变慢的界线。/);
  await committed(() => op.deleteTerm({ author, term: "孪生对照" }), author, "delete_term 孪生对照", "glossaries/Whitefoot.yaml");
  assert.deepEqual(store.snapshot().glossaries.Whitefoot!.terms.map(t => t.term), ["否决线"]);
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("glossary writes refuse an unconfigured author, an empty or badly spaced term, an empty definition and an unknown term, changing nothing", async t => {
  const { store, op, dir } = await board(t);
  await op.setTerm({ author, term: "否决线", definition: "性能比较里判定变慢的界线。" });
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.setTerm({ author: "Snowghost", term: "否决线", definition: "别的项目" }), /author Snowghost: choose a configured project/],
    [() => op.deleteTerm({ author: "Snowghost", term: "否决线" }), /author Snowghost: choose a configured project/],
    [() => op.setTerm({ author, term: " ", definition: "定义" }), /term: provide nonempty text/],
    [() => op.setTerm({ author, term: "术语", definition: " \n " }), /definition: provide nonempty text/],
    [() => op.setTerm({ author, term: "两\n行", definition: "定义" }), /term: write the term on one line/],
    [() => op.setTerm({ author, term: "否决线 ", definition: "定义" }), /term: write the term on one line/],
    [() => op.deleteTerm({ author: "Firn", term: "否决线" }), /term 否决线: not in Firn's glossary/],
  ];
  for (const [call, message] of cases) {
    const before = store.snapshot();
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
  }
  await assert.rejects(store.commit({ author, message: "Duplicate", puts: [{ kind: "glossary", id: author, expectRev: 1, doc: { terms: [...store.snapshot().glossaries.Whitefoot!.terms, ...store.snapshot().glossaries.Whitefoot!.terms] } }] }), /Terms must be unique/);
});

test("targets upsert, replace and remove keep stable order and make one commit per change", async t => {
  const { store, op } = await board(t), baseline = store.snapshot().head, before = store.snapshot().items.a!;
  await op.setTargets({ author, id: "a", target: goalNumbers });
  await op.setTargets({ author, id: "a", target: { ...goalNumbers, id: "memory", goal: "Peak memory" } });
  await op.setTargets({ author, id: "a", target: { ...goalNumbers, current: "3 倍 Chromium" } });
  assert.deepEqual(store.snapshot().items.a!.targets!.map(target => target.id), ["style", "memory"]);
  assert.equal(store.snapshot().items.a!.targets![0]!.current, "3 倍 Chromium");
  await op.setTargets({ author, id: "a", targets: [
    { ...goalNumbers, id: "memory", goal: "Peak memory" },
    { ...goalNumbers, current: "3 倍 Chromium" },
    { ...goalNumbers, id: "size", goal: "Build size" },
  ] });
  assert.deepEqual(store.snapshot().items.a!.targets!.map(target => target.id), ["memory", "style", "size"]);
  await op.setTargets({ author, id: "a", remove: "memory" });
  assert.deepEqual(store.snapshot().items.a!.targets!.map(target => target.id), ["style", "size"]);
  await op.setTargets({ author, id: "a", targets: [] });
  assert.deepEqual(store.snapshot().items.a!.targets, []);
  const current = store.snapshot().items.a!;
  assert.equal(current.status, before.status); assert.equal(current.head, before.head); assert.deepEqual(current.log, before.log);
  const commits = await store.log({ since: baseline });
  assert.equal(commits.length, 6); assert.ok(commits.every(commit => commit.message === "set_targets a"));
});

test("target current values overwrite their old value and restamp dates only when current changes", async t => {
  const { store, dir } = await board(t);
  let clock = "2026-10-12T00:00:00Z";
  const op = ops(store, () => clock);
  await op.setTargets({ author, id: "a", target: goalNumbers });
  const initial = store.snapshot().items.a!.targets![0]!;
  assert.deepEqual(initial, { ...goalNumbers, date: clock });
  clock = "2026-10-13T00:00:00Z";
  const revised = { ...goalNumbers, goal: "Style calculation time", target: "≤ 2 倍 Chromium", baseline: "Chromium 同机同页，新版本" };
  await op.setTargets({ author, id: "a", target: revised });
  assert.deepEqual(store.snapshot().items.a!.targets![0], { ...revised, date: initial.date }, "other text edits keep the measurement date");
  clock = "2026-10-14T00:00:00Z";
  await op.setTargets({ author, id: "a", target: { ...revised, current: "4 倍 Chromium" } });
  const measured = store.snapshot().items.a!.targets![0]!;
  assert.deepEqual(measured, { ...revised, current: "4 倍 Chromium", date: clock });
  assert.equal(store.snapshot().items.a!.targets!.length, 1, "no measurement history is appended");
  clock = "2026-10-15T00:00:00Z";
  await op.setTargets({ author, id: "a", targets: [{ ...goalNumbers, id: "new", current: "4 倍 Chromium" }, { ...revised, current: "4 倍 Chromium" }] });
  assert.equal(store.snapshot().items.a!.targets![1]!.date, measured.date, "replacement matches dates by stable id after a position change");
  assert.equal(store.snapshot().items.a!.targets![0]!.date, clock, "new goal gets a date even if another goal has the same current value");
  clock = "2026-10-16T00:00:00Z";
  await op.setTargets({ author, id: "a", targets: [{ ...revised, current: "2 倍 Chromium" }] });
  assert.equal(store.snapshot().items.a!.targets![0]!.date, clock, "replacement also restamps changed current values");
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot(), "stored targets survive schema readback");
});

test("identical target upserts and replacements change neither updated nor history", async t => {
  const { store } = await board(t);
  let clock = "2026-10-12T00:00:00Z";
  const op = ops(store, () => clock), empty = store.snapshot();
  await op.setTargets({ author, id: "a", targets: [] });
  assert.deepEqual(store.snapshot(), empty, "clearing an absent list also writes no commit");
  await op.setTargets({ author, id: "a", target: goalNumbers });
  const before = store.snapshot(), commits = (await store.log()).length;
  clock = "2026-10-13T00:00:00Z";
  for (const args of [{ target: goalNumbers }, { targets: [goalNumbers] }]) {
    const result = await op.setTargets({ author, id: "a", ...args });
    assert.equal(result.commit, before.head);
    assert.deepEqual(store.snapshot(), before);
    assert.equal((await store.log()).length, commits);
  }
  await op.setTargets({ author, id: "a", target: { ...goalNumbers, target: "≤ 2 倍 Chromium" } });
  assert.equal((await store.log()).length, commits + 1, "a target-value edit still writes one commit");
});

test("targets refuse missing or empty text, invalid ids, caller dates and ambiguous operations atomically", async t => {
  const { store, op, dir } = await board(t), before = store.snapshot();
  type Args = Parameters<Ops["setTargets"]>[0];
  const cases: Array<[Args, RegExp]> = [
    [{ author, id: "a", target: { ...goalNumbers, id: "../bad" } }, /id/],
    [{ author, id: "a", target: { ...goalNumbers, id: "a".repeat(41) } }, /id/],
    [{ author, id: "a", targets: [goalNumbers, goalNumbers] }, /unique/],
    [{ author, id: "a", remove: "../bad" }, /input/],
    [{ author, id: "a", remove: "missing" }, /existing target/],
    [{ author, id: "a" }, /exactly one/],
    [{ author, id: "a", target: goalNumbers, targets: [] }, /exactly one/],
    [{ author, id: "a", target: goalNumbers, remove: "style" }, /exactly one/],
    [{ author, id: "a", targets: [], remove: "style" }, /exactly one/],
    [{ author, id: "a", target: { ...goalNumbers, date: later } } as unknown as Args, /Unrecognized key/],
    [{ author, id: "a", targets: [{ ...goalNumbers, date: later }] } as unknown as Args, /Unrecognized key/],
    [{ author: " ", id: "a", target: goalNumbers }, /author/],
    [{ author, id: "missing", target: goalNumbers }, /existing item/],
  ];
  for (const field of ["goal", "target", "current", "baseline"] as const) {
    for (const value of [undefined, "", " \n "]) {
      const invalid = { ...goalNumbers, [field]: value };
      cases.push([{ author, id: "a", target: invalid } as Args, new RegExp(field)]);
      cases.push([{ author, id: "a", targets: [goalNumbers, { ...invalid, id: "other" }] } as Args, new RegExp(field)]);
    }
  }
  for (const [args, error] of cases) {
    await assert.rejects(op.setTargets(args), error);
    assert.deepEqual(store.snapshot(), before);
  }
  assert.deepEqual((await Store.open(dir)).snapshot(), before, "refused input changes neither disk nor commit history");
});

test("targets enforce project ownership in every mode and support records without deriving work status", async t => {
  const { store, op } = await board(t);
  await op.setTargets({ author, id: "a", target: goalNumbers });
  const before = store.snapshot();
  for (const mode of [{ target: goalNumbers }, { targets: [] }, { remove: "style" }]) {
    await assert.rejects(op.setTargets({ author: "Firn", id: "a", ...mode }), /belongs to project Whitefoot/);
    assert.deepEqual(store.snapshot(), before);
  }
  await op.createItem({ author, key: "record-with-targets", title: "Goal numbers", record: true, group: author, priority: "P1" });
  await op.setTargets({ author, id: "record-with-targets", target: goalNumbers });
  const s = store.snapshot(); assert.equal(s.items["record-with-targets"]!.targets![0]!.date, later);
  assert.equal(s.items["record-with-targets"]!.status, undefined); assert.equal(rules(s).statusOf("record-with-targets"), undefined);
});

test("revision-free target writes retry real conflicts and retain concurrent goals, head and logs", async t => {
  const { store, op } = await board(t), original = store.commit.bind(store);
  let raced = false;
  t.mock.method(store, "commit", async (txn: Txn) => {
    if (!raced) {
      raced = true; const current = store.snapshot().items.a!;
      await original({ author, message: "Concurrent progress", puts: [{ kind: "item", id: "a", expectRev: current.rev,
        doc: { ...current, head: "Concurrent stable head", targets: [{ ...goalNumbers, id: "other", date: at }], log: [...current.log, { at, by: author, text: "Concurrent detail" }] } }] });
    }
    return original(txn);
  });
  await op.setTargets({ author, id: "a", target: goalNumbers });
  assert.ok(raced);
  const it = store.snapshot().items.a!;
  assert.deepEqual(it.targets!.map(target => target.id), ["other", "style"]);
  assert.equal(it.targets![0]!.date, at); assert.equal(it.targets![1]!.date, later);
  assert.equal(it.head, "Concurrent stable head"); assert.equal(it.log.at(-1)!.text, "Concurrent detail");
});


test("plans replace, upsert and remove rows while preserving dates, order and no-op revisions", async t => {
  const { store } = await board(t); let clock = later; const op = ops(store, () => clock);
  await op.setPlan({ author, id: "a", row: { id: "work", text: "Work", state: "doing" } });
  const first = store.snapshot().items.a!.plan!.find(row => row.id === "work")!;
  assert.ok("since" in first); assert.equal(first.since, later);
  clock = "2026-10-12T02:03:04Z";
  await op.setPlan({ author, id: "a", row: { id: "work", text: "Work revised", state: "doing" } });
  const revised = store.snapshot().items.a!.plan!.find(row => row.id === "work")!;
  assert.ok("since" in revised); assert.equal(revised.since, later);
  const before = store.snapshot();
  const result = await op.setPlan({ author, id: "a", row: { id: "work", text: "Work revised", state: "doing" } });
  assert.equal(result.commit, before.head); assert.deepEqual(store.snapshot(), before);
  await op.setPlan({ author, id: "a", row: { id: "work", text: "Work revised", state: "done" } });
  assert.deepEqual(store.snapshot().items.a!.plan!.map(row => row.id), ["work", "accept"]);
  const done = store.snapshot().items.a!.plan![0]!; assert.ok("doneAt" in done); assert.equal(done.doneAt, clock);
  await op.setPlan({ author, id: "a", remove: "work" });
  assert.deepEqual(store.snapshot().items.a!.plan!.map(row => row.id), ["accept"]);
});

test("acceptance may precede merge and an item finishes only after every row resolves", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author, id: "a", rows: [
    { id: "accept", accept: true, text: "Scenarios pass", state: "done", after: [] },
    { id: "merge", text: "Merge into main", state: "todo" },
  ] });
  const plan = store.snapshot().items.a!.plan;
  assert.deepEqual(plan.map(row => row.id), ["accept", "merge"]);
  assert.ok("doneAt" in plan[0]!); assert.equal(plan[0]!.doneAt, later);
  assert.ok(rules(store.snapshot()).askPending("a"));
  assert.equal(rules(store.snapshot()).statusOf("a"), "blocked", "the fixture's unanswered owner ask still blocks its merge work");
  await op.clearAsk({ author, id: "a", log: "Owner approved; merge can proceed" });
  assert.equal(rules(store.snapshot()).askPending("a"), false);
  assert.equal(rules(store.snapshot()).statusOf("a"), "todo");
  await op.setPlan({ author, id: "a", row: { id: "merge", text: "Merge into main", state: "done" } });
  assert.equal(rules(store.snapshot()).statusOf("a"), "done");
});

test("multiple acceptance scenarios retain ordinary waits and insert new rows before the first acceptance", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author, id: "a", rows: [
    { id: "work", text: "Deliver scenarios", state: "done" },
    { id: "scenario-a", accept: true, text: "Scenario A passes", state: "doing", waits: "CI", after: ["work"] },
    { id: "scenario-b", accept: true, text: "Scenario B passes", state: "todo", after: ["work"] },
    { id: "release", text: "Release", state: "todo", after: ["scenario-a", "scenario-b"] },
  ] });
  await op.setPlan({ author, id: "a", row: { id: "prepare", text: "Prepare review", state: "todo", after: [] } });
  assert.deepEqual(store.snapshot().items.a!.plan.map(row => row.id), ["work", "prepare", "scenario-a", "scenario-b", "release"]);
  const scenario = store.snapshot().items.a!.plan.find(row => row.id === "scenario-a")!;
  assert.ok("text" in scenario); assert.equal(scenario.waits, "CI"); assert.equal(scenario.since, later);
  await op.setPlan({ author, id: "a", row: { id: "scenario-b", accept: true, text: "Scenario B checked", state: "done", after: ["work"] } });
  assert.deepEqual(store.snapshot().items.a!.plan.map(row => row.id), ["work", "prepare", "scenario-a", "scenario-b", "release"]);
  const beforeCancel = store.snapshot().items.a!.plan;
  await op.setStatus({ author, id: "a", status: "cancelled", log: "Pause delivery while retaining the completed checks" });
  assert.deepEqual(store.snapshot().items.a!.plan, beforeCancel, "cancellation preserves every row, acceptance states, dates, waits and after edges included");
  assert.equal(rules(store.snapshot()).statusOf("a"), "cancelled");
  await op.setStatus({ author, id: "a", status: "open", log: "Resume delivery with the same checks" });
  assert.deepEqual(store.snapshot().items.a!.plan, beforeCancel, "reopening also leaves completed and doing acceptance scenarios unchanged");
  assert.equal(rules(store.snapshot()).statusOf("a"), "wip", "the doing acceptance scenario still supplies progress after reopening");
});

test("acceptance done writes follow ordinary step rules rather than requiring all other rows resolved", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author, id: "a", row: { id: "work", text: "Independent work", state: "todo", after: [] } });
  await op.setPlan({ author, id: "a", row: { id: "accept", accept: true, text: "Observed check passes", state: "done" } });
  assert.ok(rules(store.snapshot()).askPending("a"));
  assert.equal(rules(store.snapshot()).statusOf("a"), "blocked", "writing acceptance done does not bypass the fixture's owner ask");
  await op.clearAsk({ author, id: "a", log: "Owner approved; independent work can proceed" });
  assert.equal(rules(store.snapshot()).askPending("a"), false);
  assert.equal(rules(store.snapshot()).statusOf("a"), "todo");
  const work = store.snapshot().items.a!.plan.find(row => row.id === "work")!;
  assert.ok("state" in work); assert.equal(work.state, "todo");
  await op.setPlan({ author, id: "a", row: { id: "work", text: "Independent work", state: "done", after: [] } });
  assert.equal(rules(store.snapshot()).statusOf("a"), "done");
});

test("create_item appends accept while allowing more acceptance scenarios in its initial plan", async t => {
  const { store, op } = await board(t);
  await op.createItem({ author, key: "scenarios", group: author, title: "All scenarios pass", priority: "P1", accept: "Final scenario passes", plan: [
    { id: "scenario", accept: true, text: "Initial scenario passes", state: "todo", after: [] },
    { id: "merge", text: "Merge checked work", state: "todo" },
  ] });
  assert.deepEqual(store.snapshot().items.scenarios!.plan.map(row => row.id), ["scenario", "merge", "accept"]);
  assert.equal(store.snapshot().items.scenarios!.plan.filter(row => "accept" in row && row.accept).length, 2);
});

test("plan validation refuses ambiguous modes, caller dates, invalid after and missing acceptance atomically", async t => {
  const { store, op, dir } = await board(t); const before = store.snapshot();
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ rows: [], row: { id: "work", text: "Work", state: "todo" } }, /exactly one/],
    [{ row: { id: "work", text: "Work", state: "doing", since: later } }, /Unrecognized/],
    [{ row: { id: "work", text: "Work", state: "dropped" } }, /reason/],
    [{ row: { id: "work", text: "Work", state: "todo", after: ["accept"] } }, /earlier/],
    [{ rows: [{ id: "same", text: "One", state: "todo" }, { id: "same", accept: true, text: "Accept", state: "todo" }] }, /unique/],
    [{ rows: [] }, /accept/],
    [{ remove: "accept" }, /at least one acceptance/],
    [{ row: { item: "missing", own: false } }, /依赖的条目不存在/],
    [{ row: { card: "missing" } }, /依赖的决策卡不存在/],
    [{ row: { item: "a", own: false, why: "old reason" } }, /Unrecognized/],
  ];
  for (const [args, error] of cases) {
    await assert.rejects(op.setPlan({ author, id: "b", ...args } as Parameters<Ops["setPlan"]>[0]), error);
    assert.deepEqual(store.snapshot(), before); assert.deepEqual((await Store.open(dir)).snapshot(), before);
  }
});

test("owned rows need deliberate moves; removal names after users and transfers log both owners", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await assert.rejects(op.setPlan({ author, id: "other", row: { item: "a", own: true } }), /被多个条目拥有/);
  await assert.rejects(op.setPlan({ author, id: "area", remove: "a" }), /open.*move_item/);
  await assert.rejects(op.setPlan({ author, id: "area", row: { item: "a", own: false, after: [] } }), /open.*move_item/);
  await op.setPlan({ author, id: "area", row: { id: "follow", text: "After A", state: "todo", after: ["a"] } });
  await assert.rejects(op.moveItem({ author, id: "a", owner: "other" }), /later rows follow/);
  await op.setPlan({ author, id: "area", row: { id: "follow", text: "Independent", state: "todo", after: [] } });
  await op.moveItem({ author, id: "a", owner: "other", after: [] });
  const s = store.snapshot(); assert.equal(rules(s).parentOf("a"), "other");
  assert.ok(!s.items.area!.plan!.some(row => row.id === "a"));
  assert.match(s.items.area!.log.at(-1)!.text, /中文检查.*其他项目/);
  assert.match(s.items.other!.log.at(-1)!.text, /中文检查/);
  assert.match(s.items.a!.log.at(-1)!.text, /解释器工作.*其他项目/);
  await assert.rejects(op.moveItem({ author, id: "other", owner: "a" }), /依赖成环/);
});

test("creation adoption, requests and triage use plans and commit all structural effects together", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.createItem({ author, key: "parent", title: "Combined", group: author, accept: "Both accepted", priority: "P0", children: ["a", "b"] });
  const s = store.snapshot(); assert.equal(rules(s).parentOf("a"), "parent"); assert.equal(rules(s).parentOf("b"), "parent");
  assert.deepEqual(s.items.parent!.plan!.map(row => row.id), ["a", "b", "accept"]);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["items/a.yaml", "items/area.yaml", "items/b.yaml", "items/parent.yaml"]);
  await op.createRequest({ author, project: "Firn", key: "request", title: "Witness", head: "Minimal program", accept: "Program passes", why: "Required for completion", from: "parent", after: [] });
  assert.equal(rules(store.snapshot()).priorityOf("request"), "P0");
  assert.match(store.snapshot().items.request!.log[0]!.text, /Required for completion/);
  await ops(store).triageRequest({ author: "Firn", id: "request", log: "Accepted" });
  assert.equal(store.snapshot().items.request!.request, undefined);
});

test("record-owned backlog work refuses priority even with external dependents, and cancellation refuses open parts", async t => {
  const { store, op } = await board(t);
  await op.createItem({ author, key: "backlog", title: "Backlog", group: author, record: true });
  await op.moveItem({ author, id: "a", owner: "backlog" });
  await op.createRequest({ author: "Firn", project: author, key: "request", title: "Need", head: "Witness", accept: "Pass", why: "Need", from: "other" });
  await op.setPlan({ author: "Firn", id: "other", row: { item: "a", own: false, after: [] } });
  const r = rules(store.snapshot()); assert.equal(r.isRoot("a"), false); assert.equal(r.priorityOf("a"), "P1");
  await assert.rejects(op.updateItem({ author, id: "a", rev: store.snapshot().items.a!.rev, priority: "P2" }), /record-owned.*cannot store priority.*open shared dependents/);
  await assert.rejects(op.setStatus({ author, id: "area", status: "cancelled", log: "Superseded" }), /owned items.*b/);
  await op.setStatus({ author, id: "b", status: "cancelled", log: "Superseded" });
  await op.setStatus({ author, id: "area", status: "cancelled", log: "Parts disposed" });
  await op.setStatus({ author, id: "area", status: "open", log: "Resume" });
  assert.equal(store.snapshot().items.area!.status, undefined);
});

test("record mode preserves parts and logs removed acceptance; provisional full writes clear the mark once", async t => {
  const { store, op } = await board(t);
  await op.updateItem({ author, id: "area", rev: 1, record: true });
  const record = store.snapshot().items.area!; assert.equal(record.plan!.length, 2); assert.match(record.log.at(-1)!.text, /原验收：解释器目标通过/);
  await assert.rejects(op.setStatus({ author, id: "area", status: "cancelled", log: "Drop" }), /record/);
  await assert.rejects(op.updateItem({ author, id: "area", rev: record.rev, record: false }), /accept/);
  await op.updateItem({ author, id: "area", rev: record.rev, record: false, accept: "Work verified" });
  const it = store.snapshot().items.a!;
  await store.commit({ author, message: "Synthetic provisional", puts: [{ kind: "item", id: "a", expectRev: it.rev, doc: { ...it, provisional: true } }] });
  await op.setPlan({ author, id: "a", row: { id: "accept", accept: true, text: "Accepted", state: "todo" } });
  assert.equal(store.snapshot().items.a!.provisional, true);
  await op.setPlan({ author, id: "a", rows: [{ id: "accept", accept: true, text: "Accepted", state: "todo" }] });
  const final = store.snapshot(); assert.equal(final.items.a!.provisional, undefined); assert.equal(final.items.a!.log.at(-1)!.text, "重写了计划");
  await op.setPlan({ author, id: "a", rows: [{ id: "accept", accept: true, text: "Accepted", state: "todo" }] }); assert.deepEqual(store.snapshot(), final);
});

test("record conversion refuses dangling after edges, then removes every acceptance row and logs every scenario text", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author, id: "a", rows: [
    { id: "first", accept: true, text: "First scenario passes", state: "todo" },
    { id: "merge", text: "Merge work", state: "todo", after: ["first"] },
    { id: "second", accept: true, text: "Second scenario passes", state: "todo" },
  ] });
  const beforeModeChange = store.snapshot();
  await assert.rejects(op.updateItem({ author, id: "a", rev: beforeModeChange.items.a!.rev, record: true }), /after must name earlier rows/);
  assert.deepEqual(store.snapshot(), beforeModeChange, "a refused mode change preserves every document and the data head");
  await op.setPlan({ author, id: "a", row: { id: "merge", text: "Merge work", state: "todo" } });
  await op.updateItem({ author, id: "a", rev: store.snapshot().items.a!.rev, record: true });
  const record = store.snapshot().items.a!;
  assert.deepEqual(record.plan.map(row => row.id), ["merge"]);
  assert.match(record.log.at(-1)!.text, /原验收：First scenario passes；Second scenario passes/);
  const before = store.snapshot();
  await assert.rejects(op.setPlan({ author, id: "a", row: { id: "forbidden", accept: true, text: "Record acceptance", state: "todo" } }), /record takes none/);
  assert.deepEqual(store.snapshot(), before);
});

test("revision-free plan retries preserve concurrent rows, context and logs", async t => {
  const { store, op } = await board(t), original = store.commit.bind(store); let raced = false;
  t.mock.method(store, "commit", async (txn: Txn) => {
    if (!raced) { raced = true; const current = store.snapshot().items.a!; await original({ author, message: "Concurrent", puts: [{ kind: "item", id: "a", expectRev: current.rev, doc: { ...current, head: "Concurrent head", plan: [{ id: "other", text: "Concurrent work", state: "doing", since: at }, ...current.plan!], log: [...current.log, { at, text: "Concurrent detail" }] } }] }); }
    return original(txn);
  });
  await op.setPlan({ author, id: "a", row: { id: "mine", text: "My work", state: "todo" } });
  assert.deepEqual(store.snapshot().items.a!.plan!.map(row => row.id), ["other", "mine", "accept"]);
  assert.equal(store.snapshot().items.a!.head, "Concurrent head"); assert.equal(store.snapshot().items.a!.log.at(-1)!.text, "Concurrent detail");
});

test("writes enforce configured projects and nonempty values; removed parameters never change storage", async t => {
  const { store, op, dir } = await board(t); const before = store.snapshot();
  for (const args of [{ author: " " }, { text: " " }, { id: "missing" }]) {
    await assert.rejects(op.appendLog({ author, id: "a", text: "Evidence", ...args }), OpError); assert.deepEqual(store.snapshot(), before);
  }
  await assert.rejects(op.setPlan({ author: "Firn", id: "a", row: { id: "work", text: "Foreign", state: "todo" } }), /belongs to project Whitefoot/);
  for (const extra of [{ parent: "area" }, { parentWhy: "Old" }, { sourceStatus: "todo" }, { deps: [] }, { migrated: true }]) {
    await assert.rejects(op.updateItem({ author, id: "a", rev: 1, title: "Revised", ...extra } as Parameters<Ops["updateItem"]>[0]), /removed by item plans/);
  }
  await assert.rejects(op.createItem({ author, key: "missing-accept", group: author, title: "New", priority: "P1" }), /accept/);
  await assert.rejects(op.createItem({ author, key: "record-accept", group: author, title: "Record", record: true, accept: "Wrong" }), /accept/);
  await assert.rejects(op.createItem({ author, key: "old-status", group: author, title: "New", accept: "Pass", priority: "P1", status: "todo" } as Parameters<Ops["createItem"]>[0]), /no status argument/);
  assert.deepEqual(store.snapshot(), before); assert.deepEqual((await Store.open(dir)).snapshot(), before);
});

test("card writes validate options, confidence, revisions and project ownership independently of plan placement", async t => {
  const { store, op } = await board(t), before = store.snapshot();
  const args = { author, key: "new-card", item: "a", question: "Choose?", background: "Evidence", options: [{ key: "A", text: "Option" }] };
  for (const invalid of [
    { options: [] }, { options: [{ key: "A", text: "A" }, { key: "A", text: "B" }] },
    { options: [{ key: "A", text: "A", recommended: true }, { key: "B", text: "B", recommended: true }] },
    { confidence: { score: 6, reason: "Outside range" } }, { item: "missing" },
  ]) { await assert.rejects(op.writeCard({ ...args, ...invalid }), OpError); assert.deepEqual(store.snapshot(), before); }
  await assert.rejects(op.writeCard({ ...args, author: "Firn" }), /belongs to project Whitefoot/);
  await op.writeCard(args); await op.ruleCard({ author, key: "new-card", choice: "A", ruling: "Approved" });
  const ruled = store.snapshot().decisions["new-card"]!; assert.equal(ruled.status, "ruled"); assert.equal(ruled.ruledAt, later);
  await assert.rejects(op.writeCard({ ...args, rev: ruled.rev }), /only an open card/);
  await assert.rejects(op.ruleCard({ author, key: "choice", choice: "wrong", ruling: "Unknown" }), /option key/);
});

test("priority is only stored on roots and is removed atomically when a new plan dependent appears", async t => {
  const { store, op } = await board(t);
  await assert.rejects(op.updateItem({ author, id: "a", rev: 1, priority: "P0" }), /只有.*根条目/);
  await op.createItem({ author: "Firn", group: "Firn", key: "remote", title: "Root result", priority: "P2", accept: "Pass" });
  const changed = await op.setPlan({ author, id: "a", row: { item: "remote", own: false, after: [] } });
  assert.deepEqual(changed.dropped, [{ id: "remote", priority: "P2" }]); assert.equal(store.snapshot().items.remote!.priority, undefined);
  assert.equal(rules(store.snapshot()).priorityOf("remote"), "P1");
  await op.setPlan({ author, id: "a", remove: "remote" });
  const r = rules(store.snapshot()); assert.equal(r.isRoot("remote"), true); assert.equal(r.priorityOf("remote"), ""); assert.ok(r.checks("remote").some(check => check.text === "没有未完成的条目依赖它，却没写优先级"));
  await ops(store).updateItem({ author: "Firn", id: "remote", rev: store.snapshot().items.remote!.rev, priority: "P2" });
  assert.equal(rules(store.snapshot()).priorityOf("remote"), "P2");
});

test("ownership, missing targets and cycles are refused without changing the snapshot", async t => {
  const { store, op } = await board(t);
  const before = store.snapshot();
  await assert.rejects(op.setPlan({ author, id: "a", row: { item: "other", own: true } }), /跨项目拥有/);
  await assert.rejects(op.setPlan({ author: "Firn", id: "other", row: { item: "a", own: true } }), /跨项目拥有|被多个条目拥有/);
  await assert.rejects(op.setPlan({ author, id: "area", row: { item: "missing", own: false } }), /依赖的条目不存在/);
  await assert.rejects(op.setPlan({ author, id: "a", row: { item: "area", own: false } }), /依赖成环/);
  assert.deepEqual(store.snapshot(), before);
});

test("acceptance naming avoids collisions with valid ordinary rows", async t => {
  const { store, op } = await board(t);
  await op.createItem({ author, key: "collision", group: author, title: "New", priority: "P1", accept: "Pass", plan: [{ id: "accept", text: "Ordinary work", state: "todo" }] });
  assert.deepEqual(store.snapshot().items.collision!.plan.map(row => row.id), ["accept", "accept-1"]);
  await op.createItem({ author, key: "record-collision", group: author, title: "Record", record: true, plan: [{ id: "accept", text: "Ordinary record entry", state: "todo" }] });
  await op.updateItem({ author, id: "record-collision", rev: 1, record: false, accept: "Pass" });
  assert.deepEqual(store.snapshot().items["record-collision"]!.plan.map(row => row.id), ["accept", "accept-1"]);
});

test("every ownership attachment triages pending requests atomically and records their placement", async t => {
  for (const mode of ["plan-row", "plan-rows", "create-plan", "create-children", "move", "triage"] as const) await t.test(mode, async t => {
    const { store, op, dir } = await board(t);
    await op.createRequest({ author: "Firn", project: author, key: "incoming", title: "Requested result", head: "Witness", accept: "Witness passes", why: "Other project needs the result", from: "other", after: [] });
    const request = store.snapshot().items.incoming!;
    assert.ok(request.request); assert.deepEqual(rules(store.snapshot()).inbox(author), ["incoming"]);
    const before = (await store.log()).length;
    let owner = "area";
    if (mode === "plan-row") await op.setPlan({ author, id: owner, row: { item: "incoming", own: true, after: [] } });
    else if (mode === "plan-rows") await op.setPlan({ author, id: owner, rows: [
      { item: "a", own: true, after: [] }, { item: "b", own: true, after: [] }, { item: "incoming", own: true, after: [] },
      { id: "accept", accept: true, text: "解释器目标通过", state: "todo" },
    ] });
    else if (mode === "create-plan" || mode === "create-children") {
      owner = "new-owner";
      await op.createItem({ author, key: owner, group: author, title: "Requested work owner", accept: "Owner passes", priority: "P0",
        ...(mode === "create-plan" ? { plan: [{ item: "incoming", own: true }] } : { children: ["incoming"] }),
      });
    } else if (mode === "move") await op.moveItem({ author, id: "incoming", owner });
    else await op.triageRequest({ author, id: "incoming", owner, log: "Accepted into scheduled work" });
    const after = store.snapshot(), r = rules(after);
    assert.equal(after.items.incoming!.request, undefined); assert.deepEqual(r.inbox(author), []); assert.equal(r.parentOf("incoming"), owner);
    assert.deepEqual(after.items.incoming!.log[0], request.log[0], "filing reason stays intact");
    assert.ok(after.items.incoming!.log.some(entry => entry.text === `分拣：放到「${after.items[owner]!.title}」的计划`));
    if (mode === "triage") assert.deepEqual(after.items.incoming!.log.slice(-2).map(entry=>entry.text),[
      `分拣：放到「${after.items[owner]!.title}」的计划`,"Accepted into scheduled work",
    ],"placement precedes the supplied triage log");
    assert.equal((await store.log()).length, before + 1, "attachment and inbox removal share one commit");
    const files = (await store.log({ limit: 1 }))[0]!.files;
    assert.ok(files.includes("items/incoming.yaml")); assert.ok(files.includes(`items/${owner}.yaml`));
    assert.deepEqual((await Store.open(dir)).snapshot(), after);
    await assert.rejects(op.triageRequest({ author, id: "incoming", log: "Triage again" }), /not an open request/);
  });
});
