import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Wake } from "../src/wake.ts";
import { UsageWatch } from "../src/usage-watch.ts";
import { ghBilling, parseBudgets, parseUsage, parseVisibility } from "../src/billing.ts";
import type { BillingSource } from "../src/billing.ts";
import { advanceBooks, usageFigures, usageLine, usagePushes } from "../src/rules.ts";
import type { OrgBooks, UsageFigures, UsageReading, UsageRow } from "../src/rules.ts";
import { server, wakeSocket } from "./helpers.ts";

const ORG = "Ming-Research";
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
/** A row of the usage report: `minutes` of `sku` in `repo` on October's day `d`. */
const row = (d: number, repo: string, minutes: number, sku = "Actions Linux"): UsageRow => ({ date: `${day(d)}T06:00:00Z`, repo, sku, minutes });
const visibility = { app: "private", lib: "public", site: "private" } as const;
const reading = (fields: Partial<UsageReading> & Pick<UsageReading, "rows">): UsageReading => ({ org: ORG, month: "2026-10", at: "2026-10-16T12:00:00.000Z", visibility, budget: { amount: 0, stop: true }, ...fields });
const used = (books: OrgBooks) => books.entries.reduce((sum, e) => sum + e.counted, 0);

// --- The account ---------------------------------------------------------------------------------------------------------------------

test("the account counts what the report grew by since the last look, only for repositories that are not public at that look", () => {
  // First look: what the report shows is counted by the visibility now: the private app's 100, not the public lib's 500.
  let books = advanceBooks(undefined, reading({ rows: [row(1, "app", 100), row(1, "lib", 500)] }));
  assert.equal(used(books), 100);
  assert.equal(books.since, "2026-10-16T12:00:00.000Z");
  // The public lib turns private: its 500 from before are not counted, only what it grows by from now on.
  books = advanceBooks(books, reading({ rows: [row(1, "app", 100), row(1, "lib", 520)], visibility: { ...visibility, lib: "private" } }));
  assert.equal(used(books), 120, "lib's 20 new minutes, not its 520");
  // The private app turns public: what it grows by is no longer counted, what was counted stays.
  books = advanceBooks(books, reading({ rows: [row(1, "app", 150), row(1, "lib", 520)], visibility: { ...visibility, app: "public", lib: "private" } }));
  assert.equal(used(books), 120);
  assert.equal(books.since, "2026-10-16T12:00:00.000Z", "within the month the books keep their start");
});

test("a report revised downwards adds nothing and counts again from the lower number; an unknown repository counts; names are matched in lower case", () => {
  let books = advanceBooks(undefined, reading({ rows: [row(2, "app", 100)] }));
  books = advanceBooks(books, reading({ rows: [row(2, "app", 90)] }));
  assert.equal(used(books), 100, "nothing is taken back");
  books = advanceBooks(books, reading({ rows: [row(2, "app", 95)] }));
  assert.equal(used(books), 105, "5 more than the lower 90");
  books = advanceBooks(books, reading({ rows: [row(3, "Mystery", 7), row(3, "APP", 4)] }));
  assert.equal(used(books), 116, "a repository the listing lacks counts; APP is app");
});

test("Windows and macOS minutes use more of the included minutes, larger runners and storage use none, and rows of another month are left out", () => {
  const books = advanceBooks(undefined, reading({ rows: [
    row(4, "app", 10), row(4, "app", 10, "Actions Windows"), row(4, "app", 10, "Actions macOS 3-core"), row(4, "app", 99, "Actions Linux 4-core"),
    { date: "2026-09-30T23:00:00Z", repo: "app", sku: "Actions Linux", minutes: 50 },
  ] }));
  assert.equal(used(books), 10 + 2 * 10 + 10 * 10);
});

test("a new month starts new books", () => {
  const october = advanceBooks(undefined, reading({ rows: [row(5, "app", 400)] }));
  assert.equal(used(october), 400);
  const november = advanceBooks(october, reading({ month: "2026-11", at: "2026-11-01T00:30:00.000Z", rows: [{ date: "2026-11-01T00:10:00Z", repo: "app", sku: "Actions Linux", minutes: 3 }] }));
  assert.deepEqual([november.month, november.since, used(november)], ["2026-11", "2026-11-01T00:30:00.000Z", 3]);
});

