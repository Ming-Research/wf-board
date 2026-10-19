// A head changed in parts, by the function `editHead` that locates the edits, checks them and shows them (docs/design.md,
// section 6, Changing things). How `update_item` writes them is test/head-edit-write.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AROUND, HeadEditError, MAX_CHANGES, editHead } from "../src/head-edit.ts";
import { splitHead } from "../src/head-sections.ts";

const HEAD = [
  "背景一句。",
  "",
  "**问题**：甲很长。乙也很长。",
  "",
  "**为什么**：因为丙。",
  "",
  "**做法**：",
  "- 先做 X。",
  "- 再做 Y。",
  "",
  "## 改动",
  "",
  "文件 a.ts 改了 foo。",
  "",
].join("\n");

const refused = (head: string, edits: Parameters<typeof editHead>[1], message: RegExp) =>
  assert.throws(() => editHead(head, edits), (error: unknown) => error instanceof HeadEditError && message.test(error.message), String(message));

test("a section is replaced from its title line to the next section's, and every other section stays as it was", () => {
  const { head, shown } = editHead(HEAD, { sections: [{ title: "为什么", text: "**为什么**：因为新的丁。" }] });
  assert.equal(head, HEAD.replace("**为什么**：因为丙。", "**为什么**：因为新的丁。"));
  // The blank line that ended the old section ends the new one, whether or not the new text carries it.
  assert.equal(editHead(HEAD, { sections: [{ title: "为什么", text: "**为什么**：因为新的丁。\n\n\n" }] }).head, head);
  assert.match(shown, /^head changed in 1 place; /);
  assert.match(shown, /^sections\[0\] "为什么" · line 5$/m);
  assert.match(shown, /^ {2}- \*\*为什么\*\*：因为丙。$/m); assert.match(shown, /^ {2}\+ \*\*为什么\*\*：因为新的丁。$/m);
  // The sections of the new head are the old ones but for that one.
  const titles = (text: string) => splitHead(text).map(s => s.title), texts = (text: string) => splitHead(text).map(s => s.text);
  assert.deepEqual(titles(head), titles(HEAD));
  assert.deepEqual(texts(head).filter((text, i) => text !== texts(HEAD)[i]), ["**为什么**：因为新的丁。\n\n"]);
});

test("the last section and the text before the first title are replaced the same way", () => {
  const last = editHead(HEAD, { sections: [{ title: "改动", text: "## 改动\n\n文件 b.ts 改了 bar。" }] }).head;
  assert.equal(last, HEAD.replace("文件 a.ts 改了 foo。", "文件 b.ts 改了 bar。"), "the head's own final line end stays");
  const first = editHead(HEAD, { sections: [{ title: "开头", text: "新的背景。" }] }).head;
  assert.equal(first, HEAD.replace("背景一句。", "新的背景。"));
  // A section is also replaced by a new text of many lines.
  const long = editHead(HEAD, { sections: [{ title: "做法", text: "**做法**：\n- 一\n- 二\n- 三\n- 四" }] });
  assert.ok(long.head.includes("- 四\n\n## 改动"));
});

test("a section that is not one section of the head, or whose new text is not exactly that section, is refused with the reason", () => {
  refused(HEAD, { sections: [{ title: "没有这一节", text: "**没有这一节**：x" }] }, /^sections\[0\]\.title: no section is titled "没有这一节"; this head has "开头", "问题", "为什么", "做法", "改动"$/);
  refused("**问题**：a\n\n**问题**：b\n", { sections: [{ title: "问题", text: "**问题**：c" }] }, /^sections\[0\]\.title: 2 sections are titled "问题"; change them with replace/);
  // The new text lacks its title line, carries a second section, or is another section's.
  refused(HEAD, { sections: [{ title: "为什么", text: "因为新的丁。" }] }, /^sections\[0\]\.text: must be the one section "为什么".*it holds "开头"$/);
  refused(HEAD, { sections: [{ title: "为什么", text: "**为什么**：丁。\n\n**做法**：戊。" }] }, /^sections\[0\]\.text: .*it holds "为什么", "做法"$/);
  refused(HEAD, { sections: [{ title: "为什么", text: "**做法**：丁。" }] }, /^sections\[0\]\.text: .*it holds "做法"$/);
  // A head with no text before its first title has no section 开头 to replace, and one with no text has no section at all.
  refused("**问题**：a\n", { sections: [{ title: "开头", text: "前言" }] }, /^sections\[0\]\.title: no section is titled "开头"; this head has "问题"$/);
  refused("", { sections: [{ title: "问题", text: "**问题**：a" }] }, /this head has no text/);
});

