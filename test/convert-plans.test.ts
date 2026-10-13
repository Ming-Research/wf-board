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
import { convertPlans, removeArchives, extractAcceptance, MISSING_ACCEPT, CLOSED_ACCEPT, PLAN_CONVERSION_MESSAGE, updatePlanSummary } from "../src/convert-plans.ts";
import { verifyPlans, verifyArchiveRemoval } from "../src/verify-plans.ts";
import { derivePlanOracle } from "../src/plan-conversion-oracle.ts";
import { rules } from "../src/rules.ts";
import { rules as legacyRules } from "../src/legacy-rules.ts";
import { unreadSteps, stepDiff } from "../src/history.ts";
import { ops } from "../src/ops.ts";
import { Store, readPlanData, NUMBERING_MESSAGE } from "../src/store.ts";
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

test("record-owned work receives shared open priority, but no priority from its record owner",()=>{
 const source=snapshot();source.items.root=item({record:true,status:undefined,deps:[{id:"work",why:"backlog"}]});source.items.work=item({parent:"root",group:undefined,priority:"P1"});source.items.closed=item({parent:"root",group:undefined,status:"done",priority:"P2"});source.items.waiter=item({group:"Q",priority:"P0",steps:[{id:"prepare",text:"Prepare",state:"todo"}],deps:[{id:"work",why:"result"}]});
 assert.equal(legacyRules(source).priorityOf("work"),"P0","the open legacy waiter already raises its dependency");
 const result=checked(source),r=rules(result.snapshot);assert.equal(r.priorityOf("work"),"P0");assert.equal(result.snapshot.items.work!.priority,undefined);assert.equal(r.isRoot("work"),false);assert.equal(r.priorityOf("closed"),"P2");
 assert.ok(!result.report.priorityChanges.some(change=>change.item==="work"),"unchanged P0 must not be reported as a priority change");assert.equal(result.snapshot.items.root!.provisional,true);assert.ok(!result.snapshot.items.root!.plan.some(row=>"text"in row&&row.accept));
 source.items.waiter=item({group:"Q",priority:"P0",status:"cancelled",deps:[{id:"work",why:"Result no longer needed"}]});
 const idle=checked(source);assert.equal(rules(idle.snapshot).priorityOf("work"),"");assert.equal(rules(idle.snapshot).isRoot("work"),false);assert.ok(idle.report.priorityChanges.some(change=>change.item==="work"&&change.cause==="moved into backlog"));
});

test("verifier checks record-owned priority when an unfinished legacy done waiter becomes open",()=>{
 const source=snapshot();source.items.root=item({record:true,status:undefined,deps:[{id:"work",why:"Queue entry"}]});source.items.work=item({parent:"root",group:undefined,priority:"P1"});source.items.waiter=item({group:"Q",priority:"P0",status:"done",steps:[{id:"prepare",text:"Unfinished preparation",state:"todo"}],deps:[{id:"work",why:"Result"}]});
 const before=legacyRules(source);assert.equal(before.statusOf("waiter"),"done");assert.equal(before.priorityOf("work"),"P1","the legacy closed waiter passes no priority; its record owner passes P1");
 const result=checked(source),after=rules(result.snapshot);assert.equal(after.statusOf("waiter"),"todo");assert.equal(after.priorityOf("work"),"P0");assert.equal(result.snapshot.items.work!.priority,undefined);assert.equal(after.isRoot("work"),false);
 const change=result.report.priorityChanges.find(change=>change.item==="work");assert.ok(change);assert.equal(change.old,"P1");assert.equal(change.new,"P0");assert.equal(change.cause,"shared plan dependents");assert.match(change.detail,/共用.*waiter.*P0/);
 const wronglySuppressed=structuredClone(result);wronglySuppressed.report.priorityChanges.find(change=>change.item==="work")!.new="";assert.ok(verifyPlans(source,wronglySuppressed).some(error=>error.includes("priority difference report")),"the independent oracle rejects suppressed shared priority on record-owned work");
});