test("the figures are the month's counted minutes and today's, and the line says them with the budget and where the books start", () => {
  const books = advanceBooks(undefined, reading({ rows: [row(15, "app", 200), row(16, "app", 40), row(16, "lib", 900)] }));
  const f = usageFigures(books, reading({ rows: [] }));
  assert.deepEqual([f.used, f.today, f.included, f.day], [240, 40, 3000, "2026-10-16"]);
  assert.equal(usageLine(f), "Actions 本月已用 240 / 3000（从 10-16 起记账），今天 40，预算 0 美元，到上限就拦");
  assert.equal(usageLine({ ...f, budget: null }, true), "Ming-Research：Actions 本月已用 240 / 3000（从 10-16 起记账），今天 40，预算 未设");
  assert.match(usageLine({ ...f, budget: { amount: 50, stop: false } }), /预算 50 美元$/);
});

// --- What is told --------------------------------------------------------------------------------------------------------------------

const figures = (fields: Partial<UsageFigures> = {}): UsageFigures => ({ org: ORG, month: "2026-10", day: "2026-10-16", since: "2026-10-01T00:00:00.000Z", used: 0, today: 0, included: 3000, budget: { amount: 0, stop: true }, ...fields });
/** The pushes now, which are then told: their keys join `announced` as the watch does. */
function teller() {
  const announced = new Set<string>();
  return (f: UsageFigures) => { const pushes = usagePushes(f, announced); for (const p of pushes) announced.add(p.key); return pushes.map(p => [p.fields.reason, p.fields.level]); };
}

test("the month's use is told once when it first reaches 50%, 75% and 90%; going from 49% to 50% tells, 51% does not", () => {
  const tell = teller();
  assert.deepEqual(tell(figures({ used: 1470 })), [], "49%");
  assert.deepEqual(tell(figures({ used: 1500 })), [["month", 50]], "50%");
  assert.deepEqual(tell(figures({ used: 1530 })), [], "51%");
  assert.deepEqual(tell(figures({ used: 2249 })), [], "just under 75%");
  assert.deepEqual(tell(figures({ used: 2250 })), [["month", 75]]);
  assert.deepEqual(tell(figures({ used: 2700 })), [["month", 90]]);
  assert.deepEqual(tell(figures({ used: 2999 })), [], "no further level");
  // A report revised downwards and up again does not tell a level twice.
  assert.deepEqual(tell(figures({ used: 1600 })), []);
  assert.deepEqual(tell(figures({ used: 2800 })), []);
});

test("a first look that finds the month at 88% tells one level, the highest, and none of those below it; a new month tells again", () => {
  const tell = teller();
  assert.deepEqual(tell(figures({ used: 2640 })), [["month", 75]]);
  assert.deepEqual(tell(figures({ used: 2641 })), []);
  assert.deepEqual(tell(figures({ used: 1600 })), [], "the 50% level was told with the 75% one; a report revised down to 53% does not tell it");
  assert.deepEqual(tell(figures({ used: 2700 })), [["month", 90]]);
  assert.deepEqual(tell(figures({ month: "2026-11", day: "2026-11-02", used: 1500 })), [["month", 50]], "the keys carry the month");
});

test("a day with more than 300 counted minutes is told once that day, and again on another day", () => {
  const tell = teller();
  assert.deepEqual(tell(figures({ today: 300, used: 300 })), [], "300 is not more than 300");
  assert.deepEqual(tell(figures({ today: 301, used: 301 })), [["day", null]]);
  assert.deepEqual(tell(figures({ today: 900, used: 900 })), [], "once for the day");
  assert.deepEqual(tell(figures({ day: "2026-10-17", today: 400, used: 1300 })), [["day", null]]);
});

