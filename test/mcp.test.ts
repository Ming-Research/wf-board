import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, formatChanges } from "../src/mcp.ts";
import { board, author, later } from "./helpers.ts";
import { ownerOps } from "../src/owner-ops.ts";

test("changes output stops at the limit and says how many documents it left out", () => {
  const doc = (id: string) => ({ kind: "item" as const, id, title: id, summary: "new item", commits: [{ commit: "a".repeat(40), at: "2026-10-11T00:00:00Z", author: "migration", message: "Import", files: [] }] });
  const groups = [{ areaId: "x", area: "X", documents: [doc("a"), doc("b")] }, { areaId: "y", area: "Y", documents: [doc("c")] }] as unknown as Parameters<typeof formatChanges>[0];
  const text = formatChanges(groups, 2);
  assert.match(text, /item:a/); assert.match(text, /item:b/); assert.doesNotMatch(text, /item:c/);
  assert.match(text, /… 1 more changed documents/);
  assert.doesNotMatch(formatChanges(groups), /more changed documents/);
});

test("project MCP after parameters reorder existing and newly created projects with coordinator-only placement", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Project order test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  for (const name of ["create_project", "update_project"]) {
    const tool = tools.find(tool => tool.name === name)!;
    assert.ok(tool.inputSchema.properties!.after);
    assert.ok(!tool.inputSchema.required?.includes("after"));
    assert.match(tool.description!, /总管.*after/);
  }
  const moved = await client.callTool({ name: "update_project", arguments: { author: "总管", name: "Whitefoot", after: "Firn" } });
  assert.equal(moved.isError, undefined);
  assert.deepEqual(store.snapshot().board.projects.map(p => p.name), ["Firn", "Whitefoot", "总管"]);
  const created = await client.callTool({ name: "create_project", arguments: { author: "总管", name: "New", after: "Firn" } });
  assert.equal(created.isError, undefined);
  assert.deepEqual(store.snapshot().board.projects.map(p => p.name), ["Firn", "New", "Whitefoot", "总管"]);
  for (const [name, args] of [
    ["update_project", { author: "Firn", name: "Firn", after: "New" }],
    ["create_project", { author: "Firn", name: "Refused", after: "New" }],
    ["update_project", { author: "总管", name: "Firn", after: "Missing" }],
  ] as const) {
    const before = store.snapshot(), result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.match((result.content as Array<{ text: string }>).map(c => c.text).join("\n"), /after.*(总管|configured)/);
    assert.deepEqual(store.snapshot(), before);
  }
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
  await call("create_request",{author,project:"Third",key:"request",title:"Need feature",head:"Witness",accept:"Witness passes",why:"Blocks",from:"a"});
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
  await t.test("startup repo and project author", () => { assert.match(instructions, /GitHub remote/); assert.match(instructions, /总管/); assert.doesNotMatch(instructions, /claim_project|session-list/); });
  for (const tool of tools.filter(tool => tool.inputSchema.properties?.author)) {
    await t.test(`${tool.name} author`, () => assert.equal((tool.inputSchema.properties!.author as {description?:string}).description, "the name of the project you work for (from `projects`)"));
  }
  await t.test("list agent filter removed", () => {
    const filters = tools.find(tool => tool.name === "list")!.inputSchema.properties!.filters as {properties:Record<string,unknown>};
    assert.equal(Object.hasOwn(filters.properties, "agent"), false);
  });
});

test("set_term, glossary, brief and delete_term work end to end, and an unconfigured author is refused", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Glossary agent", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, text: (result.content as Array<{ text: string }>).map(c => c.text).join("\n") };
  };
  assert.match(client.getInstructions()!, /set_term.*glossary/);
  assert.equal((await call("glossary", {})).text, "No terms.");
  assert.match((await call("set_term", { author, term: "否决线", definition: "性能比较里\n判定变慢的界线。" })).text, /^set_term 否决线 · commit [a-f0-9]{40}$/);
  await call("set_term", { author: "Firn", term: "回收压力", definition: "频繁触发回收的运行方式。" });
  assert.equal((await call("glossary", {})).text, "Whitefoot:\n  否决线: 性能比较里 判定变慢的界线。\nFirn:\n  回收压力: 频繁触发回收的运行方式。");
  assert.equal((await call("glossary", { project: "总管" })).text, "总管: no terms");
  assert.deepEqual(JSON.parse((await call("brief", { project: author })).text).glossary, ["否决线"]);
  const refused = await call("set_term", { author: "Snowghost", term: "术语", definition: "定义" });
  assert.equal(refused.error, true); assert.match(refused.text, /author Snowghost: choose a configured project/);
  const unknown = await call("glossary", { project: "Snowghost" });
  assert.equal(unknown.error, true); assert.match(unknown.text, /project Snowghost: choose a configured project/);
  assert.match((await call("delete_term", { author, term: "否决线" })).text, /^delete_term 否决线 · commit /);
  assert.equal((await call("glossary", { project: author })).text, "Whitefoot: no terms");
});