test("conversion retains a root's stored seed when its old displayed priority was empty",()=>{
 const source=snapshot();source.board=LegacyBoard.parse({title:"Unmigrated",projects:[{name:"P",migrated:false}]});
 source.items.root=item({priority:"P0",deps:[{id:"child",why:"Needed work"}]});source.items.child=item({parent:"root",priority:undefined});
 assert.equal(legacyRules(source).priorityOf("root"),"");
 const result=checked(source);assert.equal(rules(result.snapshot).isRoot("root"),true);assert.equal(result.snapshot.items.root!.priority,"P0");assert.equal(rules(result.snapshot).priorityOf("root"),"P0");assert.equal(rules(result.snapshot).priorityOf("child"),"P0");
 assert.ok(!result.snapshot.items.root!.log.some(entry=>entry.text.includes("优先级改由依赖它的条目决定")));
 assert.ok(result.report.priorityChanges.some(change=>change.item==="root"&&change.old===""&&change.new==="P0"&&change.cause==="root priority retained"&&change.detail.includes("原来写的 P0")));
 assert.equal(result.report.byCause.priority["root priority retained"],1);assert.match(result.report.summary,/根保留旧显示未体现的存储优先级 1 处/);
 const lostSeed=structuredClone(result);delete lostSeed.snapshot.items.root!.priority;assert.ok(verifyPlans(source,lostSeed).some(error=>error.includes("root seed")));
 const inventedRetirement=structuredClone(result);inventedRetirement.snapshot.items.root!.log.push({at,by:"总管",text:"迁移到依赖结构：优先级改由依赖它的条目决定，原来写的 P0 不再使用"});inventedRetirement.report.counts.newLogs++;assert.ok(verifyPlans(source,inventedRetirement).some(error=>error.includes("unprescribed conversion logs")));
});

