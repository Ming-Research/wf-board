import { test } from "node:test";
import assert from "node:assert/strict";
import { ops, OpError } from "../src/ops.ts";
import { rules, CARD_MISMATCH_LABEL } from "../src/rules.ts";
import type { Ops, Result } from "../src/ops.ts";
import { Store } from "../src/store.ts";
import type { Txn } from "../src/store.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ARCHITECT_WRITER, PROCESS_WRITERS } from "../src/model.ts";
import { board, at, later, author, architect, asArchitect, retired, rx, conf, opt, goalNumbers } from "./helpers.ts";

test("creation, revision, dependency, status, movement and card checks name a fix and leave the board unchanged", async t => {
  const { store, op, dir } = await board(t, { sharedProjects: true });
  const create = { ...asArchitect, key: "new", owner: "area", title: "New", accept: "New result passes" };
  const card = { author, key: "new-card", item: "a", question: "Choose?", blocks: "The work stops", options: [opt("A")] };
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.createItem({ ...create, key: "../escape" }), /key.*use/],
    [() => op.createItem({ ...create, key: "a" }), /key.*new/],
    [() => op.createItem({ ...create, key: "choice" }), /key.*new/],
    [() => op.createItem({ ...create, owner: undefined }), /group.*requires/],
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
    [() => op.writeCard({ confidence: conf, ...card, key: "a" }), /key.*new/],
    [() => op.writeCard({ confidence: conf, ...card, key: "choice" }), /key.*new/],
    [() => op.writeCard({ confidence: conf, ...card, options: [] }), /options.*at least one/],
    [() => op.writeCard({ confidence: conf, ...card, options: [opt("A", true), opt("B", true)] }), /recommended.*at most one/],
    [() => op.writeCard({ confidence: conf, ...card, options: [opt("一".repeat(21))] }), /options\.0\.text.*at most 20 characters/],
    [() => op.writeCard({ confidence: conf, ...card, options: [opt("first\nsecond")] }), /options\.0\.text.*one line/],
    [() => op.writeCard({ confidence: conf, ...card, question: "Choose?\nBecause" }), /question.*one line.*head/],
    [() => op.writeCard({ confidence: conf, ...card, item: "missing" }), /item.*existing/],
    [() => op.writeCard({ confidence: conf, ...card, key: "choice", rev: 1, item: "a" }), /item.*belongs to b and cannot change item/],
    [() => op.writeCard({ confidence: conf, ...card, before: "missing" }), /before.*choose a row of the item's plan/],
    [() => op.writeCard({ confidence: conf, ...card, key: "ruled", rev: 1, item: "b" }), /status.*open card.*create a new card/],
    [() => op.writeCard({ confidence: conf, ...card, key: "choice", rev: 1, item: "b", before: "accept" }), /before.*placed when it starts to block/],
    [() => op.writeCard({ confidence: conf, ...card, blocks: undefined, before: "accept" }), /before.*only a card with blocks has a row/],
    [() => op.writeCard({ author, key: "new-card", item: "a", question: "Choose?", blocks: "The work stops", options: [opt("A")] }), /confidence.*how sure.*score of 1 to 5/],
    [() => op.writeCard({ confidence: conf, ...card, options: [{ text: "A", detail: "" }] }), /detail/],
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
    // A note says how the write was made (a row behind its owner's), not what it produced: it is left out here.
    const { note: _note, ...named } = result;
    assert.deepEqual(named,{commit:after.head,id,rev:doc.rev,summary:message},"the result names the revision and commit actually produced");
    assert.equal(log[0]!.author,by); assert.equal(log[0]!.message,message);
    assert.deepEqual(log[0]!.files.slice().sort(),files.slice().sort(),"the commit contains every effect and no unrelated document");
    assert.deepEqual(await store.show(kind,id,result.commit),doc,"the returned revision is stored in that exact commit");
    assert.deepEqual((await Store.open(dir)).snapshot(),after,"all atomic effects survive reopen");
  }
  const itemCommit = (call: () => Promise<Result>, message: string, files=["items/new.yaml"], by = author) => committed(call,message,files,"item","new",by);
  await itemCommit(() => op.createItem({ ...asArchitect, key: "new", owner: "area", title: "New", head: "Stable", accept: "New result passes", plan: [{id:"work",text:"Deliver result",state:"todo"}], links: [], data: "4 cases" }),"create_item new",["items/new.yaml","items/area.yaml","numbers.yaml"],architect);
  assert.deepEqual(store.snapshot().items.area!.plan.find(row=>row.id === "new"),{id:"new",item:"new",own:true});
  const created=store.snapshot().items.new!; assert.equal(created.created,later); assert.equal(created.updated,later); assert.equal(rules(store.snapshot()).statusOf("new"),"blocked","its row follows the area's earlier row, which is still open");
  assert.deepEqual(created.plan,[{id:"work",text:"Deliver result",state:"todo"},{id:"accept",accept:true,text:"New result passes",state:"todo"}]);
  await itemCommit(() => op.appendLog({ author, id: "new", text: "Evidence" }),"append_log new");
  assert.deepEqual(store.snapshot().items.new!.log[0],{at:later,by:author,text:"Evidence"});
  await itemCommit(() => op.updateItem({ ...asArchitect, id: "new", rev: 2, head: "Revised", reason: "Scope settled", title: "Revised title", links: [{label:"PR",url:"https://github.com/Ming-Research/Whitefoot/pull/1"}], data: null }),"update_item new",undefined,architect);
  const revised=store.snapshot().items.new!; assert.equal(revised.head,"Revised"); assert.equal(revised.title,"Revised title"); assert.equal(revised.data,undefined); assert.equal(Object.hasOwn(revised,"agent"),false);
  assert.deepEqual(revised.plan,created.plan); assert.deepEqual(revised.log.at(-1),{at:later,by:architect,text:"改了 head：Scope settled"});
  await committed(() => op.updateItem({author,id:"other",rev:store.snapshot().items.other!.rev,order:2}),"update_item other",["items/other.yaml"],"item","other");
  assert.equal(store.snapshot().items.other!.order,2,"top-item order remains editable while owned order is the plan's");
  // The card is written with its row in the item's plan, in one commit with the card.
  const writeNewCard=()=>op.writeCard({ confidence: conf,author,key:"new-card",item:"new",question:"Choose?",blocks:"The work stops",options:[opt("A", true),opt("B")]});
  await committed(writeNewCard,"write_card new-card",["decisions/new-card.yaml","items/new.yaml","numbers.yaml"],"decision","new-card");
  assert.deepEqual(store.snapshot().items.new!.plan.map(row=>row.id),["work","new-card","accept"]);
  assert.deepEqual(store.snapshot().items.new!.plan[1],{id:"new-card",card:"new-card"});
  assert.deepEqual(store.snapshot().items.new!.plan[2],{id:"accept",accept:true,text:"New result passes",state:"todo",after:["work","new-card"]},"the acceptance step waits for the card and still for the row before");
  assert.deepEqual(store.snapshot().decisions["new-card"]!.options,[{key:"A",...opt("A",true)},{key:"B",...opt("B")}],"the board gives the option keys");
  await itemCommit(() => op.setTargets({ author, id: "new", target: goalNumbers }),"set_targets new");
  assert.deepEqual(store.snapshot().items.new!.targets,[{...goalNumbers,date:later}]);
  await itemCommit(() => op.setPlan({ author, id: "new", row: {id:"work",text:"Deliver result",state:"doing"} }),"set_plan new");
  assert.equal(rules(store.snapshot()).statusOf("new"),"wip");
  await itemCommit(() => op.setPlan({ author, id: "new", row: {id:"work",text:"Deliver result",state:"done"} }),"set_plan new");
  assert.equal(rules(store.snapshot()).statusOf("new"),"blocked");
  const waiting=store.snapshot().items.new!;
  await store.commit({author:"Fixture",message:"Legacy ask",puts:[{kind:"item",id:"new",expectRev:waiting.rev,doc:{...waiting,ask:{text:"Approve",url:"https://example.com/approve",chat:true}}}]});
  const beforeCancel=store.snapshot().items.new!;
  // The cancellation withdraws the item's open card in the same commit.
  await committed(() => op.setStatus({ ...asArchitect, id: "new", status: "cancelled", log: "Superseded" }),"set_status new cancelled",["decisions/new-card.yaml","items/new.yaml"],"item","new",architect);
  assert.equal(rules(store.snapshot()).statusOf("new"),"cancelled"); assert.deepEqual(store.snapshot().items.new!.plan,beforeCancel.plan); assert.deepEqual(store.snapshot().items.new!.ask,beforeCancel.ask);
  assert.deepEqual(store.snapshot().items.new!.log.at(-1),{at:later,by:architect,text:"Superseded"});
  // Reopening restores the card the cancellation withdrew, in the same commit.
  await committed(() => op.setStatus({ ...asArchitect, id: "new", status: "open", log: "Resume" }),"set_status new open",["decisions/new-card.yaml","items/new.yaml"],"item","new",architect);
  assert.equal(store.snapshot().items.new!.status,undefined); assert.equal(rules(store.snapshot()).statusOf("new"),"blocked");
  await itemCommit(() => op.clearAsk({ author, id: "new", log: "Owner approved" }),"clear_ask new");
  assert.equal(store.snapshot().items.new!.ask,undefined); assert.equal(store.snapshot().items.new!.log.at(-1)!.text,"Owner approved");
  await itemCommit(() => op.moveItem({ author, id: "new", owner: "other" }),"move_item new",["items/new.yaml","items/area.yaml","items/other.yaml"]);
  const moved=store.snapshot(); assert.equal(rules(moved).parentOf("new"),"other"); assert.ok(!moved.items.area!.plan.some(row=>row.id === "new"));
  assert.deepEqual(moved.items.other!.plan.find(row=>row.id === "new"),{id:"new",item:"new",own:true});
  assert.match(moved.items.area!.log.at(-1)!.text,/Revised title.*其他项目/); assert.match(moved.items.other!.log.at(-1)!.text,/Revised title/); assert.match(moved.items.new!.log.at(-1)!.text,/解释器工作.*其他项目/);
  const cardCommit=(call: () => Promise<Result>,message:string,key="new-card",extra:string[]=[])=>committed(call,message,["decisions/"+key+".yaml",...extra],"decision",key);
  const originalAt=store.snapshot().decisions["new-card"]!.at, rowsBefore=store.snapshot().items.new!.plan;
  await cardCommit(() => op.writeCard({ confidence: conf,author,key:"new-card",rev:store.snapshot().decisions["new-card"]!.rev,item:"new",question:"Choose revised?",options:[opt("A"),opt("B"),opt("C")]}),"write_card new-card");
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
  // Someone else replaced the same field since the revision the writer read.
  await op.updateItem({ ...asArchitect, id: "a", rev: 1, title: "Intervening title" });
  const before = store.snapshot();
  await assert.rejects(op.updateItem({ ...asArchitect, id: "a", rev: 1, title: "Stale" }), /rev 1: current rev 2; title changed.*redo.*rev 2/);
  assert.deepEqual(store.snapshot(), before);
  const args = { author, key: "choice", item: "b", question: "Changed?", options: [opt("A")] };
  await op.writeCard({ confidence: conf, ...args, rev: 1 });
  const cardBefore = store.snapshot();
  await assert.rejects(op.writeCard({ confidence: conf, ...args, rev: 1 }), /current rev 2.*question changed/);
  assert.deepEqual(store.snapshot(), cardBefore);
});