test("a reference token in an owner note reaches sessions as typed, with the key", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op }), own = ownerOps(store, () => later);
  const client = new Client({ name: "Test agent", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as Array<{ type: string; text: string }>).filter(c => c.type === "text").map(c => c.text).join("\n");
  const note = await own.createNote({ target: "it:a", kind: "comment", text: "compare with [[it:b]] and [[q:choice]]" });
  assert.equal(store.snapshot().notes[note.id]!.text, "compare with [[it:b]] and [[q:choice]]", "the store keeps the token, not the title");
  assert.match(text(await client.callTool({ name: "notes", arguments: { filters: {} } })), /compare with \[\[it:b\]\] and \[\[q:choice\]\]/);
  assert.match(text(await client.callTool({ name: "context", arguments: { id: "a" } })), /compare with \[\[it:b\]\] and \[\[q:choice\]\]/);
});

test("MCP set_targets exposes date-free goal edits, all modes and compact context and brief", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Targets client", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const tool = (await client.listTools()).tools.find(tool => tool.name === "set_targets")!;
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), ["author", "id", "remove", "target", "targets"]);
  const targetSchema = tool.inputSchema.properties!.target as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(targetSchema.properties).sort(), ["baseline", "current", "goal", "id", "target"]);
  assert.match(client.getInstructions()!, /Use set_targets.*goal/);
  const readText = (value: Awaited<ReturnType<typeof client.callTool>>) => (value.content as Array<{ text: string }>).map(c => c.text).join("\n");
  const target = { id: "style", goal: "apollo11 样式计算耗时", target: "≤ 1 倍 Chromium", current: "12 倍 Chromium", baseline: "Chromium 同机同页" };
  const written = await client.callTool({ name: "set_targets", arguments: { author, id: "a", targets: [target] } });
  assert.equal(written.isError, undefined); assert.match(readText(written), /set_targets a/);
  const line = "apollo11 样式计算耗时: 12 倍 Chromium (vs Chromium 同机同页) → ≤ 1 倍 Chromium, 2026-10-11";
  assert.ok(readText(await client.callTool({ name: "context", arguments: { id: "a", log: 0 } })).includes(`targets:\n  ${line}`));
  const brief = JSON.parse(readText(await client.callTool({ name: "brief", arguments: { project: author } })));
  assert.ok(!brief.todo.some((item: { id: string }) => item.id === "a"), "the pending ask blocks this fixture's next work");
  const blocked = brief.checks.find((item: { id: string }) => item.id === "a");
  assert.ok(blocked, "the blocked fixture remains in the brief checks");
  assert.deepEqual(blocked.targets, [line]);
  await op.clearAsk({ author, id: "a", log: "Ready to work on the target" });
  const readyBrief = JSON.parse(readText(await client.callTool({ name: "brief", arguments: { project: author } })));
  const ready = readyBrief.todo.find((item: { id: string }) => item.id === "a");
  assert.ok(ready, "clearing the ask makes the frontier available");
  assert.deepEqual(ready.targets, [line]);
  const before = store.snapshot();
  for (const args of [
    {}, { targets: [], target }, { targets: [], remove: "style" }, { target, remove: "style" },
    { target: { ...target, date: later } }, { targets: [{ ...target, date: later }] },
    { target: { ...target, current: " " } }, { target: { id: "no-baseline", goal: "Goal", target: "1", current: "2" } },
  ]) {
    const refused = await client.callTool({ name: "set_targets", arguments: { author, id: "a", ...args } });
    assert.equal(refused.isError, true); assert.deepEqual(store.snapshot(), before);
  }
  const changed = await client.callTool({ name: "set_targets", arguments: { author, id: "a", target: { ...target, current: "8 倍 Chromium" } } });
  assert.equal(changed.isError, undefined); assert.equal(store.snapshot().items.a!.targets![0]!.current, "8 倍 Chromium");
  const removed = await client.callTool({ name: "set_targets", arguments: { author, id: "a", remove: "style" } });
  assert.equal(removed.isError, undefined); assert.deepEqual(store.snapshot().items.a!.targets, []);
  assert.doesNotMatch(readText(await client.callTool({ name: "context", arguments: { id: "a", log: 0 } })), /targets:/);
});

