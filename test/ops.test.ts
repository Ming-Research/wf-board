import { test } from "node:test";
import assert from "node:assert/strict";
import { ops, OpError } from "../src/ops.ts";
import { rules } from "../src/rules.ts";
import type { Ops, Result } from "../src/ops.ts";
import { Store } from "../src/store.ts";
import type { Txn } from "../src/store.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { board, at, later, author, architect, asArchitect } from "./helpers.ts";

const goalNumbers = { id: "style", goal: "apollo11 样式计算耗时", target: "≤ 1 倍 Chromium", current: "12 倍 Chromium", baseline: "Chromium 同机同页" };

test("creation, revision, dependency, status, movement and card checks name a fix and leave the board unchanged", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const create = { ...asArchitect, key: "new", owner: "area", title: "New", accept: "New result passes" };
  const card = { author, key: "new-card", item: "a", question: "Choose?", options: [{ text: "A" }] };
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.createItem({ ...create, key: "../escape" }), /key.*use/],
    [() => op.createItem({ ...create, key: "a" }), /key.*new/],
    [() => op.createItem({ ...create, key: "choice" }), /key.*new/],
    [() => op.createItem({ ...create, owner: undefined, priority: "P1" }), /group.*requires/],
    [() => op.createItem({ ...create, owner: "missing" }), /owner.*existing/],
    [() => op.createItem({ ...create, accept: undefined }), /accept.*required/],
    [() => op.createItem({ ...create, plan: [{ item: "missing", own: false }] }), /依赖的条目不存在.*missing.*set_plan.*remove or replace/],
    [() => op.createItem({ ...create, plan: [{ card: "choice" }] }), /plan.*write_card creates the card; a new item has no card rows/],
    [() => op.updateItem({ ...asArchitect, id: "a", rev: 0, title: "Bad" }), /rev.*positive.*context/],
    [() => op.updateItem({ author, id: "a", rev: 1, head: "Changed" }), /reason.*explain.*head/],
    [() => op.updateItem({ author, id: "a", rev: 1, links: [{ label: "Invalid", url: "invalid" }] }), /links.*fix/],
    [() => op.updateItem({ author, id: "a", rev: 1, order: 2 }), /order.*only top items.*plan/],
    [() => op.setPlan({ author, id: "a", row: { card: "missing" } }), /card missing.*write_card creates the card; a plan write cannot add it/],
    [() => op.setPlan({ author, id: "other", row: { card: "choice" } }), /card choice.*write_card creates the card; a plan write cannot add it/],
    [() => op.setPlan({ author, id: "b", rows: [{ item: "a", own: false, after: [] }, { id: "accept", accept: true, text: "阻塞证据验收通过", state: "todo" }] }), /card ruled.*cannot be removed.*withdraw_card/],
    [() => op.setPlan({ author, id: "b", remove: "choice" }), /card choice.*cannot be removed.*withdraw_card/],
    [() => op.setPlan({ author, id: "other", row: { item: "a", own: true } }), /被多个条目拥有.*current owner area.*move_item/],
    [() => op.setPlan({ author, id: "area", remove: "a" }), /a is open.*move_item or cancel/],
    [() => op.setPlan({ author, id: "a", row: { id: "later", text: "Later work", state: "todo", after: ["accept"] } }), /after.*earlier/],
    [() => op.setPlan({ author, id: "a", row: { id: "drop", text: "Dropped work", state: "dropped" } }), /reason.*fix/],
    [() => op.setStatus({ ...asArchitect, id: "area", status: "done", log: "Done" } as unknown as Parameters<Ops["setStatus"]>[0]), /status.*only cancelled or open.*derived from the plan/],
    [() => op.setStatus({ ...asArchitect, id: "other", status: "blocked", log: "Wait" } as unknown as Parameters<Ops["setStatus"]>[0]), /status.*only cancelled or open.*derived from the plan/],
    [() => op.setStatus({ ...asArchitect, id: "area", status: "cancelled", log: "Drop" }), /owned items.*a.*b.*cancel or move each part first/],
    [() => op.setStatus({ ...asArchitect, id: "a", status: "open", log: "Resume" }), /only a cancelled item can be reopened/],
    [() => op.moveItem({ author, id: "a", owner: "a" }), /依赖成环.*set_plan or move_item.*remove/],
    [() => op.moveItem({ author, id: "area", owner: "a" }), /依赖成环.*set_plan or move_item.*remove/],
    [() => op.moveItem({ author, id: "a", owner: "missing" }), /owner.*existing/],
    [() => op.moveItem({ author, id: "a", owner: "other", priority: "P2" }), /priority.*refused with owner/],
    [() => op.writeCard({ ...card, key: "a" }), /key.*new/],
    [() => op.writeCard({ ...card, key: "choice" }), /key.*new/],
    [() => op.writeCard({ ...card, options: [] }), /options.*at least one/],
    [() => op.writeCard({ ...card, options: [{ text: "A", recommended: true }, { text: "B", recommended: true }] }), /recommended.*at most one/],
    [() => op.writeCard({ ...card, options: [{ text: "一".repeat(21) }] }), /options\.0\.text.*at most 20 characters/],
    [() => op.writeCard({ ...card, options: [{ text: "first\nsecond" }] }), /options\.0\.text.*one line/],
    [() => op.writeCard({ ...card, question: "Choose?\nBecause" }), /question.*one line.*head/],
    [() => op.writeCard({ ...card, item: "missing" }), /item.*existing/],
    [() => op.writeCard({ ...card, key: "choice", rev: 1, item: "a" }), /item.*belongs to b and cannot change item/],
    [() => op.writeCard({ ...card, before: "missing" }), /before.*choose a row of the item's plan/],
    [() => op.writeCard({ ...card, key: "ruled", rev: 1, item: "b" }), /status.*open card.*create a new card/],
    [() => op.writeCard({ ...card, rev: 1, before: "accept" }), /before.*placed when the card is created/],
    [() => op.ruleCard({ author, key: "ruled", choice: "A" }), /status.*open card/],
    [() => op.ruleCard({ author, key: "choice", choice: "C" }), /choice.*option keys \(A, B\)/],
    [() => op.withdrawCard({ author, key: "ruled", log: "No longer needed" }), /status.*open card/],
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
  async function committed(call: () => Promise<Result>, message: string, files: string[], kind: "item" | "decision" | "note", id: string, by = author) {
    const count = (await store.log()).length, previous = store.snapshot().head, result = await call(), after = store.snapshot(), log = await store.log({ limit: 1 });
    const doc = kind === "item" ? after.items[id]! : kind === "decision" ? after.decisions[id]! : after.notes[id]!;
    assert.equal((await store.log()).length,count+1,"all document effects enter one atomic commit");
    assert.notEqual(after.head,previous); assert.equal(result.commit,after.head); assert.equal(result.commit,log[0]!.commit);
    assert.deepEqual(result,{commit:after.head,id,rev:doc.rev,summary:message},"the result names the revision and commit actually produced");
    assert.equal(log[0]!.author,by); assert.equal(log[0]!.message,message);
    assert.deepEqual(log[0]!.files.slice().sort(),files.slice().sort(),"the commit contains every effect and no unrelated document");
    assert.deepEqual(await store.show(kind,id,result.commit),doc,"the returned revision is stored in that exact commit");
    assert.deepEqual((await Store.open(dir)).snapshot(),after,"all atomic effects survive reopen");
  }
  const itemCommit = (call: () => Promise<Result>, message: string, files=["items/new.yaml"], by = author) => committed(call,message,files,"item","new",by);
  await itemCommit(() => op.createItem({ ...asArchitect, key: "new", owner: "area", title: "New", head: "Stable", accept: "New result passes", plan: [{id:"work",text:"Deliver result",state:"todo"}], links: [], data: "4 cases" }),"create_item new",["items/new.yaml","items/area.yaml","numbers.yaml"],architect);
  assert.deepEqual(store.snapshot().items.area!.plan.find(row=>row.id === "new"),{id:"new",item:"new",own:true});
  const created=store.snapshot().items.new!; assert.equal(created.created,later); assert.equal(created.updated,later); assert.equal(rules(store.snapshot()).statusOf("new"),"todo");
  assert.deepEqual(created.plan,[{id:"work",text:"Deliver result",state:"todo"},{id:"accept",accept:true,text:"New result passes",state:"todo"}]);
  await itemCommit(() => op.appendLog({ author, id: "new", text: "Evidence" }),"append_log new");
  assert.deepEqual(store.snapshot().items.new!.log[0],{at:later,by:author,text:"Evidence"});
  await itemCommit(() => op.updateItem({ ...asArchitect, id: "new", rev: 2, head: "Revised", reason: "Scope settled", title: "Revised title", links: [{label:"PR",url:"https://github.com/Ming-Research/Whitefoot/pull/1"}], data: null }),"update_item new",undefined,architect);
  const revised=store.snapshot().items.new!; assert.equal(revised.head,"Revised"); assert.equal(revised.title,"Revised title"); assert.equal(revised.data,undefined); assert.equal(Object.hasOwn(revised,"agent"),false);
  assert.deepEqual(revised.plan,created.plan); assert.deepEqual(revised.log.at(-1),{at:later,by:architect,text:"改了 head：Scope settled"});
  await committed(() => op.updateItem({author,id:"other",rev:store.snapshot().items.other!.rev,order:2}),"update_item other",["items/other.yaml"],"item","other");
  assert.equal(store.snapshot().items.other!.order,2,"top-item order remains editable while owned order is the plan's");
  // The card is written with its row in the item's plan, in one commit with the card.
  const writeNewCard=()=>op.writeCard({author,key:"new-card",item:"new",question:"Choose?",options:[{text:"A",recommended:true},{text:"B"}]});
  await committed(writeNewCard,"write_card new-card",["decisions/new-card.yaml","items/new.yaml","numbers.yaml"],"decision","new-card");
  assert.deepEqual(store.snapshot().items.new!.plan.map(row=>row.id),["work","new-card","accept"]);
  assert.deepEqual(store.snapshot().items.new!.plan[1],{id:"new-card",card:"new-card"});
  assert.deepEqual(store.snapshot().items.new!.plan[2],{id:"accept",accept:true,text:"New result passes",state:"todo",after:["work","new-card"]},"the acceptance step waits for the card and still for the row before");
  assert.deepEqual(store.snapshot().decisions["new-card"]!.options,[{key:"A",text:"A",recommended:true},{key:"B",text:"B"}],"the board gives the option keys");
  await itemCommit(() => op.setTargets({ author, id: "new", target: goalNumbers }),"set_targets new");
  assert.deepEqual(store.snapshot().items.new!.targets,[{...goalNumbers,date:later}]);
  await itemCommit(() => op.setPlan({ author, id: "new", row: {id:"work",text:"Deliver result",state:"doing"} }),"set_plan new");
  assert.equal(rules(store.snapshot()).statusOf("new"),"wip");
  await itemCommit(() => op.setPlan({ author, id: "new", row: {id:"work",text:"Deliver result",state:"done"} }),"set_plan new");
  assert.equal(rules(store.snapshot()).statusOf("new"),"blocked");
  const waiting=store.snapshot().items.new!;
  await store.commit({author:"Fixture",message:"Legacy ask",puts:[{kind:"item",id:"new",expectRev:waiting.rev,doc:{...waiting,ask:{text:"Approve",url:"https://example.com/approve",chat:true}}}]});
  const beforeCancel=store.snapshot().items.new!;
  await itemCommit(() => op.setStatus({ ...asArchitect, id: "new", status: "cancelled", log: "Superseded" }),"set_status new cancelled",undefined,architect);
  assert.equal(rules(store.snapshot()).statusOf("new"),"cancelled"); assert.deepEqual(store.snapshot().items.new!.plan,beforeCancel.plan); assert.deepEqual(store.snapshot().items.new!.ask,beforeCancel.ask);
  assert.deepEqual(store.snapshot().items.new!.log.at(-1),{at:later,by:architect,text:"Superseded"});
  await itemCommit(() => op.setStatus({ ...asArchitect, id: "new", status: "open", log: "Resume" }),"set_status new open",undefined,architect);
  assert.equal(store.snapshot().items.new!.status,undefined); assert.equal(rules(store.snapshot()).statusOf("new"),"blocked");
  await itemCommit(() => op.clearAsk({ author, id: "new", log: "Owner approved" }),"clear_ask new");
  assert.equal(store.snapshot().items.new!.ask,undefined); assert.equal(store.snapshot().items.new!.log.at(-1)!.text,"Owner approved");
  await itemCommit(() => op.moveItem({ author, id: "new", owner: "other" }),"move_item new",["items/new.yaml","items/area.yaml","items/other.yaml"]);
  const moved=store.snapshot(); assert.equal(rules(moved).parentOf("new"),"other"); assert.ok(!moved.items.area!.plan.some(row=>row.id === "new"));
  assert.deepEqual(moved.items.other!.plan.find(row=>row.id === "new"),{id:"new",item:"new",own:true});
  assert.match(moved.items.area!.log.at(-1)!.text,/Revised title.*其他项目/); assert.match(moved.items.other!.log.at(-1)!.text,/Revised title/); assert.match(moved.items.new!.log.at(-1)!.text,/解释器工作.*其他项目/);
  const cardCommit=(call: () => Promise<Result>,message:string,key="new-card",extra:string[]=[])=>committed(call,message,["decisions/"+key+".yaml",...extra],"decision",key);
  const originalAt=store.snapshot().decisions["new-card"]!.at, rowsBefore=store.snapshot().items.new!.plan;
  await cardCommit(() => op.writeCard({author,key:"new-card",rev:1,item:"new",question:"Choose revised?",options:[{text:"A"},{text:"B"},{text:"C"}]}),"write_card new-card");
  assert.equal(store.snapshot().decisions["new-card"]!.at,originalAt); assert.deepEqual(store.snapshot().items.new!.plan,rowsBefore,"a revision keeps the card's row");
  await cardCommit(() => op.ruleCard({author,key:"new-card",choice:"B"}),"rule_card new-card");
  assert.equal(store.snapshot().decisions["new-card"]!.choice,"B"); assert.equal(store.snapshot().decisions["new-card"]!.ruledAt,later);
  await cardCommit(() => op.ruleCard({author,key:"choice",choice:"A"}),"rule_card choice","choice");
  await itemCommit(() => op.setPlan({author,id:"new",row:{id:"accept",accept:true,text:"New result passes",state:"done"}}),"set_plan new");
  assert.equal(rules(store.snapshot()).statusOf("new"),"done");
  await committed(() => op.replyNote({author,id:"note-1",reply:"Answer"}),"reply_note note-1",["notes/note-1.yaml"],"note","note-1");
  assert.deepEqual(store.snapshot().notes["note-1"],{target:"it:a",kind:"comment",text:"中文意见 Whitefoot #341",at,sentAt:at,state:"done",reply:"Answer",repliedAt:later,repliedBy:author,rev:2});
});

