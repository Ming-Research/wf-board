/** Independent plan derivation used only by the preservation oracle. */
import type { Snapshot, Status, PlanRow } from "./model.ts";
export type OracleRowState = "resolved" | "progress" | "waiting" | "open";
export function derivePlanOracle(snapshot: Snapshot, now=Date.now()) {
  const owners = new Map<string,string[]>(), waiters = new Map<string,string[]>();
  for(const [id,item] of Object.entries(snapshot.items))for(const row of item.plan){
    if(!("item"in row))continue;
    const incoming=waiters.get(row.item)??[];if(!incoming.includes(id))incoming.push(id);waiters.set(row.item,incoming);
    if(row.own){const parents=owners.get(row.item)??[];if(!parents.includes(id))parents.push(id);owners.set(row.item,parents);}
  }
  function askPending(id:string):boolean {
    const ask=snapshot.items[id]?.ask;if(!ask)return false;
    return !Object.values(snapshot.notes).some(note=>note.target===`it:${id}`&&note.state!=="draft"&&(note.kind==="approve"||note.kind==="done")&&(note.answerText??note.text)===(note.kind==="approve"?"同意：":"已完成：")+ask.text);
  }
  function rowState(row:PlanRow,trail:Set<string>):OracleRowState {
    if("text"in row)return row.state==="doing"?"progress":row.state==="todo"?"open":"resolved";
    if("card"in row)return !snapshot.decisions[row.card]||snapshot.decisions[row.card]?.status==="open"?"waiting":"resolved";
    const item=snapshot.items[row.item];if(!item)return "waiting";if(item.record)return "resolved";
    const status=walk(row.item,trail);
    if(status==="done"||row.own&&status==="cancelled")return "resolved";
    if(!row.own||status==="blocked"||status==="paused")return "waiting";
    return status==="wip"?"progress":"open";
  }
  // A record row is no step: left out of the counts whether it is owned or shared, and out of the order, where a row with no
  // `after` follows the nearest row before it that is not a record row.
  const recordRow=(row:PlanRow):boolean=>"item"in row&&snapshot.items[row.item]?.record===true;
  const excludedRow=(row:PlanRow):boolean=>"text"in row?row.state==="dropped":"item"in row&&(recordRow(row)||row.own&&snapshot.items[row.item]?.status==="cancelled");
  function rowsOf(plan:readonly PlanRow[],trail:Set<string>) {
    const preceding = new Map<string,OracleRowState>(), result:Array<{id:string;state:OracleRowState;ready:boolean;excluded:boolean}>=[];
    let step:string|undefined;
    for(const row of plan){
      const state=rowState(row,trail);
      const needs=row.after??(step===undefined?[]:[step]);
      result.push({id:row.id,state,ready:state!=="resolved"&&needs.every(key=>preceding.get(key)==="resolved"),excluded:excludedRow(row)});
      preceding.set(row.id,state);
      if(!recordRow(row))step=row.id;
    }
    return result;
  }
  function rows(id:string,trail:Set<string>) { return rowsOf(snapshot.items[id]?.plan??[],trail); }
  // Paused: this item or an ancestor in its same-project ownership chain carries a pause marker. A record on the way has no
  // status and its marker means nothing, and it does not interrupt the chain; shared rows never inherit a pause.
  function paused(id:string):boolean {
    const group=snapshot.items[id]?.group,seen=new Set<string>();
    for(let cur:string|undefined=id;cur&&!seen.has(cur);cur=(owners.get(cur)??[])[0]){
      seen.add(cur);const item=snapshot.items[cur];
      if(!item||item.group!==group)return false;
      if(!item.record&&item.paused)return true;
    }
    return false;
  }
  // The session of a live dispatch wrote or was started within six hours of `now`, as the agent list reads it.
  const SIX_HOURS=6*3600*1000;
  function liveSession(id:string):boolean {
    return (snapshot.items[id]?.dispatches??[]).some(d=>!d.finish&&now-Math.max(Date.parse(d.started),Date.parse(snapshot.activity?.agents?.[d.agent]?.[0]?.at??"1970-01-01T00:00:00Z"))<=SIX_HOURS);
  }
  // Whether an item is done or cancelled by its rows alone, with no sessions, pauses or order: the rows before an owned item in
  // its owner's plan need only this, and asking the full status there would ask the owned item's turn back. An item met again
  // on the path is not done, because a cycle never completes.
  function closedOf(id:string,trail:Set<string>):"done"|"cancelled"|undefined {
    const item=snapshot.items[id];if(!item||item.record)return undefined;if(item.status==="cancelled")return "cancelled";
    if(trail.has(id))return undefined;
    const next=new Set(trail).add(id);
    return item.plan.length>0&&item.plan.every(row=>rowResolved(row,next))?"done":undefined;
  }
  function rowResolved(row:PlanRow,trail:Set<string>):boolean {
    if("text"in row)return row.state==="done"||row.state==="dropped";
    if("card"in row){const card=snapshot.decisions[row.card];return !!card&&card.status!=="open";}
    const target=snapshot.items[row.item];if(!target)return false;if(target.record)return true;
    const closed=closedOf(row.item,trail);return closed==="done"||row.own&&closed==="cancelled";
  }
  // Whether every row before the row that owns `id` in its owner's plan is resolved; a record's rows are a list, so no order there.
  function ownerReady(id:string):boolean {
    const owner=(owners.get(id)??[])[0],plan=owner?snapshot.items[owner]:undefined;
    if(!owner||!plan||plan.record)return true;
    const done=new Map<string,boolean>(),path=new Set([id]);let last=true;
    for(const row of plan.plan){
      if("item"in row&&row.item===id)return (row.after===undefined?[last]:row.after.map(key=>done.get(key)===true)).every(ok=>ok);
      const resolved=rowResolved(row,path);done.set(row.id,resolved);
      if(!recordRow(row))last=resolved;
    }
    return true;
  }
  // Something of the item's own is done: a step, or an item it owns that is done; or an open item it owns has begun. What
  // others finished does not count: a shared row, a card and an owned record are not this item's work.
  function begun(id:string,values:Array<{state:OracleRowState;excluded:boolean}>,plan:readonly PlanRow[],trail:Set<string>):boolean {
    if(plan.some((row,at)=>values[at]!.state==="resolved"&&!values[at]!.excluded&&("text"in row||"item"in row&&row.own)))return true;
    return plan.some(row=>"item"in row&&row.own&&open(row.item)&&!trail.has(row.item)&&begunItem(row.item,new Set(trail).add(row.item)));
  }
  function begunItem(id:string,trail:Set<string>):boolean {
    const plan=snapshot.items[id]?.plan??[];return begun(id,rowsOf(plan,trail),plan,trail);
  }
  // This independent oracle discovers cycles through its active walk, rather
  // than importing the production graph analysis. A result touched by a cycle
  // guard is path-dependent and must never become a nested-target cache entry.
  const targetStatuses=new Map<string,Status|undefined>();let cycleHits=0;
  function walk(id:string,trail:Set<string>):Status|undefined {
    const item=snapshot.items[id];if(!item||item.record)return undefined;if(item.status==="cancelled")return "cancelled";
    if(trail.has(id)){cycleHits++;return "blocked";}
    if(targetStatuses.has(id))return targetStatuses.get(id);
    const before=cycleHits;
    const active=new Set(trail);active.add(id);const plan=item.plan,values=rowsOf(plan,active);
    const frontier=values.filter(row=>row.ready);
    const status=!values.length?"todo":values.every(row=>row.state==="resolved")?"done":paused(id)?"paused":values.some(row=>row.state==="progress")?"wip"
      :askPending(id)||frontier.length>0&&frontier.every(row=>row.state==="waiting")||!ownerReady(id)?"blocked"
      :liveSession(id)?"wip":begun(id,values,plan,active)?"idle":"todo";
    if(cycleHits===before)targetStatuses.set(id,status);
    return status;
  }
  const statuses=new Map<string,Status|undefined>();
  function statusOf(id:string){if(!statuses.has(id))statuses.set(id,walk(id,new Set()));return statuses.get(id);}
  function open(id:string){const status=statusOf(id);return !!snapshot.items[id]&&status!==undefined&&status!=="done"&&status!=="cancelled";}
  function backlog(id:string){return open(id)&&(owners.get(id)??[]).some(owner=>snapshot.items[owner]?.record);}
  function root(id:string){return !!snapshot.items[id]&&!backlog(id)&&!(waiters.get(id)??[]).some(open);}
  return {statusOf,askPending,isOpenWork:open,isBacklog:backlog,isRoot:root,rows:(id:string)=>rows(id,new Set([id])).map(({id,state,ready,excluded})=>({id,state,ready,excluded}))};
}
