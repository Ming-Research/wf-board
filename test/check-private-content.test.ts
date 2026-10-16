// The private-content check (scripts/check-private-content.ts). Each rule has a line it must flag and a line it must
// let through. Every planted value is put together from pieces, so that this file passes the check it tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addedLines, checkLine, checkPath, checkText } from "../scripts/private-content-rules.ts";
import { checkRange } from "../scripts/check-private-content.ts";

const dot = (...parts: (string | number)[]) => parts.join(".");

const LINE_CASES: { rule: string; hit: string[]; allowed: string[] }[] = [
  { rule: "private-ipv4",
    hit: [`ssh ${dot(192, 168, 1, 20)}`, `host: ${dot(10, 0, 3, 7)}`, `${dot(172, 16, 0, 9)}:7417`, `${dot(172, 31, 255, 1)}`],
    allowed: [dot(127, 0, 0, 1), dot(8, 8, 8, 8), dot(172, 32, 0, 1), dot(192, 169, 1, 1), "version 10.1.2", "node >=24"] },
  { rule: "home-directory",
    hit: ["cd /Users/" + "alice/dev", "path=/home/" + "bob/.config", "C:\\Users\\" + "carol\\dev"],
    allowed: ["/home/runner/work", "/Users/Shared/x", "https://example.com/home/page/x", "src/home/widgets/a.ts", "/Users/user/dev", "~/dev/wf/AGENTS.md", "see /Users/<name>/dev"] },
  { rule: "ssh-key-file",
    hit: ["IdentityFile ~/." + "ssh/key", "ssh -i id_" + "ed25519 host", "Identities" + "Only yes"],
    allowed: ["sshd_config", "run ssh-keygen", "ssh host"] },
  { rule: "key-file-path",
    hit: ["read ~/" + "secrets/api-key.txt", "~/.config/vendor/" + "token.json", "~/" + "creds/db_password.env"],
    allowed: ["~/dev/wf/AGENTS.md", "~/notes/todo.txt", "keys.txt"] },
  { rule: "private-key-block",
    hit: ["-----BEGIN " + "RSA PRIVATE KEY-----", "-----BEGIN " + "PRIVATE KEY-----"],
    allowed: ["-----BEGIN CERTIFICATE-----", "a PRIVATE KEY is secret"] },
  { rule: "token",
    hit: ["ghp_" + "a".repeat(30), "github_pat_" + "A1".repeat(15), "sk-" + "x".repeat(24), "AKIA" + "B".repeat(16),
      "xoxb-" + "1234567890-abc", "Authorization: Bearer " + "t".repeat(30)],
    allowed: ["ghp_short", "sk-learn", "Bearer token", "risk-assessment-for-the-board-process", "task-queue-name-with-long-words-here"] },
  { rule: "secret-literal",
    hit: [`password = "${"hunter2".repeat(2)}"`, `apiKey: '${"abcd1234".repeat(2)}'`, `"access_token": "${"z9".repeat(8)}"`],
    allowed: ["const password = process.env.PW", "secret: string", `password: "short"`, "password = ''"] },
  { rule: "old-board-page",
    hit: ["https://claude.ai/" + "artifact/abc123"],
    allowed: ["independent of any claude.ai account", "https://claude.ai/code"] },
];

for (const { rule, hit, allowed } of LINE_CASES) {
  test(`line rule ${rule} flags what it names and lets other text through`, () => {
    for (const line of hit) assert.ok(checkLine(line).includes(rule), `${rule} should flag a ${line.length}-character line: ${JSON.stringify(checkLine(line))}`);
    for (const line of allowed) assert.ok(!checkLine(line).includes(rule), `${rule} should let through: ${line}`);
  });
}

test("a line with the allow marker is skipped by every rule", () => {
  const line = `host ${dot(192, 168, 1, 20)}`;
  assert.deepEqual(checkLine(line), ["private-ipv4"]);
  assert.deepEqual(checkLine(`${line} // private-content: allow`), []);
});

const PATH_CASES: { rule: string; hit: string[]; allowed: string[] }[] = [
  { rule: "scratch-directory", hit: ["scratch/notes.md", "a/b/.scratch/x", ".scratch/y"], allowed: ["scratchpad/x", "docs/scratch-notes.md", "src/scratch.ts"] },
  { rule: "backup-file", hit: ["src/old.bak", "a.ts.bak"], allowed: ["src/bakery.ts", "backup.md"] },
  { rule: "env-file", hit: [".env", "app/.env.local", ".env.production"], allowed: [".env.example", "app/.env.sample", ".env.template", ".envrc", "src/environment.ts"] },
];

