import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, formatChanges } from "../src/mcp.ts";
import { board, author } from "./helpers.ts";

test("SDK client discovers exactly twenty-seven described tools, reads/writes fresh state and receives tool errors", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Test agent", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name).sort(), ["search", "context", "graph", "overview", "list", "notes", "prs", "changes", "history", "diff", "create_item", "append_log", "update_item", "set_status", "move_item", "clear_ask", "write_card", "rule_card", "reply_note", "close_note", "create_project", "update_project", "create_request", "triage_request", "projects", "brief", "followups"].sort());
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 30);
    for (const [key, value] of Object.entries(tool.inputSchema.properties ?? {})) assert.ok((value as { description?: string }).description, `${tool.name}.${key} describes its parameter`);
  }
  assert.match(client.getInstructions()!, /append_log.*set_status.*why.*stamps times/);
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as Array<{ type: string; text: string }>).filter(c => c.type === "text").map(c => c.text).join("\n");
  const read = await client.callTool({ name: "context", arguments: { id: "a" } });
  assert.equal(read.isError, undefined); assert.match(text(read), /a · TODO P1 · 中文检查 · Whitefoot › area/);
  assert.doesNotMatch(text(read), /effective|raised by/);
  assert.match(text(read), /5 shown; 2 earlier/);
  const write = await client.callTool({ name: "append_log", arguments: { author, id: "a", text: "MCP evidence" } });
  assert.equal(write.isError, undefined); assert.match(text(write), /append_log a · rev 2 · commit [a-f0-9]{40}/);
  assert.match(text(await client.callTool({ name: "context", arguments: { id: "a" } })), /MCP evidence/);
  const before = store.snapshot();
  const refused = await client.callTool({ name: "set_status", arguments: { author, id: "area", status: "done", log: "Not a leaf" } });
  assert.equal(refused.isError, true); assert.match(text(refused), /status.*derived.*sub-item/); assert.deepEqual(store.snapshot(), before);
  const unknown = await client.callTool({ name: "context", arguments: { id: "missing" } });
  assert.equal(unknown.isError, true); assert.match(text(unknown), /Unknown id/);
  const stale = await client.callTool({ name: "update_item", arguments: { author, id: "a", rev: 1, title: "Stale" } });
  assert.equal(stale.isError, true); assert.match(text(stale), /current rev 2.*\+1 log/);
  const extra = await client.callTool({ name: "update_item", arguments: { author, id: "a", rev: 2, status: "done" } });
  assert.equal(extra.isError, true); assert.deepEqual(store.snapshot(), before);
  const search = await client.callTool({ name: "search", arguments: { query: "中文", filters: { kind: ["note"], limit: 1 } } });
  assert.match(text(search), /«中文»/);
});

test("cached rules refresh when owner state changes without a new commit", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Archive test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const before = store.snapshot().head;
  const initial = await client.callTool({ name: "list", arguments: { filters: { hasChecks: true } } });
  assert.ok(initial.content);
  await op.setStatus({ author, id: "b", status: "wip", log: "Work alongside blockers" });
  const unarchived = await client.callTool({ name: "list", arguments: { filters: { hasChecks: true } } });
  assert.match(JSON.stringify(unarchived.content), /b · WIP/);
  const head = store.snapshot().head;
  assert.notEqual(before, head);
  store.setOwner({ archived: { b: "2999-01-01T00:00:00Z" } });
  assert.equal(store.snapshot().head, head);
  const archived = await client.callTool({ name: "list", arguments: { filters: { hasChecks: true } } });
  // The other fixture items stay listed for their heads without a completion condition.
  assert.doesNotMatch(JSON.stringify(archived.content), /b · /); assert.match(JSON.stringify(archived.content), /a · TODO/);
});

test("changes output stops at the limit and says how many documents it left out", () => {
  const doc = (id: string) => ({ kind: "item" as const, id, title: id, summary: "new item", commits: [{ commit: "a".repeat(40), at: "2026-10-11T00:00:00Z", author: "migration", message: "Import", files: [] }] });
  const groups = [{ areaId: "x", area: "X", documents: [doc("a"), doc("b")] }, { areaId: "y", area: "Y", documents: [doc("c")] }] as unknown as Parameters<typeof formatChanges>[0];
  const text = formatChanges(groups, 2);
  assert.match(text, /item:a/); assert.match(text, /item:b/); assert.doesNotMatch(text, /item:c/);
  assert.match(text, /… 1 more changed documents/);
  assert.doesNotMatch(formatChanges(groups), /more changed documents/);
});