test("the included minutes all used tells when the budget is 0, and not when there is a budget or none is set", () => {
  const cap = (fields: Partial<UsageFigures>) => teller()(figures({ used: 3000, ...fields })).filter(([reason]) => reason === "cap");
  assert.deepEqual(cap({}), [["cap", null]]);
  assert.deepEqual(cap({ used: 3400 }), [["cap", null]]);
  assert.deepEqual(cap({ used: 2999 }), [], "not yet");
  assert.deepEqual(cap({ budget: { amount: 20, stop: true } }), [], "a budget lets CI go on");
  assert.deepEqual(cap({ budget: null }), [], "no budget set is not a budget of 0");
  const tell = teller();
  assert.deepEqual(tell(figures({ used: 3000 })).map(([reason]) => reason), ["month", "cap"], "the 90% level, then the cap");
  assert.deepEqual(tell(figures({ used: 3100 })), [], "told once a month");
});

// --- The watch -----------------------------------------------------------------------------------------------------------------------

async function board(t: { after(fn: () => void | Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-usage-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = await Store.open(dir, { init: true, board: { title: "Synthetic board", projects: [
    { name: "wf-board", repo: "Ming-Research/wf-board" },
    { name: "Whitefoot", repo: "Ming-Research/Whitefoot" },
    { name: "Architect", repo: "mbbill/agents_config" },
    { name: "总管" },
  ] } });
  return { dir, store, stateFile: join(dir, "state", "actions-usage.json") };
}
/** A billing source answering from a function; the personal account answers `undefined`, as the real one does. */
function billing(answer: (owner: string, at: Date) => UsageReading | undefined | Error) {
  const calls: string[] = [];
  const source: BillingSource = { async read(owner, at) { calls.push(owner); const a = answer(owner, at); if (a instanceof Error) throw a; return a; } };
  return { source, calls };
}
const quiet = async <T>(fn: () => Promise<T>): Promise<{ result: T; said: string[] }> => {
  const said: string[] = [], error = console.error, info = console.info;
  console.error = (...a: unknown[]) => { said.push(a.map(String).join(" ")); }; console.info = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
  try { return { result: await fn(), said }; } finally { console.error = error; console.info = info; }
};
/** The days 1 to 15 with 98 minutes each in the private app: 1470, which is 49% of 3000. */
const fortyNine = Array.from({ length: 15 }, (_, i) => row(i + 1, "app", 98));
const usageFrames = (wake: Wake) => wake.since(0).frames.filter(f => f.event === "actions-usage").map(f => [f.reason, f.level, f.used]);

test("the use going from 49% to 50% is told once, 51% is not; it is read for the organization only, once, and not for a personal account", async t => {
  const { store } = await board(t), wake = new Wake();
  let todays = 0;
  const { source, calls } = billing((owner, at) => owner === "mbbill" ? undefined : reading({ at: at.toISOString(), rows: [...fortyNine, ...(todays ? [row(16, "app", todays)] : [])] }));
  const watch = new UsageWatch({ store, wake, billing: source, now: () => Date.parse("2026-10-16T12:00:00Z") });
  await watch.poll();
  assert.deepEqual(usageFrames(wake), [], "49%");
  assert.deepEqual(calls, [ORG, "mbbill"], "Ming-Research once for its three projects, the personal account asked and skipped");
  assert.deepEqual(watch.status().problems, {}, "a personal account is no problem");
  todays = 30; await watch.poll();
  assert.deepEqual(usageFrames(wake), [["month", 50, 1500]], "50%");
  todays = 60; await watch.poll();
  assert.deepEqual(usageFrames(wake), [["month", 50, 1500]], "51% tells nothing");
  const frame = wake.since(0).frames[0]!;
  assert.deepEqual([frame.org, frame.month, frame.day, frame.included, frame.today, frame.budget], [ORG, "2026-10", "2026-10-16", 3000, 30, { amount: 0, stop: true }]);
  assert.match(String(frame.text), /Ming-Research 的 Actions 本月用量到 50%/);
});

test("a day over 300 minutes and the included minutes all used with a budget of 0 are told once each through the watch", async t => {
  const { store } = await board(t), wake = new Wake();
  // Today's minutes in the private app, then ten earlier days of 270 on top of them: 3030 for the month.
  const earlier = Array.from({ length: 10 }, (_, i) => row(i + 1, "app", 270));
  const looks: UsageRow[][] = [[row(16, "app", 250)], [row(16, "app", 320)], [row(16, "app", 330), ...earlier], [row(16, "app", 340), ...earlier]];
  let look = 0;
  const { source } = billing((owner, at) => owner === "mbbill" ? undefined : reading({ at: at.toISOString(), rows: looks[look]! }));
  const watch = new UsageWatch({ store, wake, billing: source, now: () => Date.parse("2026-10-16T12:00:00Z") });
  const told = async () => { await watch.poll(); return usageFrames(wake); };
  assert.deepEqual(await told(), [], "250 minutes today");
  look = 1;
  assert.deepEqual(await told(), [["day", null, 320]], "more than 300 today");
  look = 2;
  assert.deepEqual(await told(), [["day", null, 320], ["month", 90, 3030], ["cap", null, 3030]], "the day is not told again; the month is at 101%, which is the 90% level, and the budget is 0");
  look = 3;
  assert.equal((await told()).length, 3, "nothing more");
});

test("a restart neither tells a push again nor starts the account over, and the account is kept in the state file", async t => {
  const { store, stateFile } = await board(t), wake = new Wake(), now = () => Date.parse("2026-10-16T12:00:00Z");
  let todays = 30;
  const { source } = billing((owner, at) => owner === "mbbill" ? undefined : reading({ at: at.toISOString(), rows: [...fortyNine, row(16, "app", todays)], visibility: { app: "private" } }));
  await new UsageWatch({ store, wake, billing: source, now, stateFile }).poll();
  assert.deepEqual(usageFrames(wake), [["month", 50, 1500]]);
  const state = JSON.parse(await readFile(stateFile, "utf8")) as { polledAt: string; books: Record<string, OrgBooks> };
  assert.equal(state.polledAt, "2026-10-16T12:00:00.000Z");
  assert.equal(used(state.books[ORG]!), 1500);
  // The report now shows the app public: a restarted watch adds nothing to the account it kept, and does not tell 50% again.
  todays = 80;
  const flipped = billing((owner, at) => owner === "mbbill" ? undefined : reading({ at: at.toISOString(), rows: [...fortyNine, row(16, "app", todays)], visibility: { app: "public" } }));
  const again = new UsageWatch({ store, wake, billing: flipped.source, now, stateFile });
  await again.poll();
  assert.equal(again.status().figures[0]!.used, 1500, "the 50 new minutes were spent while public");
  assert.equal(again.status().figures[0]!.since, "2026-10-16T12:00:00.000Z");
  assert.deepEqual(usageFrames(wake), [["month", 50, 1500]]);
});

test("a state file that is lost or unreadable starts the account again from the visibility of the first look, and says so", async t => {
  const { store, stateFile } = await board(t), wake = new Wake(), now = () => Date.parse("2026-10-16T12:00:00Z");
  const { source } = billing((owner, at) => owner === "mbbill" ? undefined : reading({ at: at.toISOString(), rows: [row(16, "app", 40), row(16, "lib", 700)] }));
  const lost = await quiet(async () => { const w = new UsageWatch({ store, wake, billing: source, now, stateFile }); await w.poll(); return w; });
  assert.equal(lost.result.status().figures[0]!.used, 40, "the public lib's minutes are not counted");
  assert.ok(lost.said.some(line => /no state file/.test(line)));
  assert.ok(lost.said.some(line => /account for 2026-10 starts now/.test(line)));
  await writeFile(stateFile, "not json");
  const broken = await quiet(async () => { const w = new UsageWatch({ store, wake, billing: source, now, stateFile }); await w.poll(); return w; });
  assert.equal(broken.result.status().figures[0]!.used, 40);
  assert.ok(broken.said.some(line => /state file unreadable/.test(line)));
  await writeFile(stateFile, JSON.stringify({ polledAt: "2026-10-16T11:59:00.000Z", books: { [ORG]: { month: "2026-10", since: "x", entries: "bad" } } }));
  const shaped = await quiet(async () => new UsageWatch({ store, wake, billing: source, now, stateFile }));
  assert.ok(shaped.said.some(line => /state file unreadable/.test(line)), "a file of the wrong shape is unreadable too");
  assert.equal(shaped.result.nextDelayMs(), 0, "and costs one early look");
});

test("a look that cannot read the billing says why in the line and tells nothing; the next good look clears it; the timed wake line never throws", async t => {
  const { store } = await board(t), wake = new Wake();
  let failing: Error | undefined = new Error("wf: usage report: gh: HTTP 403");
  const { source } = billing((owner, at) => owner === "mbbill" ? undefined : failing ?? reading({ at: at.toISOString(), rows: [row(16, "app", 10)] }));
  const watch = new UsageWatch({ store, wake, billing: source, now: () => Date.parse("2026-10-16T12:00:00Z") });
  assert.equal(watch.line(), "Actions 用量还没读到");
  const bad = await quiet(() => watch.poll());
  assert.equal(watch.line(), "Actions 用量读不到：wf: usage report: gh: HTTP 403");
  assert.deepEqual(watch.status().problems, { [ORG]: "wf: usage report: gh: HTTP 403" });
  assert.ok(bad.said.some(line => /usage report: gh: HTTP 403/.test(line)));
  const second = await quiet(() => watch.poll());
  assert.deepEqual(second.said, [], "said once while it lasts");
  assert.deepEqual(wake.since(0).frames, []);
  failing = undefined;
  await watch.poll();
  assert.equal(watch.line(), "Actions 本月已用 10 / 3000（从 10-16 起记账），今天 10，预算 0 美元，到上限就拦");
  assert.deepEqual(watch.status().problems, {});
  // Only personal accounts: nothing to read, and the line says so.
  const personal = new UsageWatch({ store, wake, billing: billing(() => undefined).source });
  await personal.poll();
  assert.match(personal.line(), /没有可读的组织/);
});

test("start looks at once, then at every interval, and waits out the rest of the interval after a restart; stop ends it", async t => {
  const { store, stateFile } = await board(t);
  const { source, calls } = billing(() => undefined);
  const watch = new UsageWatch({ store, wake: new Wake(), billing: source, everyMs: 20 });
  watch.start();
  for (let i = 0; i < 300 && calls.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 10));
  watch.stop();
  assert.ok(calls.length >= 6, "an immediate look and then timed ones (two owners each)");
  const settled = calls.length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls.length, settled, "no look after stop");
  const at = Date.parse("2026-10-16T12:00:00Z"), every = 30 * 60_000;
  const make = (now: number) => new UsageWatch({ store, wake: new Wake(), billing: source, now: () => now, stateFile });
  assert.equal(make(at).nextDelayMs(), 0, "no look known: at once");
  await make(at).poll();
  assert.equal(make(at + 10 * 60_000).nextDelayMs(), 20 * 60_000);
  assert.equal(make(at + every).nextDelayMs(), 0);
  assert.equal(make(at - 60_000).nextDelayMs(), every, "a clock that went back waits one interval, not more");
});