test("stale item/card revisions summarize intervening changes and never overwrite", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.appendLog({ author, id: "a", text: "Concurrent evidence" });
  const before = store.snapshot();
  await assert.rejects(op.updateItem({ ...asArchitect, id: "a", rev: 1, title: "Stale" }), /rev 1: current rev 2; \+1 log.*redo.*rev 2/);
  assert.deepEqual(store.snapshot(), before);
  const args = { author, key: "choice", item: "b", question: "Changed?", options: [{ text: "A" }] };
  await op.writeCard({ ...args, rev: 1 });
  const cardBefore = store.snapshot();
  await assert.rejects(op.writeCard({ ...args, rev: 1 }), /current rev 2.*question changed/);
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
  await assert.rejects(op.updateItem({ ...asArchitect, id: "a", rev: 1, title: "Would overwrite" }), e => {
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
    const id = target === "it:a" ? "close-item" : "close-card", logged = target === "it:a" ? "a" : "b";
    await store.commit({author:"Fixture",message:"Note",puts:[{kind:"note",id,expectRev:null,doc:{target,kind:"done",text:"Done",state:"draft",at}}]});
    const before = store.snapshot();
    await assert.rejects(op.closeNote({author,id,log:"Handled"}),/draft/); assert.deepEqual(store.snapshot(),before);
    await store.commit({author:"Fixture",message:"Send",puts:[{kind:"note",id,expectRev:1,doc:{...before.notes[id],state:"sent",sentAt:at}}]});
    const count = (await store.log()).length;
    await op.closeNote({author,id,log:"Handled"});
    assert.equal((await store.log()).length,count+1);
    assert.deepEqual(store.snapshot().notes[id],{...before.notes[id],rev:3,state:"done",sentAt:at,repliedBy:author,repliedAt:later});
    assert.equal(store.snapshot().items[logged]!.log.at(-1)!.text,"关闭评论：Handled");
    await op.closeNote({author,id,log:"Recorded follow-up"});
    assert.equal(store.snapshot().notes[id]!.state,"done");
    assert.equal(store.snapshot().items[logged]!.log.at(-1)!.text,"关闭评论：Recorded follow-up");
  }
});

