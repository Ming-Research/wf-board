import { test } from "node:test";
import assert from "node:assert/strict";
import { findTargets, refQuery, refToken, refsIn, replaceRefs } from "../web/find.ts";

const targets = [
  { kind: "item" as const, key: "a", title: "Firn 跑限流脚本" },
  { kind: "card" as const, key: "q", title: "如何显示 Alpha？" },
  { kind: "item" as const, key: "b", title: "已完成的 alpha 条目" },
];

test("title matching is a case-insensitive substring, Chinese included, and keeps board order", () => {
  assert.deepEqual(findTargets(targets, "限流").map(t => t.key), ["a"]);
  assert.deepEqual(findTargets(targets, "ALPHA").map(t => t.key), ["q", "b"], "upper case finds lower case and the reverse");
  assert.deepEqual(findTargets(targets, "firn 跑").map(t => t.key), ["a"], "a Chinese title with a Latin word matches across both");
  assert.deepEqual(findTargets(targets, " 显示 ").map(t => t.key), ["q"], "surrounding spaces are not part of the query");
  assert.deepEqual(findTargets(targets, "没有").map(t => t.key), []);
});

test("an empty query matches every target, and a match is a substring, not a prefix or a word", () => {
  assert.deepEqual(findTargets(targets, "").map(t => t.key), ["a", "q", "b"]);
  assert.deepEqual(findTargets(targets, "   ").map(t => t.key), ["a", "q", "b"]);
  assert.deepEqual(findTargets(targets, "lph").map(t => t.key), ["q", "b"]);
});

test("a reference token names its kind, because an item and a card may share a key", () => {
  assert.equal(refToken("item", "gran-1"), "[[it:gran-1]]");
  assert.equal(refToken("card", "gran-1"), "[[q:gran-1]]");
});

test("references are replaced outside code spans only, and only well-formed tokens count", () => {
  const render = (kind: string, key: string) => `<${kind}:${key}>`;
  assert.equal(replaceRefs("见 [[it:a]] 和 [[q:b.c_d-1]]", render), "见 <item:a> 和 <card:b.c_d-1>");
  assert.equal(replaceRefs("<code>[[it:a]]</code> 但 [[it:a]]", render), "<code>[[it:a]]</code> 但 <item:a>", "a code span keeps the token as typed");
  for (const bad of ["[[a]]", "[[it:]]", "[[x:a]]", "[it:a]", "[[it:a]", "[[it: a]]", "[[it:-a]]"]) {
    assert.equal(replaceRefs(bad, render), bad, bad + " is not a reference");
  }
  assert.equal(replaceRefs("[x](https://example.com)", render), "[x](https://example.com)", "an ordinary link is left to the link markup");
});

test("references in a text are listed with their kind prefix", () => {
  assert.deepEqual(refsIn("a [[it:x]] b [[q:x]] c [[it:x]] [[it:]]"), ["it:x", "q:x", "it:x"]);
  assert.deepEqual(refsIn("no tokens [here]"), []);
});

test("# starts a reference query unless it is glued to a word before it", () => {
  assert.deepEqual(refQuery("见 #", 3), { start: 2, query: "" });
  assert.deepEqual(refQuery("见 #限流", 5), { start: 2, query: "限流" });
  assert.deepEqual(refQuery("#abc", 4), { start: 0, query: "abc" });
  assert.deepEqual(refQuery("见#条目", 4), { start: 1, query: "条目" }, "a Chinese character before # does not glue it");
  assert.equal(refQuery("Whitefoot#341", 13), null, "Repo#341 is a pull request reference, not a search");
  assert.equal(refQuery("a_b#c", 5), null);
  assert.equal(refQuery("no hash", 7), null);
  assert.equal(refQuery("#abc\n下一行", 7), null, "a line break ends the query");
  assert.equal(refQuery("#a #b", 5)?.start, 3, "the nearest # before the caret is the one that counts");
  assert.equal(refQuery("#abc", 0), null, "the caret before the # is not in a query");
});
