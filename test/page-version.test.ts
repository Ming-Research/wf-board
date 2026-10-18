// The version of the page the daemon serves, and how open pages learn that it changed (docs/design.md, section 4, Deploying).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "./helpers.ts";
import { VERSION_MARK, pageVersion, stampPage } from "../src/page-version.ts";

const HTML = `<!doctype html><meta id="page-version" content="${VERSION_MARK}"><script type="module" src="/app.js"></script>`;
const deployed = { event: "deployed", version: "a".repeat(40), previous: "b".repeat(40), changes: [], restarted: false, repo: null };
const deployFailed = { event: "deployFailed", version: "a".repeat(40), running: null, reason: "the daemon was not healthy", changes: [], repo: null };

/** A page directory of its own, which a test rewrites the way a deploy does. The diagram library is built only when `library` is given. */
async function pageDir(t: { after(fn: () => unknown): void }, files: { html?: string; js?: string | null; library?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wf-board-page-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "dist"));
  const write = async (html: string, js: string | null, library?: string | null) => {
    await writeFile(join(dir, "index.html"), html);
    if (js !== null) await writeFile(join(dir, "dist/app.js"), js);
    if (library === null) await rm(join(dir, "dist/mermaid.js"), { force: true });
    else if (library !== undefined) await writeFile(join(dir, "dist/mermaid.js"), library);
  };
  await write(files.html ?? HTML, files.js === undefined ? "console.log('one')" : files.js, files.library);
  const library = () => readFile(join(dir, "dist/mermaid.js")).catch(() => undefined);
  return { dir, write, version: async () => pageVersion(await readFile(join(dir, "index.html")), await readFile(join(dir, "dist/app.js")), await library()) };
}

/**
 * The page events of a page's stream, read as they arrive: `next` waits for one event (the comment line that opens the stream is not
 * one, and neither is `live`, the runner's beats that the stream also carries; test/live.test.ts reads those).
 */
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
      if (event && event !== "live") events.push({ event, data: data ? JSON.parse(data) : undefined });
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

test("reading the page reads no history: with requireBudget GET /, the stream and a deploy's announcement work", async t => {
  const page = await pageDir(t), { url, api } = await server(t, { webDir: page.dir, requireBudget: true });
  const one = await page.version();
  assert.match(await (await fetch(url + "/")).text(), new RegExp(`content="${one}"`));
  const events = await stream(t, url);
  assert.deepEqual(await events.next(), { event: "page", data: { version: one } });
  await page.write(HTML, "console.log('two')");
  assert.equal((await api("/api/wake", deployed)).status, 200);
  assert.deepEqual(await events.next(), { event: "page", data: { version: await page.version() } });
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

test("the diagram library is part of the version once built: a change to it changes the version, a byte moved into it does too, and a page without it keeps the old version", () => {
  const html = Buffer.from("html"), js = Buffer.from("js"), lib = Buffer.from("lib");
  const without = pageVersion(html, js), a = pageVersion(html, js, lib);
  assert.notEqual(a, without, "building the library is a new version");
  assert.equal(pageVersion(html, js, Buffer.from("lib")), a);
  assert.notEqual(pageVersion(html, js, Buffer.from("lib!")), a);
  assert.notEqual(pageVersion(html, Buffer.from("jsl"), Buffer.from("ib")), a, "a byte moved from the bundle to the library is another version");
  assert.notEqual(pageVersion(html, js, Buffer.alloc(0)), without, "an empty library is not no library");
});

test("GET /mermaid.js serves the library on disk with a tag, answers 304 to that tag and the new file once rebuilt, and 404 while it is not built", async t => {
  const page = await pageDir(t), { url } = await server(t, { webDir: page.dir });
  const missing = await fetch(url + "/mermaid.js");
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
  await page.write(HTML, "console.log('one')", "export default 1;");
  const first = await fetch(url + "/mermaid.js");
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-type") ?? "", /^text\/javascript/);
  assert.equal(first.headers.get("cache-control"), "no-cache");
  assert.equal(await first.text(), "export default 1;");
  const tag = first.headers.get("etag")!;
  assert.match(tag, /^"[0-9a-f]{16}"$/);
  const same = await fetch(url + "/mermaid.js", { headers: { "If-None-Match": tag } });
  assert.equal(same.status, 304);
  assert.equal((await same.arrayBuffer()).byteLength, 0);
  await page.write(HTML, "console.log('one')", "export default 2;");
  const rebuilt = await fetch(url + "/mermaid.js", { headers: { "If-None-Match": tag } });
  assert.equal(rebuilt.status, 200, "a rebuilt library is not answered with the old tag");
  assert.equal(await rebuilt.text(), "export default 2;");
  assert.notEqual(rebuilt.headers.get("etag"), tag);
});

test("a rebuilt diagram library is a new page version: GET / carries it and a deploy announces it, though the bundle did not change", async t => {
  const page = await pageDir(t, { library: "export default 1;" }), { url, api } = await server(t, { webDir: page.dir });
  const meta = async () => /id="page-version" content="([^"]*)"/.exec(await (await fetch(url + "/")).text())![1];
  const one = await page.version();
  assert.equal(await meta(), one);
  const events = await stream(t, url);
  assert.deepEqual(await events.next(), { event: "page", data: { version: one } });
  await page.write(HTML, "console.log('one')", "export default 2;");
  const two = await page.version();
  assert.notEqual(two, one);
  assert.equal(await meta(), two);
  assert.equal((await api("/api/wake", deployed)).status, 200);
  assert.deepEqual(await events.next(), { event: "page", data: { version: two } });
  // A page without the library is still a page with a version, so it reloads itself when the library arrives.
  await page.write(HTML, "console.log('one')", null);
  assert.equal(await meta(), await page.version());
});