test("texts are replaced where they stand, found in the head as it was: the order they are given in changes nothing", () => {
  const pairs = [{ old: "乙也很长", new: "乙改了" }, { old: "因为丙", new: "因为戊" }];
  const forward = editHead(HEAD, { replace: pairs }), backward = editHead(HEAD, { replace: [...pairs].reverse() });
  assert.equal(forward.head, HEAD.replace("乙也很长", "乙改了").replace("因为丙", "因为戊"));
  assert.equal(backward.head, forward.head);
  // Two texts that swap are both found in the old head: a second pass over the first one's result would make `b b`.
  assert.equal(editHead("a b", { replace: [{ old: "a", new: "b" }, { old: "b", new: "a" }] }).head, "b a");
  // The text may span lines, and may be deleted by an empty new text.
  assert.equal(editHead(HEAD, { replace: [{ old: "- 先做 X。\n- 再做 Y。", new: "- 只做 Z。" }] }).head, HEAD.replace("- 先做 X。\n- 再做 Y。", "- 只做 Z。"));
  assert.equal(editHead(HEAD, { replace: [{ old: "乙也很长。", new: "" }] }).head, HEAD.replace("乙也很长。", ""));
  // Sections and texts in one call, each in a part of its own.
  const both = editHead(HEAD, { sections: [{ title: "做法", text: "**做法**：新" }], replace: [{ old: "因为丙", new: "因为戊" }] });
  assert.equal(both.head, HEAD.replace("因为丙", "因为戊").replace("**做法**：\n- 先做 X。\n- 再做 Y。", "**做法**：新"));
  assert.match(both.shown, /^head changed in 2 places; /);
});

test("a text found other than once refuses the whole call, naming which one and how many times", () => {
  refused(HEAD, { replace: [{ old: "因为丙", new: "x" }, { old: "不在正文里", new: "y" }] }, /^replace\[1\]\.old: "不在正文里" occurs 0 times in the head; copy it exactly from context/);
  refused(HEAD, { replace: [{ old: "因为丙", new: "x" }, { old: "。", new: "y" }] }, /^replace\[1\]\.old: "。" occurs 7 times in the head \(lines 1, 3, 3, 5, 8, …\); add words around it so that it occurs exactly once$/);
  // Places that overlap each other count as separate places.
  refused("aaa", { replace: [{ old: "aa", new: "b" }] }, /occurs 2 times in the head \(lines 1, 1\)/);
});

test("a blank old text, an empty list and a call that would leave the head blank are refused", () => {
  for (const old of ["   ", " ", "\n\n"]) refused(HEAD, { replace: [{ old, new: "x" }] }, /^replace\[0\]\.old: give text that is not blank$/);
  refused(HEAD, { replace: [] }, /^replace: give at least one pair/);
  refused(HEAD, { sections: [] }, /^sections: give at least one section/);
  refused("短", { replace: [{ old: "短", new: " " }] }, /would leave the head blank/);
});

test("edits that change the same text are refused, whatever order they are given in", () => {
  refused(HEAD, { replace: [{ old: "甲很长。乙也很长", new: "x" }, { old: "乙也很长。", new: "y" }] }, /^replace\[0\] and replace\[1\] change the same text \(line 3\)/);
  refused(HEAD, { replace: [{ old: "乙也很长。", new: "y" }, { old: "甲很长。乙也很长", new: "x" }] }, /^replace\[1\] and replace\[0\] change the same text \(line 3\)/);
  // A text inside a section that is replaced, and a section replaced twice.
  refused(HEAD, { sections: [{ title: "为什么", text: "**为什么**：x" }], replace: [{ old: "因为丙", new: "y" }] }, /^sections\[0\] "为什么" and replace\[0\] change the same text/);
  refused(HEAD, { sections: [{ title: "为什么", text: "**为什么**：x" }, { title: "为什么", text: "**为什么**：y" }] }, /^sections\[0\] "为什么" and sections\[1\] "为什么" change the same text/);
  // Texts next to each other do not overlap.
  assert.equal(editHead("ab", { replace: [{ old: "a", new: "1" }, { old: "b", new: "2" }] }).head, "12");
});

test("the answer shows the lines before and after each change, in head order", () => {
  const { shown } = editHead(HEAD, { replace: [{ old: "因为丙", new: "因为戊" }, { old: "乙也很长", new: "乙改了" }] });
  assert.equal(shown, [
    "head changed in 2 places; lines are numbered as in the head before this write:",
    "replace[1] in 问题 · line 3", "  - **问题**：甲很长。乙也很长。", "  + **问题**：甲很长。乙改了。",
    "replace[0] in 为什么 · line 5", "  - **为什么**：因为丙。", "  + **为什么**：因为戊。",
  ].join("\n"));
  // A deleted line has nothing to show after it; a deleted part of a line shows what is left of the line.
  assert.match(editHead(HEAD, { replace: [{ old: "文件 a.ts 改了 foo。\n", new: "" }] }).shown, /^ {2}\+ \(deleted\)$/m);
  assert.match(editHead(HEAD, { replace: [{ old: "乙也很长。", new: "" }] }).shown, /^ {2}\+ \*\*问题\*\*：甲很长。$/m);
});

