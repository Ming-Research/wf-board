/** Temporary, lossless phase-one mapping. Remove after the board and its read baselines migrate. */
import { Item, Board, Time, OwnerState } from "./model.ts";
import type { Snapshot, PlanRow, Priority } from "./model.ts";
import type { Snapshot as LegacySnapshot } from "./legacy-model.ts";
import { rules as legacyRules } from "./legacy-rules.ts";
import { rules } from "./rules.ts";

export const MISSING_ACCEPT = "（转换时没找到完成条件，待补）";
export const CLOSED_ACCEPT = "（转换前已结束，当时没写完成条件）";
export const PLAN_CONVERSION_MESSAGE = "Convert item plans (phase 1)";
export interface PlanFinding { item: string; project: string; kind: string; detail: string }
export interface PlanChange {
  item: string; project: string; title: string;
  old: string; new: string; cause: string; detail: string;
}
export interface PlanConversionReport {
  summary: string;
  sourceHead: string;
  at: string;
  planConversionAt?: string;
  counts: { items: number; records: number; decisions: number; notes: number; targets: number; oldLogs: number; newLogs: number; provisional: number; droppedArchives: number };
  findings: PlanFinding[];
  rewritePointers: PlanFinding[];
  survey: Record<string, number>;
  byProject: Record<string, { findings: number; rewritePointers: number; statusChanges: number; priorityChanges: number }>;
  byCause: { status: Record<string, number>; priority: Record<string, number> };
  statusChanges: PlanChange[];
  priorityChanges: PlanChange[];
  errors: string[];
}
export interface PlanConversion { snapshot: Snapshot; report: PlanConversionReport }

/** Recognize only a whole heading or a bold label beginning its paragraph, outside code fences. */
export function extractAcceptance(head: string | undefined): { head: string | undefined; text?: string; ambiguous: boolean } {
  if (head === undefined) return { head, ambiguous: false };
  const lines = head.split("\n"), candidates: Array<{ start: number; text: string }> = [];
  let fence = false, ambiguous = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (!/(完成条件|怎样算完成)/.test(line)) continue;
    const heading = /^#{1,6}[ \t]+[^\n]*(完成条件|怎样算完成)[^\n]*$/.test(line);
    const bold = /^\*\*[^*\n]*(完成条件|怎样算完成)[^*\n]*\*\*[：:]?[ \t]*(.*)$/.exec(line);
    if (heading) candidates.push({ start: i, text: "" });
    else if (bold && (i === 0 || !lines[i - 1]!.trim())) candidates.push({ start: i, text: bold[2] ?? "" });
    else if (/\*\*[^*\n]*(完成条件|怎样算完成)[^*\n]*\*\*/.test(line)) ambiguous = true;
  }
  if (candidates.length !== 1 || ambiguous) return { head, ambiguous: ambiguous || candidates.length > 1 };
  const candidate = candidates[0]!;
  let end = lines.length, fenceInside = false;
  for (let i = candidate.start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) { fenceInside = !fenceInside; continue; }
    if (!fenceInside && (/^#{1,6}[ \t]+/.test(line) || /^\*\*[^*]+\*\*/.test(line) && !lines[i - 1]!.trim())) { end = i; break; }
  }
  const text = [candidate.text, ...lines.slice(candidate.start + 1, end)].join("\n").trim();
  if (!text) return { head, ambiguous: true };
  // Keep every character outside the section; no unrelated whitespace cleanup.
  return { head: [...lines.slice(0, candidate.start), ...lines.slice(end)].join("\n"), text, ambiguous: false };
}