// --- GitHub's answer -------------------------------------------------------------------------------------------------------------------
// The shapes are those of `gh api` for an organization's usage report, repository list and budgets, as read from the live answers.

const usageJson = JSON.stringify({ usageItems: [
  { date: "2026-10-04T08:34:42Z", product: "actions", sku: "Actions Linux", quantity: 1640.0, unitType: "Minutes", pricePerUnit: 0.006, grossAmount: 9.84, discountAmount: 9.84, netAmount: 0.0, organizationName: ORG, repositoryName: "Whitefoot" },
  { date: "2026-10-04T00:00:00Z", product: "actions", sku: "Actions storage", quantity: 0.0186, unitType: "GigabyteHours", pricePerUnit: 0.0003, grossAmount: 0, discountAmount: 0, netAmount: 0, organizationName: ORG, repositoryName: "site" },
  { date: "2026-10-05T01:00:00Z", product: "copilot", sku: "Copilot", quantity: 3, unitType: "Minutes", pricePerUnit: 1, grossAmount: 3, discountAmount: 0, netAmount: 3, organizationName: ORG, repositoryName: "site" },
  { date: "2026-10-05T02:00:00Z", product: "actions", sku: "Actions macOS 3-core", quantity: 12.0, unitType: "Minutes", pricePerUnit: 0.062, grossAmount: 0.744, discountAmount: 0.744, netAmount: 0, organizationName: ORG, repositoryName: "App" },
] });
const budgetItem = (sku: string, amount: number, stop: boolean, scope = "organization") => ({ id: sku, budget_type: "ProductPricing", budget_product_sku: sku, budget_scope: scope, budget_amount: amount, prevent_further_usage: stop, budget_entity_name: ORG, budget_alerting: { will_alert: true, alert_recipients: ["x"] } });
const listing = "Whitefoot\tpublic\napp\tprivate\nSite\tprivate\n";