test("a long line is shown around the change, a change of many lines by its first lines, and no character is cut in half", () => {
  const line = `${"前".repeat(300)}目标${"后".repeat(300)}`;
  const long = editHead(`**问题**：\n${line}\n`, { replace: [{ old: "目标", new: "新目标" }] }).shown;
  assert.ok(long.includes(`  - …${"前".repeat(AROUND)}目标${"后".repeat(AROUND)}…`), long);
  assert.ok(long.includes(`  + …${"前".repeat(AROUND)}新目标${"后".repeat(AROUND)}…`), long);
  assert.ok(long.length < 600, `${long.length} characters for a line of 602`);
  // The section's title line and two more lines of each side, then how many lines were left out.
  const many = editHead("**甲**：\n1\n2\n3\n4\n5\n", { sections: [{ title: "甲", text: "**甲**：\n一\n二\n三\n四\n五\n六" }] }).shown;
  assert.equal(many, [
    "head changed in 1 place; lines are numbered as in the head before this write:",
    'sections[0] "甲" · line 1–6', "  - **甲**：", "  - 1", "  - 2", "  - … 3 more lines", "  + **甲**：", "  + 一", "  + 二", "  + … 4 more lines",
  ].join("\n"));
  // A cut that would fall inside a pair of code units moves out of it; a lone half would not survive being sent.
  const emoji = `${"😀".repeat(100)}aX${"😀".repeat(100)}`;
  const shown = editHead(`**问题**：\n${emoji}\n`, { replace: [{ old: "X", new: "Y" }] }).shown;
  assert.doesNotThrow(() => encodeURIComponent(shown));
  assert.match(shown, /aY/); assert.match(shown, /aX/);
});

test("an edit that changes nothing is said to change nothing, and the answer lists at most MAX_CHANGES changes", () => {
  assert.equal(editHead(HEAD, { replace: [{ old: "因为丙", new: "因为丙" }] }).shown, "head unchanged: every edit left the text as it was");
  const count = MAX_CHANGES + 5, line = (i: number) => `行 ${String(i).padStart(3, "0")}`;
  const answer = editHead(Array.from({ length: count }, (_, i) => line(i)).join("\n"), { replace: Array.from({ length: count }, (_, i) => ({ old: line(i), new: `改 ${i}` })) });
  assert.match(answer.shown, new RegExp(`^head changed in ${count} places \\(the first ${MAX_CHANGES} shown\\); `));
  assert.equal(answer.shown.split("\n").filter(text => text.startsWith("replace[")).length, MAX_CHANGES);
  assert.equal(answer.head, Array.from({ length: count }, (_, i) => `改 ${i}`).join("\n"), "all of them are made");
});

// A line that opens or closes a fenced block changes what the text below it is: `splitHead` reads a title inside a block as code.
const BLOCK = ["**问题**：甲。", "", "**做法**：", "```wf", "let x = 1", "```", "", "**改动**：", "文件 a.ts。", ""].join("\n");
const titles = (text: string) => splitHead(text).map(s => s.title);