for (const { rule, hit, allowed } of PATH_CASES) {
  test(`path rule ${rule} flags what it names and lets other paths through`, () => {
    for (const path of hit) assert.ok(checkPath(path).includes(rule), `${rule} should flag ${path}`);
    for (const path of allowed) assert.ok(!checkPath(path).includes(rule), `${rule} should let through ${path}`);
  });
}

test("checkText reports the rule and the line number, not the text", () => {
  const ip = dot(10, 9, 8, 7);
  const findings = checkText("commit abc", `Fix the thing\n\nRuns on ${ip}\nand on ${dot(192, 168, 0, 1)}`);
  assert.deepEqual(findings, [
    { where: "commit abc", line: 3, rule: "private-ipv4" },
    { where: "commit abc", line: 4, rule: "private-ipv4" },
  ]);
  assert.ok(!JSON.stringify(findings).includes(ip));
});

test("addedLines gives each added line its number in the new file and skips removed, context and header lines", () => {
  const diff = [
    "diff --git a/one.txt b/one.txt",
    "--- a/one.txt",
    "+++ b/one.txt",
    "@@ -2,2 +2,3 @@",
    "-old two",
    "+new two",
    "+++ looks like a header but is added text",
    " context",
    "@@ -10 +11 @@",
    "+eleven",
    "diff --git a/gone.txt b/gone.txt",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-removed file",
    "diff --git a/new/dir/two.txt b/new/dir/two.txt",
    "--- /dev/null",
    "+++ b/new/dir/two.txt",
    "@@ -0,0 +1 @@",
    "+first",
  ].join("\n");
  assert.deepEqual(addedLines(diff), [
    { path: "one.txt", line: 2, text: "new two" },
    { path: "one.txt", line: 3, text: "++ looks like a header but is added text" },
    { path: "one.txt", line: 11, text: "eleven" },
    { path: "new/dir/two.txt", line: 1, text: "first" },
  ]);
});

// A throwaway repository: a clean base commit that already holds a planted value, then a branch that adds more.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "private-content-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env, encoding: "utf8" }).trim();
  const write = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  git("init", "-q", "-b", "main");
  return { dir, env, git, write };
}

test("checkRange inspects only what the range adds: lines, paths and commit messages", () => {
  const { dir, git, write } = repo();
  try {
    const old = dot(10, 1, 1, 1), added = dot(192, 168, 7, 7), tokenText = "ghp_" + "q".repeat(30);
    write("notes.txt", `already there: ${old}\nline two\n`);
    git("add", "-A"); git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");

    write("notes.txt", `already there: ${old}\nline two\nnew line ${added}\n`);
    write("scratch/plan.md", "clean text\n");
    write("src/clean.ts", "export const fine = 1;\n");
    git("add", "-A"); git("commit", "-q", "-m", "Add things", "-m", `token ${tokenText}`);
    const head = git("rev-parse", "HEAD");

    const findings = checkRange(base, head, { title: "Add things", body: `see ${dot(172, 20, 1, 1)}` }, dir);
    const sha = head.slice(0, 10);
    assert.deepEqual(findings.map(f => `${f.rule} ${f.where}${f.line === null ? "" : ":" + f.line}`).sort(), [
      "private-ipv4 notes.txt:3",
      "private-ipv4 pull request body:1",
      "scratch-directory scratch/plan.md",
      `token commit ${sha}:3`,
    ].sort());
    for (const secret of [added, old, tokenText]) assert.ok(!JSON.stringify(findings).includes(secret), "a finding must not carry the matched text");

    // Without a base the whole of head is checked: the value already in the base commit shows too.
    assert.ok(checkRange(null, head, undefined, dir).some(f => f.where === "notes.txt" && f.line === 1));
    // A range that adds nothing risky is clean, whatever the base already holds.
    assert.deepEqual(checkRange(head, head, undefined, dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the command exits 1 and prints rule and place only for a bad range, 0 for a clean one", () => {
  const { dir, env, git, write } = repo();
  try {
    const bad = dot(10, 4, 4, 4);
    write("a.txt", "clean\n");
    git("add", "-A"); git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    write("a.txt", `clean\nhost ${bad}\n`);
    git("add", "-A"); git("commit", "-q", "-m", "second");
    const head = git("rev-parse", "HEAD");

    const script = join(dirname(fileURLToPath(import.meta.url)), "../scripts/check-private-content.ts");
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: "utf8" });
    const failed = run(base, head);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stdout, /^private-ipv4: a\.txt:2$/m);
    assert.ok(!failed.stdout.includes(bad));
    const passed = run(head, head);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /no private content added/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