test("project creation accepts any author and repo updates require the project or Architect", async t => {
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
  await op.updateProject({ ...asArchitect, name: "Whitefoot", repo: "Org/Coordinated" });
  assert.equal(store.snapshot().board.projects[0]!.repo, "Org/Coordinated");
  assert.equal((await store.log({ limit: 1 }))[0]!.author, architect);
  const unchanged = store.snapshot();
  await assert.rejects(op.updateProject({ author: "Whitefoot", name: "Missing", repo: "Org/Missing" }), /project Missing.*configured/);
  assert.deepEqual(store.snapshot(), unchanged);
  await op.createItem({ ...asArchitect, key: "new-area", title: "Area", accept: "Pass", group: "New project", priority: "P2" });
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("Architect reorders and creates projects after an existing project in one commit, while omitted after preserves defaults", async t => {
  const { store, op, dir } = await board(t);
  const names = () => store.snapshot().board.projects.map(p => p.name);
  const initial = store.snapshot();
  let count = (await store.log()).length;
  await op.updateProject({ ...asArchitect, name: "Whitefoot", after: "Firn" });
  assert.deepEqual(names(), ["Firn", "Whitefoot", "总管", "Architect"]);
  assert.deepEqual(store.snapshot().items, initial.items);
  assert.equal((await store.log()).length, ++count);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files, ["board.yaml"]);
  await op.updateProject({ ...asArchitect, name: "总管", repo: "Org/Coordinator", after: "Firn" });
  assert.deepEqual(names(), ["Firn", "总管", "Whitefoot", "Architect"]);
  assert.equal(store.snapshot().board.projects[1]!.repo, "Org/Coordinator");
  assert.equal((await store.log()).length, ++count);
  await op.createProject({ ...asArchitect, name: "Inserted", repo: "Org/Inserted", after: "Firn" });
  assert.deepEqual(names(), ["Firn", "Inserted", "总管", "Whitefoot", "Architect"]);
  assert.deepEqual(store.snapshot().board.projects[1], { name: "Inserted", repo: "Org/Inserted" });
  assert.equal((await store.log()).length, ++count);
  await op.createProject({ author: "Any caller", name: "Last" });
  assert.deepEqual(names(), ["Firn", "Inserted", "总管", "Whitefoot", "Architect", "Last"]);
  assert.equal((await store.log()).length, ++count);
  await op.updateProject({ author: "Whitefoot", name: "Whitefoot", repo: "Org/Changed" });
  assert.deepEqual(names(), ["Firn", "Inserted", "总管", "Whitefoot", "Architect", "Last"]);
  assert.equal((await store.log()).length, ++count);
  await op.updateProject({ ...asArchitect, name: "Firn", after: "Last" });
  assert.deepEqual(names(), ["Inserted", "总管", "Whitefoot", "Architect", "Last", "Firn"]);
  assert.equal((await store.log()).length, ++count);
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("project after rejects every author but Architect, unknown projects and self placement atomically", async t => {
  const { store, op, dir } = await board(t), before = store.snapshot(), count = (await store.log()).length;
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.updateProject({ author: "Whitefoot", name: "Whitefoot", after: "Firn" }), /after: only Architect with session 架构师 may reorder projects/],
    [() => op.updateProject({ author: "Whitefoot", name: "Whitefoot", repo: "Org/Changed", after: "Firn" }), /after: only Architect with session 架构师 may reorder projects/],
    [() => op.updateProject({ author: "Firn", name: "Whitefoot", repo: "Org/Changed", after: "Firn" }), /only that project or Architect with session 架构师 may update its repo/],
    [() => op.createProject({ author: "Whitefoot", name: "New", after: "Firn" }), /after: only Architect with session 架构师 may reorder projects/],
    [() => op.createProject({ author: "Any caller", name: "New", after: "Firn" }), /after: only Architect with session 架构师 may reorder projects/],
    [() => op.updateProject({ author: "总管", name: "Whitefoot", after: "Firn" }), /author 总管: this identity is retired; write as Architect/],
    [() => op.updateProject({ author: "总管", name: "Whitefoot", repo: "Org/Changed" }), /author 总管: this identity is retired; write as Architect/],
    [() => op.createProject({ author: "总管", name: "New" }), /author 总管: this identity is retired; write as Architect/],
    [() => op.updateProject({ ...asArchitect, name: "Whitefoot", repo: "Org/Changed", after: "Missing" }), /after Missing.*configured/],
    [() => op.createProject({ ...asArchitect, name: "New", after: "Missing" }), /after Missing.*configured/],
    [() => op.updateProject({ ...asArchitect, name: "Missing", after: "Firn" }), /project Missing.*configured/],
    [() => op.updateProject({ ...asArchitect, name: "Whitefoot", after: "Whitefoot" }), /after.*cannot follow itself/],
    [() => op.createProject({ ...asArchitect, name: "New", after: "New" }), /after.*cannot follow itself/],
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
  await committed(() => op.setTerm({ ...asArchitect, term: "否决线", definition: "架构师的说法" }), architect, "set_term 否决线", "glossaries/Architect.yaml");
  await committed(() => op.setTerm({ author, term: "否决线", definition: "性能比较里判定变慢的界线。" }), author, "set_term 否决线", "glossaries/Whitefoot.yaml");
  const entry = (term: string, definition: string, by = author) => ({ term, definition, updated: later, by });
  assert.deepEqual(store.snapshot().glossaries, {
    Whitefoot: { terms: [entry("孪生对照", "同一构建的第二份副本，一起跑来显示噪声。"), entry("否决线", "性能比较里判定变慢的界线。")], rev: 3 },
    Architect: { terms: [entry("否决线", "架构师的说法", architect)], rev: 1 },
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
  await op.createItem({ ...asArchitect, key: "record-with-targets", title: "Goal numbers", record: true, group: author, priority: "P1" });
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
  await op.setStatus({ ...asArchitect, id: "a", status: "cancelled", log: "Pause delivery while retaining the completed checks" });
  assert.deepEqual(store.snapshot().items.a!.plan, beforeCancel, "cancellation preserves every row, acceptance states, dates, waits and after edges included");
  assert.equal(rules(store.snapshot()).statusOf("a"), "cancelled");
  await op.setStatus({ ...asArchitect, id: "a", status: "open", log: "Resume delivery with the same checks" });
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
  await op.createItem({ ...asArchitect, key: "scenarios", group: author, title: "All scenarios pass", priority: "P1", accept: "Final scenario passes", plan: [
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
    [{ rows: [{ item: "a", own: false, after: [] }, { card: "choice", after: [] }, { card: "ruled", after: [] }] }, /accept/],
    [{ remove: "accept" }, /at least one acceptance/],
    [{ row: { item: "missing", own: false } }, /依赖的条目不存在/],
    [{ row: { card: "missing" } }, /write_card creates the card; a plan write cannot add it/],
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
  await op.createItem({ ...asArchitect, key: "parent", title: "Combined", group: author, accept: "Both accepted", priority: "P0", children: ["a", "b"] });
  const s = store.snapshot(); assert.equal(rules(s).parentOf("a"), "parent"); assert.equal(rules(s).parentOf("b"), "parent");
  assert.deepEqual(s.items.parent!.plan!.map(row => row.id), ["a", "b", "accept"]);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["items/a.yaml", "items/area.yaml", "items/b.yaml", "items/parent.yaml", "numbers.yaml"], "the issued number's counter enters the creating commit");
  await op.createRequest({ author, project: "Firn", key: "request", title: "Witness", head: "Minimal program", accept: "Program passes", why: "Required for completion", from: "parent", after: [] });
  assert.equal(rules(store.snapshot()).priorityOf("request"), "P0");
  assert.match(store.snapshot().items.request!.log[0]!.text, /Required for completion/);
  await ops(store).triageRequest({ author: "Firn", id: "request", log: "Accepted" });
  assert.equal(store.snapshot().items.request!.request, undefined);
});

test("record-owned backlog work refuses priority even with external dependents, and cancellation refuses open parts", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "backlog", title: "Backlog", group: author, record: true });
  await op.moveItem({ author, id: "a", owner: "backlog" });
  await op.createRequest({ author: "Firn", project: author, key: "request", title: "Need", head: "Witness", accept: "Pass", why: "Need", from: "other" });
  await op.setPlan({ author: "Firn", id: "other", row: { item: "a", own: false, after: [] } });
  const r = rules(store.snapshot()); assert.equal(r.isRoot("a"), false); assert.equal(r.priorityOf("a"), "P1");
  await assert.rejects(op.updateItem({ author, id: "a", rev: store.snapshot().items.a!.rev, priority: "P2" }), /record-owned.*cannot store priority.*open shared dependents/);
  await assert.rejects(op.setStatus({ ...asArchitect, id: "area", status: "cancelled", log: "Superseded" }), /owned items.*b/);
  await op.setStatus({ ...asArchitect, id: "b", status: "cancelled", log: "Superseded" });
  await op.setStatus({ ...asArchitect, id: "area", status: "cancelled", log: "Parts disposed" });
  await op.setStatus({ ...asArchitect, id: "area", status: "open", log: "Resume" });
  assert.equal(store.snapshot().items.area!.status, undefined);
});

test("record mode preserves parts and logs removed acceptance; provisional full writes clear the mark once", async t => {
  const { store, op } = await board(t);
  await op.updateItem({ author, id: "area", rev: 1, record: true });
  const record = store.snapshot().items.area!; assert.equal(record.plan!.length, 2); assert.match(record.log.at(-1)!.text, /原验收：解释器目标通过/);
  await assert.rejects(op.setStatus({ ...asArchitect, id: "area", status: "cancelled", log: "Drop" }), /record/);
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
  await assert.rejects(op.createItem({ ...asArchitect, key: "missing-accept", group: author, title: "New", priority: "P1" }), /accept/);
  await assert.rejects(op.createItem({ ...asArchitect, key: "record-accept", group: author, title: "Record", record: true, accept: "Wrong" }), /accept/);
  await assert.rejects(op.createItem({ ...asArchitect, key: "old-status", group: author, title: "New", accept: "Pass", priority: "P1", status: "todo" } as Parameters<Ops["createItem"]>[0]), /no status argument/);
  assert.deepEqual(store.snapshot(), before); assert.deepEqual((await Store.open(dir)).snapshot(), before);
});

test("card writes validate the question, option names, revisions and project ownership, and place the row where asked", async t => {
  const { store, op } = await board(t), before = store.snapshot();
  const args = { author, key: "new-card", item: "a", question: "Choose?", options: [{ text: "Option" }] };
  for (const invalid of [
    { options: [] }, { options: [{ text: "A", recommended: true }, { text: "B", recommended: true }] },
    { options: [{ text: "x".repeat(21) }] }, { options: [{ text: "two\nlines" }] }, { question: "two\nlines" }, { item: "missing" },
  ]) { await assert.rejects(op.writeCard({ ...args, ...invalid }), OpError); assert.deepEqual(store.snapshot(), before); }
  await assert.rejects(op.writeCard({ ...args, author: "Firn" }), /belongs to project Whitefoot/);
  // An option name of exactly 20 characters is fine, spaces not counted.
  await op.writeCard({ ...args, options: [{ text: "一二三四五六七八九十 一二三四五六七八九十" }, { text: "B" }] });
  assert.deepEqual(store.snapshot().decisions["new-card"]!.options.map(o => o.key), ["A", "B"]);
  // The row is in a's plan, before the acceptance step, which now waits for the card.
  assert.deepEqual(store.snapshot().items.a!.plan.map(row => row.id), ["new-card", "accept"]);
  assert.deepEqual(store.snapshot().items.a!.plan.at(-1), { id: "accept", accept: true, text: "独立验收通过", state: "todo", after: ["new-card"] });
  await op.ruleCard({ author, key: "new-card", choice: "A" });
  const ruled = store.snapshot().decisions["new-card"]!; assert.equal(ruled.status, "ruled"); assert.equal(ruled.choice, "A"); assert.equal(ruled.ruledAt, later);
  await assert.rejects(op.writeCard({ ...args, rev: ruled.rev }), /only an open card/);
  await assert.rejects(op.ruleCard({ author, key: "choice", choice: "wrong" }), /option keys/);
  await assert.rejects(op.ruleCard({ author, key: "new-card", choice: "A" }), /only an open card/);
});

test("write_card places the row where before and after say, and a row it waits for is not lost", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author, id: "a", rows: [
    { id: "one", text: "One", state: "todo" }, { id: "two", text: "Two", state: "todo" }, { id: "three", text: "Three", state: "todo", after: ["one"] },
    { id: "accept", accept: true, text: "独立验收通过", state: "todo" },
  ] });
  await op.writeCard({ author, key: "mid", item: "a", question: "Where?", options: [{ text: "Here" }], before: "three", after: ["one"] });
  const plan = store.snapshot().items.a!.plan;
  assert.deepEqual(plan.map(row => row.id), ["one", "two", "mid", "three", "accept"]);
  assert.deepEqual(plan[2], { id: "mid", card: "mid", after: ["one"] });
  assert.deepEqual(plan[3], { id: "three", text: "Three", state: "todo", after: ["one", "mid"] }, "the row that waits for the card keeps what it waited for");
  await assert.rejects(op.writeCard({ author, key: "dangling", item: "a", question: "Where?", options: [{ text: "Here" }], after: ["missing"] }), /after must name earlier rows/);
  assert.equal(Object.hasOwn(store.snapshot().decisions, "dangling"), false, "a refused placement writes no card");
});

