// How a page decides to reload when the server announces another version of it (web/update.ts), without a page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RECHECK_MS, RELOAD_AGAIN_MS, STUCK, WAITING, pageUpdater } from "../web/update.ts";
import type { UpdateEnv } from "../web/update.ts";

/** A page on version "one" with a clock the test moves; `later` callbacks run when the clock reaches them. */
function fake(own = "one") {
  let clock = 1_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const state = { busy: false, reloads: 0, banner: null as string | null, last: undefined as { version: string; at: number } | undefined };
  const env: UpdateEnv = {
    own,
    busy: () => state.busy,
    banner: text => { state.banner = text; },
    reload: () => { state.reloads++; },
    lastReload: () => state.last,
    rememberReload: reload => { state.last = reload; },
    now: () => clock,
    later: (fn, ms) => { timers.push({ at: clock + ms, fn }); },
  };
  const advance = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const next = timers.filter(t => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1); clock = next.at; next.fn();
    }
    clock = until;
  };
  return { ...pageUpdater(env), state, advance };
}

test("the page announced as its own version does nothing", () => {
  const page = fake();
  page.announce("one");
  assert.equal(page.state.reloads, 0);
  assert.equal(page.state.banner, null);
});

test("another version reloads the page at once, and only once", () => {
  const page = fake();
  page.announce("two");
  assert.equal(page.state.reloads, 1);
  assert.equal(page.state.last?.version, "two", "the next page learns which version this reload was for");
  page.announce("two"); page.announce("three");
  assert.equal(page.state.reloads, 1, "once the reload has begun, nothing the page is told begins another");
});

test("a page that does not know its own version never reloads", () => {
  const page = fake("");
  page.announce("two");
  assert.equal(page.state.reloads, 0);
});

test("while the owner is writing the page shows the banner and waits, then reloads once the writing is done", () => {
  const page = fake();
  page.state.busy = true;
  page.announce("two");
  assert.equal(page.state.reloads, 0);
  assert.equal(page.state.banner, WAITING);
  page.advance(10 * RECHECK_MS);
  assert.equal(page.state.reloads, 0, "still writing");
  page.state.busy = false;
  page.advance(RECHECK_MS);
  assert.equal(page.state.reloads, 1);
});

test("a page that waited and was then announced as its own version again stays", () => {
  const page = fake();
  page.state.busy = true;
  page.announce("two");
  assert.equal(page.state.banner, WAITING);
  // The deploy went back: the page is on the current version after all.
  page.announce("one");
  assert.equal(page.state.banner, null);
  page.state.busy = false;
  page.advance(10 * RECHECK_MS);
  assert.equal(page.state.reloads, 0);
});

test("a waiting page looks again on a timer only once, however often it is told", () => {
  const page = fake();
  page.state.busy = true;
  page.announce("two"); page.announce("two"); page.announce("two");
  page.state.busy = false;
  page.advance(RECHECK_MS);
  assert.equal(page.state.reloads, 1);
});

test("a reload that left the page on another version is not repeated for a minute, then tried again", () => {
  const page = fake();
  // The page after a reload toward "two": it was served as "one" still, and is told "two" again.
  page.state.last = { version: "two", at: 1_000_000 - 1000 };
  page.announce("two");
  assert.equal(page.state.reloads, 0);
  assert.equal(page.state.banner, STUCK);
  page.advance(RELOAD_AGAIN_MS);
  page.announce("two");
  assert.equal(page.state.reloads, 1);
});

test("a reload toward another version than the last one is not held back by the last", () => {
  const page = fake();
  page.state.last = { version: "two", at: 1_000_000 - 1000 };
  page.announce("three");
  assert.equal(page.state.reloads, 1);
});