export function convertPlans(old: LegacySnapshot, options: { at: string }): PlanConversion {
  const at = Time.parse(options.at);
  const previous = legacyRules(old), findings: PlanFinding[] = [];
  const {archived: _archives, ...owner} = old.owner;
  // The one-time plan conversion carries the cards as they were (old shape); the card conversion (migrate-cards.ts) gives them the new one.
  const snapshot: Snapshot = { ...structuredClone(old), decisions: structuredClone(old.decisions) as unknown as Snapshot["decisions"], owner: OwnerState.parse(owner), board: Board.parse({ ...old.board, projects: old.board.projects.map(({ migrated: _migrated, ...p }) => p) }), items: {} };
  const report: PlanConversionReport = { summary: "", sourceHead: old.head, at, planConversionAt:at, counts: { items: Object.keys(old.items).length, records: Object.values(old.items).filter(it => it.record).length, decisions: Object.keys(old.decisions).length, notes: Object.keys(old.notes).length, targets: Object.values(old.items).reduce((n,it) => n + (it.targets?.length ?? 0),0), oldLogs: Object.values(old.items).reduce((n,it) => n + it.log.length,0), newLogs: 0, provisional: 0, droppedArchives: Object.keys(old.owner.archived).length }, findings, rewritePointers: [], survey: {}, byProject: {}, byCause: {status:{},priority:{}}, statusChanges: [], priorityChanges: [], errors: [] };
  const note = (id: string, kind: string, detail: string) => findings.push({ item: id, project: previous.groupOf(id), kind, detail });
  for (const [id, original] of Object.entries(old.items)) {
    // The inbox's request marker is not part of the item schema any more; a converted item does not carry it.
    const { parent: _parent, deps, steps, status: _status, priority: _priority, request: _request, ...rest } = structuredClone(original);
    const plan: PlanRow[] = [], oldStatus = previous.statusOf(id), used = new Set<string>();
    const append = (row: PlanRow) => {
      if (used.has(row.id)) { note(id,"row id collision",`Old step and reference share ${row.id}; no id is renamed`); report.errors.push(`${id}: duplicate plan id ${row.id}`); }
      used.add(row.id); plan.push(row);
    };
    for (const dep of deps) {
      const target = "id" in dep ? dep.id : dep.card;
      if (used.has(target)) { note(id,"duplicate target",target); continue; }
      if ("id" in dep) append({ id: target, item: target, own: old.items[target]?.parent === id, after: [] });
      else append({ id: target, card: target, after: [] });
      if (!("id" in dep ? old.items[target] : old.decisions[target])) note(id,"dangling target",target);
    }
    for (const child of previous.children(id)) if (!used.has(child)) { append({ id: child, item: child, own: true, after: [] }); note(id,"child not listed",child); }
    if (original.parent && !old.items[original.parent]) note(id,"dangling parent",original.parent);
    // Keep old step ids when possible. A collision requires review, never a silent rename.
    for (const [index, step] of (steps ?? []).entries()) append({ ...step, ...(index === 0 ? { after: [] } : {}) });
    const extraction = original.record ? { head: original.head, ambiguous: false } : extractAcceptance(original.head);
    if (extraction.ambiguous) note(id,"ambiguous condition","Completion section is not uniquely bounded; head preserved");
    if (!original.record) {
      let acceptId = "accept";
      for (let suffix = 2; used.has(acceptId); suffix++) acceptId = `accept-${suffix}`;
      const closed = oldStatus === "done" || oldStatus === "cancelled";
      append({ id: acceptId, text: extraction.text ?? (closed ? CLOSED_ACCEPT : MISSING_ACCEPT), accept: true,
        state: oldStatus === "done" ? "done" : "todo",
        ...(oldStatus === "done" ? { doneAt: original.updated } : {}) });
    }
    const converted = { ...rest, group: previous.groupOf(id), ...(extraction.head === undefined ? {} : { head: extraction.head }), plan, ...(plan.length ? { provisional: true as const } : {}), ...(oldStatus === "cancelled" ? { status: "cancelled" as const } : {}) };
    if (deps.length) converted.log.push({ at, by: "总管", text: "转换前的依赖说明：\n" + deps.map(dep => { const target = "id" in dep ? dep.id : dep.card; const title = "id" in dep ? old.items[target]?.title : old.decisions[target]?.question; return `- 「${title ?? target}」（${target}）：${dep.why}`; }).join("\n") });
    snapshot.items[id] = converted;
  }
  const ids = Object.keys(old.items);
  // Roots retain the displayed seed, or their stored seed when the legacy display was empty.
  let current = rules(snapshot);
  for (const id of ids) {
    const item=snapshot.items[id]!, oldPriority=previous.priorityOf(id);
    if (current.isRoot(id)) {
      const seed=oldPriority||old.items[id]!.priority;
      if(seed)item.priority=seed as Priority;
    }
    else if (old.items[id]!.priority) item.log.push({at,by:"总管",text:`迁移到依赖结构：优先级改由依赖它的条目决定，原来写的 ${old.items[id]!.priority} 不再使用`});
  }
  current = rules(snapshot);
  for (const id of ids) {
    const item = snapshot.items[id]!, source = old.items[id]!;
    const identity = {item:id, project:previous.groupOf(id), title:source.title};
    const oldStatus=previous.statusOf(id), newStatus=current.statusOf(id);
    if(oldStatus!==newStatus){
      const pendingAsk = newStatus === "blocked" && current.askPending(id);
      const cause = pendingAsk ? "pending ask" : newStatus === "wip" ? "doing rows count"
        : oldStatus === "done" ? "unfinished plan rows"
        : oldStatus === "wip" ? "manual progress removed"
        : newStatus === "blocked" ? "waiting frontier" : "ready frontier";
      const detail = pendingAsk ? `旧的 owner 请求尚未回答：「${item.ask!.text}」。` : newStatus === "wip" ? "原有进行中步骤或拥有条目的进展决定新状态。"
        : oldStatus === "done" ? "原来的完成标记不覆盖仍未完成的步骤、条目或决策卡。"
        : oldStatus === "wip" ? "不补写进行中步骤；状态只取决于原有步骤和引用。"
        : newStatus === "blocked" ? "所有可推进的行都在等待；验收行仍等待其它行。" : "计划有可开始的行，不沿用手写阻塞标记。";
      const relevant = current.planRows(id).filter(row=>newStatus==="wip"?row.state==="progress":oldStatus==="done"?row.state!=="resolved":row.ready);
      const describe = (row:PlanRow) => `「${"text"in row?row.text:"item"in row?snapshot.items[row.item]?.title??row.item:snapshot.decisions[row.card]?.question??row.card}」（${row.id}）`;
      const evidence = relevant.slice(0,3).map(row=>`${describe(row.row)}：${row.state}`).join("；") + (relevant.length>3?`；另有 ${relevant.length-3} 行`:"");
      const explanation = `${detail} 对应行：${evidence||"没有进行中行；验收仍未完成"}`;
      report.statusChanges.push({...identity,old:oldStatus??"record",new:newStatus??"record",cause,detail:explanation});
      note(id,"status changed",`${oldStatus} → ${newStatus}：${explanation}`);
    }
    const oldPriority=previous.priorityOf(id), newPriority=current.priorityOf(id);
    if(oldPriority!==newPriority){
      const unlisted = !!source.parent && !old.items[source.parent]?.deps.some(dep=>"id"in dep&&dep.id===id);
      const cause=current.isRoot(id)?"root priority retained":current.isBacklog(id)?newPriority?"shared plan dependents":"moved into backlog":!previous.migrated(id)?"legacy priority retired":unlisted?"owned row added":"open plan dependents";
      const detail=current.isRoot(id)?"根保留原来写的优先级；旧显示为空不删除存储值。":current.isBacklog(id)?newPriority?"记录拥有的工作不存储优先级；共用它的未完成条目传入最高优先级，记录本身不传入。":"记录拥有的工作没有带优先级的未完成引用；记录本身不传入优先级。"
        : !previous.migrated(id)?"原来的叶条目优先级规则退役；现在从未完成计划的引用推导。"
        : unlisted?"原来未列在依赖中的子条目现在有拥有行，优先级从未完成计划推导。":"优先级取未完成计划中直接或间接引用它的条目的最高值。";
      const dependents=current.dependents(id).filter(dependent=>current.isOpenWork(dependent.id));
      const winning=dependents.filter(dependent=>newPriority?current.priorityOf(dependent.id)===newPriority:true);
      const owner=current.parentOf(id);
      const evidence=current.isBacklog(id)&&!newPriority&&owner?`记录「${snapshot.items[owner]?.title??owner}」（${owner}）拥有它。`
        : winning.length?winning.slice(0,3).map(dependent=>`${dependent.own?"拥有":"共用"}它的「${snapshot.items[dependent.id]?.title??dependent.id}」（${dependent.id}）为 ${current.priorityOf(dependent.id)||"无优先级"}`).join("；")+(winning.length>3?`；另有 ${winning.length-3} 个同值引用`:"")
        : current.isRoot(id)?`根保留转换前的显示值；显示为空时保留原来写的 ${source.priority??"无优先级"}。`:"没有带优先级的未完成引用。";
      const explanation=`${detail} ${evidence}`;
      report.priorityChanges.push({...identity,old:oldPriority,new:newPriority,cause,detail:explanation});
      note(id,"priority changed",`${oldPriority || "none"} → ${newPriority || "none"}：${explanation}`);
    }
    const parsed=Item.safeParse(snapshot.items[id]);if(!parsed.success)report.errors.push(`${id}: ${parsed.error.message}`);else snapshot.items[id]=parsed.data;
  }
  // Phase two gets pointers to source facts, not automatic structural judgments.
  const pointer = (id: string, kind: string, detail: string) => report.rewritePointers.push({item:id,project:previous.groupOf(id),kind,detail});
  const survey: Record<string, number> = {parents:0,topItems:0,closed:0,closedTop:0,archived:0,stepsItems:0,sharedItemDeps:0,crossProjectDeps:0,sameProjectDeps:0,cardDeps:0,unlistedChildren:0,ownWorkSubitems:0,openMissingAcceptance:0,closedMissingAcceptance:0,wipWithoutDoing:0,ruleChanges:report.statusChanges.filter(change=>change.cause==="ready frontier"&&!previous.isStatusLeaf(change.item)).length};
  for(const [id,it]of Object.entries(old.items)){
    const children=previous.children(id), status=previous.statusOf(id), closed=status==="done"||status==="cancelled", section=it.record?undefined:extractAcceptance(it.head);
    if(children.length)survey.parents = (survey.parents ?? 0) + 1;if(!it.parent)survey.topItems = (survey.topItems ?? 0) + 1;if(closed)survey.closed = (survey.closed ?? 0) + 1;if(closed&&!it.parent)survey.closedTop = (survey.closedTop ?? 0) + 1;if(previous.isArchived(id))survey.archived = (survey.archived ?? 0) + 1;if(it.steps?.length)survey.stepsItems = (survey.stepsItems ?? 0) + 1;
    if(it.record)pointer(id,"record",`Record owns ${children.length} items and has no acceptance step`);
    if(!it.record&&!section?.text){survey[closed?"closedMissingAcceptance":"openMissingAcceptance"] = (survey[closed?"closedMissingAcceptance":"openMissingAcceptance"] ?? 0) + 1;pointer(id,"missing condition",closed?"Closed item has no unique completion section":"Open item needs an acceptance check");}
    if(it.log.some(entry=>/接过「[^\n]*」自己的工作/.test(entry.text))){survey.ownWorkSubitems = (survey.ownWorkSubitems ?? 0) + 1;pointer(id,"own-work subitem","Existing own-work log retained; project decides whether to keep an item or fold it into a step");}
    if(children.length&&!it.record&&!section?.text)pointer(id,"possible topic group",`Owns ${children.length} items but has no unique completion section; project must inspect its purpose`);
    if(previous.isStatusLeaf(id)&&status==="wip"&&!(it.steps??[]).some(step=>step.state==="doing"))survey.wipWithoutDoing = (survey.wipWithoutDoing ?? 0) + 1;
    for(const dep of it.deps){if("card"in dep){survey.cardDeps = (survey.cardDeps ?? 0) + 1;continue;}if(old.items[dep.id]?.parent===id)continue;survey.sharedItemDeps = (survey.sharedItemDeps ?? 0) + 1;const same=previous.groupOf(id)===previous.groupOf(dep.id);survey[same?"sameProjectDeps":"crossProjectDeps"] = (survey[same?"sameProjectDeps":"crossProjectDeps"] ?? 0) + 1;if(same)pointer(id,"same-project shared",`Shares ${dep.id}, whose legacy owner is ${old.items[dep.id]?.parent??"none"}`);if(old.items[dep.id]&&!old.items[dep.id]!.parent)pointer(dep.id,"unowned shared",`Top item is shared by ${id}; project decides whether this remains a collecting item or needs an owner`);}
    survey.unlistedChildren = (survey.unlistedChildren ?? 0) + children.filter(child=>!it.deps.some(dep=>"id"in dep&&dep.id===child)).length;
  }
  report.survey=survey;
  for(const id of Object.keys(old.items)){const project=previous.groupOf(id);report.byProject[project]??={findings:0,rewritePointers:0,statusChanges:0,priorityChanges:0};}
  for(const finding of report.findings)report.byProject[finding.project]!.findings++;
  for(const finding of report.rewritePointers)report.byProject[finding.project]!.rewritePointers++;
  for(const change of report.statusChanges)report.byProject[previous.groupOf(change.item)]!.statusChanges++;
  for(const change of report.priorityChanges)report.byProject[previous.groupOf(change.item)]!.priorityChanges++;
  for(const change of report.statusChanges)report.byCause.status[change.cause]=(report.byCause.status[change.cause]??0)+1;
  for(const change of report.priorityChanges)report.byCause.priority[change.cause]=(report.byCause.priority[change.cause]??0)+1;
  updatePlanSummary(report);
  report.counts.newLogs=Object.values(snapshot.items).reduce((n,it)=>n+it.log.length,0);
  report.counts.provisional=Object.values(snapshot.items).filter(it=>it.provisional).length;
  return { snapshot, report };
}