test("withdraw_card closes an open card, counts its row done and logs the reason on the item", async t => {
  const { store, op } = await board(t);
  const result = await op.withdrawCard({ author, key: "choice", log: "The decision moved to chat" });
  const card = store.snapshot().decisions.choice!;
  assert.deepEqual([card.status, card.choice, card.ruledAt], ["withdrawn", undefined, later]);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["decisions/choice.yaml", "items/b.yaml"]);
  assert.equal(result.commit, store.snapshot().head);
  assert.match(store.snapshot().items.b!.log.at(-1)!.text, /撤回了决策卡「中文方案？」：The decision moved to chat/);
  const r = rules(store.snapshot());
  assert.equal(r.planRows("b").find(row => row.row.id === "choice")!.state, "resolved");
  assert.equal(r.cardWaiting("choice"), false);
  await assert.rejects(op.withdrawCard({ author, key: "choice", log: "Again" }), /only an open card/);
  await assert.rejects(op.writeCard({ author, key: "choice", rev: card.rev, item: "b", question: "Again?", options: [{ text: "A" }] }), /only an open card/);
});

test("priority is only stored on roots and is removed atomically when a new plan dependent appears", async t => {
  const { store, op } = await board(t);
  await assert.rejects(op.updateItem({ author, id: "a", rev: 1, priority: "P0" }), /只有.*根条目/);
  await op.createItem({ ...asArchitect, group: "Firn", key: "remote", title: "Root result", priority: "P2", accept: "Pass" });
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

test("required validation skips unrelated items for log and local plan writes", async t => {
  const { store, op } = await board(t);
  const snapshot = store.snapshot.bind(store);
  let unrelatedChecks = 0;
  t.mock.method(store, "snapshot", () => {
    const s = snapshot(), unrelated = { ...s.items.other! };
    // checks() reads provisional; ownership, priority and status do not. The
    // accessor observes visits without adding a production instrumentation API.
    Object.defineProperty(unrelated, "provisional", { enumerable: true, get() { unrelatedChecks++; return undefined; } });
    return { ...s, items: { ...s.items, other: unrelated } };
  });
  await op.appendLog({ author, id: "a", text: "New evidence" });
  assert.equal(unrelatedChecks, 0, "an unrelated check is not revisited for a log-only write");
  await op.setPlan({ author, id: "a", row: { id: "local", text: "Own implementation", state: "todo" } });
  assert.equal(unrelatedChecks, 0, "a changed plan checks its affected graph, not unrelated items");
});

test("reopening a waiter refuses a new ownership violation on its unwritten shared target", async t => {
  const { store, op, dir } = await board(t);
  const acceptance = [{ id: "accept", accept: true, text: "Check passes", state: "todo" as const }];
  await store.commit({ author: "Fixture", message: "Closed waiter and loose work", puts: [
    { kind: "item", id: "loose", expectRev: null, doc: { title: "Loose work", group: author, plan: acceptance, updated: at } },
    { kind: "item", id: "waiter", expectRev: null, doc: { title: "Cancelled waiter", group: author, status: "cancelled", plan: [{ id: "loose", item: "loose", own: false }, ...acceptance], updated: at } },
  ] });
  const before = store.snapshot();
  assert.equal(before.items.loose!.priority, undefined, "priority cleanup must not turn the target into a written item");
  assert.ok(!rules(before).checks("loose").some(c => c.text.includes("没有条目拥有")));
  await assert.rejects(op.setStatus({ ...asArchitect, id: "waiter", status: "open", log: "Resume waiting" }), /item loose:.*同项目有条目在等它，却没有条目拥有它.*move_item/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before, "refusal preserves documents, revisions and head on disk too");
});

test("reopening a child refuses a new ownership violation on its unwritten status ancestor", async t => {
  const { store, op, dir } = await board(t);
  const acceptance = (state: "done" | "todo") => ({ id: "accept", accept: true, text: "Check passes", state, ...(state === "done" ? { doneAt: at } : {}) });
  await store.commit({ author: "Fixture", message: "Closed shared target with a cancelled part", puts: [
    { kind: "item", id: "part", expectRev: null, doc: { title: "Cancelled part", group: author, status: "cancelled", plan: [acceptance("todo")], updated: at } },
    { kind: "item", id: "loose", expectRev: null, doc: { title: "Completed shared target", group: author, plan: [{ id: "part", item: "part", own: true }, acceptance("done")], updated: at } },
    { kind: "item", id: "waiter", expectRev: null, doc: { title: "Open waiter", group: author, priority: "P1", plan: [{ id: "loose", item: "loose", own: false }, acceptance("todo")], updated: at } },
  ] });
  const before = store.snapshot();
  assert.equal(rules(before).statusOf("loose"), "done");
  assert.equal(before.items.loose!.priority, undefined);
  await assert.rejects(op.setStatus({ ...asArchitect, id: "part", status: "open", log: "Resume part" }), /item loose:.*同项目有条目在等它，却没有条目拥有它.*move_item/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
});

test("acceptance naming avoids collisions with valid ordinary rows", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "collision", group: author, title: "New", priority: "P1", accept: "Pass", plan: [{ id: "accept", text: "Ordinary work", state: "todo" }] });
  assert.deepEqual(store.snapshot().items.collision!.plan.map(row => row.id), ["accept", "accept-1"]);
  await op.createItem({ ...asArchitect, key: "record-collision", group: author, title: "Record", record: true, plan: [{ id: "accept", text: "Ordinary record entry", state: "todo" }] });
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
      await op.createItem({ ...asArchitect, key: owner, group: author, title: "Requested work owner", accept: "Owner passes", priority: "P0",
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

test("Architect pause and resume are atomic, server-stamped and preserve every plan row", async t => {
  const { store, op, dir } = await board(t);
  await op.clearAsk({ author, id: "a", log: "Owner already approved" });
  await op.setPlan({ author, id: "a", row: { id: "work", text: "Implementation", state: "doing" } });
  const before = store.snapshot(), plans = Object.fromEntries(Object.entries(before.items).map(([id, it]) => [id, it.plan]));
  const statuses = Object.fromEntries(["area", "a", "b"].map(id => [id, rules(before).statusOf(id)]));
  const count = (await store.log()).length;
  const result = await op.setPause({ ...asArchitect, id: "area", paused: true, reason: "  Owner paused the project  " });
  const paused = store.snapshot();
  assert.equal((await store.log()).length, count + 1);
  assert.equal(result.commit, paused.head);
  assert.deepEqual(paused.items.area!.paused, { reason: "Owner paused the project", at: later });
  assert.deepEqual(paused.items.area!.log.at(-1), { at: later, by: architect, text: "暂停：Owner paused the project" });
  for (const id of ["area", "a", "b"]) assert.equal(rules(paused).statusOf(id), "paused");
  assert.deepEqual(Object.fromEntries(Object.entries(paused.items).map(([id, it]) => [id, it.plan])), plans);
  assert.deepEqual((await Store.open(dir)).snapshot().items.area!.paused, paused.items.area!.paused);
  await op.setPause({ ...asArchitect, id: "a", paused: false });
  assert.equal(store.snapshot().head, paused.head, "resuming an inherited pause changes nothing");
  await op.setPause({ ...asArchitect, id: "area", paused: true, reason: "Owner paused the project" });
  assert.equal(store.snapshot().head, paused.head, "repeating the same pause adds no commit or log");
  await op.setPause({ ...asArchitect, id: "area", paused: false });
  const resumed = store.snapshot();
  assert.equal((await store.log()).length, count + 2);
  assert.equal(resumed.items.area!.paused, undefined);
  assert.deepEqual(resumed.items.area!.log.at(-1), { at: later, by: architect, text: "恢复" });
  for (const id of ["area", "a", "b"]) assert.equal(rules(resumed).statusOf(id), statuses[id]);
  assert.deepEqual(Object.fromEntries(Object.entries(resumed.items).map(([id, it]) => [id, it.plan])), plans);
});

test("pause refusals preserve memory, disk and commits for authors, missing reason and closed or record targets", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, group: author, key: "record-pause", title: "Record", record: true });
  await op.createItem({ ...asArchitect, group: author, key: "done-pause", title: "Done", priority: "P1", accept: "Done accepted" });
  await op.setPlan({ author, id: "done-pause", rows: [{ id: "accept", accept: true, text: "Done accepted", state: "done" }] });
  await op.createItem({ ...asArchitect, group: author, key: "cancel-pause", title: "Cancelled", priority: "P1", accept: "Cancelled accepted" });
  await op.setStatus({ ...asArchitect, id: "cancel-pause", status: "cancelled", log: "No longer needed" });
  const cases: Array<[Parameters<Ops["setPause"]>[0], RegExp]> = [
    [{ author, id: "a", paused: true, reason: "No permission" }, /author: only Architect with session 架构师 may pause or resume/],
    [{ author, id: "a", paused: false }, /author: only Architect with session 架构师 may pause or resume/],
    [{ ...asArchitect, id: "a", paused: true }, /reason.*required/],
    [{ ...asArchitect, id: "a", paused: true, reason: "   " }, /reason.*(nonempty|required)/],
    [{ ...asArchitect, id: "record-pause", paused: true, reason: "Record" }, /record cannot be paused/],
    [{ ...asArchitect, id: "record-pause", paused: false }, /record cannot be paused/],
    [{ ...asArchitect, id: "done-pause", paused: true, reason: "Done" }, /done or cancelled/],
    [{ ...asArchitect, id: "cancel-pause", paused: true, reason: "Cancelled" }, /done or cancelled/],
    [{ ...asArchitect, id: "done-pause", paused: false }, /done or cancelled/],
    [{ ...asArchitect, id: "cancel-pause", paused: false }, /done or cancelled/],
  ];
  const before = store.snapshot(), count = (await store.log()).length;
  for (const [input, refusal] of cases) {
    await assert.rejects(op.setPause(input), refusal);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
});

test("cancelling work and converting it to a record cannot clear an owner pause", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, group: author, key: "pause-cancel", title: "Work", priority: "P1", accept: "Check", plan: [{ id: "doing", text: "Implementation", state: "doing" }] });
  await op.setPause({ ...asArchitect, id: "pause-cancel", paused: true, reason: "Parked" });
  const paused = store.snapshot().items["pause-cancel"]!, plan = paused.plan, marker = paused.paused;
  await op.setStatus({ ...asArchitect, id: "pause-cancel", status: "cancelled", log: "No longer needed" });
  assert.equal(rules(store.snapshot()).statusOf("pause-cancel"), "cancelled");
  assert.deepEqual(store.snapshot().items["pause-cancel"]!.paused, marker, "cancellation does not clear the owner's pause");
  assert.deepEqual(store.snapshot().items["pause-cancel"]!.plan, plan);
  await op.setStatus({ ...asArchitect, id: "pause-cancel", status: "open", log: "Needed again" });
  assert.equal(rules(store.snapshot()).statusOf("pause-cancel"), "paused", "reopening cannot silently resume the owner's pause");
  await op.setPause({ ...asArchitect, id: "pause-cancel", paused: false });
  assert.equal(rules(store.snapshot()).statusOf("pause-cancel"), "wip");
  assert.deepEqual(store.snapshot().items["pause-cancel"]!.plan, plan);
  await op.setPause({ ...asArchitect, id: "a", paused: true, reason: "Parked" });
  const before = store.snapshot(), count = (await store.log()).length;
  await assert.rejects(op.updateItem({ author, id: "a", rev: before.items.a!.rev, record: true }), /paused.*中文检查.*only the owner or Architect with session 架构师 can resume/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal((await store.log()).length, count);
  await op.setPause({ ...asArchitect, id: "a", paused: false });
  await op.updateItem({ author, id: "a", rev: store.snapshot().items.a!.rev, record: true });
  assert.equal(store.snapshot().items.a!.paused, undefined);
  assert.equal(store.snapshot().items.a!.record, true);
});

