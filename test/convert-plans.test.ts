import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stringify, parse } from "yaml";
import { Item as LegacyItem, Board as LegacyBoard } from "../src/legacy-model.ts";
import type { Snapshot as LegacySnapshot } from "../src/legacy-model.ts";
import { convertPlans, extractAcceptance, MISSING_ACCEPT, CLOSED_ACCEPT, PLAN_CONVERSION_MESSAGE, updatePlanSummary } from "../src/convert-plans.ts";
import { verifyPlans } from "../src/verify-plans.ts";
import { rules } from "../src/rules.ts";
import { rules as legacyRules } from "../src/legacy-rules.ts";
import { unreadSteps, stepDiff } from "../src/history.ts";
import { ops } from "../src/ops.ts";
import { Store, readPlanData } from "../src/store.ts";
const at="2026-10-13T01:00:00Z", since="2026-10-12T01:00:00Z";
function item(fields: Record<string,unknown>={}) { return LegacyItem.parse({title:"Work",group:"P",head:"**问题**：Some problem\n\n**完成条件**：CI passes\n\n**何时**：Today",status:"todo",priority:"P1",log:[{at:since,by:"P",text:"original"}],updated:at,rev:2,...fields}); }
function snapshot(): LegacySnapshot{return {board:LegacyBoard.parse({title:"Synthetic",projects:[{name:"P",migrated:true},{name:"Q",migrated:true}]}),items:{root:item()},decisions:{},notes:{},notices:{},glossaries:{},owner:{archived:{}},head:"a".repeat(40)};}
function finalText(plan: ReturnType<typeof convertPlans>["snapshot"]["items"][string]["plan"]): string | undefined { const row=plan.at(-1); return row&&"text"in row?row.text:undefined; }
function checked(source: LegacySnapshot){const result=convertPlans(source,{at});assert.deepEqual(result.report.errors,[]);assert.deepEqual(verifyPlans(source,result),[]);return result;}

test("phase one preserves original steps, closed acceptance states, dates, own-work children and untouched documents",()=>{
 const source=snapshot();source.items.root=item({status:undefined,deps:[{id:"child",why:"Child needed"}],targets:[{id:"goal",goal:"All",target:"3",current:"2",baseline:"main",date:since}]});
 source.items.child=item({parent:"root",group:undefined,status:"done",steps:[{id:"one",text:"Done",state:"done",doneAt:since},{id:"two",text:"Unmarked",state:"todo"}],log:[{at:since,text:"接过「Work」自己的工作"}]});
 source.items.closed=item({parent:"root",group:undefined,status:"cancelled",head:"No condition"});
 source.decisions.card={item:"root",question:"Choose?",background:"Evidence",options:[{key:"A",text:"A"}],status:"ruled",ruling:"A",updated:at,rev:1};
 source.notes.note={target:"q:card",kind:"comment",text:"Question",at:since,state:"done",reply:"Answer",repliedAt:at,repliedBy:"P",anchor:{kind:"log",at:since},rev:1};
 source.owner.archived.closed=at;
 source.owner.archived.child=at;
 const original=structuredClone(source),result=checked(source);assert.deepEqual(source,original);
 assert.deepEqual(result.snapshot.items.root!.plan.filter(row=>"item"in row).map(row=>row.id),["child","closed"]);
 assert.equal(rules(result.snapshot).statusOf("root"),"todo");assert.equal(rules(result.snapshot).statusOf("child"),"todo");assert.equal(rules(result.snapshot).statusOf("closed"),"cancelled");
 const originalStep=result.snapshot.items.child!.plan.find(row=>row.id==="two");assert.ok(originalStep&&"text"in originalStep&&originalStep.state==="todo");
 assert.equal(finalText(result.snapshot.items.closed!.plan),CLOSED_ACCEPT);
 assert.equal(result.snapshot.items.root!.head,"**问题**：Some problem\n\n**何时**：Today");
 assert.ok(result.report.findings.some(f=>f.kind==="child not listed"));
});