async function connected(t: { after(fn: () => void | Promise<void>): void }) {
  const { store, op } = await board(t, { sharedProjects: true }), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Plans integration", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct); t.after(async () => { await client.close(); await server.close(); });
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as Array<{ type: string; text: string }>).map(c => c.text).join("\n");
  return { store, op, client, text };
}

test("MCP replaces legacy fields and tools with plan semantics and refuses removed arguments", async t => {
  const { client, text, store } = await connected(t), tools = (await client.listTools()).tools;
  assert.equal(tools.length, 39); assert.ok(tools.some(tool => tool.name === "set_plan")); assert.ok(!tools.some(tool => tool.name === "set_steps"));
  assert.deepEqual(Object.keys(tools.find(tool => tool.name === "set_plan")!.inputSchema.properties!).sort(), ["author", "id", "remove", "row", "rows"]);
  for (const [name, removed] of [["create_item", ["parent", "status", "deps", "parent_why", "parent_own_work"]], ["move_item", ["new_parent", "source_status", "source_priority"]], ["update_project", ["migrated"]], ["triage_request", ["parent", "parent_why"]]] as const) {
    const schema = tools.find(tool => tool.name === name)!.inputSchema;
    for (const field of removed) assert.ok(!(field in schema.properties!));
  }
  assert.match(client.getInstructions()!, /set_plan/); assert.match(client.getInstructions()!, /Status is derived from the plan/); assert.doesNotMatch(client.getInstructions()!, /Every dependency carries a why/);
  const before = store.snapshot();
  for (const args of [{ status: "done" }, { deps: [] }, { parent: "other" }]) {
    const rejected = await client.callTool({ name: "update_item", arguments: { author, id: "a", rev: 1, ...args } }); assert.equal(rejected.isError, true, text(rejected));
  }
  assert.deepEqual(store.snapshot(), before);
});

test("MCP plan rows have server dates and compact levels, targets and ownership in context and brief", async t => {
  const { client, text, store } = await connected(t);
  const written = await client.callTool({ name: "set_plan", arguments: { author, id: "a", row: { id: "work", text: "Runs pass", state: "doing", waits: "CI", after: [] } } });
  assert.equal(written.isError, undefined, text(written)); assert.match(text(written), /a · WIP P1/); assert.match(text(written), /ancestor area now WIP P1/);
  const context = text(await client.callTool({ name: "context", arguments: { id: "area" } }));
  assert.match(context, /plan:\n.*L0.*a.*\[own\].*Runs pass/s); assert.doesNotMatch(context, /why|migrated|status derived from.*sub-item/);
  const brief = JSON.parse(text(await client.callTool({ name: "brief", arguments: { project: author } })));
  assert.ok(brief.wip.find((item: { id: string }) => item.id === "a").plan.some((line: string) => line.includes("Runs pass")));
  const before = store.snapshot(); const dated = await client.callTool({ name: "set_plan", arguments: { author, id: "a", row: { id: "work", text: "Bad date", state: "doing", since: later } } });
  assert.equal(dated.isError, true); assert.deepEqual(store.snapshot(), before);
});