test("only Architect can clear a retained pause after work completes or is cancelled", async t => {
  const { store, op } = await board(t);
  for (const state of ["done", "cancelled"] as const) {
    const id = `pause-closed-${state}`;
    await op.createItem({ ...asArchitect, group: author, key: id, title: "Closed work", priority: "P1", accept: "Check" });
    await op.setPause({ ...asArchitect, id, paused: true, reason: "Owner paused" });
    if (state === "done") await op.setPlan({ author, id, rows: [{ id: "accept", accept: true, text: "Check", state: "done" }] });
    else await op.setStatus({ ...asArchitect, id, status: "cancelled", log: "Not needed" });
    const before = store.snapshot(), plan = before.items[id]!.plan;
    assert.equal(rules(before).statusOf(id), state);
    assert.ok(before.items[id]!.paused, "ordinary closure retains the owner's marker");
    await assert.rejects(op.setPause({ author, id, paused: false }), /only Architect with session 架构师 may pause or resume an item/);
    assert.deepEqual(store.snapshot(), before);
    await op.setPause({ ...asArchitect, id, paused: false });
    assert.equal(store.snapshot().items[id]!.paused, undefined);
    assert.equal(rules(store.snapshot()).statusOf(id), state);
    assert.deepEqual(store.snapshot().items[id]!.plan, plan);
  }
});


