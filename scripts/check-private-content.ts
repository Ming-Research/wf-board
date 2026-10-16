// Fails when a push or pull request adds private content to this public repository (rules: private-content-rules.ts).
// It looks only at what the change adds: the added lines and the added or changed paths of the diff, the messages of
// the commits in the range and, for a pull request, its title and body. It never prints the text it matched, only the
// rule and where: the CI log of a public repository is public too.
//
// Usage: node scripts/check-private-content.ts [<base> [<head>]]
//   Checks <base>...<head> (default head: HEAD). Given a <base>, the event is ignored; without one it reads the CI event file (GITHUB_EVENT_PATH): for a
//   pull request the base and head commits, title and body; for a push the commit before it. The event file is read
//   rather than passed in environment variables, because the runner prints a step's variables in its public log, and
//   a pull request body that holds a private value would be printed a second time. A base that is missing, all zeros
//   or not in this clone means the whole of <head> is checked, so running it with no arguments checks the whole tree.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkPath, checkText, addedLines, checkLine, ALLOW_MARKER, type Finding } from "./private-content-rules.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const run = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
const exists = (cwd: string, rev: string): boolean => { try { run(cwd, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`); return true; } catch { return false; } };

// Every finding of the change from `base` to `head`; `base` null means the whole of `head`.
export function checkRange(base: string | null, head: string, pr?: { title?: string; body?: string }, cwd = process.cwd()): Finding[] {
  const git = (...args: string[]) => run(cwd, ...args);
  const findings: Finding[] = [];
  const diffArgs = ["--no-renames", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
  const range = base === null ? [EMPTY_TREE, head] : [`${base}...${head}`];

  for (const path of git("diff", ...diffArgs, "--name-only", "--diff-filter=AM", ...range).split("\n").filter(Boolean)) {
    for (const rule of checkPath(path)) findings.push({ where: path, line: null, rule });
  }
  for (const { path, line, text } of addedLines(git("diff", ...diffArgs, "--unified=0", ...range))) {
    for (const rule of checkLine(text)) findings.push({ where: path, line, rule });
  }

  const log = git("log", "--format=%H%x00%B%x01", base === null ? head : `${base}..${head}`);
  for (const entry of log.split("\x01").map(part => part.trim()).filter(Boolean)) {
    const [sha = "", message = ""] = entry.split("\x00");
    findings.push(...checkText(`commit ${sha.slice(0, 10)}`, message));
  }
  if (pr?.title) findings.push(...checkText("pull request title", pr.title));
  if (pr?.body) findings.push(...checkText("pull request body", pr.body));
  return findings;
}

interface EventFacts { base?: string; head?: string; title?: string; body?: string }

// What the CI event says about the change: a pull request's commits, title and body, or a push's previous head.
function readEvent(path: string | undefined): EventFacts {
  if (!path) return {};
  const event = JSON.parse(readFileSync(path, "utf8")) as { before?: string; pull_request?: { base: { sha: string }; head: { sha: string }; title: string; body: string | null } };
  const pr = event.pull_request;
  return pr ? { base: pr.base.sha, head: pr.head.sha, title: pr.title, body: pr.body ?? "" } : { base: event.before };
}

function main(): number {
  const [baseArg, headArg] = process.argv.slice(2);
  const event = baseArg ? {} : readEvent(process.env.GITHUB_EVENT_PATH);
  const head = headArg ?? event.head ?? "HEAD";
  const candidate = baseArg ?? event.base;
  const base = candidate && !/^0+$/.test(candidate) && exists(process.cwd(), candidate) ? candidate : null;
  if (candidate && base === null) console.log(`base ${candidate.slice(0, 10)} is not in this clone: checking all of ${head}`);

  const findings = checkRange(base, head, { title: event.title, body: event.body });
  for (const { where, line, rule } of findings) console.log(`${rule}: ${where}${line === null ? "" : `:${line}`}`);
  if (findings.length === 0) { console.log("no private content added"); return 0; }
  console.log(`\n${findings.length} finding(s). Remove the value, or, for a fixture that must hold it, put "${ALLOW_MARKER}" on the line.`);
  return 1;
}

if (import.meta.main) process.exitCode = main();