/** Archive-only upgrade for data that already uses plans; never rewrites its plans. */
export function removeArchives(source: Snapshot, options: { at: string; planConversionAt?: string }): PlanConversion {
  const at = Time.parse(options.at);
  const { archived = {}, ...owner } = source.owner as Snapshot["owner"] & { archived?: Record<string,string> };
  const snapshot = structuredClone(source);
  snapshot.owner = OwnerState.parse(owner);
  const logs = Object.values(source.items).reduce((n,item)=>n+item.log.length,0);
  const report: PlanConversionReport = {
    summary: "", sourceHead: source.head, at, ...(options.planConversionAt?{planConversionAt:Time.parse(options.planConversionAt)}:{}),
    counts: { items:Object.keys(source.items).length, records:Object.values(source.items).filter(item=>item.record).length,
      decisions:Object.keys(source.decisions).length, notes:Object.keys(source.notes).length,
      targets:Object.values(source.items).reduce((n,item)=>n+(item.targets?.length??0),0), oldLogs:logs,newLogs:logs,
      provisional:Object.values(source.items).filter(item=>item.provisional).length,droppedArchives:Object.keys(archived).length },
    findings:[],rewritePointers:[],survey:{},byProject:{},byCause:{status:{},priority:{}},statusChanges:[],priorityChanges:[],errors:[],
  };
  for(const item of Object.values(source.items))report.byProject[item.group]??={findings:0,rewritePointers:0,statusChanges:0,priorityChanges:0};
  updatePlanSummary(report);
  return {snapshot,report};
}