test("other projects still refuse cross-project writes without changing memory, disk or HEAD", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const before = store.snapshot(), count = (await store.log()).length;
  const calls = [
    () => op.setPlan({ author: "Firn", id: "a", row: { id: "accept", accept: true, text: "Changed acceptance", state: "todo" } }),
    () => op.updateItem({ author: "Firn", id: "a", rev: before.items.a!.rev, head: "Changed head", reason: "Foreign" }),
    () => op.moveItem({ author: "Firn", id: "a", owner: "other" }),
    () => op.appendLog({ author: "Firn", id: "a", text: "Foreign log" }),
    () => op.writeCard({ author: "Firn", key: "foreign-card", item: "a", question: "Q?", options: [{ text: "A" }] }),
    () => op.ruleCard({ author: "Firn", key: "choice", choice: "A" }),
    () => op.withdrawCard({ author: "Firn", key: "choice", log: "Not needed" }),
    () => op.replyNote({ author: "Firn", id: "note-1", reply: "Answer" }),
    () => op.closeNote({ author: "Firn", id: "note-1", log: "Handled" }),
  ];
  for (const call of calls) {
    await assert.rejects(call(), /item [ab] belongs to project Whitefoot; file a request into Whitefoot with create_request instead/);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal(store.snapshot().head, before.head);
    assert.equal((await store.log()).length, count);
  }
});

test("Architect writes any project's items, cards and note replies under its own name", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const lastAuthor = async () => (await store.log({ limit: 1 }))[0]!.author;
  const mine = async (call: () => Promise<Result>) => { await call(); assert.equal(await lastAuthor(), architect, "the commit names Architect, not the item's project"); };
  await mine(() => op.appendLog({ ...asArchitect, id: "a", text: "Architect evidence" }));
  assert.deepEqual(store.snapshot().items.a!.log.at(-1), { at: later, by: architect, text: "Architect evidence" });
  await mine(() => op.setPlan({ ...asArchitect, id: "a", row: { id: "work", text: "Implementation", state: "doing" } }));
  await mine(() => op.setTargets({ ...asArchitect, id: "a", target: goalNumbers }));
  await mine(() => op.updateItem({ ...asArchitect, id: "a", rev: store.snapshot().items.a!.rev, head: "Revised by Architect", reason: "Scope settled" }));
  assert.deepEqual(store.snapshot().items.a!.log.at(-1), { at: later, by: architect, text: "改了 head：Scope settled" });
  await mine(() => op.moveItem({ ...asArchitect, id: "a", owner: "other" }));
  assert.equal(rules(store.snapshot()).parentOf("a"), "other");
  await mine(() => op.writeCard({ ...asArchitect, key: "architect-card", item: "a", question: "Choose?", options: [{ text: "A" }] }));
  await mine(() => op.ruleCard({ ...asArchitect, key: "architect-card", choice: "A" }));
  await mine(() => op.replyNote({ ...asArchitect, id: "note-1", reply: "Answer" }));
  assert.equal(store.snapshot().notes["note-1"]!.repliedBy, architect);
  await store.commit({ author: "Fixture", message: "Another sent note", puts: [{ kind: "note", id: "note-3", expectRev: null, doc: { target: "it:a", kind: "comment", text: "又一条意见", at, sentAt: at, state: "sent" } }] });
  await mine(() => op.closeNote({ ...asArchitect, id: "note-3", log: "Handled" }));
  assert.equal(store.snapshot().notes["note-3"]!.repliedBy, architect);
  await mine(() => op.setStatus({ ...asArchitect, id: "b", status: "cancelled", log: "Superseded" }));
  await mine(() => op.setStatus({ ...asArchitect, id: "b", status: "open", log: "Resume" }));
  await mine(() => op.setPause({ ...asArchitect, id: "b", paused: true, reason: "Owner chose to wait" }));
  await mine(() => op.createItem({ ...asArchitect, key: "made-for-firn", group: "Firn", title: "Made for Firn", priority: "P1", accept: "Pass" }));
  assert.equal(store.snapshot().items["made-for-firn"]!.group, "Firn", "the new item belongs to the project named by group, not to Architect");
  for (const id of ["a", "b"]) assert.equal(store.snapshot().items[id]!.group, author, "Architect's writes never move an item to another project");
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("only Architect from session 架构师 creates items, cancels or reopens them, changes a title, moves them to another project, pauses or resumes, and changes the tag vocabulary", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  await op.createItem({ ...asArchitect, key: "own-item", group: architect, title: "Architect's own", accept: "Pass", priority: "P1" });
  const before = store.snapshot(), count = (await store.log()).length, rev = before.items.a!.rev;
  const tag = { name: "新标签", meaning: "测试用" };
  const only = (what: string) => new RegExp(`^author: only Architect with session 架构师 may ${what}`);
  // The item's own project, another project, and the Architect project with no session, another session or a near miss.
  const writers = [{ author }, { author: "Firn" }, { author, session: "架构师" }, { author: architect }, { author: architect, session: "engineer" }, { author: architect, session: "架构师x" }];
  const cases: Array<[() => Promise<unknown>, RegExp]> = [];
  for (const who of writers) cases.push(
    [() => op.createItem({ ...who, key: "made", group: who.author, title: "Made", accept: "Pass", priority: "P1" }), only("create items")],
    [() => op.setStatus({ ...who, id: "b", status: "cancelled", log: "Drop" }), only("cancel or reopen an item")],
    [() => op.updateItem({ ...who, id: "a", rev, title: "Renamed" }), only("change an item's title")],
    [() => op.setPause({ ...who, id: "a", paused: true, reason: "Wait" }), only("pause or resume an item")],
    [() => op.setPause({ ...who, id: "a", paused: false }), only("pause or resume an item")],
    [() => op.setTag({ ...who, ...tag }), only("change the tag vocabulary")],
    [() => op.renameTag({ ...who, name: tag.name, to: "改名" }), only("change the tag vocabulary")],
    [() => op.removeTag({ ...who, name: tag.name }), only("change the tag vocabulary")],
    [() => op.moveItemProject({ ...who, id: "a", project: "Firn" }), only("move an item to another project")],
    [() => op.createProject({ ...who, name: "New", after: "Firn" }), /^after: only Architect with session 架构师 may reorder projects/],
    [() => op.updateProject({ ...who, name: "总管", repo: "Org/Changed" }), /^project 总管: only that project or Architect with session 架构师 may update its repo$/],
  );
  // Even the Architect project's own item is out of reach of these operations without the session.
  for (const who of [{ author: architect }, { author: architect, session: "engineer" }]) cases.push(
    [() => op.setStatus({ ...who, id: "own-item", status: "cancelled", log: "Drop" }), only("cancel or reopen an item")],
    [() => op.updateItem({ ...who, id: "own-item", rev: before.items["own-item"]!.rev, title: "Renamed" }), only("change an item's title")],
    [() => op.moveItemProject({ ...who, id: "own-item", project: "Firn" }), only("move an item to another project")],
  );
  for (const [call, message] of cases) {
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
  // What the engineer writes stays open to the item's project: a head with the title unchanged, the log and plan progress.
  await op.updateItem({ author, id: "a", rev, title: before.items.a!.title, head: "改动一节由工程师写", reason: "Changes recorded" });
  await op.appendLog({ author, id: "a", text: "Evidence" });
  await op.setPlan({ author, id: "a", row: { id: "work", text: "Implementation", state: "doing" } });
  assert.equal(store.snapshot().items.a!.title, before.items.a!.title);
  assert.equal(store.snapshot().items.a!.head, "改动一节由工程师写");
});

test("Architect from another session writes only the Architect project's items, and a padded session name still counts", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  await op.createItem({ ...asArchitect, key: "own-item", group: architect, title: "Architect's own", accept: "Pass", priority: "P1" });
  const engineer = { author: architect, session: "engineer" };
  // An engineer working in the Architect project is an ordinary project author there.
  await op.appendLog({ ...engineer, id: "own-item", text: "Engineer evidence" });
  await op.setPlan({ ...engineer, id: "own-item", row: { id: "work", text: "Implementation", state: "doing" } });
  assert.deepEqual(store.snapshot().items["own-item"]!.log.at(-1), { at: later, by: architect, text: "Engineer evidence" });
  const before = store.snapshot(), count = (await store.log()).length;
  for (const who of [engineer, { author: architect }]) {
    await assert.rejects(op.appendLog({ ...who, id: "a", text: "Foreign" }), /item a belongs to project Whitefoot; file a request into Whitefoot with create_request instead; Architect writes other projects' items only with session 架构师/);
    await assert.rejects(op.writeCard({ ...who, key: "foreign-card", item: "a", question: "Q?", options: [{ text: "A" }] }), /item a belongs to project Whitefoot/);
    await assert.rejects(op.replyNote({ ...who, id: "note-1", reply: "Answer" }), /item a belongs to project Whitefoot/);
    await assert.rejects(op.moveItem({ ...who, id: "a", owner: "other" }), /item a belongs to project Whitefoot/);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
  await op.appendLog({ author: architect, session: "  架构师  ", id: "a", text: "Padded session" });
  assert.deepEqual(store.snapshot().items.a!.log.at(-1), { at: later, by: architect, text: "Padded session" });
  assert.equal((await store.log({ limit: 1 }))[0]!.session, "架构师", "the commit records the trimmed session");
});

test("a cancelled item turns into a record only by Architect, so a project cannot reopen it through record mode", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  for (const [key, group] of [["dropped", author], ["dropped-own", architect]] as const) {
    await op.createItem({ ...asArchitect, key, group, title: "Dropped work", accept: "Pass", priority: "P1" });
    await op.setStatus({ ...asArchitect, id: key, status: "cancelled", log: "Not needed" });
  }
  const before = store.snapshot(), count = (await store.log()).length;
  // The item's own project, with or without the session name, never gets past the gate.
  const attempts: Array<[string, { author: string; session?: string }]> = [["dropped", { author }], ["dropped", { author, session: "架构师" }], ["dropped-own", { author: architect }], ["dropped-own", { author: architect, session: "engineer" }]];
  for (const [id, who] of attempts) {
    await assert.rejects(op.updateItem({ ...who, id, rev: before.items[id]!.rev, record: true }), /author: only Architect with session 架构师 may turn a cancelled item into a record/);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
  // This gate comes after the ownership check: another project's author hears whose item it is.
  await assert.rejects(op.updateItem({ author: "Firn", id: "dropped", rev: before.items.dropped!.rev, record: true }), /item dropped belongs to project Whitefoot/);
  assert.deepEqual(store.snapshot(), before);
  // Work that is not cancelled still becomes a record by its project, and Architect may convert the cancelled one.
  await op.updateItem({ author, id: "a", rev: before.items.a!.rev, record: true });
  assert.equal(store.snapshot().items.a!.record, true);
  await op.updateItem({ ...asArchitect, id: "dropped", rev: before.items.dropped!.rev, record: true });
  assert.equal(store.snapshot().items.dropped!.record, true);
  assert.equal(store.snapshot().items.dropped!.status, undefined);
});

test("Architect's reach across projects keeps the same-project ownership rules", async t => {
  const { store, op, dir } = await board(t);
  const before = store.snapshot(), count = (await store.log()).length;
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.createItem({ ...asArchitect, key: "x", owner: "area", group: "Firn", title: "X", accept: "Pass" }), /owner: ownership must stay within the same project/],
    [() => op.moveItem({ ...asArchitect, id: "a", owner: "other" }), /owner: ownership must stay within the same project/],
    [() => op.setPlan({ ...asArchitect, id: "other", row: { item: "a", own: true } }), /跨项目拥有 a; use a shared row/],
    [() => op.createItem({ ...asArchitect, key: "x", group: "Firn", title: "X", accept: "Pass", priority: "P1", children: ["a"] }), /跨项目拥有 a; use a shared row/],
  ];
  for (const [call, message] of cases) {
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError); assert.match(e.message, message); return true; });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
});