test("converted cancellation leaves acceptance open when reopened and other rows resolve",async t=>{
 const source=snapshot();source.items.root=item({status:"cancelled",steps:[{id:"work",text:"Produce the result",state:"todo"}]});
 const result=checked(source),acceptance=result.snapshot.items.root!.plan.at(-1);assert.ok(acceptance&&"text"in acceptance);assert.equal(acceptance.state,"todo");assert.equal(acceptance.reason,undefined);assert.equal(acceptance.droppedAt,undefined);
 const incorrectlyDropped=structuredClone(result),badAccept=incorrectlyDropped.snapshot.items.root!.plan.at(-1);assert.ok(badAccept&&"text"in badAccept);badAccept.state="dropped";badAccept.reason="条目已取消";badAccept.droppedAt=at;assert.ok(verifyPlans(source,incorrectlyDropped).some(error=>error.includes("acceptance state")));
 const dir=await mkdtemp(join(tmpdir(),"wf-board-reopen-conversion-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await Store.open(dir,{init:true,board:{title:"Reopened conversion",projects:[{name:"P"}]}});
 await store.commit({author:"P",message:"Synthetic converted cancelled item",puts:[{kind:"item",id:"root",expectRev:null,doc:result.snapshot.items.root!}]});
 const write=ops(store,()=>"2026-10-13T02:00:00Z");await write.setStatus({author:"P",id:"root",status:"open",log:"Resume the cancelled work"});
 await write.setPlan({author:"P",id:"root",row:{id:"work",text:"Produce the result",state:"done"}});
 assert.equal(rules(store.snapshot()).statusOf("root"),"todo");const reopenedAcceptance=store.snapshot().items.root!.plan.at(-1);assert.ok(reopenedAcceptance&&"text"in reopenedAcceptance);assert.equal(reopenedAcceptance.state,"todo");
 await write.setPlan({author:"P",id:"root",row:{id:acceptance.id,text:acceptance.text,accept:true,state:"done"}});assert.equal(rules(store.snapshot()).statusOf("root"),"done");
});

test("independent oracle evaluates shared diamond targets once and keeps cyclic walks path-sensitive",()=>{
 const converted=checked(snapshot()).snapshot,base=converted.items.root!;converted.items={};let planReads=0;
 for(let level=0;level<14;level++)for(const side of ["a","b"]){
   const id=`${side}-${level}`,plan:typeof base.plan=level===13?[]:[{id:`a-${level+1}`,item:`a-${level+1}`,own:false,after:[]},{id:`b-${level+1}`,item:`b-${level+1}`,own:false,after:[]}];
   plan.push({id:"accept",text:"Result accepted",state:"todo",accept:true});
   converted.items[id]=new Proxy({...base,plan},{get(target,key,receiver){if(key==="plan")planReads++;return Reflect.get(target,key,receiver);}});
 }
 const oracle=derivePlanOracle(converted);assert.equal(oracle.statusOf("a-0"),"blocked");assert.equal(oracle.statusOf("b-0"),"blocked");assert.equal(oracle.statusOf("a-13"),"todo");
 assert.ok(planReads<=Object.keys(converted.items).length*3,`shared targets were repeatedly expanded: ${planReads} plan reads`);
 converted.items={a:{...base,plan:[{id:"b",item:"b",own:true,after:[]},{id:"accept",text:"Accepted",state:"todo",accept:true}]},b:{...base,plan:[{id:"a",item:"a",own:true,after:[]},{id:"work",text:"Actual work",state:"doing",since,after:[]},{id:"accept",text:"Accepted",state:"todo",accept:true}]}};
 const cyclic=derivePlanOracle(converted);assert.equal(cyclic.statusOf("a"),"wip");assert.equal(cyclic.statusOf("b"),"wip");
 assert.equal(cyclic.rows("a")[0]!.state,"progress");assert.equal(cyclic.rows("b")[0]!.state,"waiting");assert.equal(cyclic.rows("a")[0]!.state,"progress");
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

test("conversion drops every archive record, including ineffective and orphan records, while preserving reading state",()=>{
 const source=snapshot();source.items.root=item({status:"done",deps:[{id:"other",why:"Completed result"}],steps:[{id:"unfinished",text:"Unfinished",state:"todo"}]});source.items.other=item({group:"Q",status:"done"});source.items.child=item({parent:"root",group:undefined,status:"done"});
 source.owner={archived:{root:at,other:since,orphan:since},cursor:source.head,readMarks:{"item:child":source.head}};
 const original=structuredClone(source),result=convertPlans(source,{at:"2026-10-13T02:00:00Z"});assert.deepEqual(result.report.errors,[]);assert.deepEqual(verifyPlans(source,result),[]);
 assert.deepEqual(source,original);assert.deepEqual(result.snapshot.owner,{cursor:source.head,readMarks:{"item:child":source.head}});
 assert.equal(result.report.counts.droppedArchives,3);
 const restored=structuredClone(result);Object.assign(restored.snapshot.owner,{archived:{orphan:since}});assert.ok(verifyPlans(source,restored).some(error=>error.includes("owner")));
 const wrongCount=structuredClone(result);wrongCount.report.counts.droppedArchives--;assert.ok(verifyPlans(source,wrongCount).some(error=>error.includes("archive count")));
 const lostRead=structuredClone(result);delete lostRead.snapshot.owner.readMarks;assert.ok(verifyPlans(source,lostRead).some(error=>error.includes("owner state")));
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
 const store=await Store.open(dir,{planConversionHead:head});const all=await store.log({since:head});assert.equal(all[0]!.message,NUMBERING_MESSAGE,"the converted board is then numbered once");const history=all.slice(1);assert.equal(history.length,1);assert.equal(history[0]!.author,"总管");assert.equal(history[0]!.message,PLAN_CONVERSION_MESSAGE);assert.ok(history[0]!.files.includes("import/plan-conversion.yaml"));
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
 updatePlanSummary(result.report,true);assert.match(result.report.summary,/均已保留/);assert.match(result.report.summary,/需在阶段二重写计划：1 个旧 wip 条目没有进行中行，其中 1 个变为 todo，0 个因等待行变为 blocked/);
 result.report.errors.push("Synthetic corruption");updatePlanSummary(result.report,true);assert.doesNotMatch(result.report.summary,/均已保留/);assert.match(result.report.summary,/不能应用转换/);
});

 test("startup drops archives with the conversion and restores the exact owner sidefile on failure",async t=>{
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
 const store=await Store.open(dir,{planConversionHead:head}),report=parse(await readFile(join(dir,"import/plan-conversion.yaml"),"utf8"));assert.equal(report.counts.droppedArchives,1);assert.equal(Object.hasOwn(store.snapshot().owner,"archived"),false);assert.equal(store.snapshot().owner.cursor,baseline);assert.equal(Object.hasOwn(parse(await readFile(join(dir,"state/owner.yaml"),"utf8")),"archived"),false);assert.match(report.summary,/均已保留/);assert.doesNotMatch(report.summary,/等待独立保留校验/);
 const all=await store.log({since:head});assert.equal(all[0]!.message,NUMBERING_MESSAGE,"the converted board is then numbered once");const history=all.slice(1);assert.equal(history.length,1);assert.ok(history[0]!.files.includes("state/owner.yaml"));assert.equal(Object.hasOwn(parse((await git("git",["show",`${history[0]!.commit}:state/owner.yaml`],{cwd:dir})).stdout),"archived"),false);assert.equal((await store.show("item","root",head)as {updated:string}).updated,oldAt);
});


test("native plans with old archives migrate owner state only, preserving plans, revisions, history and read marks", async t => {
 const dir=await mkdtemp(join(tmpdir(),"wf-board-native-archives-"));t.after(()=>rm(dir,{recursive:true,force:true}));const git=promisify(execFile);
 const initial=await Store.open(dir,{init:true,board:{title:"Native plans",projects:[{name:"P"}]}});
 await initial.commit({author:"P",message:"Native plan witnesses",puts:[
  {kind:"item",id:"work",expectRev:null,doc:{title:"Work",group:"P",priority:"P0",plan:[{id:"working",text:"Actual current work",state:"doing",since},{id:"accept",text:"Pass",state:"todo",accept:true}],targets:[{id:"rate",goal:"Rate",target:"3",current:"2",baseline:"main",date:since}],log:[{at:since,by:"P",text:"Native log"}],updated:at}},
  {kind:"item",id:"done",expectRev:null,doc:{title:"Done",group:"P",priority:"P1",plan:[{id:"accept",text:"Pass",state:"done",doneAt:at,accept:true}],updated:at}},
 ]});
 const before=initial.snapshot(),oldOwner={cursor:before.head,readMarks:{"item:work":before.head},archived:{done:at,orphan:since}};
 await mkdir(join(dir,"state"),{recursive:true});await writeFile(join(dir,"state/owner.yaml"),stringify(oldOwner));
 await git("git",["add","state/owner.yaml"],{cwd:dir});await git("git",["-c","user.name=Test","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","commit","-m","Native plans with old archives"],{cwd:dir});
 const head=(await git("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim(),itemBytes=await readFile(join(dir,"items/work.yaml"));
 const read=await readPlanData(dir);assert.equal(read.legacy,false);assert.equal(read.hasArchives,true);
 const source=read.snapshot as import("../src/model.ts").Snapshot, result=removeArchives(source,{at});assert.deepEqual(verifyArchiveRemoval(source,result),[]);
 const corruptedContent=structuredClone(result);corruptedContent.snapshot.items.work!.plan[0]!.id="lost";assert.ok(verifyArchiveRemoval(source,corruptedContent).some(error=>error.includes("changed content")));
 const resurrectedArchive=structuredClone(result);Object.assign(resurrectedArchive.snapshot.owner,{archived:{done:at}});assert.ok(verifyArchiveRemoval(source,resurrectedArchive).some(error=>error.includes("archive field")));
 const changedCount=structuredClone(result);changedCount.report.counts.droppedArchives--;assert.ok(verifyArchiveRemoval(source,changedCount).some(error=>error.includes("archive count")));
 const lostRead=structuredClone(result);delete lostRead.snapshot.owner.readMarks;assert.ok(verifyArchiveRemoval(source,lostRead).some(error=>error.includes("other owner fields")));
 const inventedPointer=structuredClone(result);inventedPointer.report.rewritePointers.push({item:"work",project:"P",kind:"invented",detail:"Not archive removal"});assert.ok(verifyArchiveRemoval(source,inventedPointer).some(error=>error.includes("invented differences")));
 const reportDir=await mkdtemp(join(tmpdir(),"wf-board-native-archive-report-"));t.after(()=>rm(reportDir,{recursive:true,force:true}));const reportFile=join(reportDir,"report.yaml");
 const dry=await git(process.execPath,["src/convert-plans-cli.ts","--data",dir,"--dry-run","--report",reportFile]);assert.match(dry.stdout,/"errors":0/);
 const dryReport=parse(await readFile(reportFile,"utf8"));assert.equal(dryReport.counts.droppedArchives,2);assert.deepEqual(dryReport.statusChanges,[]);assert.deepEqual(dryReport.priorityChanges,[]);assert.equal((await git("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim(),head);
 await assert.rejects(Store.open(dir),/owner-approved/);
 const migrated=await Store.open(dir,{planConversionHead:head}),next=migrated.snapshot();assert.deepEqual(next.items,before.items);assert.deepEqual(next.owner,{cursor:before.head,readMarks:{"item:work":before.head}});assert.deepEqual(await readFile(join(dir,"items/work.yaml")),itemBytes);
 const commits=await migrated.log({since:head});assert.equal(commits.length,1);assert.ok(commits[0]!.files.includes("state/owner.yaml"));assert.ok(commits[0]!.files.includes("import/plan-conversion.yaml"));assert.ok(!commits[0]!.files.some(file=>file.startsWith("items/")));
 assert.deepEqual((await migrated.comparisonSnapshot(head)).owner,next.owner,"historical native plans normalize removed owner fields only for comparison");
 assert.deepEqual(await migrated.showCompared("item","work",head),before.items.work);assert.deepEqual(await migrated.show("item","work",head),before.items.work);
 assert.deepEqual(parse((await git("git",["show",`${head}:state/owner.yaml`],{cwd:dir})).stdout),oldOwner,"raw history retains archive provenance");
 assert.deepEqual(await unreadSteps(migrated,head),[],"archive retirement is not a content unread stop");
 assert.equal((await Store.open(dir)).snapshot().head,next.head,"reopening does not convert again");
});


test("archive retirement preserves the first plan-conversion timestamp for old unread baselines", async t => {
 const {dir,git,source}=await legacyRepository(t);
 source.items.root=item({deps:[{id:"result",why:"Original dependency explanation"}]});source.items.result=item({group:"Q",status:"done"});
 await writeFile(join(dir,"items/root.yaml"),stringify(source.items.root));await writeFile(join(dir,"items/result.yaml"),stringify(source.items.result));
 await git("git",["add","items"],{cwd:dir});await git("git",["-c","user.name=Test","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","commit","-m","Legacy dependency witness"],{cwd:dir});
 const legacyHead=(await git("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim();
 const initial=await Store.open(dir,{planConversionHead:legacyHead}),firstPlanHead=initial.snapshot().head;
 const firstReport=parse(await readFile(join(dir,"import/plan-conversion.yaml"),"utf8")),originalComparison=await initial.comparisonSnapshot(legacyHead),rawLegacy=await initial.show("item","root",legacyHead);
 assert.ok(originalComparison.items.root!.log.some(entry=>entry.text.includes("Original dependency explanation")&&entry.at===firstReport.at));
 const oldOwner={cursor:legacyHead,archived:{result:at}};
 await writeFile(join(dir,"state/owner.yaml"),stringify(oldOwner));await git("git",["add","state/owner.yaml"],{cwd:dir});await git("git",["-c","user.name=Test","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","commit","-m","Reintroduced old archive state"],{cwd:dir});
 const archiveHead=(await git("git",["rev-parse","HEAD"],{cwd:dir})).stdout.trim(),upgraded=await Store.open(dir,{planConversionHead:archiveHead});
 const removalReport=parse(await readFile(join(dir,"import/plan-conversion.yaml"),"utf8"));assert.notEqual(removalReport.at,firstReport.at);assert.equal(removalReport.planConversionAt,firstReport.planConversionAt??firstReport.at);
 assert.deepEqual(await upgraded.comparisonSnapshot(legacyHead),originalComparison,"archive-only report replacement cannot restamp historical conversion logs");
 assert.deepEqual(await upgraded.show("item","root",legacyHead),rawLegacy,"raw legacy audit is never normalized or rewritten");
 assert.deepEqual(await unreadSteps(upgraded,firstPlanHead),[],"archive owner writes and archive migration add no content unread changes");
 const later=await ops(upgraded,()=>"2030-01-01T00:00:00Z").setPlan({author:"P",id:"root",row:{id:"actual",text:"Later real plan progress",state:"doing",after:[]}});
 const unread=await unreadSteps(upgraded,legacyHead);assert.equal(unread.length,1);assert.deepEqual(unread[0]!.commits,[later.commit]);assert.deepEqual(unread[0]!.docs[0]!.pieces,{progress:1,reply:0,other:0});
 const progress=await stepDiff(upgraded,unread[0]!,"item","root");assert.match(progress.diff,/Later real plan progress/);assert.deepEqual(await upgraded.comparisonSnapshot(legacyHead),originalComparison);
});
