/** Independent plan derivation used only by the preservation oracle. */
import type { Snapshot, Priority, Status, PlanRow } from "./model.ts";
export type OracleRowState = "resolved" | "progress" | "waiting" | "open";
export function derivePlanOracle(snapshot: Snapshot, seed?: (id:string)=>Priority|"", now=Date.now()) {
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
    if(!row.own||status==="blocked")return "waiting";
    return status==="wip"?"progress":"open";
  }
  const excludedRow=(row:PlanRow):boolean=>"text"in row?row.state==="dropped":"item"in row&&row.own&&(snapshot.items[row.item]?.record===true||snapshot.items[row.item]?.status==="cancelled");
  function rowsOf(plan:readonly PlanRow[],trail:Set<string>) {
    const preceding = new Map<string,OracleRowState>(), result:Array<{id:string;state:OracleRowState;ready:boolean;excluded:boolean}>=[];
    for(const row of plan){
      const state=rowState(row,trail);
      const needs=row.after??result.slice(-1).map(value=>value.id);
      result.push({id:row.id,state,ready:state!=="resolved"&&needs.every(key=>preceding.get(key)==="resolved"),excluded:excludedRow(row)});
      preceding.set(row.id,state);
    }
    return result;
  }
  function rows(id:string,trail:Set<string>) { return rowsOf(snapshot.items[id]?.plan??[],trail); }
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
      last=rowResolved(row,path);done.set(row.id,last);
    }
    return true;
  }
  // Something is done here, or in an open item this one owns that has begun.
  function begun(id:string,values:Array<{state:OracleRowState;excluded:boolean}>,plan:readonly PlanRow[],trail:Set<string>):boolean {
    if(values.some(value=>value.state==="resolved"&&!value.excluded))return true;
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
    const status=!values.length?"todo":values.every(row=>row.state==="resolved")?"done":values.some(row=>row.state==="progress")?"wip"
      :askPending(id)||frontier.length>0&&frontier.every(row=>row.state==="waiting")||!ownerReady(id)?"blocked"
      :liveSession(id)?"wip":begun(id,values,plan,active)?"partial":"todo";
    if(cycleHits===before)targetStatuses.set(id,status);
    return status;
  }
  const statuses=new Map<string,Status|undefined>();
  function statusOf(id:string){if(!statuses.has(id))statuses.set(id,walk(id,new Set()));return statuses.get(id);}
  function open(id:string){const status=statusOf(id);return !!snapshot.items[id]&&status!==undefined&&status!=="done"&&status!=="cancelled";}
  function backlog(id:string){return open(id)&&(owners.get(id)??[]).some(owner=>snapshot.items[owner]?.record);}
  function root(id:string){return !!snapshot.items[id]&&!backlog(id)&&!(waiters.get(id)??[]).some(open);}
  const ranks=new Map<string,number>(), priorityRank=(priority:Priority|undefined)=>priority==="P0"?0:priority==="P1"?1:priority==="P2"?2:3;
  for(const [id,item] of Object.entries(snapshot.items))if(root(id))ranks.set(id,priorityRank(seed ? seed(id) || undefined : item.priority));
  for(let changed=true;changed;){changed=false;for(const id of Object.keys(snapshot.items)){
    const old=ranks.get(id)??3;let value=old;
    for(const dependent of waiters.get(id)??[])if(open(dependent))value=Math.min(value,ranks.get(dependent)??3);
    if(value<old){ranks.set(id,value);changed=true;}
  }}
  return {statusOf,askPending,isOpenWork:open,isBacklog:backlog,isRoot:root,priorityOf:(id:string):Priority|""=>(["P0","P1","P2"] as const)[ranks.get(id)??3]??"",rows:(id:string)=>rows(id,new Set([id])).map(({id,state,ready})=>({id,state,ready}))};
}