test("Architect without the session cannot resume paused work in its own project either", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "arch-parent", group: architect, title: "Paused release", priority: "P1", accept: "Release passes" });
  await op.createItem({ ...asArchitect, key: "arch-child", owner: "arch-parent", title: "Paused implementation", accept: "Implementation passes", plan: [{ id: "work", text: "Implementation", state: "doing" }] });
  await op.createItem({ ...asArchitect, key: "arch-other", group: architect, title: "Active release", priority: "P2", accept: "Active release passes" });
  await op.createItem({ ...asArchitect, key: "arch-marked", group: architect, title: "Marked work", priority: "P1", accept: "Marked passes" });
  await op.setPause({ ...asArchitect, id: "arch-parent", paused: true, reason: "Owner chose to wait" });
  await op.setPause({ ...asArchitect, id: "arch-marked", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  const resume = /only the owner or Architect with session 架构师 can resume/;
  for (const who of [{ author: architect }, { author: architect, session: "engineer" }]) {
    // Moving open work out of a paused chain, and converting a paused item to a record (which clears its marker).
    await assert.rejects(op.moveItem({ ...who, id: "arch-child", owner: "arch-other" }), resume);
    await assert.rejects(op.updateItem({ ...who, id: "arch-marked", rev: before.items["arch-marked"]!.rev, record: true }), resume);
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual((await Store.open(dir)).snapshot(), before);
    assert.equal((await store.log()).length, count);
  }
  await op.moveItem({ ...asArchitect, id: "arch-child", owner: "arch-other" });
  assert.equal(rules(store.snapshot()).statusOf("arch-child"), "wip");
});

test("every write under the retired author 总管 is refused and changes nothing", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const before = store.snapshot(), count = (await store.log()).length, retired = "总管";
  assert.ok(before.board.projects.some(p => p.name === retired), "the retired project is still configured, so only the retirement refuses");
  const calls: Record<keyof Ops, () => Promise<unknown>> = {
    createProject: () => op.createProject({ author: retired, name: "New" }),
    updateProject: () => op.updateProject({ author: retired, name: "Whitefoot", repo: "Org/Changed" }),
    createRequest: () => op.createRequest({ author: retired, project: "Firn", key: "req", title: "Req", head: "H", accept: "A", priority: "P1", why: "W" }),
    triageRequest: () => op.triageRequest({ author: retired, id: "a", log: "L" }),
    closeNote: () => op.closeNote({ author: retired, id: "note-1", log: "Handled" }),
    createItem: () => op.createItem({ author: retired, key: "x", group: retired, title: "X", accept: "Pass", priority: "P1" }),
    appendLog: () => op.appendLog({ author: retired, id: "a", text: "Log" }),
    journalEntry: () => op.journalEntry({ author: retired, text: "Entry" }),
    setPlan: () => op.setPlan({ author: retired, id: "a", row: { id: "work", text: "Work", state: "doing" } }),
    setTargets: () => op.setTargets({ author: retired, id: "a", target: goalNumbers }),
    updateItem: () => op.updateItem({ author: retired, id: "a", rev: before.items.a!.rev, title: "Renamed" }),
    setStatus: () => op.setStatus({ author: retired, id: "b", status: "cancelled", log: "Drop" }),
    setTags: () => op.setTags({ author: retired, id: "a", tags: ["健全性"] }),
    setTagsMany: () => op.setTagsMany({ author: retired, items: [{ id: "a", tags: ["健全性"] }] }),
    setTag: () => op.setTag({ author: retired, name: "新标签", meaning: "测试用" }),
    renameTag: () => op.renameTag({ author: retired, name: "健全性", to: "改名" }),
    removeTag: () => op.removeTag({ author: retired, name: "健全性" }),
    setPause: () => op.setPause({ author: retired, id: "a", paused: true, reason: "Wait" }),
    moveItem: () => op.moveItem({ author: retired, id: "a", owner: "other" }),
    moveItemProject: () => op.moveItemProject({ author: retired, id: "a", project: "Firn" }),
    clearAsk: () => op.clearAsk({ author: retired, id: "a", log: "Settled" }),
    writeCard: () => op.writeCard({ author: retired, key: "new-card", item: "a", question: "Q?", options: [{ text: "A" }] }),
    ruleCard: () => op.ruleCard({ author: retired, key: "choice", choice: "A" }),
    withdrawCard: () => op.withdrawCard({ author: retired, key: "choice", log: "Not needed" }),
    replyNote: () => op.replyNote({ author: retired, id: "note-1", reply: "Answer" }),
    setTerm: () => op.setTerm({ author: retired, term: "术语", definition: "定义" }),
    deleteTerm: () => op.deleteTerm({ author: retired, term: "术语" }),
  };
  for (const [name, call] of Object.entries(calls)) {
    await assert.rejects(call(), e => { assert.ok(e instanceof OpError, name); assert.match(e.message, /^author 总管: this identity is retired; write as Architect$/, name); return true; });
    assert.deepEqual(store.snapshot(), before, name);
    assert.deepEqual((await Store.open(dir)).snapshot(), before, name);
    assert.equal((await store.log()).length, count, name);
  }
});