test("dependency rows precede unchanged steps; differences are reported without fabricating waits",()=>{
 const source=snapshot();source.items.root=item({status:"blocked",deps:[{id:"other",why:"needs output"},{card:"card",why:"needs choice"},{id:"other",why:"duplicate explanation"}],steps:[{id:"build",text:"Build",state:"todo"},{id:"run",text:"Run",state:"todo"}]});source.items.other=item({group:"Q",priority:"P1"});
 source.decisions.card={item:"root",question:"Choose?",background:"Evidence",options:[{key:"A",text:"A"}],status:"open",blocks:"Build waits",updated:at,rev:1};
 const result=checked(source),plan=result.snapshot.items.root!.plan;
 assert.deepEqual(plan.map(row=>row.id),["other","card","build","run","accept"]);assert.deepEqual(plan[0]!.after,[]);assert.deepEqual(plan[2]!.after,[]);assert.equal(plan[3]!.after,undefined);
 assert.equal(rules(result.snapshot).statusOf("root"),"todo");assert.equal(result.snapshot.items.root!.log.filter(entry=>entry.text.startsWith("转换前的依赖说明：")).length,1);
 assert.ok(result.snapshot.items.root!.log.some(entry=>entry.text.includes("duplicate explanation")));
});

test("manual wip does not promote old steps or fabricate new work",()=>{
 const source=snapshot();source.items.root=item({deps:[{id:"external",why:"later"}],steps:[{id:"write",text:"Write",state:"todo"}]});source.items.external=item({group:"Q"});
 const result=checked(source);assert.deepEqual(result.snapshot.items.root!.plan[1]!.after,[]);assert.equal(rules(result.snapshot).statusOf("root"),"todo");
 source.items.root=item({status:"wip",steps:[{id:"write",text:"Write",state:"todo"}]});const preserved=checked(source);assert.ok(preserved.snapshot.items.root!.plan.some(row=>"text"in row&&row.id==="write"&&row.state==="todo"&&row.since===undefined));
 source.items.root=item({status:"wip"});const added=checked(source);assert.equal(added.snapshot.items.root!.plan.length,1);assert.ok(added.report.statusChanges.some(change=>change.old==="wip"&&change.new==="todo"&&change.cause==="manual progress removed"));
});

test("record-owned open work receives no priority even with an external dependent; closed record children keep theirs",()=>{
 const source=snapshot();source.items.root=item({record:true,status:undefined,deps:[{id:"work",why:"backlog"}]});source.items.work=item({parent:"root",group:undefined,priority:"P1"});source.items.closed=item({parent:"root",group:undefined,status:"done",priority:"P2"});source.items.waiter=item({group:"Q",priority:"P0",steps:[{id:"prepare",text:"Prepare",state:"todo"}],deps:[{id:"work",why:"result"}]});
 const result=checked(source),r=rules(result.snapshot);assert.equal(r.priorityOf("work"),"");assert.equal(result.snapshot.items.work!.priority,undefined);assert.equal(r.isRoot("work"),false);assert.equal(r.priorityOf("closed"),"P2");
 assert.ok(result.report.priorityChanges.some(change=>change.item==="work"&&change.cause==="moved into backlog"));assert.equal(result.snapshot.items.root!.provisional,true);assert.ok(!result.snapshot.items.root!.plan.some(row=>"text"in row&&row.accept));
});

test("acceptance extraction rejects ambiguous/inline matches, keeps fenced text and exact unrelated head text",()=>{
 assert.deepEqual(extractAcceptance("Before **完成条件**：same paragraph"),{head:"Before **完成条件**：same paragraph",ambiguous:true});
 const duplicate="## 完成条件\nFirst\n\n## 怎样算完成\nSecond";assert.equal(extractAcceptance(duplicate).head,duplicate);
 const source=snapshot();source.items.root=item({head:"No completion section"});const result=checked(source);assert.equal(finalText(result.snapshot.items.root!.plan),MISSING_ACCEPT);
 const fenced="```md\n## 完成条件\nNot the condition\n```\n\n## 完成条件\nThe check";assert.equal(extractAcceptance(fenced).text,"The check");
});