test("writes answer with the state they produced; refusals and context name the sub-items behind a derived status", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Test agent", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as Array<{ type: string; text: string }>).map(c => c.text).join("\n");
  // area's sub-items: a (todo) and b (blocked) → area BLOCK. Finishing b's blocker does not change area; finishing a and b does.
  const done = text(await client.callTool({ name: "set_status", arguments: { author, id: "a", status: "done", log: "Finished" } }));
  assert.match(done, /^a · DONE /m);
  assert.doesNotMatch(done, /ancestor area/); // still BLOCK because of b
  const unblocked = text(await client.callTool({ name: "set_status", arguments: { author, id: "b", status: "done", log: "Finished too" } }));
  assert.match(unblocked, /^ancestor area now DONE \S* \(was BLOCK \S*\)$/m);
  const refused = text(await client.callTool({ name: "set_status", arguments: { author, id: "area", status: "todo", log: "Not a leaf" } }));
  assert.match(refused, /area's status is derived from its sub-items \(.*a done.*b done.*\)|area's status is derived from its sub-items \(.*b done.*a done.*\)/);
  assert.match(text(await client.callTool({ name: "context", arguments: { id: "area" } })), /^status derived from 2 sub-items: .*a DONE/m);
  const prs = text(await client.callTool({ name: "search", arguments: { query: "Whitefoot#341" } }));
  assert.equal(prs.split("\n").filter(l => l.includes("without repository")).length, 1);
  assert.match(prs, /also a bare #341 without repository \(may be another repository's PR\) in: .*item:b/);
});


test("R2 R4 R5 MCP exposes transition and replacement fields and unscored confidence", async t => {
  const { store, op } = await board(t, {sharedProjects:true}), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Review regression", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  for (const name of ["parent_own_work", "source_status", "source_priority"]) assert.ok(tools.find(t => t.name === "move_item")!.inputSchema.properties?.[name]);
  assert.ok(tools.find(t => t.name === "reply_note")!.inputSchema.properties?.replace);
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => JSON.stringify(r.content);
  const move = await client.callTool({ name: "move_item", arguments: { author, id: "a", new_parent: "other", parent_why: "Transfer", parent_own_work: { key: "other-own", title: "Own" } } });
  assert.equal(move.isError, undefined, text(move));
  const last = await client.callTool({ name: "move_item", arguments: { author, id: "b", new_parent: "other", parent_why: "Transfer", source_status: "done", source_priority: "P2" } });
  assert.equal(last.isError, undefined, text(last));
  const reply = await client.callTool({ name: "reply_note", arguments: { author, id: "note-2", reply: "Deliberate correction", replace: true } });
  assert.equal(reply.isError, undefined, text(reply));
  const card = await client.callTool({ name: "write_card", arguments: { author, key: "unscored", item: "a", question: "Q", background: "B", options: [{ key: "A", text: "A" }], confidence: { reason: "Unscored grounds" } } });
  assert.equal(card.isError, undefined, text(card));
  const context = text(await client.callTool({ name: "context", arguments: { id: "a" } }));
  assert.match(context, /confidence Unscored grounds/); assert.doesNotMatch(context, /undefined\/5/);
});

