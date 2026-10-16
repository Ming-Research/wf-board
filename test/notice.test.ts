import { test } from "node:test";
import assert from "node:assert/strict";
import { noticeTag, showNotice } from "../web/notice.ts";
import type { NoticeEnv, OwnerNotice } from "../web/notice.ts";

/** A page with a Notification constructor that records what it was asked to show. */
function page(permission: string) {
  const shown: Array<{ title: string; body: string; tag: string; closed: boolean; instance: { onclick: (() => void) | null; close(): void } }> = [];
  const opened: unknown[] = [];
  let focused = 0;
  class Notification {
    static permission = permission;
    onclick: (() => void) | null = null;
    closed = false;
    constructor(title: string, options: { body: string; tag: string }) {
      const record = { title, body: options.body, tag: options.tag, closed: false, instance: this as unknown as { onclick: (() => void) | null; close(): void } };
      shown.push(record);
      this.close = () => { this.closed = true; record.closed = true; };
    }
    close(): void { this.closed = true; }
  }
  const env: NoticeEnv = {
    Notification: Notification as unknown as NoticeEnv["Notification"],
    focus: () => { focused++; },
    open: target => { opened.push(target); },
  };
  return { env, shown, opened, focused: () => focused };
}

const card: OwnerNotice = { title: "挡事的卡 · Whitefoot", message: "选哪个？（挡住：chrome-notify）", target: { kind: "card", key: "choice" } };

test("a notice is shown only when the owner allowed notices", () => {
  for (const permission of ["default", "denied"]) {
    const { env, shown } = page(permission);
    assert.equal(showNotice(card, env), undefined, `permission ${permission} shows nothing`);
    assert.equal(shown.length, 0);
  }
  const { env, shown } = page("granted");
  assert.ok(showNotice(card, env));
  assert.equal(shown.length, 1);
});

test("a page without the Notification API shows nothing and does not fail", () => {
  assert.equal(showNotice(card, { focus() {}, open() {} }), undefined);
});

test("the notice carries its title and message, and its tag is the card's key", () => {
  const { env, shown } = page("granted");
  showNotice(card, env);
  assert.deepEqual(shown[0], { title: card.title, body: card.message, tag: "card:choice", closed: false, instance: shown[0]!.instance });
});

test("the same card or item gets the same tag in every open page, so the browser keeps one notice for it", () => {
  // Two tabs each show the notice; the browser replaces a notice that has the same tag, so only one stays visible.
  assert.equal(noticeTag(card), noticeTag({ ...card, title: "另一个标题", message: "另一句" }));
  assert.notEqual(noticeTag(card), noticeTag({ ...card, target: { kind: "card", key: "other" } }));
  assert.notEqual(noticeTag(card), noticeTag({ ...card, target: { kind: "item", key: "choice" } }));
});

test("a notice with no card or item is tagged with its title", () => {
  assert.equal(noticeTag({ title: "架构师一小时没响应", message: "x" }), "架构师一小时没响应");
});

test("clicking a notice closes it, focuses the page and opens its card or item", () => {
  const { env, shown, opened, focused } = page("granted");
  showNotice(card, env);
  shown[0]!.instance.onclick!();
  assert.equal(shown[0]!.closed, true);
  assert.equal(focused(), 1);
  assert.deepEqual(opened, [{ kind: "card", key: "choice" }]);
  const item: OwnerNotice = { title: "架构师一小时没响应", message: "x", target: { kind: "item", key: "a" } };
  showNotice(item, env);
  shown[1]!.instance.onclick!();
  assert.deepEqual(opened[1], { kind: "item", key: "a" });
});

test("a notice with no target opens nothing when clicked", () => {
  const { env, shown, opened, focused } = page("granted");
  showNotice({ title: "t", message: "m" }, env);
  shown[0]!.instance.onclick!();
  assert.equal(focused(), 1);
  assert.deepEqual(opened, []);
});