test("independent oracle rejects corruption while reporting honest status and priority differences",()=>{
 const source=snapshot(),result=checked(source);
 const corruptions: Array<(copy:typeof result)=>void>=[copy=>{copy.snapshot.items.root!.title="lost";},copy=>{copy.snapshot.items.root!.head="lost";},copy=>{copy.snapshot.items.root!.log[0]!.text="lost";},copy=>{copy.snapshot.items.root!.priority="P0";},copy=>{copy.snapshot.items.root!.plan=[];},copy=>{copy.snapshot.items.root!.provisional=undefined;},copy=>{copy.report.counts.items++;},copy=>{delete copy.snapshot.items.root;}];
 for(const mutate of corruptions){const broken=structuredClone(result);mutate(broken);assert.ok(verifyPlans(source,broken).length);}
 const priority=snapshot();priority.items.root=item({priority:"P0",deps:[{id:"open",why:"work"}]});priority.items.open=item({parent:"root",group:undefined,priority:"P0"});priority.items.closed=item({parent:"root",group:undefined,status:"done",priority:"P2"});const propagated=checked(priority);assert.ok(propagated.report.priorityChanges.some(change=>change.item==="closed"&&change.old==="P2"&&change.new==="P0"&&change.cause==="owned row added"&&change.detail.includes("root")));
 const cancelledShared=snapshot();cancelledShared.items.root=item({status:"done",deps:[{id:"cancelled",why:"Old completed item still lists it"}]});cancelledShared.items.cancelled=item({status:"cancelled"});const kept=checked(cancelledShared);assert.ok(kept.snapshot.items.root!.plan.some(row=>"item"in row&&row.item==="cancelled"));assert.ok(kept.report.statusChanges.some(change=>change.old==="done"&&change.new==="blocked"&&change.cause==="unfinished plan rows"));
 const bad=snapshot();bad.items.root=item({status:"blocked"});assert.ok(checked(bad).report.statusChanges.some(change=>change.old==="blocked"&&change.new==="todo"));
 const pending=snapshot();pending.items.root=item({deps:[{id:"needed",why:"Needed"}]});pending.items.needed=item({group:"Q"});const waiting=checked(pending);assert.ok(waiting.report.statusChanges.some(change=>change.old==="todo"&&change.new==="blocked"&&change.cause==="waiting frontier"&&change.detail.includes("needed")));
 const ask=snapshot();ask.items.root=item({ask:{text:"Owner must approve this"}});const awaiting=checked(ask);assert.ok(awaiting.report.statusChanges.some(change=>change.old==="todo"&&change.new==="blocked"&&change.cause==="pending ask"&&change.detail.includes("Owner must approve this")));
 const altered=structuredClone(waiting);altered.report.statusChanges[0]!.new="todo";assert.ok(verifyPlans(pending,altered).some(error=>error.includes("difference report")));
 const missingSeed=structuredClone(result);delete missingSeed.snapshot.items.root!.priority;assert.ok(verifyPlans(source,missingSeed).some(error=>error.includes("root seed")));
});

test("only effective archives broken by actual conversion logs advance, with exact map/report preservation",()=>{
 const source=snapshot();source.items.root=item({status:"done",deps:[{id:"other",why:"Completed result"}],steps:[{id:"unfinished",text:"Unfinished",state:"todo"}]});source.items.other=item({group:"Q",status:"done"});source.items.child=item({parent:"root",group:undefined,status:"done"});source.owner.archived={root:at,other:since,orphan:since};assert.equal(legacyRules(source).inArchive("child"),true);
 const result=convertPlans(source,{at:"2026-10-13T02:00:00Z"});assert.deepEqual(result.report.errors,[]);assert.deepEqual(verifyPlans(source,result),[]);
 assert.deepEqual(source.owner.archived,{root:at,other:since,orphan:since});assert.deepEqual(result.snapshot.owner.archived,{root:"2026-10-13T02:00:00Z",other:since,orphan:since});
 assert.equal(result.report.archiveChanges.length,1);assert.equal(result.report.archiveChanges[0]!.oldArchiveAt,at);assert.equal(result.report.archiveChanges[0]!.newArchiveAt,"2026-10-13T02:00:00Z");assert.equal(rules(result.snapshot).isArchived("root"),true);assert.equal(rules(result.snapshot).isArchived("other"),false);assert.equal(rules(result.snapshot).inArchive("child"),true);assert.equal(Object.hasOwn(result.snapshot.owner.archived,"child"),false);
 const changed=structuredClone(result);changed.snapshot.owner.archived.orphan=at;assert.ok(verifyPlans(source,changed).some(error=>error.includes("archive map")));
 const unstamped=structuredClone(result);unstamped.snapshot.owner.archived.root=at;assert.ok(verifyPlans(source,unstamped).some(error=>error.includes("archive")));
 const fakeReport=structuredClone(result);fakeReport.report.archiveChanges[0]!.oldArchiveAt=since;assert.ok(verifyPlans(source,fakeReport).some(error=>error.includes("archive adjustment report")));
});