test("a text write on a revision that is behind stands when no field it replaces has changed since, and the answer says what did", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.appendLog({ author, id: "a", text: "Concurrent evidence" });
  await op.setPlan({ author, id: "a", row: { id: "extra", text: "Extra step", state: "todo" } });
  const behind = store.snapshot().items.a!.rev;
  assert.equal(behind, 3, "the log line and the plan row each raised the revision");
  const done = await op.updateItem({ author, id: "a", rev: 1, head: "New head", reason: "Rewritten" });
  assert.match(done.note ?? "", /^rev 1 was behind \(current rev 3\): .+ since, and head did not change, so the edit was written$/);
  assert.match(done.note!, /\+1 log/); assert.match(done.note!, /plan changed/);
  const doc = store.snapshot().items.a!;
  assert.equal(doc.head, "New head"); assert.equal(doc.rev, 4);
  assert.ok(doc.log.some(entry => entry.text === "Concurrent evidence"), "the concurrent log line is kept");
  assert.ok(doc.plan!.some(row => row.id === "extra"), "the concurrent plan row is kept");
  // Another field of the same write is judged by itself: data was not touched since, so it stands on the old revision too.
  await op.updateItem({ author, id: "a", rev: 1, data: "12 s" });
  assert.equal(store.snapshot().items.a!.data, "12 s");
  // The field changed since: refused, and nothing is overwritten.
  const head = store.snapshot().items.a!.head, rev = store.snapshot().items.a!.rev;
  await assert.rejects(op.updateItem({ author, id: "a", rev: 1, head: "Mine", reason: "Stale" }), /rev 1: current rev \d+; .*head changed.*redo.*rev \d+/);
  assert.equal(store.snapshot().items.a!.head, head); assert.equal(store.snapshot().items.a!.rev, rev);
  // Turning an item into a record changes its plan too, so it needs the revision to be the current one.
  await assert.rejects(op.updateItem({ author, id: "a", rev: 1, record: true }), /rev 1: current rev \d+/);
  // A revision that never existed is refused, as before.
  await assert.rejects(op.updateItem({ author, id: "a", rev: rev + 9, head: "Never read", reason: "Future" }), /previous revision unavailable/);
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
  await op.createItem({ ...asArchitect, key: "new-area", title: "Area", accept: "Pass", group: "New project" });
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("a project's mainline is set, kept when only the repo changes, cleared by null, and changed only by that project or Architect", async t => {
  const { store, op, dir } = await board(t), project = () => store.snapshot().board.projects[0]!;
  await op.updateProject({ author: "Whitefoot", name: "Whitefoot", mainline: "claude/first-board" });
  assert.deepEqual(project(), { name: "Whitefoot", repo: "Ming-Research/Whitefoot", mainline: "claude/first-board" });
  await op.updateProject({ author: "Whitefoot", name: "Whitefoot", repo: "Org/Next" });
  assert.deepEqual(project(), { name: "Whitefoot", repo: "Org/Next", mainline: "claude/first-board" }, "a repo change keeps the mainline");
  await op.updateProject({ ...asArchitect, name: "Whitefoot", mainline: "trunk" });
  assert.equal(project().mainline, "trunk");
  const before = store.snapshot();
  await assert.rejects(op.updateProject({ author: "Firn", name: "Whitefoot", mainline: "other" }), rx`only that project or ${ARCHITECT_WRITER} may update its mainline`);
  await assert.rejects(op.updateProject({ author: "Whitefoot", name: "Whitefoot", mainline: "has space" }), /whitespace/);
  await assert.rejects(op.updateProject({ author: "Whitefoot", name: "Whitefoot" }), /provide repo, mainline or after/);
  assert.deepEqual(store.snapshot(), before);
  await op.updateProject({ author: "Whitefoot", name: "Whitefoot", mainline: null });
  assert.deepEqual(project(), { name: "Whitefoot", repo: "Org/Next" }, "null clears it");
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("Architect reorders and creates projects after an existing project in one commit, while omitted after preserves defaults", async t => {
  const { store, op, dir } = await board(t);
  const names = () => store.snapshot().board.projects.map(p => p.name);
  const initial = store.snapshot();
  let count = (await store.log()).length;
  await op.updateProject({ ...asArchitect, name: "Whitefoot", after: "Firn" });
  assert.deepEqual(names(), ["Firn", "Whitefoot", "总管", "Architect", "PM"]);
  assert.deepEqual(store.snapshot().items, initial.items);
  assert.equal((await store.log()).length, ++count);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files, ["board.yaml"]);
  await op.updateProject({ ...asArchitect, name: "总管", repo: "Org/Coordinator", after: "Firn" });
  assert.deepEqual(names(), ["Firn", "总管", "Whitefoot", "Architect", "PM"]);
  assert.equal(store.snapshot().board.projects[1]!.repo, "Org/Coordinator");
  assert.equal((await store.log()).length, ++count);
  await op.createProject({ ...asArchitect, name: "Inserted", repo: "Org/Inserted", after: "Firn" });
  assert.deepEqual(names(), ["Firn", "Inserted", "总管", "Whitefoot", "Architect", "PM"]);
  assert.deepEqual(store.snapshot().board.projects[1], { name: "Inserted", repo: "Org/Inserted" });
  assert.equal((await store.log()).length, ++count);
  await op.createProject({ author: "Any caller", name: "Last" });
  assert.deepEqual(names(), ["Firn", "Inserted", "总管", "Whitefoot", "Architect", "PM", "Last"]);
  assert.equal((await store.log()).length, ++count);
  await op.updateProject({ author: "Whitefoot", name: "Whitefoot", repo: "Org/Changed" });
  assert.deepEqual(names(), ["Firn", "Inserted", "总管", "Whitefoot", "Architect", "PM", "Last"]);
  assert.equal((await store.log()).length, ++count);
  await op.updateProject({ ...asArchitect, name: "Firn", after: "Last" });
  assert.deepEqual(names(), ["Inserted", "总管", "Whitefoot", "Architect", "PM", "Last", "Firn"]);
  assert.equal((await store.log()).length, ++count);
  assert.deepEqual((await Store.open(dir)).snapshot(), store.snapshot());
});

test("project after rejects every author but Architect, unknown projects and self placement atomically", async t => {
  const { store, op, dir } = await board(t), before = store.snapshot(), count = (await store.log()).length;
  const cases: Array<[() => Promise<unknown>, RegExp]> = [
    [() => op.updateProject({ author: "Whitefoot", name: "Whitefoot", after: "Firn" }), rx`after: only ${PROCESS_WRITERS} may reorder projects`],
    [() => op.updateProject({ author: "Whitefoot", name: "Whitefoot", repo: "Org/Changed", after: "Firn" }), rx`after: only ${PROCESS_WRITERS} may reorder projects`],
    [() => op.updateProject({ author: "Firn", name: "Whitefoot", repo: "Org/Changed", after: "Firn" }), rx`only that project or ${ARCHITECT_WRITER} may update its repo`],
    [() => op.createProject({ author: "Whitefoot", name: "New", after: "Firn" }), rx`after: only ${PROCESS_WRITERS} may reorder projects`],
    [() => op.createProject({ author: "Any caller", name: "New", after: "Firn" }), rx`after: only ${PROCESS_WRITERS} may reorder projects`],
    [() => op.updateProject({ author: "总管", name: "Whitefoot", after: "Firn" }), retired],
    [() => op.updateProject({ author: "总管", name: "Whitefoot", repo: "Org/Changed" }), retired],
    [() => op.createProject({ author: "总管", name: "New" }), retired],
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
  await op.createItem({ ...asArchitect, key: "record-with-targets", title: "Goal numbers", record: true, group: author });
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
  assert.equal(rules(store.snapshot()).statusOf("a"), "idle");
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
  assert.equal(rules(store.snapshot()).statusOf("a"), "idle");
  const work = store.snapshot().items.a!.plan.find(row => row.id === "work")!;
  assert.ok("state" in work); assert.equal(work.state, "todo");
  await op.setPlan({ author, id: "a", row: { id: "work", text: "Independent work", state: "done", after: [] } });
  assert.equal(rules(store.snapshot()).statusOf("a"), "done");
});

test("a new or changed owned row that starts behind unfinished rows says which rows hold it and that after: [] starts it", async t => {
  const { op } = await board(t);
  await op.createItem({ ...asArchitect, key: "owner-hint", group: author, title: "Owner", accept: "Owner passes", plan: [{ id: "first", text: "First step", state: "todo" }] });
  const behind = await op.createItem({ ...asArchitect, key: "child-behind", owner: "owner-hint", title: "Child", accept: "Child passes" });
  assert.match(behind.note ?? "", /child-behind is blocked: its row in owner-hint's plan waits for first, not done yet.*after: \[\]/);
  const free = await op.createItem({ ...asArchitect, key: "child-free", owner: "owner-hint", after: [], title: "Free", accept: "Free passes" });
  assert.equal(free.note, undefined);
  await op.createItem({ ...asArchitect, key: "child-set", group: author, title: "Set", accept: "Set passes" });
  const set = await op.setPlan({ ...asArchitect, id: "owner-hint", row: { item: "child-set", own: true } });
  assert.match(set.note ?? "", /child-set is blocked: its row in owner-hint's plan waits for child-free, not done yet/);
  const started = await op.setPlan({ ...asArchitect, id: "owner-hint", row: { item: "child-set", own: true, after: [] } });
  assert.equal(started.note, undefined);
});

test("create_item appends accept while allowing more acceptance scenarios in its initial plan", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "scenarios", group: author, title: "All scenarios pass", accept: "Final scenario passes", plan: [
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

test("a cancelled item shows no checks but still refuses a new dangling dependency", async t => {
  const { store, op } = await board(t);
  await op.setStatus({ ...asArchitect, id: "b", status: "cancelled", log: "Drop" });
  const before = store.snapshot();
  await assert.rejects(op.setPlan({ ...asArchitect, id: "b", row: { item: "missing", own: false } }), /依赖的条目不存在.*missing/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(rules(store.snapshot()).checks("b"), []);
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

test("creation adoption uses plans and commits all structural effects together", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  await op.createItem({ ...asArchitect, key: "parent", title: "Combined", group: author, accept: "Both accepted", children: ["a", "b"] });
  const s = store.snapshot(); assert.equal(rules(s).parentOf("a"), "parent"); assert.equal(rules(s).parentOf("b"), "parent");
  assert.deepEqual(s.items.parent!.plan!.map(row => row.id), ["a", "b", "accept"]);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files.sort(), ["items/a.yaml", "items/area.yaml", "items/b.yaml", "items/parent.yaml", "numbers.yaml"], "the issued number's counter enters the creating commit");
});

test("record-owned backlog work is no root even with external dependents, and cancellation refuses open parts", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "backlog", title: "Backlog", group: author, record: true });
  await op.moveItem({ author, id: "a", owner: "backlog" });
  await op.setPlan({ author: "Firn", id: "other", row: { item: "a", own: false, after: [] } });
  const r = rules(store.snapshot()); assert.equal(r.isRoot("a"), false);
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
  await assert.rejects(op.createItem({ ...asArchitect, key: "missing-accept", group: author, title: "New" }), /accept/);
  await assert.rejects(op.createItem({ ...asArchitect, key: "record-accept", group: author, title: "Record", record: true, accept: "Wrong" }), /accept/);
  await assert.rejects(op.createItem({ ...asArchitect, key: "old-status", group: author, title: "New", accept: "Pass", status: "todo" } as Parameters<Ops["createItem"]>[0]), /no status argument/);
  assert.deepEqual(store.snapshot(), before); assert.deepEqual((await Store.open(dir)).snapshot(), before);
});

test("card writes validate the question, option names, revisions and project ownership, and place the row where asked", async t => {
  const { store, op } = await board(t), before = store.snapshot();
  const args = { author, key: "new-card", item: "a", question: "Choose?", blocks: "The work stops", options: [opt("Option")] };
  for (const invalid of [
    { options: [] }, { options: [opt("A", true), opt("B", true)] },
    { options: [opt("x".repeat(21))] }, { options: [opt("two\nlines")] }, { question: "two\nlines" }, { item: "missing" },
  ]) { await assert.rejects(op.writeCard({ confidence: conf, ...args, ...invalid }), OpError); assert.deepEqual(store.snapshot(), before); }
  await assert.rejects(op.writeCard({ confidence: conf, ...args, author: "Firn" }), /belongs to project Whitefoot/);
  // An option name of exactly 20 characters is fine, spaces not counted.
  await op.writeCard({ confidence: conf, ...args, options: [opt("一二三四五六七八九十 一二三四五六七八九十"), opt("B")] });
  assert.deepEqual(store.snapshot().decisions["new-card"]!.options.map(o => o.key), ["A", "B"]);
  // The row is in a's plan, before the acceptance step, which now waits for the card.
  assert.deepEqual(store.snapshot().items.a!.plan.map(row => row.id), ["new-card", "accept"]);
  assert.deepEqual(store.snapshot().items.a!.plan.at(-1), { id: "accept", accept: true, text: "独立验收通过", state: "todo", after: ["new-card"] });
  await op.ruleCard({ author, key: "new-card", choice: "A" });
  const ruled = store.snapshot().decisions["new-card"]!; assert.equal(ruled.status, "ruled"); assert.equal(ruled.choice, "A"); assert.equal(ruled.ruledAt, later);
  await assert.rejects(op.writeCard({ confidence: conf, ...args, rev: ruled.rev }), /only an open card/);
  await assert.rejects(op.ruleCard({ author, key: "choice", choice: "wrong" }), /option keys/);
  await assert.rejects(op.ruleCard({ author, key: "new-card", choice: "A" }), /only an open card/);
});

test("write_card places the row where before and after say, and a row it waits for is not lost", async t => {
  const { store, op } = await board(t);
  await op.setPlan({ author, id: "a", rows: [
    { id: "one", text: "One", state: "todo" }, { id: "two", text: "Two", state: "todo" }, { id: "three", text: "Three", state: "todo", after: ["one"] },
    { id: "accept", accept: true, text: "独立验收通过", state: "todo" },
  ] });
  await op.writeCard({ confidence: conf, author, key: "mid", item: "a", question: "Where?", blocks: "The work stops", options: [opt("Here")], before: "three", after: ["one"] });
  const plan = store.snapshot().items.a!.plan;
  assert.deepEqual(plan.map(row => row.id), ["one", "two", "mid", "three", "accept"]);
  assert.deepEqual(plan[2], { id: "mid", card: "mid", after: ["one"] });
  assert.deepEqual(plan[3], { id: "three", text: "Three", state: "todo", after: ["one", "mid"] }, "the row that waits for the card keeps what it waited for");
  await assert.rejects(op.writeCard({ confidence: conf, author, key: "dangling", item: "a", question: "Where?", blocks: "The work stops", options: [opt("Here")], after: ["missing"] }), /after must name earlier rows/);
  assert.equal(Object.hasOwn(store.snapshot().decisions, "dangling"), false, "a refused placement writes no card");
});

test("write_card keeps what the row after the card waited for when a record row stands before it", async t => {
  const { store, op } = await board(t);
  // A record row is no step: the acceptance row follows "one", the last step before the record row, not the record row.
  await store.commit({ author: "Fixture", message: "Seed a record", puts: [{ kind: "item", id: "rec", expectRev: null, doc: { title: "记录", group: author, record: true, plan: [], updated: at } }] });
  await op.setPlan({ author, id: "a", rows: [
    { id: "one", text: "One", state: "todo" }, { item: "rec", own: false, after: [] }, { id: "accept", accept: true, text: "独立验收通过", state: "todo" },
  ] });
  const args = { confidence: conf, author, key: "mid", item: "a", question: "Where?", blocks: "The work stops", options: [opt("Here")] };
  await op.writeCard(args);
  const plan = () => store.snapshot().items.a!.plan;
  assert.deepEqual(plan().map(row => row.id), ["one", "rec", "mid", "accept"]);
  assert.deepEqual(plan()[2], { id: "mid", card: "mid" }, "the card row follows the step before the record row");
  assert.deepEqual(plan()[3], { id: "accept", accept: true, text: "独立验收通过", state: "todo", after: ["one", "mid"] }, "the acceptance row still waits for the step before the record row");
  await op.writeCard({ ...args, rev: 1, blocks: null });
  assert.deepEqual(plan().map(row => row.id), ["one", "rec", "accept"]);
  assert.deepEqual(plan()[2], { id: "accept", accept: true, text: "独立验收通过", state: "todo", after: ["one"] }, "and goes back to waiting for it alone");
});

test("only a card that blocks has a row: a card without blocks has none, setting or clearing blocks on a revision adds or removes the row, and the checks agree", async t => {
  const { store, op } = await board(t);
  const plan = () => store.snapshot().items.a!.plan.map(row => row.id);
  const mismatch = () => rules(store.snapshot()).checks("a").filter(check => check.label === CARD_MISMATCH_LABEL);
  const args = { author, key: "free", item: "a", question: "Which?", confidence: conf, options: [opt("A", true), opt("B"), opt("C")] };
  await op.writeCard(args);
  assert.deepEqual(plan(), ["accept"], "a card that does not block gets no row");
  assert.deepEqual(store.snapshot().decisions.free!.confidence, conf);
  assert.deepEqual(store.snapshot().decisions.free!.options[0], { key: "A", ...opt("A", true) });
  assert.deepEqual(mismatch(), []);
  // blocks set on a revision: the row appears before the acceptance step, which waits for it
  await op.writeCard({ ...args, rev: 1, blocks: "The work stops" });
  assert.deepEqual(plan(), ["free", "accept"]);
  assert.deepEqual(store.snapshot().items.a!.plan.at(-1), { id: "accept", accept: true, text: "独立验收通过", state: "todo", after: ["free"] });
  assert.deepEqual(mismatch(), []);
  // blocks cleared: the row goes and what waited for it waits for what it waited for
  await op.writeCard({ ...args, rev: 2, blocks: null });
  assert.deepEqual(plan(), ["accept"]);
  assert.equal(store.snapshot().decisions.free!.blocks, undefined);
  assert.match(store.snapshot().items.a!.log.at(-1)!.text, /不再挡事/);
  assert.deepEqual(mismatch(), []);
  // a blocking card without its row, and a non-blocking card with one, are flagged
  const item = store.snapshot().items.a!;
  await store.commit({ author: "Fixture", message: "Break", puts: [{ kind: "decision", id: "free", expectRev: 3, doc: { ...store.snapshot().decisions.free!, blocks: "Now it blocks" } }] });
  assert.match(mismatch()[0]!.text, /free 挡事，却没有计划行/);
  await store.commit({ author: "Fixture", message: "Break", puts: [{ kind: "decision", id: "free", expectRev: 4, doc: { ...store.snapshot().decisions.free!, blocks: undefined } }, { kind: "item", id: "a", expectRev: item.rev, doc: { ...item, plan: [{ id: "free", card: "free" }, ...item.plan] } }] });
  assert.match(mismatch()[0]!.text, /free 不挡事，却有计划行/);
});

test("rule_card takes the option the owner chose, their words, or both; neither is refused", async t => {
  const { store, op } = await board(t);
  await assert.rejects(op.ruleCard({ author, key: "choice" }), /choice.*option the owner chose.*ruling/);
  await op.ruleCard({ author, key: "choice", ruling: "Neither: do it in chat" });
  const card = store.snapshot().decisions.choice!;
  assert.deepEqual([card.status, card.choice, card.ruling], ["ruled", undefined, "Neither: do it in chat"]);
  await op.writeCard({ author, key: "both", item: "a", question: "Which?", confidence: conf, options: [opt("A"), opt("B"), opt("C")] });
  await op.ruleCard({ author, key: "both", choice: "B", ruling: "B, but later" });
  assert.deepEqual([store.snapshot().decisions.both!.choice, store.snapshot().decisions.both!.ruling], ["B", "B, but later"]);
  await assert.rejects(op.ruleCard({ author, key: "both", choice: "Z" }), /only an open card/);
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
  await assert.rejects(op.writeCard({ confidence: conf, author, key: "choice", rev: card.rev, item: "b", question: "Again?", options: [opt("A")] }), /only an open card/);
});

test("a write that still names priority is refused and says the field is gone", async t => {
  const { store, op } = await board(t);
  const before = store.snapshot(), gone = /priority: 已去掉/;
  await assert.rejects(op.createItem({ ...asArchitect, key: "p", group: author, title: "P", accept: "Pass", priority: "P1" } as Parameters<Ops["createItem"]>[0]), gone);
  await assert.rejects(op.updateItem({ author, id: "a", rev: 1, priority: "P0" } as Parameters<Ops["updateItem"]>[0]), gone);
  await assert.rejects(op.moveItem({ author, id: "a", priority: "P0" } as Parameters<Ops["moveItem"]>[0]), gone);
  await assert.rejects(op.moveItemProject({ ...asArchitect, id: "a", project: "Firn", priority: "P0" } as Parameters<Ops["moveItemProject"]>[0]), gone);
  assert.deepEqual(store.snapshot(), before, "nothing was written");
});

test("a new root needs no priority, and a plan row that makes it a non-root writes nothing else to it", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, group: "Firn", key: "remote", title: "Root result", accept: "Pass" });
  assert.equal(rules(store.snapshot()).isRoot("remote"), true);
  const rev = store.snapshot().items.remote!.rev;
  const changed = await op.setPlan({ author, id: "a", row: { item: "remote", own: false, after: [] } });
  assert.equal(rules(store.snapshot()).isRoot("remote"), false);
  assert.equal(store.snapshot().items.remote!.rev, rev, "the item the plan row names is not written");
  assert.equal(Object.hasOwn(changed, "dropped"), false);
  assert.deepEqual((await store.log({ limit: 1 }))[0]!.files, ["items/a.yaml"]);
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
    // checks() reads provisional; ownership and status do not. The
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
    { kind: "item", id: "waiter", expectRev: null, doc: { title: "Open waiter", group: author, plan: [{ id: "loose", item: "loose", own: false }, acceptance("todo")], updated: at } },
  ] });
  const before = store.snapshot();
  assert.equal(rules(before).statusOf("loose"), "done");
  await assert.rejects(op.setStatus({ ...asArchitect, id: "part", status: "open", log: "Resume part" }), /item loose:.*同项目有条目在等它，却没有条目拥有它.*move_item/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await Store.open(dir)).snapshot(), before);
});