test("an edit may not leave a fenced block open or closed that it did not open or close, since the sections below would turn into code or out of it", () => {
  // A new section that opens a block it does not close is one section alone, but it swallows every title below it.
  refused(BLOCK, { sections: [{ title: "问题", text: "**问题**：\n```\ncode" }] }, /^sections\[0\]\.text: it opens a fenced block \(a line starting with ``` or ~~~\) that it does not close, so the text after it would be code; give every fence line together with its partner in the same edit$/);
  refused(BLOCK, { replace: [{ old: "甲。", new: "甲。\n~~~\ncode" }] }, /^replace\[0\]\.new: it opens a fenced block/);
  // Taking away the line that closes a block opens it to the end, and a fence line in the middle of a block closes it.
  refused(BLOCK, { replace: [{ old: "let x = 1\n```\n", new: "let x = 1\n" }] }, /^replace\[0\]\.new: it opens a fenced block/);
  refused(BLOCK, { replace: [{ old: "let x = 1", new: "let x = 1\n```" }] }, /^replace\[0\]\.new: it closes a fenced block that it did not open, so the text after it would stop being code/);
  // The edit that is named is the first of the call that breaks the fences.
  refused(BLOCK, { replace: [{ old: "文件 a.ts。", new: "文件 b.ts。" }, { old: "甲。", new: "甲。\n```" }] }, /^replace\[1\]\.new: it opens a fenced block/);
  // Whole blocks, and fence lines changed where they stand, keep the fences as they were.
  const kept = editHead(BLOCK, { sections: [{ title: "做法", text: "**做法**：\n```wf\nlet y = 2\n```" }], replace: [{ old: "甲。", new: "甲。\n\n```\nnew\n```" }] }).head;
  assert.deepEqual(titles(kept), titles(BLOCK));
  assert.ok(kept.includes("let y = 2") && kept.includes("```\nnew\n```"));
  const added = editHead(BLOCK, { replace: [{ old: "```wf", new: "```wf2" }, { old: "let x = 1\n```\n\n", new: "let x = 1\n```\n\n**新的一节**：\n\n" }] }).head;
  assert.deepEqual(titles(added), ["问题", "做法", "新的一节", "改动"], "a section added after a sentence has its title found");
  // A title written inside a block stays code.
  assert.deepEqual(titles(editHead(BLOCK, { replace: [{ old: "let x = 1", new: "**不是标题**：\nlet x = 1" }] }).head), titles(BLOCK));
  // A head that already ends inside a block is not made worse by an edit that leaves it so.
  assert.equal(editHead("**甲**：\n```\n没闭合", { replace: [{ old: "没闭合", new: "仍没闭合" }] }).head, "**甲**：\n```\n仍没闭合");
});

test("a new text that holds the line of a cut answer is refused in the words of its edit, pointing to the section to read", () => {
  const mark = '  … 12 more characters (section "问题")';
  refused(HEAD, { sections: [{ title: "问题", text: `**问题**：x\n${mark}` }] }, /^sections\[0\]\.text: it holds the line "… 12 more characters \(section "问题"\)", which context writes where it cut a section short, so it was copied from a cut answer; get the section whole with context section: "问题" and change that$/);
  refused(HEAD, { replace: [{ old: "因为丙", new: "y" }, { old: "因为丙", new: mark }] }, /^replace\[1\]\.new: it holds the line "… 12 more characters \(section "问题"\)".*context section: "<title>" and copy the text from that$/);
  // Neither message sends the writer back to reading the whole head.
  for (const edits of [{ sections: [{ title: "问题", text: mark }] }, { replace: [{ old: "因为丙", new: mark }] }]) {
    assert.throws(() => editHead(HEAD, edits), (error: unknown) => error instanceof HeadEditError && !/"all"|whole head|write it back/.test(error.message));
  }
});

test("a long run of white space in a new section or an old one is cut off in linear time", () => {
  // `/\s+$/` and `/\s*$/` are quadratic on a run followed by a letter (measured: four times as long for twice the run).
  const run = " ".repeat(300_000);
  const start = performance.now();
  const edited = editHead(`**问题**：甲${run}乙\n\n**做法**：丙\n`, { sections: [{ title: "问题", text: `**问题**：丁${run}戊\n` }] }).head;
  assert.equal(edited, `**问题**：丁${run}戊\n\n**做法**：丙\n`);
  assert.ok(performance.now() - start < 2000, `${performance.now() - start} ms`);
});

test("a # heading's title is found as the pattern it replaced found it, and a long run of white space in it costs linear time", () => {
  // The pattern `splitHead` used for these lines, kept here as the oracle; it is quadratic on a long run of white space.
  const before = /^#{1,6}\s+(.+?)\s*$/;
  const lines = ["# 甲", "## 甲 乙 ", "###### 甲", "####### 甲", "#", "# ", "#  ", "#\t\t", "# \r", "#  \r", "# \r ", "# a\rb", "# a\r", "# a\u2028", "# a\u2028b", "#甲", "##\t甲\t", "#　甲　", "# 甲  乙", "#   ", "# \u2028\u2028", "#  \u2028x"];
  for (const line of lines) {
    // After a line of text, a line that is a title starts a section of its own, whatever its title says, and one that is none does not.
    const expected = before.exec(line)?.[1]?.trim();
    const sections = splitHead(`前言\n${line}`);
    assert.deepEqual(sections.length === 2 ? sections[1]!.title : undefined, expected, JSON.stringify(line));
  }
  const run = " ".repeat(300_000), start = performance.now();
  assert.deepEqual(splitHead(`前言\n## 甲${run}乙\n`).map(s => s.title), ["", `甲${run}乙`]);
  assert.ok(performance.now() - start < 2000, `${performance.now() - start} ms`);
});