test("the usage report is read into the minutes rows only, the listing into visibility in lower case, and a page of budgets into the Actions budget of the organization", () => {
  assert.deepEqual(parseUsage(usageJson), [
    { date: "2026-10-04T08:34:42Z", repo: "Whitefoot", sku: "Actions Linux", minutes: 1640 },
    { date: "2026-10-05T02:00:00Z", repo: "App", sku: "Actions macOS 3-core", minutes: 12 },
  ]);
  assert.deepEqual(parseVisibility(listing), { whitefoot: "public", app: "private", site: "private" });
  const page = (items: object[], more = false) => JSON.stringify({ budgets: items, has_next_page: more, total_count: items.length });
  assert.deepEqual(parseBudgets(page([budgetItem("codespaces", 0, true), budgetItem("actions", 0, true)])), { found: { amount: 0, stop: true }, more: false });
  assert.deepEqual(parseBudgets(page([budgetItem("actions", 40, false)])), { found: { amount: 40, stop: false }, more: false });
  assert.deepEqual(parseBudgets(page([budgetItem("actions", 40, true, "repository")], true)), { more: true }, "a budget of a repository is not the organization's");
  assert.throws(() => parseUsage("<html>"), /not JSON/);
  assert.throws(() => parseUsage("{}"), /unexpected shape/);
  assert.throws(() => parseBudgets(JSON.stringify({ budgets: [{ budget_amount: "x" }] })), /unexpected shape/);
  assert.throws(() => parseVisibility("app\tsecret"), /unexpected line/);
});