test("approved startup migration is one atomic commit, preserves raw history and normalizes baselines; stale approval refuses",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"wf-board-plan-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));const git=promisify(execFile);
 const source=snapshot();source.owner.archived={};
 await git("git",["init","-b","main"],{cwd:dir});await mkdir(join(dir,"items"));await mkdir(join(dir,"state"));
 await writeFile(join(dir,"board.yaml"),stringify(source.board));await writeFile(join(dir,"items/root.yaml"),stringify(source.items.root));await writeFile(join(dir,"state/owner.yaml"),stringify(source.owner));
 await git("git",["add","."],{cwd:dir});await git("git",["-c","user.name=Test","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","commit","-m","Synthetic legacy data"],{cwd:dir});const head=(await git("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim();
 const reportDir=await mkdtemp(join(tmpdir(),"wf-board-plan-report-"));t.after(()=>rm(reportDir,{recursive:true,force:true}));const reportFile=join(reportDir,"report.yaml");
 const dryrun=await git(process.execPath,["src/convert-plans-cli.ts","--data",dir,"--dry-run","--report",reportFile]);assert.match(dryrun.stdout,/"errors":0/);assert.equal((await git("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim(),head);
 const dryReport=parse(await readFile(reportFile,"utf8"));assert.equal(dryReport.sourceHead,head);
 await assert.rejects(git(process.execPath,["src/convert-plans-cli.ts","--data",dir,"--report",reportFile]),/approved-head/);
 await assert.rejects(Store.open(dir),/owner-approved/);await assert.rejects(Store.open(dir,{planConversionHead:"b".repeat(40)}),/differs/);assert.equal((await git("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim(),head);
 const store=await Store.open(dir,{planConversionHead:head});const history=await store.log({since:head});assert.equal(history.length,1);assert.equal(history[0]!.author,"总管");assert.equal(history[0]!.message,PLAN_CONVERSION_MESSAGE);assert.ok(history[0]!.files.includes("import/plan-conversion.yaml"));
 assert.ok("deps"in(await store.show("item","root",head)as object));assert.ok("plan"in(await store.showCompared("item","root",head)as object));
 assert.deepEqual((await store.comparisonSnapshot(head)).items.root!.plan,store.snapshot().items.root!.plan);const report=parse(await readFile(join(dir,"import/plan-conversion.yaml"),"utf8"));assert.equal(report.sourceHead,head);assert.deepEqual(report.errors,[]);assert.match(report.summary,/均已保留/);assert.doesNotMatch(report.summary,/等待独立保留校验/);
 assert.equal((await Store.open(dir)).snapshot().head,store.snapshot().head);
});


test("reader accepts current records with omitted plans and detects empty legacy boards and mixed work shapes", async t => {
  const dir=await mkdtemp(join(tmpdir(),"wf-board-plan-reader-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=await Store.open(dir,{init:true,board:{title:"Reader",projects:[{name:"P"}]}});
  await store.commit({author:"P",message:"Current work and record",puts:[
    {kind:"item",id:"work",expectRev:null,doc:{title:"Work",group:"P",plan:[{id:"accept",accept:true,text:"Passes",state:"todo"}],updated:at}},
    {kind:"item",id:"record",expectRev:null,doc:{title:"Record",group:"P",record:true,updated:at}},
  ]});
  const git=promisify(execFile);
  await writeFile(join(dir,"items/record.yaml"),stringify({title:"Record",group:"P",record:true,log:[],links:[],updated:at,rev:1}));
  await git("git",["add","items/record.yaml"],{cwd:dir});
  await git("git",["-c","user.name=Test","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","commit","-m","Synthetic omitted record plan"],{cwd:dir});
  const current=await readPlanData(dir);
  assert.equal(current.legacy,false);
  assert.deepEqual(current.snapshot.items.record&&"plan"in current.snapshot.items.record?current.snapshot.items.record.plan:undefined,[]);
  assert.equal((await Store.open(dir)).snapshot().items.record!.record,true);
  await writeFile(join(dir,"items/legacy.yaml"),stringify(item()));
  await assert.rejects(readPlanData(dir),/Mixed legacy and plan/);

  const empty=await mkdtemp(join(tmpdir(),"wf-board-empty-legacy-"));
  t.after(()=>rm(empty,{recursive:true,force:true}));
  await git("git",["init","-b","main"],{cwd:empty});
  await writeFile(join(empty,"board.yaml"),stringify({title:"Empty legacy",projects:[{name:"P",migrated:false}]}));
  await git("git",["add","board.yaml"],{cwd:empty});
  await git("git",["-c","user.name=Test","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","commit","-m","Synthetic empty legacy board"],{cwd:empty});
  const legacy=await readPlanData(empty);
  assert.equal(legacy.legacy,true);
  assert.deepEqual(legacy.snapshot.items,{});
  await assert.rejects(Store.open(empty),/owner-approved/);
});


test("independent oracle rejects full-row reordering, reference interleaving and arbitrary conversion logs",()=>{
 const source=snapshot();source.items.root=item({deps:[{id:"shared",why:"Result"}],steps:[{id:"one",text:"One",state:"todo"},{id:"two",text:"Two",state:"todo"}]});source.items.shared=item({group:"Q"});
 const result=checked(source);
 const swapped=structuredClone(result);[swapped.snapshot.items.root!.plan[1],swapped.snapshot.items.root!.plan[2]]=[swapped.snapshot.items.root!.plan[2]!,swapped.snapshot.items.root!.plan[1]!];assert.ok(verifyPlans(source,swapped).some(error=>error.includes("sequence")));
 const interleaved=structuredClone(result);[interleaved.snapshot.items.root!.plan[0],interleaved.snapshot.items.root!.plan[1]]=[interleaved.snapshot.items.root!.plan[1]!,interleaved.snapshot.items.root!.plan[0]!];assert.ok(verifyPlans(source,interleaved).some(error=>error.includes("sequence")));
 const invented=structuredClone(result);invented.snapshot.items.root!.log.push({at,by:"总管",text:"Arbitrary undocumented conversion event"});invented.report.counts.newLogs++;assert.ok(verifyPlans(source,invented).some(error=>error.includes("unprescribed conversion logs")));
});

async function legacyRepository(t: {after(fn:()=>Promise<void>):void}) {
 const dir=await mkdtemp(join(tmpdir(),"wf-board-unread-plan-"));t.after(()=>rm(dir,{recursive:true,force:true}));const git=promisify(execFile),source=snapshot();
 await git("git",["init","-b","main"],{cwd:dir});await mkdir(join(dir,"items"));await mkdir(join(dir,"state"));
 await writeFile(join(dir,"board.yaml"),stringify(source.board));await writeFile(join(dir,"items/root.yaml"),stringify(source.items.root));await writeFile(join(dir,"state/owner.yaml"),stringify(source.owner));
 await git("git",["add","."],{cwd:dir});await git("git",["-c","user.name=Test","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","commit","-m","Synthetic old baseline"],{cwd:dir});
 const head=(await git("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim();return {dir,git,source,head};
}

test("unread comparison preserves real changes across conversion while excluding the migration commit",async t=>{
 const {dir,git,source,head:cursor}=await legacyRepository(t);
 const originalHead=source.items.root!.head;
 source.items.root!.head="**问题**：Real pre-conversion head change\n\n**完成条件**：CI passes";source.items.root!.rev++;source.items.root!.updated="2026-10-13T02:00:00Z";
 await writeFile(join(dir,"items/root.yaml"),stringify(source.items.root));
 await git("git",["add","items/root.yaml"],{cwd:dir});await git("git",["-c","user.name=Test","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","commit","--author","P <p@wf-board.invalid>","-m","Real head change before migration"],{cwd:dir});
 const oldHead=(await git("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim();
 await writeFile(join(dir,"state/owner.yaml"),stringify({archived:{},cursor}));
 const store=await Store.open(dir,{planConversionHead:oldHead}),migration=store.snapshot().head;
 const beforeLater=await unreadSteps(store,cursor);assert.equal(beforeLater.length,1);assert.deepEqual(beforeLater[0]!.commits,[oldHead]);assert.equal(beforeLater[0]!.docs[0]!.summary,"head changed");assert.deepEqual(beforeLater[0]!.docs[0]!.pieces,{progress:0,reply:0,other:1});
 const prior=await stepDiff(store,beforeLater[0]!,"item","root");assert.ok(prior.before&&typeof prior.before==="object"&&"plan"in prior.before);assert.ok(prior.after&&typeof prior.after==="object"&&"plan"in prior.after);assert.match(prior.diff,/Real pre-conversion head change/);
 const raw=await store.show("item","root",cursor) as {head?:string;deps?:unknown;plan?:unknown};assert.equal(raw.head,originalHead);assert.ok(Object.hasOwn(raw,"deps"));assert.equal(raw.plan,undefined);
 const later=await ops(store,()=>"2026-10-13T03:00:00Z").setPlan({author:"P",id:"root",row:{id:"write",text:"Real later progress",state:"doing"}});
 const unread=await unreadSteps(store,cursor);assert.equal(unread.length,2);assert.ok(unread.every(step=>!step.commits.includes(migration)));assert.deepEqual(unread[0]!.commits,[oldHead]);assert.deepEqual(unread[1]!.commits,[later.commit]);assert.deepEqual(unread[1]!.docs[0]!.pieces,{progress:1,reply:0,other:0});
 const progress=await stepDiff(store,unread[1]!,"item","root");assert.deepEqual(progress.before,await store.show("item","root",migration));assert.match(progress.diff,/Real later progress/);
 assert.equal((await store.show("item","root",cursor) as {head:string}).head,originalHead);assert.match(await store.diff("item","root",cursor,oldHead),/Real pre-conversion head change/);
});


test("summary gives Chinese cause counts and claims preservation only after successful independent verification",()=>{
 const source=snapshot();source.items.root=item({status:"wip"});const result=checked(source);
 assert.equal(Object.keys(result.report)[0],"summary");assert.match(result.report.summary,/等待独立保留校验/);assert.match(result.report.summary,/不再沿用手写进行中状态 1 处/);
 updatePlanSummary(result.report,true);assert.match(result.report.summary,/均已保留/);
 result.report.errors.push("Synthetic corruption");updatePlanSummary(result.report,true);assert.doesNotMatch(result.report.summary,/均已保留/);assert.match(result.report.summary,/不能应用转换/);
});

 test("startup persists archive advancement with the conversion and restores the exact owner sidefile on failure",async t=>{
 const {dir,git,source,head:baseline}=await legacyRepository(t),oldAt="2000-01-01T00:00:00Z";
 source.items.root=item({status:"done",updated:oldAt,log:[{at:oldAt,text:"Original"}],deps:[{id:"closed",why:"Done result"}]});source.items.closed=item({status:"done",group:"Q",updated:oldAt,log:[]});source.owner.archived={root:oldAt};
 await writeFile(join(dir,"items/root.yaml"),stringify(source.items.root));await writeFile(join(dir,"items/closed.yaml"),stringify(source.items.closed));
 // Preserve noncanonical YAML formatting as well as the owner's cursor and archive values.
 const originalOwner=`# Original owner formatting\ncursor: ${baseline}\narchived: { root: '${oldAt}' }\n`;await writeFile(join(dir,"state/owner.yaml"),originalOwner);
 await git("git",["add","."],{cwd:dir});await git("git",["-c","user.name=Test","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","commit","-m","Archived synthetic source"],{cwd:dir});
 const head=(await git("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim(),originalItem=await readFile(join(dir,"items/root.yaml"));
 await writeFile(join(dir,".git/hooks/pre-commit"),"#!/bin/sh\nexit 1\n",{mode:0o755});
 await assert.rejects(Store.open(dir,{planConversionHead:head}));assert.equal((await git("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim(),head);assert.equal(await readFile(join(dir,"state/owner.yaml"),"utf8"),originalOwner);assert.deepEqual(await readFile(join(dir,"items/root.yaml")),originalItem);assert.equal((await git("git",["diff","--cached","--name-only"],{cwd:dir})).stdout.trim(),"");await assert.rejects(readFile(join(dir,"import/plan-conversion.yaml")),{code:"ENOENT"});
 await rm(join(dir,".git/hooks/pre-commit"));
 const store=await Store.open(dir,{planConversionHead:head}),report=parse(await readFile(join(dir,"import/plan-conversion.yaml"),"utf8"));assert.equal(report.archiveChanges.length,1);assert.equal(store.snapshot().owner.archived.root,report.at);assert.equal(store.snapshot().owner.cursor,baseline);assert.equal(parse(await readFile(join(dir,"state/owner.yaml"),"utf8")).archived.root,report.at);assert.match(report.summary,/均已保留/);assert.doesNotMatch(report.summary,/等待独立保留校验/);assert.equal(rules(store.snapshot()).isArchived("root"),true);
 const history=await store.log({since:head});assert.equal(history.length,1);assert.ok(history[0]!.files.includes("state/owner.yaml"));assert.equal(parse((await git("git",["show",`${history[0]!.commit}:state/owner.yaml`],{cwd:dir})).stdout).archived.root,report.at);assert.equal((await store.show("item","root",head)as {updated:string}).updated,oldAt);
});