test("acceptance naming avoids collisions with valid ordinary rows", async t => {
  const { store, op } = await board(t);
  await op.createItem({ ...asArchitect, key: "collision", group: author, title: "New", accept: "Pass", plan: [{ id: "accept", text: "Ordinary work", state: "todo" }] });
  assert.deepEqual(store.snapshot().items.collision!.plan.map(row => row.id), ["accept", "accept-1"]);
  await op.createItem({ ...asArchitect, key: "record-collision", group: author, title: "Record", record: true, plan: [{ id: "accept", text: "Ordinary record entry", state: "todo" }] });
  await op.updateItem({ author, id: "record-collision", rev: 1, record: false, accept: "Pass" });
  assert.deepEqual(store.snapshot().items["record-collision"]!.plan.map(row => row.id), ["accept", "accept-1"]);
});

test("cancelling an item withdraws its open cards in the same commit; reopening restores those, not the ones withdrawn by hand", async t => {
  const { store, op } = await board(t, { sharedProjects: true });
  const openCards = () => Object.entries(store.snapshot().decisions).filter(([, card]) => card.item === "cancel-cards" && card.status === "open").map(([key]) => key).sort();
  await op.createItem({ ...asArchitect, key: "cancel-cards", group: author, title: "Cancel cards", accept: "Pass" });
  for (const key of ["cancel-card-one", "cancel-card-two", "cancel-card-manual"]) await op.writeCard({ ...asArchitect, confidence: conf, key, item: "cancel-cards", question: `Question ${key}?`, options: [opt("A")] });
  await op.withdrawCard({ ...asArchitect, key: "cancel-card-manual", log: "Not needed" });
  assert.deepEqual(openCards(), ["cancel-card-one", "cancel-card-two"]);
  const commits = (await store.log()).length;
  await op.setStatus({ ...asArchitect, id: "cancel-cards", status: "cancelled", log: "No longer needed" });
  assert.deepEqual(openCards(), [], "no open card is left on a cancelled item");
  assert.equal(store.snapshot().decisions["cancel-card-one"]!.status, "withdrawn");
  assert.equal((await store.log()).length, commits + 1, "the cancellation and the withdrawals are one commit");
  await op.setStatus({ ...asArchitect, id: "cancel-cards", status: "open", log: "Needed again" });
  assert.deepEqual(openCards(), ["cancel-card-one", "cancel-card-two"], "reopening restores the cards the cancellation withdrew");
  assert.equal(store.snapshot().decisions["cancel-card-manual"]!.status, "withdrawn", "a card withdrawn by hand stays withdrawn");
});