test("MCP exposes acceptance anywhere, several scenarios and first-acceptance row insertion", async t => {
  const { client, text, store } = await connected(t), tools = (await client.listTools()).tools;
  assert.match(client.getInstructions()!, /at least one acceptance step.*several acceptance steps/);
  assert.doesNotMatch(client.getInstructions()!, /ends with its acceptance/);
  assert.match(tools.find(tool => tool.name === "set_plan")!.description!, /new rows before the first acceptance step/);
  assert.match(tools.find(tool => tool.name === "create_item")!.description!, /one acceptance step appended from accept/);
  const written = await client.callTool({ name: "set_plan", arguments: { author, id: "a", rows: [
    { id: "scenario-a", accept: true, text: "Scenario A passes", state: "done", after: [] },
    { id: "scenario-b", accept: true, text: "Scenario B passes", state: "doing", waits: "CI", after: [] },
    { id: "merge", text: "Merge into main", state: "todo", after: ["scenario-a", "scenario-b"] },
  ] } });
  assert.equal(written.isError, undefined, text(written)); assert.match(text(written), /^a · WIP P1/m);
  const inserted = await client.callTool({ name: "set_plan", arguments: { author, id: "a", row: { id: "prepare", text: "Prepare release", state: "todo", after: [] } } });
  assert.equal(inserted.isError, undefined, text(inserted));
  assert.deepEqual(store.snapshot().items.a!.plan.map(row => row.id), ["prepare", "scenario-a", "scenario-b", "merge"]);
  const context = text(await client.callTool({ name: "context", arguments: { id: "a" } }));
  assert.match(context, /验收.*Scenario A passes/); assert.match(context, /验收.*Scenario B passes/); assert.match(context, /Merge into main/);
});

test("writes answer with their produced plan state; refusals and context identify open owned parts", async t => {
  const { client, text, store } = await connected(t);
  const prerequisites = await client.callTool({ name: "set_plan", arguments: { author, id: "b", row: { id: "accept", accept: true, text: "阻塞证据验收通过", state: "todo", after: ["a", "choice"] } } });
  assert.equal(prerequisites.isError, undefined, text(prerequisites));
  const write = async (id: string, state: "todo" | "doing" | "done") => {
    const result = await client.callTool({ name: "set_plan", arguments: { author, id, row: { id: "accept", text: "Acceptance passes", accept: true, state } } });
    assert.equal(result.isError, undefined, text(result));
    assert.match(text(result), new RegExp(`rev ${store.snapshot().items[id]!.rev} · commit ${store.snapshot().head}`));
    return text(result);
  };
  const ruled = await client.callTool({ name: "rule_card", arguments: { author, key: "choice", choice: "A", ruling: "Owner accepted" } });
  assert.equal(ruled.isError, undefined, text(ruled));
  const finished = await write("a", "done");
  assert.match(finished, /^a · DONE P1/m);
  assert.match(finished, /^ancestor area now TODO P1 \(was BLOCK P1\)$/m);
  assert.match(await write("b", "done"), /^b · DONE P1/m);
  assert.match(await write("area", "doing"), /^area · WIP P1/m);
  assert.match(await write("area", "done"), /^area · DONE P1/m);
  // Reopening an owned part makes its owner open even when acceptance stays done.
  await write("a", "todo");
  const before = store.snapshot();
  const refused = await client.callTool({ name: "set_status", arguments: { author, id: "area", status: "cancelled", log: "Drop" } });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /owned items are still open: a, b; cancel or move each part first/);
  assert.deepEqual(store.snapshot(), before);
  const context = text(await client.callTool({ name: "context", arguments: { id: "area" } }));
  assert.match(context, /^status derived from plan and owner pause$/m);
  assert.match(context, /L0.*a \[own\].*中文检查 · blocked/);
  assert.match(context, /L0.*b \[own\].*阻塞证据 · blocked/);
  const dependent = text(await client.callTool({ name: "context", arguments: { id: "b" } }));
  assert.match(dependent, /⏸ a \[shared @area\].*中文检查 · blocked/);
  assert.doesNotMatch(dependent, /验收已标完成，但还有行没完成/);
  const prs = text(await client.callTool({ name: "search", arguments: { query: "Whitefoot#341" } }));
  assert.equal(prs.split("\n").filter(line => line.includes("without repository")).length, 1);
  assert.match(prs, /also a bare #341 without repository.*item:b/);
});