/** `gh` answering by the path asked for; `answers` maps a path fragment to its output or error. */
function gh(answers: Record<string, string | Error | Array<string | Error>>) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const path = args.find(a => a.startsWith("/")) ?? "", key = Object.keys(answers).find(k => path.includes(k));
    if (!key) throw new Error(`unexpected call ${args.join(" ")}`);
    const answer = answers[key]!, next = Array.isArray(answer) ? answer.shift()! : answer;
    if (next instanceof Error) throw next;
    return next;
  };
  return { run, calls };
}
const ghError = (reason: string) => new Error(`Command failed: gh api\n${reason}`);

test("the billing is read with three calls for the UTC month, finding the Actions budget on a later page", async () => {
  const { run, calls } = gh({
    "/orgs/Ming-Research/repos": listing,
    "/billing/usage": usageJson,
    "/billing/budgets": [JSON.stringify({ budgets: [budgetItem("codespaces", 0, true)], has_next_page: true }), JSON.stringify({ budgets: [budgetItem("actions", 0, true)], has_next_page: false })],
  });
  const read = await ghBilling(run).read(ORG, new Date("2026-10-31T23:59:59Z"));
  assert.deepEqual(read, { org: ORG, month: "2026-10", at: "2026-10-31T23:59:59.000Z", rows: parseUsage(usageJson), visibility: parseVisibility(listing), budget: { amount: 0, stop: true } });
  const usage = calls.find(c => c.some(a => a.includes("/billing/usage")))!;
  assert.deepEqual(usage.slice(usage.indexOf("-f")), ["-f", "year=2026", "-f", "month=10"]);
  assert.equal(calls.filter(c => c.some(a => a.includes("/billing/budgets"))).length, 2);
  assert.ok(calls.every(c => c[0] === "api"));
  // No Actions budget at all: none in the reading.
  const none = gh({ "/orgs/": listing, "/billing/usage": usageJson, "/billing/budgets": JSON.stringify({ budgets: [budgetItem("git_lfs", 0, true)], has_next_page: false }) });
  assert.equal((await ghBilling(none.run).read(ORG, new Date("2026-10-16T00:00:00Z"))).budget, undefined);
});

