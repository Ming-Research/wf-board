// The version of the page the daemon serves, and how open pages learn that it changed (docs/design.md, section 4, Deploying).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "./helpers.ts";
import { VERSION_MARK, pageVersion, stampPage } from "../src/page-version.ts";

const HTML = `<!doctype html><meta id="page-version" content="${VERSION_MARK}"><script type="module" src="/app.js"></script>`;
const deployed = { event: "deployed", version: "a".repeat(40), previous: "b".repeat(40), changes: [], restarted: false };
const deployFailed = { event: "deployFailed", version: "a".repeat(40), running: null, reason: "the daemon was not healthy" };

/** A page directory of its own, which a test rewrites the way a deploy does. */
async function pageDir(t: { after(fn: () => unknown): void }, files: { html?: string; js?: string | null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-page-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "dist"));
  const write = async (html: string, js: string | null) => {
    await writeFile(join(dir, "index.html"), html);
    if (js !== null) await writeFile(join(dir, "dist/app.js"), js);
  };
  await write(files.html ?? HTML, files.js === undefined ? "console.log('one')" : files.js);
  return { dir, write, version: async () => pageVersion(await readFile(join(dir, "index.html")), await readFile(join(dir, "dist/app.js"))) };
}

/** The events of a page's stream, read as they arrive: `next` waits for one event (the comment line that opens the stream is not one). */
async function stream(t: { after(fn: () => unknown): void }, url: string) {
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(url + "/api/events", { signal: controller.signal });
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let text = "";
  const events: Array<{ event: string; data: unknown }> = [];
  // One read stays outstanding until a chunk arrives, so a wait that ran out does not swallow the next chunk.
  let pending: ReturnType<typeof reader.read> | undefined;
  async function read(wait: number) {
    pending ??= reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const chunk = await Promise.race([pending, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("no event arrived")), wait); })]);
      pending = undefined;
      text += decoder.decode(chunk.value);
    } finally { clearTimeout(timer); }
    for (let end = text.indexOf("\n\n"); end >= 0; end = text.indexOf("\n\n")) {
      const block = text.slice(0, end); text = text.slice(end + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
      if (event) events.push({ event, data: data ? JSON.parse(data) : undefined });
    }
  }
  return {
    /** The next event, waiting for it. */
    async next() { while (!events.length) await read(3000); return events.shift()!; },
    /** Whether no event arrives within `wait` ms; an event that does arrive stays unread. */
    async quiet(wait = 300) {
      const until = Date.now() + wait;
      while (!events.length && Date.now() < until) { try { await read(Math.max(1, until - Date.now())); } catch { break; } }
      return !events.length;
    },
  };
}

test("the version is a hash of the two files, so a change to either changes it and a moved byte does too", () => {
  const a = pageVersion(Buffer.from("html"), Buffer.from("js"));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(pageVersion(Buffer.from("html"), Buffer.from("js")), a);
  assert.notEqual(pageVersion(Buffer.from("html!"), Buffer.from("js")), a);
  assert.notEqual(pageVersion(Buffer.from("html"), Buffer.from("js!")), a);
  assert.notEqual(pageVersion(Buffer.from("htm"), Buffer.from("ljs")), a, "a byte moved from one file to the other is another version");
});

test("web/index.html holds the mark exactly once, and stampPage fills it in or empties it", async () => {
  const html = await readFile(join(import.meta.dirname, "../web/index.html"), "utf8");
  assert.equal(html.split(VERSION_MARK).length - 1, 1);
  assert.equal(stampPage(`a ${VERSION_MARK} b`, "0123"), "a 0123 b");
  assert.equal(stampPage(`a ${VERSION_MARK} b`, undefined), "a  b");
});

test("GET / carries the version of the files on disk, and it follows a rebuilt page without a restart", async t => {
  const page = await pageDir(t), { url } = await server(t, { webDir: page.dir });
  const meta = async () => /id="page-version" content="([^"]*)"/.exec(await (await fetch(url + "/")).text())![1];
  assert.equal(await meta(), await page.version());
  const before = await meta();
  await page.write(HTML, "console.log('two')");
  assert.equal(await meta(), await page.version());
  assert.notEqual(await meta(), before);
});

test("a page with no bundle yet is served without a version, and its stream opens without a page event", async t => {
  const page = await pageDir(t, { js: null }), { url } = await server(t, { webDir: page.dir });
  const response = await fetch(url + "/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="page-version" content=""/);
  const events = await stream(t, url);
  assert.equal(await events.quiet(), true);
});

test("a stream opens with the version of the page on disk", async t => {
  const page = await pageDir(t), { url } = await server(t, { webDir: page.dir });
  const events = await stream(t, url);
  assert.deepEqual(await events.next(), { event: "page", data: { version: await page.version() } });
});

test("a deploy that changed the page tells every open page, and one that did not tells none", async t => {
  const page = await pageDir(t), { url, api } = await server(t, { webDir: page.dir });
  const first = await stream(t, url), second = await stream(t, url);
  const one = await page.version();
  assert.deepEqual(await first.next(), { event: "page", data: { version: one } });
  assert.deepEqual(await second.next(), { event: "page", data: { version: one } });
  // A deploy that changed only docs: the page files are as before.
  assert.equal((await api("/api/wake", deployed)).status, 200);
  assert.equal(await first.quiet(), true, "an unchanged page is not announced");
  // A deploy that changed the bundle, without a restart.
  await page.write(HTML, "console.log('two')");
  const two = await page.version();
  assert.notEqual(two, one);
  assert.equal((await api("/api/wake", deployed)).status, 200);
  assert.deepEqual(await first.next(), { event: "page", data: { version: two } });
  assert.deepEqual(await second.next(), { event: "page", data: { version: two } });
  // The same page again, told twice, is announced once.
  assert.equal((await api("/api/wake", deployed)).status, 200);
  assert.equal(await first.quiet(), true);
  // A deploy that failed and went back to the first page tells the pages that it changed back.
  await page.write(HTML, "console.log('one')");
  assert.equal((await api("/api/wake", deployFailed)).status, 200);
  assert.deepEqual(await first.next(), { event: "page", data: { version: one } });
});

test("a page that connects is told the version on disk, and the pages already open wait for the deploy that ends", async t => {
  const page = await pageDir(t), { url, api } = await server(t, { webDir: page.dir });
  const first = await stream(t, url);
  const one = await page.version();
  assert.deepEqual(await first.next(), { event: "page", data: { version: one } });
  // The page files change with no deploy push (a build under way, or a deploy by hand): a page that connects reads what is there.
  await page.write(HTML, "console.log('by hand')");
  const second = await stream(t, url);
  const two = await page.version();
  assert.deepEqual(await second.next(), { event: "page", data: { version: two } });
  assert.equal(await first.quiet(), true, "the open page is not told by another page's connecting: the files may not be done changing");
  // The deploy ends: now every open page is told.
  assert.equal((await api("/api/wake", deployed)).status, 200);
  assert.deepEqual(await first.next(), { event: "page", data: { version: two } });
});