test("moving inherited paused work out requires an authorized resume first", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "pause-parent", group: author, title: "Paused release", priority: "P1", accept: "Release passes" });
  await op.createItem({ ...asArchitect, key: "pause-child", owner: "pause-parent", title: "Paused implementation", accept: "Implementation passes", plan: [{ id: "work", text: "Implementation", state: "doing" }] });
  await op.createItem({ ...asArchitect, key: "resume-owner", group: author, title: "Active release", priority: "P2", accept: "Active release passes" });
  await op.setPause({ ...asArchitect, id: "pause-parent", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  await assert.rejects(op.moveItem({ author, id: "pause-child", owner: "resume-owner" }), /paused.*Paused implementation.*pause-child.*Paused release.*pause-parent.*only the owner or Architect with session 架构师 can resume/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
  assert.equal((await store.log()).length, count);
  await op.setPause({ ...asArchitect, id: "pause-parent", paused: false });
  await op.moveItem({ author, id: "pause-child", owner: "resume-owner" });
  assert.equal(rules(store.snapshot()).statusOf("pause-child"), "wip");
  assert.deepEqual(store.snapshot().items["pause-child"]!.plan, before.items["pause-child"]!.plan);
  await op.setPause({ ...asArchitect, id: "pause-parent", paused: true, reason: "Owner chose to wait" });
  await op.moveItem({ author, id: "pause-child", owner: "pause-parent" });
  assert.equal(rules(store.snapshot()).statusOf("pause-child"), "paused", "moving into a paused chain remains allowed");
});

test("removing a paused parent's owning row cannot resume open child work", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "pause-parent", group: author, title: "Paused release", priority: "P1", accept: "Release passes" });
  await op.createItem({ ...asArchitect, key: "pause-child", owner: "pause-parent", title: "Paused implementation", accept: "Implementation passes" });
  await op.setPause({ ...asArchitect, id: "pause-parent", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  await assert.rejects(op.setPlan({ author, id: "pause-parent", remove: "pause-child" }), /paused.*Paused implementation.*Paused release.*pause-parent.*only the owner or Architect with session 架构师 can resume/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
  assert.equal((await store.log()).length, count);
});

test("Architect plans still require moving or cancelling their open owned children before removal", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "architect-parent", group: author, title: "Architect release", priority: "P1", accept: "Release passes" });
  await op.createItem({ ...asArchitect, key: "architect-child", owner: "architect-parent", title: "Architect work", accept: "Work passes" });
  await op.setPause({ ...asArchitect, id: "architect-parent", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  await assert.rejects(op.setPlan({ ...asArchitect, id: "architect-parent", remove: "architect-child" }), /architect-child is open; use move_item or cancel it before removing its owned row/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
  assert.equal((await store.log()).length, count);
  await op.moveItem({ ...asArchitect, id: "architect-child", priority: "P1" });
  assert.equal(rules(store.snapshot()).parentOf("architect-child"), undefined);
  assert.equal(rules(store.snapshot()).statusOf("architect-child"), "todo", "the Architect's own move may resume its work");
});

test("an inherited pause does not prevent converting work to a record while preserving descendant pause", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "record-descendant", owner: "a", title: "Descendant work", accept: "Result passes" });
  await op.setPause({ ...asArchitect, id: "area", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  assert.equal(before.items.a!.paused, undefined);
  await op.updateItem({ author, id: "a", rev: before.items.a!.rev, record: true });
  const after = store.snapshot();
  assert.equal(after.items.a!.record, true);
  assert.equal(rules(after).statusOf("a"), undefined, "a record has no open work status to resume");
  assert.deepEqual(after.items.area!.paused, before.items.area!.paused);
  assert.equal(rules(after).statusOf("record-descendant"), "paused");
  assert.deepEqual(after.items["record-descendant"], before.items["record-descendant"]);
  assert.equal((await store.log()).length, count + 1);
  assert.deepEqual((await Store.open(dir)).snapshot(), after);
});

test("pause permission follows unwritten descendants when their record owner moves", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  await op.createItem({ ...asArchitect, key: "pause-record", owner: "area", title: "Work queue", record: true });
  await op.createItem({ ...asArchitect, key: "pause-descendant", owner: "pause-record", title: "Queued work", accept: "Queue result passes" });
  await op.setPause({ ...asArchitect, id: "area", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  await assert.rejects(op.moveItem({ author, id: "pause-record", owner: "other" }), /paused.*Queued work.*解释器工作.*area.*only the owner or Architect with session 架构师 can resume/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
  assert.equal((await store.log()).length, count);
  await op.setPause({ ...asArchitect, id: "area", paused: false });
  await op.moveItem({ author, id: "pause-record", owner: "other" });
  assert.equal(rules(store.snapshot()).statusOf("pause-descendant"), "todo");
  assert.deepEqual(store.snapshot().items["pause-descendant"], before.items["pause-descendant"], "the descendant's plan is never rewritten by the move");
});

test("cancelling or completing paused work preserves its retained pause in one commit", async t => {
  const { store, op, dir } = await board(t);
  for (const status of ["done", "cancelled"] as const) {
    const id = `paused-close-${status}`;
    await op.createItem({ ...asArchitect, key: id, group: author, title: "Paused work", priority: "P1", accept: "Result passes" });
    await op.setPause({ ...asArchitect, id, paused: true, reason: "Owner chose to wait" });
    const before = store.snapshot(), count = (await store.log()).length;
    const result = status === "done"
      ? await op.setPlan({ author, id, rows: [{ id: "accept", accept: true, text: "Result passes", state: "done" }] })
      : await op.setStatus({ ...asArchitect, id, status: "cancelled", log: "Not needed" });
    const after = store.snapshot();
    assert.equal(rules(after).statusOf(id), status);
    assert.deepEqual(after.items[id]!.paused, before.items[id]!.paused);
    if (status === "cancelled") assert.deepEqual(after.items[id]!.plan, before.items[id]!.plan);
    assert.equal((await store.log()).length, count + 1);
    assert.equal(result.commit, after.head);
    assert.deepEqual((await Store.open(dir)).snapshot(), after);
  }
});

test("converting closed work to a record requires clearing its retained owner pause first", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "pause-closed-record", group: author, title: "Closed paused work", priority: "P1", accept: "Result passes" });
  await op.setPause({ ...asArchitect, id: "pause-closed-record", paused: true, reason: "Owner chose to wait" });
  await op.setPlan({ author, id: "pause-closed-record", rows: [{ id: "accept", accept: true, text: "Result passes", state: "done" }] });
  const before = store.snapshot(), count = (await store.log()).length, item = before.items["pause-closed-record"]!;
  assert.equal(rules(before).isPaused("pause-closed-record"), false);
  await assert.rejects(op.updateItem({ author, id: "pause-closed-record", rev: item.rev, record: true }), /paused.*Closed paused work.*pause-closed-record.*only the owner or Architect with session 架构师 can resume/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
  assert.equal((await store.log()).length, count);
  await op.setPause({ ...asArchitect, id: "pause-closed-record", paused: false });
  await op.updateItem({ author, id: "pause-closed-record", rev: store.snapshot().items["pause-closed-record"]!.rev, record: true });
  assert.equal(store.snapshot().items["pause-closed-record"]!.record, true);
  assert.equal(store.snapshot().items["pause-closed-record"]!.paused, undefined);
});

test("a project card ruling may complete an unwritten paused dependent without clearing its marker", async t => {
  const { store, op, dir } = await board(t);
  await op.createItem({ ...asArchitect, key: "pause-card-dependent", group: author, title: "Paused card dependent", priority: "P1", accept: "Result passes" });
  await op.writeCard({ author, key: "pause-card", item: "pause-card-dependent", question: "Proceed?", options: [{ text: "Yes" }] });
  await op.setPlan({ author, id: "pause-card-dependent", row: { id: "accept", accept: true, text: "Result passes", state: "done" } });
  await op.setPause({ ...asArchitect, id: "pause-card-dependent", paused: true, reason: "Owner chose to wait" });
  const before = store.snapshot(), count = (await store.log()).length;
  const result = await op.ruleCard({ author, key: "pause-card", choice: "A" });
  const after = store.snapshot();
  assert.equal(rules(after).statusOf("pause-card-dependent"), "done");
  assert.deepEqual(after.items["pause-card-dependent"], before.items["pause-card-dependent"], "card resolution leaves the retained pause and entire unwritten item intact");
  assert.equal((await store.log()).length, count + 1);
  assert.equal(result.commit, after.head);
  assert.deepEqual((await Store.open(dir)).snapshot(), after);
});