test("MCP creates acceptance, adopts children, moves owners and cancels or reopens only", async t => {
  const { client, text, store } = await connected(t);
  const created = await client.callTool({ name: "create_item", arguments: { author, key: "new", title: "New", group: author, accept: "Pass", priority: "P0", children: ["a"] } });
  assert.equal(created.isError, undefined, text(created)); assert.ok(store.snapshot().items.new!.plan!.some(row => "item" in row && row.item === "a" && row.own));
  const refused = await client.callTool({ name: "set_status", arguments: { author, id: "new", status: "cancelled", log: "Drop" } }); assert.equal(refused.isError, true); assert.match(text(refused), /owned items.*a/);
  const moved = await client.callTool({ name: "move_item", arguments: { author, id: "a", owner: "other", after: [] } }); assert.equal(moved.isError, undefined, text(moved));
  const cancelled = await client.callTool({ name: "set_status", arguments: { author, id: "new", status: "cancelled", log: "Superseded" } }); assert.equal(cancelled.isError, undefined, text(cancelled));
  const reopened = await client.callTool({ name: "set_status", arguments: { author, id: "new", status: "open", log: "Resume" } }); assert.equal(reopened.isError, undefined, text(reopened)); assert.equal(store.snapshot().items.new!.status, undefined);
});

test("MCP request filing stores reason only in the log and triage attaches the receiving owner", async t => {
  const { client, text, store } = await connected(t);
  const root = await client.callTool({ name: "create_item", arguments: { author: "Firn", group: "Firn", key: "firn-root", title: "Firn root", accept: "Pass", priority: "P1" } }); assert.equal(root.isError, undefined, text(root));
  const request = await client.callTool({ name: "create_request", arguments: { author, project: "Firn", key: "request", title: "Feature", head: "Witness", accept: "Program passes", why: "Needs peer address", from: "a", after: [] } }); assert.equal(request.isError, undefined, text(request));
  assert.equal(store.snapshot().items.request!.log[0]!.text, `${author} 提出：Needs peer address`);
  const triage = await client.callTool({ name: "triage_request", arguments: { author: "Firn", id: "request", owner: "firn-root", log: "Accept" } }); assert.equal(triage.isError, undefined, text(triage));
  assert.equal(store.snapshot().items.request!.request, undefined); assert.ok(store.snapshot().items["firn-root"]!.plan!.some(row => "item" in row && row.item === "request" && row.own));
});

test("owner reading state does not hide plan checks or change the data head", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op, now: () => later });
  const client = new Client({ name: "Owner reading test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const b = store.snapshot().items.b!;
  await store.commit({ author: "Fixture", message: "Provisional plan witness", puts: [{ kind: "item", id: "b", expectRev: b.rev, doc: { ...b, provisional: true } }] });
  await op.setPlan({ author, id: "b", row: { id: "work", text: "Work alongside dependencies", state: "doing", after: [] } });
  const before = await client.callTool({ name: "list", arguments: { filters: { hasChecks: true } } });
  assert.match(JSON.stringify(before.content), /b · WIP/);
  assert.match(JSON.stringify(before.content), /a · BLOCK/);
  const head = store.snapshot().head;
  store.setOwner({ cursor: head, readMarks: { "item:b": head } });
  assert.equal(store.snapshot().head, head);
  const after = await client.callTool({ name: "list", arguments: { filters: { hasChecks: true } } });
  assert.deepEqual(after.content, before.content, "read markers cannot suppress checks");
});

test("MCP re-evaluates active time without a new commit and exposes record creation and updates", async t => {
  const { store, op } = await board(t);
  const start = Date.parse("2026-10-11T03:00:00Z");
  let clock = start + 60 * 60 * 1000 - 1;
  const server = createMcpServer({store, ops: op, now: () => new Date(clock).toISOString()});
  const client = new Client({name: "Test agent", version: "1"});
  const [st, ct] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  for (const name of ["create_item", "update_item"]) assert.ok(tools.find(tool => tool.name === name)!.inputSchema.properties!.record);
  const s = structuredClone(store.snapshot());
  s.items.a!.plan = [
    { id: "work", text: "Current own work", state: "doing", since: new Date(start).toISOString() },
    { id: "accept", text: "The result passes", state: "todo", accept: true },
  ];
  s.items.a!.updated = new Date(start).toISOString();
  s.decisions = {}; s.notes = {};
  s.activity = { writes: Array.from({length: 2}, (_, i) => new Date(start + i * 30 * 60 * 1000).toISOString()), items: {} };
  store.snapshot = () => structuredClone(s);
  const context = async () => {
    const result = await client.callTool({ name: "context", arguments: { id: "a" } });
    assert.ok(!result.isError); return (result.content as Array<{ text: string }>)[0]!.text;
  };
  const head = store.snapshot().head;
  assert.ok(!(await context()).includes("活跃时间"));
  clock++;
  assert.ok((await context()).includes("活跃时间"));
  assert.equal(store.snapshot().head, head, "crossing the active-time threshold changes no document or commit");
});