test("project MCP onboarding, requests, triage, close and coordinator reads use the configured contracts", async t => {
  const {store,op}=await board(t), server=createMcpServer({store,ops:op,now:()=>"2026-10-12T00:00:00Z"});
  const client=new Client({name:"Project test",version:"1"}), [st,ct]=InMemoryTransport.createLinkedPair();
  await server.connect(st);await client.connect(ct); t.after(async()=>{await client.close();await server.close();});
  const text=(r:Awaited<ReturnType<typeof client.callTool>>)=>(r.content as Array<{text:string}>).map(c=>c.text).join("\n");
  async function call(name:string,args:Record<string,unknown>={}) {const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,text(r));return text(r);}
  const instructions=client.getInstructions()!;
  for (const term of ["projects","brief","create_request","close_note","coordinator","need not listen"]) assert.ok(instructions.includes(term),term);
  const configured=JSON.parse(await call("projects"));assert.equal(Object.hasOwn(configured[0],"agents"),false);assert.equal(configured[0].repo,"Ming-Research/Whitefoot");
  await call("update_project",{author,name:"Whitefoot",repo:"Ming-Research/Whitefoot-next"});
  assert.equal(store.snapshot().board.projects[0]!.repo,"Ming-Research/Whitefoot-next");
  await call("create_project",{author:"Third agent",name:"Third",repo:"Org/Third"});
  await call("create_request",{author,project:"Third",key:"request",title:"Need feature",head:"Witness",why:"Blocks",from:"a"});
  const brief=JSON.parse(await call("brief",{project:"Third"})); assert.deepEqual(brief.inbox.map((r:{id:string})=>r.id),["request"]);
  const pending=JSON.parse(await call("followups",{minutes:1}));assert.ok(pending.requests.some((r:{id:string})=>r.id==="request"));assert.ok(pending.notes.some((r:{id:string})=>r.id==="note-1"));
  await call("triage_request",{author:"Third",id:"request",log:"Own area"});assert.equal(store.snapshot().items.request!.request,undefined);
  await call("close_note",{author,id:"note-1",log:"Handled"});assert.equal(store.snapshot().notes["note-1"]!.state,"done");
  const summary=await call("overview",{group:"Whitefoot"});assert.doesNotMatch(summary,/agents:/);assert.match(summary,/Whitefoot · inbox 0/);
  for (const name of ["create_item","update_item"]) {
    const schema=(await client.listTools()).tools.find(t=>t.name===name)!.inputSchema;
    assert.ok(!Object.hasOwn(schema.properties!,"agent"));
  }
});


test("MCP onboarding and write schemas use project identities", async t => {
  const {store, op} = await board(t), server = createMcpServer({store, ops:op});
  const client = new Client({name:"Schema test",version:"1"}), [st,ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const instructions = client.getInstructions()!, tools = (await client.listTools()).tools;
  await t.test("startup repo and project author", () => { assert.match(instructions, /GitHub remote/); assert.match(instructions, /跨项目/); assert.doesNotMatch(instructions, /claim_project|session-list/); });
  for (const tool of tools.filter(tool => tool.inputSchema.properties?.author)) {
    await t.test(`${tool.name} author`, () => assert.equal((tool.inputSchema.properties!.author as {description?:string}).description, "the name of the project you work for (from `projects`)"));
  }
  await t.test("list agent filter removed", () => {
    const filters = tools.find(tool => tool.name === "list")!.inputSchema.properties!.filters as {properties:Record<string,unknown>};
    assert.equal(Object.hasOwn(filters.properties, "agent"), false);
  });
});

test("MCP write schemas take a priority only for a root and relay the refusal", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Priority test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>).map(c => c.text).join("\n");
  const kid = await client.callTool({ name: "create_item", arguments: { author, key: "kid", parent: "area", parent_why: "Part", title: "Kid" } });
  assert.equal(kid.isError, undefined, text(kid)); assert.match(text(kid), /^kid · TODO P1 · Kid/m);
  const refused = await client.callTool({ name: "create_item", arguments: { author, key: "kid2", parent: "area", parent_why: "Part", title: "Kid", priority: "P0" } });
  assert.equal(refused.isError, true); assert.match(text(refused), /优先级来自这些条目（area）/);
  const filed = await client.callTool({ name: "create_request", arguments: { author, project: "Firn", key: "need", title: "Need", head: "Witness", why: "Blocks", from: "a" } });
  assert.equal(filed.isError, undefined, text(filed)); assert.match(text(filed), /^need · TODO P1 · Need/m);
  const update = await client.callTool({ name: "update_item", arguments: { author, id: "b", rev: 1, priority: "P2" } });
  assert.equal(update.isError, true); assert.match(text(update), /优先级来自这些条目（area）/);
});
