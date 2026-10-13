import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightCode, codeBlock, fenceLang } from "../web/highlight.ts";

const text = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

test("wf: comments, keywords, numbers, strings and type names are tokens", () => {
  const html = highlightCode('fn Main(x: u64) { let y = 7_u64; // note\n  "s" }', "wf", false);
  assert.match(html, /<span class="tk-k">fn<\/span>/);
  assert.match(html, /<span class="tk-t">Main<\/span>/);
  assert.match(html, /<span class="tk-t">u64<\/span>/);
  assert.match(html, /<span class="tk-k">let<\/span>/);
  assert.match(html, /<span class="tk-n">7_u64<\/span>/);
  assert.match(html, /<span class="tk-c">\/\/ note<\/span>/);
  assert.match(html, /<span class="tk-s">&quot;s&quot;<\/span>/);
  assert.ok(!html.includes('tk-k">x<'),"an ordinary identifier is plain");
});

test("escaping: <, & and quotes are escaped inside and outside tokens", () => {
  const html = highlightCode('a < b && "x<&y" // <i>&', "whitefoot", false);
  assert.ok(!/<(?!\/?span)/.test(html),"no raw tag from the source");
  assert.ok(html.includes("&lt;") && html.includes("&amp;&amp;") && html.includes("&quot;x&lt;&amp;y&quot;"));
});

test("text content round-trips for every language and numbering", () => {
  const src = 'fn f() {\n\n  let s = "a\\"b"; // c <&>\n  \'q\' 1..5 Tt\n}';
  for (const info of ["wf", "rust", "sh", "", "unknown"]) for (const numbered of [false, true]) {
    assert.equal(text(highlightCode(src, info, numbered)), src, info);
  }
});

test("unlabeled fence is plain", () => {
  const html = highlightCode("fn x // 1 \"s\" Type", "", false);
  assert.equal(html, "fn x // 1 &quot;s&quot; Type");
});

test("another language gets comments, strings and numbers only", () => {
  const html = highlightCode('fn Main() { let n = 3; } // c\n# not a comment in rust', "rust", false);
  assert.ok(!html.includes("tk-k") && !html.includes("tk-t"));
  assert.match(html, /<span class="tk-n">3<\/span>/);
  assert.match(html, /<span class="tk-c">\/\/ c<\/span>/);
  assert.ok(!html.includes('tk-c">#'));
  assert.match(highlightCode("# c\nx", "sh", false), /<span class="tk-c"># c<\/span>/);
  assert.match(highlightCode("local x = 1 -- c", "lua", false), /<span class="tk-c">-- c<\/span>/);
  assert.match(highlightCode('; c\n"probe-stack"="inline-asm"', "llvm", false), /<span class="tk-c">; c<\/span>/);
});

test("codeBlock numbers from 3 lines, counting blank lines, and not below", () => {
  const three = codeBlock(["a", "", "// c"], "wf");
  assert.ok(three.startsWith('<pre class="code numbered">'));
  assert.equal(three.match(/<span class="l">/g)!.length, 3);
  assert.ok(!codeBlock(["a", "b"], "wf").includes('class="l"'));
  assert.ok(!codeBlock(["a"], "").includes("numbered"));
});

test("fenceLang reads the first word of the info string", () => {
  assert.equal(fenceLang("WF title"), "wf");
  assert.equal(fenceLang(""), "");
});