test("MCP set_pause is coordinator-only and paused status works in list and overview", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Pause test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as Array<{ text: string }>).map(c => c.text).join("\n");
  const tool = (await client.listTools()).tools.find(tool => tool.name === "set_pause");
  assert.ok(tool, "the pause operation is available to the coordinator");
  assert.match(tool.description!, /Only author 总管/);
  assert.match(client.getInstructions()!, /Only 总管 may use set_pause/);
  const before = store.snapshot();
  const refused = await client.callTool({ name: "set_pause", arguments: { author, id: "area", paused: true, reason: "Pause" } });
  assert.equal(refused.isError, true); assert.match(text(refused), /only 总管/); assert.deepEqual(store.snapshot(), before);
  const missingReason = await client.callTool({ name: "set_pause", arguments: { author: "总管", id: "area", paused: true } });
  assert.equal(missingReason.isError, true); assert.match(text(missingReason), /reason.*required/);
  const paused = await client.callTool({ name: "set_pause", arguments: { author: "总管", id: "area", paused: true, reason: "Owner paused project" } });
  assert.ok(!paused.isError, text(paused)); assert.match(text(paused), /PAUSE/);
  const listed = await client.callTool({ name: "list", arguments: { filters: { status: ["paused"], group: author } } });
  assert.ok(!listed.isError, text(listed));
  for (const id of ["area", "a", "b"]) assert.match(text(listed), new RegExp(`${id} · PAUSE`));
  const overview = await client.callTool({ name: "overview", arguments: { group: author, status: ["paused"] } });
  assert.ok(!overview.isError, text(overview)); assert.match(text(overview), /PAUSE 2/);
  const context = await client.callTool({ name: "context", arguments: { id: "a" } });
  assert.match(text(context), /pause: 解释器工作 · Owner paused project/);
  const resumed = await client.callTool({ name: "set_pause", arguments: { author: "总管", id: "area", paused: false } });
  assert.ok(!resumed.isError, text(resumed)); assert.equal(store.snapshot().items.area!.paused, undefined);
});

test("context and graph accept a short number, rows show it, and an exact key wins over a number", async t => {
  const { store, op } = await board(t), server = createMcpServer({ store, ops: op });
  const client = new Client({ name: "Number test", version: "1" }), [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const s = store.snapshot(), call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, text: (result.content as Array<{ text: string }>)[0]!.text };
  };
  // The seed creates area, other, a, b, then the cards choice and ruled: one sequence in creation order.
  assert.deepEqual([s.items.area!.num, s.items.a!.num, s.decisions.choice!.num, s.decisions.ruled!.num], [1, 3, 5, 6]);
  for (const ref of ["#3", "3"]) {
    const item = await call("context", { id: ref });
    assert.equal(item.error, false, item.text); assert.match(item.text, /^a · .*· #3$/m, ref + " resolves to item a and its row ends with its number");
  }
  const card = await call("context", { id: "#5" });
  assert.equal(card.error, false, card.text); assert.match(card.text, /^choice · OPEN · 中文方案？ · rev 1 · #5$/m);
  assert.match((await call("context", { id: "a" })).text, /^a · .*· #3$/m);
  assert.match((await call("graph", { id: "#4", direction: "up" })).text, /^item:b #4 · /m);
  assert.match((await call("list", {})).text, /^area · .*· #1$/m);
  assert.match((await call("context", { id: "#99" })).text, /Unknown id #99/);
  assert.equal((await call("context", { id: "#3x" })).error, true, "a malformed number reference is refused by the schema");
  // A key made of digits names that document, not the number.
  await op.createItem({ author, key: "1", owner: "area", title: "Digits key", accept: "ok" });
  assert.match((await call("context", { id: "1" })).text, /^1 · .*Digits key.*· #7$/m);
  assert.match((await call("context", { id: "#1" })).text, /^area · /m);
  const brief = JSON.parse((await call("brief", { project: "Whitefoot" })).text) as { cards: Array<{ id: string; num?: number }> };
  assert.equal(brief.cards.find(c => c.id === "choice")?.num, 5);
});