/** Called again after independent verification so the report never claims unverified preservation. */
export function updatePlanSummary(report: PlanConversionReport, verified = false): void {
  const result=verified&&!report.errors.length?"独立校验确认原有条目、步骤、日期、日志、决策卡、评论和目标均已保留。":verified?`独立校验发现 ${report.errors.length} 个结构或保留错误，不能应用转换。`:"等待独立保留校验。";
  const labels: Record<string,string>={"doing rows count":"原有进行中行现在决定状态","unfinished plan rows":"已标完成的计划仍有未完成行","manual progress removed":"不再沿用手写进行中状态","waiting frontier":"下一步只有等待行","ready frontier":"计划存在可开始的行","pending ask":"仍在等待旧的 owner 请求","moved into backlog":"记录拥有的工作没有带优先级的未完成引用","shared plan dependents":"记录拥有的工作从共用引用获得优先级","root priority retained":"根保留旧显示未体现的存储优先级","legacy priority retired":"旧的优先级规则退役","owned row added":"补齐原来未列出的拥有行","open plan dependents":"按未完成计划的引用传播优先级"};
  const mainCauses=(counts:Record<string,number>)=>Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([cause,count])=>`${labels[cause]??cause} ${count} 处`).join("；")||"没有变化";
  const manual=report.statusChanges.filter(change=>change.old === "wip" && change.cause === "manual progress removed");
  const todo=manual.filter(change=>change.new === "todo").length;
  const blocked=manual.filter(change=>change.new === "blocked").length;
  report.summary=`转换 ${report.counts.items} 个条目，不补写或改写原有进展。状态变化 ${report.statusChanges.length} 处，主要原因：${mainCauses(report.byCause.status)}。优先级变化 ${report.priorityChanges.length} 处，主要原因：${mainCauses(report.byCause.priority)}。\n已删除 ${report.counts.droppedArchives} 条旧归档记录；其它 owner 状态不变。${result}\n需在阶段二重写计划：${manual.length} 个旧 wip 条目没有进行中行，其中 ${todo} 个变为 todo，${blocked} 个因等待行变为 blocked；没有补写 doing 步骤。`;
}