test("a personal account has no organization repositories and is skipped; any other failure is a reason that names the owner and the call", async () => {
  const personal = gh({ "/orgs/mbbill/repos": ghError("gh: Not Found (HTTP 404)") });
  assert.equal(await ghBilling(personal.run).read("mbbill", new Date("2026-10-16T00:00:00Z")), undefined);
  assert.equal(personal.calls.length, 1, "nothing else is asked");
  const at = new Date("2026-10-16T00:00:00Z"), other = (answers: Parameters<typeof gh>[0]) => ghBilling(gh(answers).run).read(ORG, at);
  await assert.rejects(other({ "/repos": ghError("gh: Resource not accessible (HTTP 403)") }), { message: "Ming-Research: repository list: gh: Resource not accessible (HTTP 403)" });
  await assert.rejects(other({ "/repos": listing, "/billing/usage": ghError("gh: Forbidden (HTTP 403)"), "/billing/budgets": JSON.stringify({ budgets: [], has_next_page: false }) }), { message: "Ming-Research: usage report: gh: Forbidden (HTTP 403)" });
  await assert.rejects(other({ "/repos": listing, "/billing/usage": "<html>", "/billing/budgets": JSON.stringify({ budgets: [], has_next_page: false }) }), { message: "Ming-Research: usage report: usage report is not JSON" });
  await assert.rejects(other({ "/repos": listing, "/billing/usage": usageJson, "/billing/budgets": ghError("gh: Not Found (HTTP 404)") }), { message: "Ming-Research: budgets: gh: Not Found (HTTP 404)" });
  await assert.rejects(other({ "/repos": "app\tsecret\n", "/billing/usage": usageJson, "/billing/budgets": JSON.stringify({ budgets: [], has_next_page: false }) }), /repository list: repository list has an unexpected line/);
});

// --- Inside the server -----------------------------------------------------------------------------------------------------------------

test("the timed wake carries the usage line, and /health reports the last look", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const half = 30 * 60_000, T0 = Date.parse("2026-10-16T00:00:00Z");
  let clock = T0;
  const wake = new Wake({ now: () => clock }), { source } = billing((owner, at) => owner === "Ming-Research" ? reading({ at: at.toISOString(), rows: [row(2, "app", 100)] }) : undefined);
  let usage: UsageWatch | undefined;
  const { url, api } = await server(t, { now: () => clock, checkIntervalMs: 1000, wake, timedWakeMs: half, usage: fx => (usage = new UsageWatch({ store: fx.store, wake, billing: source, now: () => clock })) });
  for (let i = 0; i < 300 && usage!.status().figures.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(usage!.status().figures[0]?.used, 100);
  const star = await wakeSocket(t, url);
  clock = T0 + half; t.mock.timers.tick(1000);
  for (let i = 0; i < 400 && star.events().length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const frame = star.events()[0]!;
  assert.equal(frame.event, "timed");
  assert.equal(frame.actions, "Actions 本月已用 100 / 3000（从 10-16 起记账），今天 0，预算 0 美元，到上限就拦");
  const health = await api("/health", undefined, "GET");
  assert.deepEqual((health.data as { usage: { polledAt: string; problems: object; figures: Array<{ used: number }> } }).usage.figures.map(f => f.used), [100]);
  assert.ok((health.data as { usage: { polledAt: string } }).usage.polledAt);
});
