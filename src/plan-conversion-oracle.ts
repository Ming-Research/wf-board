/** Independent plan derivation used only by the preservation oracle. */
import type { Snapshot, Priority, Status, PlanRow } from "./model.ts";
export type OracleRowState = "resolved" | "progress" | "waiting" | "open";
export function derivePlanOracle(snapshot: Snapshot, seed?: (id:string)=>Priority|"") {
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
  function rows(id:string,trail:Set<string>) {
    const preceding = new Map<string,OracleRowState>(), result:Array<{id:string;state:OracleRowState;ready:boolean}>=[];
    for(const row of snapshot.items[id]?.plan??[]){
      const state=rowState(row,trail);
      const needs="text"in row&&row.accept?result.map(value=>value.id):row.after??result.slice(-1).map(value=>value.id);
      result.push({id:row.id,state,ready:state!=="resolved"&&needs.every(key=>preceding.get(key)==="resolved")});
      preceding.set(row.id,state);
    }
    return result;
  }
  function walk(id:string,trail:Set<string>):Status|undefined {
    const item=snapshot.items[id];if(!item||item.record)return undefined;if(item.status==="cancelled")return "cancelled";if(trail.has(id))return "blocked";
    const active=new Set(trail);active.add(id);const values=rows(id,active);
    if(!values.length)return "todo";if(values.every(row=>row.state==="resolved"))return "done";if(values.some(row=>row.state==="progress"))return "wip";
    const frontier=values.filter(row=>row.ready);
    return askPending(id)||frontier.length>0&&frontier.every(row=>row.state==="waiting")?"blocked":"todo";
  }
  const statuses=new Map<string,Status|undefined>();
  function statusOf(id:string){if(!statuses.has(id))statuses.set(id,walk(id,new Set()));return statuses.get(id);}
  function open(id:string){const status=statusOf(id);return !!snapshot.items[id]&&status!==undefined&&status!=="done"&&status!=="cancelled";}
  function backlog(id:string){return open(id)&&(owners.get(id)??[]).some(owner=>snapshot.items[owner]?.record);}
  function root(id:string){return !!snapshot.items[id]&&!backlog(id)&&!(waiters.get(id)??[]).some(open);}
  const ranks=new Map<string,number>(), priorityRank=(priority:Priority|undefined)=>priority==="P0"?0:priority==="P1"?1:priority==="P2"?2:3;
  for(const [id,item] of Object.entries(snapshot.items))if(root(id))ranks.set(id,priorityRank(seed ? seed(id) || undefined : item.priority));
  for(let changed=true;changed;){changed=false;for(const id of Object.keys(snapshot.items)){
    if(backlog(id))continue;const old=ranks.get(id)??3;let value=old;
    for(const dependent of waiters.get(id)??[])if(open(dependent))value=Math.min(value,ranks.get(dependent)??3);
    if(value<old){ranks.set(id,value);changed=true;}
  }}
  return {statusOf,askPending,isOpenWork:open,isBacklog:backlog,isRoot:root,priorityOf:(id:string):Priority|""=>(["P0","P1","P2"] as const)[ranks.get(id)??3]??"",rows:(id:string)=>rows(id,new Set([id]))};
}
