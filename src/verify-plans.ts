/** Independent preservation oracle. It never calls the converter or its extraction helper. */
import { isDeepStrictEqual as equal } from "node:util";
import { Item, Board, OwnerState } from "./model.ts";
import type { Snapshot as LegacySnapshot } from "./legacy-model.ts";
import { rules as oldRules } from "./legacy-rules.ts";
import { rules as newRules } from "./rules.ts";
import type { PlanRow, LogEntry, Snapshot } from "./model.ts";
import { derivePlanOracle } from "./plan-conversion-oracle.ts";
import type { PlanConversion } from "./convert-plans.ts";

export function verifyPlans(old: LegacySnapshot, result: PlanConversion): string[] {
  const errors: string[] = [], next=result.snapshot, before=oldRules(old), actual=newRules(next), after=derivePlanOracle(next,id=>before.priorityOf(id)||old.items[id]?.priority||"");
  const check=(ok:boolean,path:string)=>{if(!ok)errors.push(path);};
  const keys=(value:object)=>Object.keys(value).sort();
  const survey: Record<string,number>={parents:0,topItems:0,closed:0,closedTop:0,archived:0,stepsItems:0,sharedItemDeps:0,crossProjectDeps:0,sameProjectDeps:0,cardDeps:0,unlistedChildren:0,ownWorkSubitems:0,openMissingAcceptance:0,closedMissingAcceptance:0,wipWithoutDoing:0,ruleChanges:0};
  const inc=(key:string,n=1)=>survey[key]=(survey[key]??0)+n;
  check(equal(keys(old.items),keys(next.items)),"item ids changed");
  for(const collection of ["decisions","notes","glossaries"] as const)check(equal(old[collection],next[collection]),`${collection} changed`);
  // Notices are no longer a document kind; a legacy board's pass through the conversion untouched, and the next start retires them.
  check(equal(old.notices,(next as unknown as {notices?:unknown}).notices),"notices changed");
  check(equal({...old.board,projects:old.board.projects.map(({migrated:_m,...project})=>project)},next.board),"board changed beyond retired migration switch");
  check(Board.safeParse(next.board).success,"new board schema invalid");
  const {archived:_oldArchives,...oldOwner}=old.owner;
  check(equal(oldOwner,next.owner),"owner state changed beyond archive removal");
  check(OwnerState.safeParse(next.owner).success,"new owner schema invalid");
  check(result.report.counts.droppedArchives===Object.keys(old.owner.archived).length,"dropped archive count changed");
  const expectedStatusChanges: typeof result.report.statusChanges=[], expectedPriorityChanges: typeof result.report.priorityChanges=[];
  for(const [id,source] of Object.entries(old.items)) {
    const target=next.items[id];if(!target)continue;
    check(Item.safeParse(target).success,`${id}: new item schema invalid`);
    const sourceFields=Object.fromEntries(Object.entries(source).filter(([key])=>!["parent","deps","steps","status","priority","head","group","log"].includes(key)));
    const targetFields=Object.fromEntries(Object.entries(target).filter(([key])=>!["plan","status","priority","head","group","log","provisional"].includes(key)));
    check(equal(sourceFields,targetFields),`${id}: preserved item fields changed`);
    check(target.group===before.groupOf(id),`${id}: project changed`);
    check(equal(source.log,target.log.slice(0,source.log.length)),`${id}: original logs changed`);
    check(target.plan.length===0&&!source.record?false:!target.plan.length||target.provisional===true,`${id}: provisional mark missing`);
    const owns=target.plan.filter(row=>"item" in row&&row.own).map(row=>"item"in row?row.item:"").sort();
    check(equal(owns,keys(old.items).filter(child=>old.items[child]!.parent===id).sort()),`${id}: parent mapping changed`);
    for(const row of target.plan)if("item"in row||"card"in row)check(equal(row.after,[]),`${id}:${row.id}: invented dependency order`);
    const expectedLogs: LogEntry[]=[];
    const addLog=(text:string)=>expectedLogs.push({at:result.report.at,by:"总管",text});
    const originalRefs: Array<Extract<PlanRow,{item:string}|{card:string}>>=[];
    for(const dep of source.deps){const key="id"in dep?dep.id:dep.card;if(originalRefs.some(row=>row.id===key))continue;originalRefs.push("id"in dep?{id:key,item:key,own:old.items[key]?.parent===id,after:[]}:{id:key,card:key,after:[]});}
    for(const child of before.children(id))if(!originalRefs.some(row=>row.id===child))originalRefs.push({id:child,item:child,own:true,after:[]});
    const expectedSteps=(source.steps??[]).map((step,index)=>({...step,...(index===0?{after:[] as string[]}:{})}));
    const allOriginalIds=new Set([...originalRefs.map(row=>row.id),...expectedSteps.map(step=>step.id)]);
    let acceptId="accept";for(let n=2;allOriginalIds.has(acceptId);n++)acceptId=`accept-${n}`;
    if(source.deps.length)addLog("转换前的依赖说明：\n"+source.deps.map(dep=>{const key="id"in dep?dep.id:dep.card;return `- 「${("id"in dep?old.items[key]?.title:old.decisions[key]?.question)??key}」（${key}）：${dep.why}`;}).join("\n"));
    if(!after.isRoot(id)&&source.priority)addLog(`迁移到依赖结构：优先级改由依赖它的条目决定，原来写的 ${source.priority} 不再使用`);
    const expectedPrefix: PlanRow[]=[...originalRefs,...expectedSteps];
    check(equal(target.plan.slice(0,expectedPrefix.length),expectedPrefix),`${id}: full reference/step sequence or fields changed`);
    check(equal(target.plan.map(row=>row.id),[...expectedPrefix.map(row=>row.id),...(source.record?[]:[acceptId])]),`${id}: full plan row sequence changed`);
    check(equal(target.log.slice(source.log.length),expectedLogs),`${id}: unprescribed conversion logs`);
    // Independently locate the one complete section, masking code fences.
    const lines=(source.head??"").split("\n");let fenced=false;const headings:number[]=[];let ambiguous=false;
    for(let i=0;i<lines.length;i++){const line=lines[i]!;if(/^\s*(```|~~~)/.test(line)){fenced=!fenced;continue;}if(fenced)continue;
      const match=/^\*\*[^*]*(完成条件|怎样算完成)[^*]*\*\*/.test(line), heading=/^#{1,6}[ \t]+.*(完成条件|怎样算完成)/.test(line);
      if(heading||match&&(i===0||!lines[i-1]!.trim()))headings.push(i);else if(/\*\*[^*]*(完成条件|怎样算完成)[^*]*\*\*/.test(line))ambiguous=true;
    }
    let expectedHead=source.head, expectedText:string|undefined;
    if(headings.length===1&&!ambiguous&&!source.record){const start=headings[0]!;let end=lines.length;fenced=false;for(let i=start+1;i<lines.length;i++){const line=lines[i]!;if(/^\s*(```|~~~)/.test(line)){fenced=!fenced;continue;}if(!fenced&&(/^#{1,6}[ \t]+/.test(line)||/^\*\*[^*]+\*\*/.test(line)&&!lines[i-1]!.trim())){end=i;break;}}
      const inline=lines[start]!.startsWith("#")?"":lines[start]!.replace(/^\*\*[^*]+\*\*[：:]?[ \t]*/,"");const body=[inline,...lines.slice(start+1,end)].join("\n").trim();if(body){expectedText=body;expectedHead=[...lines.slice(0,start),...lines.slice(end)].join("\n");}}
    check(target.head===expectedHead,`${id}: head changed beyond acceptance section`);
    // Phase one generates exactly one acceptance at the end. Live plans may
    // move it or add scenarios; this verifies conversion output, not writes.
    const accepts=target.plan.filter(row=>"text"in row&&row.accept);
    check(accepts.length===(source.record?0:1),`${id}: acceptance count`);
    const acceptance=accepts[0];if(acceptance&&"text"in acceptance){const st=before.statusOf(id);const placeholder=st==="done"||st==="cancelled"?"（转换前已结束，当时没写完成条件）":"（转换时没找到完成条件，待补）";check(acceptance.text===(expectedText??placeholder),`${id}: acceptance text changed`);check(target.plan.at(-1)===acceptance,`${id}: acceptance not last`);check(acceptance.doneAt===(st==="done"?source.updated:undefined)&&acceptance.droppedAt===undefined&&acceptance.reason===undefined,`${id}: acceptance dates/reason changed`);check(acceptance.state===(st==="done"?"done":"todo"),`${id}: acceptance state changed`);}
    const oldStatus=before.statusOf(id),newStatus=after.statusOf(id);
    const children=before.children(id), closed=oldStatus==="done"||oldStatus==="cancelled";
    if(children.length)inc("parents");if(!source.parent)inc("topItems");if(closed)inc("closed");if(closed&&!source.parent)inc("closedTop");if(before.isArchived(id))inc("archived");if(source.steps?.length)inc("stepsItems");
    if(!source.record&&!expectedText)inc(closed?"closedMissingAcceptance":"openMissingAcceptance");
    if(source.log.some(entry=>/接过「[^\n]*」自己的工作/.test(entry.text)))inc("ownWorkSubitems");
    if(before.isStatusLeaf(id)&&oldStatus==="wip"&&!(source.steps??[]).some(step=>step.state==="doing"))inc("wipWithoutDoing");
    for(const dep of source.deps){if("card"in dep){inc("cardDeps");continue;}if(old.items[dep.id]?.parent===id)continue;inc("sharedItemDeps");inc(before.groupOf(id)===before.groupOf(dep.id)?"sameProjectDeps":"crossProjectDeps");}
    inc("unlistedChildren",children.filter(child=>!source.deps.some(dep=>"id"in dep&&dep.id===child)).length);
    check(actual.statusOf(id)===newStatus,`${id}: plan status rule disagreement`);
    check(actual.isRoot(id)===after.isRoot(id)&&actual.isBacklog(id)===after.isBacklog(id),`${id}: root/backlog rule disagreement`);
    check(actual.priorityOf(id)===after.priorityOf(id),`${id}: plan priority rule disagreement`);
    check(equal(actual.planRows(id).map(row=>({id:row.row.id,state:row.state,ready:row.ready})),after.rows(id)),`${id}: plan frontier rule disagreement`);
    const expectedSeed=after.isRoot(id)?before.priorityOf(id)||source.priority:undefined;
    check(target.priority===expectedSeed,`${id}: stored root seed changed`);
    const identity={item:id,project:before.groupOf(id),title:source.title};
    if(oldStatus!==newStatus){
      const cause=newStatus==="blocked"&&after.askPending(id)?"pending ask":newStatus==="wip"?"doing rows count":oldStatus==="done"?"unfinished plan rows":oldStatus==="wip"?"manual progress removed":newStatus==="blocked"?"waiting frontier":"ready frontier";
      expectedStatusChanges.push({...identity,old:oldStatus??"record",new:newStatus??"record",cause,detail:""});
      const evidence=after.rows(id).filter(row=>newStatus==="wip"?row.state==="progress":oldStatus==="done"?row.state!=="resolved":row.ready).slice(0,3);
      const reported=result.report.statusChanges.find(change=>change.item===id);
      check(!!reported&&evidence.every(row=>reported.detail.includes(row.id)),`${id}: status cause sources missing`);
      if(cause==="pending ask")check(!!reported&&reported.detail.includes(source.ask!.text),`${id}: pending ask cause missing`);
      if(cause==="ready frontier"&&!before.isStatusLeaf(id))inc("ruleChanges");
    }
    const op=before.priorityOf(id),np=after.priorityOf(id);
    if(op!==np){const unlisted=!!source.parent&&!old.items[source.parent]?.deps.some(dep=>"id"in dep&&dep.id===id);const cause=after.isRoot(id)?"root priority retained":after.isBacklog(id)?np?"shared plan dependents":"moved into backlog":!before.migrated(id)?"legacy priority retired":unlisted?"owned row added":"open plan dependents";expectedPriorityChanges.push({...identity,old:op,new:np,cause,detail:""});
      const reported=result.report.priorityChanges.find(change=>change.item===id);
      const dependents=Object.entries(next.items).filter(([dependent,item])=>after.isOpenWork(dependent)&&item.plan.some(row=>"item"in row&&row.item===id)&&(!np||after.priorityOf(dependent)===np)).map(([dependent])=>dependent).slice(0,3);
      const evidence=after.isBacklog(id)&&!np&&source.parent?[source.parent]:dependents;
      check(!!reported&&evidence.every(dependent=>reported.detail.includes(dependent)),`${id}: priority cause sources missing`);
    }
    check(target.status===(oldStatus==="cancelled"?"cancelled":undefined),`${id}: stored status changed`);
  }
  const withoutDetail=(values: typeof result.report.statusChanges)=>values.map(({detail:_detail,...value})=>value);
  check(equal(withoutDetail(expectedStatusChanges),withoutDetail(result.report.statusChanges)),"status difference report changed");
  check(equal(withoutDetail(expectedPriorityChanges),withoutDetail(result.report.priorityChanges)),"priority difference report changed");
  check(result.report.statusChanges.every(change=>!!change.detail.trim())&&result.report.priorityChanges.every(change=>!!change.detail.trim()),"difference cause detail missing");
  const causes: typeof result.report.byCause={status:{},priority:{}};
  for(const [key,changes]of [["status",expectedStatusChanges],["priority",expectedPriorityChanges]]as const)for(const change of changes)causes[key][change.cause]=(causes[key][change.cause]??0)+1;
  check(equal(causes,result.report.byCause),"cause counts changed");
  check(equal(survey,result.report.survey),"survey counts changed");
  const projects: typeof result.report.byProject = {};
  for(const id of Object.keys(old.items))projects[before.groupOf(id)]??={findings:0,rewritePointers:0,statusChanges:0,priorityChanges:0};
  for(const [field,key]of [["findings","findings"],["rewritePointers","rewritePointers"]]as const)for(const finding of result.report[field]){check(!!old.items[finding.item]&&finding.project===before.groupOf(finding.item),`${field}: unknown item/project`);if(projects[finding.project])projects[finding.project]![key]++;}
  for(const field of ["statusChanges","priorityChanges"]as const)for(const change of result.report[field])if(projects[before.groupOf(change.item)])projects[before.groupOf(change.item)]![field]++;
  check(equal(projects,result.report.byProject),"project report counts changed");
  check(result.report.counts.items===Object.keys(old.items).length,"report item count");
  check(result.report.counts.records===Object.values(old.items).filter(it=>it.record).length,"report record count");
  check(result.report.counts.decisions===Object.keys(old.decisions).length&&result.report.counts.notes===Object.keys(old.notes).length,"report card/note counts");
  check(result.report.counts.targets===Object.values(old.items).reduce((n,it)=>n+(it.targets?.length??0),0),"report target count");
  check(result.report.counts.oldLogs===Object.values(old.items).reduce((n,it)=>n+it.log.length,0)&&result.report.counts.newLogs===Object.values(next.items).reduce((n,it)=>n+it.log.length,0),"report log counts");
  check(result.report.counts.provisional===Object.values(next.items).filter(it=>it.provisional).length,"report provisional count");
  check(result.report.sourceHead===old.head,"source head changed");
  check(result.report.planConversionAt===result.report.at,"plan conversion timestamp changed");
  return errors;
}

/** Native-plan data may still have a retired owner archive field. */
export function verifyArchiveRemoval(source: Snapshot, result: PlanConversion, planConversionAt?: string): string[] {
  const errors:string[]=[], target=result.snapshot;
  const check=(ok:boolean,message:string)=>{if(!ok)errors.push(message);};
  const {archived={},...owner}=source.owner as Snapshot["owner"] & {archived?:Record<string,string>};
  check(equal({...source,owner},target),"archive-only conversion changed content or other owner fields");
  check(OwnerState.safeParse(target.owner).success,"retired archive field survives");
  check(result.report.counts.droppedArchives===Object.keys(archived).length,"dropped archive count changed");
  check(result.report.sourceHead===source.head,"source head changed");
  check(result.report.planConversionAt===planConversionAt,"plan conversion provenance changed");
  const c=result.report.counts;
  check(c.items===Object.keys(source.items).length&&c.records===Object.values(source.items).filter(item=>item.record).length,"archive-only item counts changed");
  check(c.decisions===Object.keys(source.decisions).length&&c.notes===Object.keys(source.notes).length,"archive-only card/note counts changed");
  const logs=Object.values(source.items).reduce((n,item)=>n+item.log.length,0);
  check(c.oldLogs===logs&&c.newLogs===logs&&c.targets===Object.values(source.items).reduce((n,item)=>n+(item.targets?.length??0),0),"archive-only log/target counts changed");
  check(c.provisional===Object.values(source.items).filter(item=>item.provisional).length,"archive-only provisional count changed");
  check(!result.report.statusChanges.length&&!result.report.priorityChanges.length&&!result.report.findings.length&&!result.report.rewritePointers.length,"archive-only conversion invented differences");
  check(equal(result.report.byCause,{status:{},priority:{}})&&equal(result.report.survey,{}),"archive-only cause/survey counts changed");
  const projects:typeof result.report.byProject={};
  for(const item of Object.values(source.items))projects[item.group]??={findings:0,rewritePointers:0,statusChanges:0,priorityChanges:0};
  check(equal(projects,result.report.byProject),"archive-only project counts changed");
  return errors;
}
