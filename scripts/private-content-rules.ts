// What counts as private content in this public repository, as plain functions. scripts/check-private-content.ts
// applies them in CI to what a push or pull request adds; test/check-private-content.test.ts holds a case per rule.
//
// The rules are general: they name kinds of thing (an address on a private network, a user's home directory, an SSH key
// file) and carry no real value of the owner's. Written as character classes where they would otherwise spell what they
// look for, so that this file passes its own check. A line that must hold such a value on purpose (a fixture) carries
// the marker below and is skipped; the marker shows in review.

export const ALLOW_MARKER = "private-content: allow";

export interface Rule { name: string; pattern: RegExp }
export interface Finding { where: string; line: number | null; rule: string }

// Home-directory names that are placeholders or belong to CI, not to a person. A directory only counts when the path
// starts there, so a URL or a source folder named home does not.
const PLACEHOLDER_HOMES = "runner|owner|user|username|example|me|Shared";
const NAME = "[A-Za-z0-9._-]";

export const CONTENT_RULES: readonly Rule[] = [
  // RFC 1918 (10/8, 172.16/12, 192.168/16) and 100.64/10, which carrier-grade NAT and Tailscale use.
  { name: "private-ipv4", pattern: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/ },
  { name: "home-directory", pattern: new RegExp(`(?<![\\w.~-])(?:/Users|/home)/(?!(?:${PLACEHOLDER_HOMES})(?!${NAME}))${NAME}+|[A-Za-z]:\\\\Users\\\\${NAME}+`) },
  { name: "ssh-key-file", pattern: /[.]ssh\/|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|Identities[O]nly/ },
  // A path under the home directory with a word for a secret in it (not inside a longer word: keyboard, monkey).
  { name: "key-file-path", pattern: /(?:~|\$HOME|\$\{HOME\})\/[\w./-]*(?<![a-z])(?:key|token|secret|credential|password)s?(?![a-z])/i },
  { name: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // An sk- key has hyphens and underscores inside and digits among its letters (sk-ant-api03-..., sk-proj-...).
  { name: "token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bBearer [A-Za-z0-9._-]{20,}/ },
  { name: "secret-literal", pattern: /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9/+_.-]{8,}["']/i },
  { name: "old-board-page", pattern: /claude\.ai\/artifact\/[A-Za-z0-9]/ },
];

// Paths that hold working material, wherever they sit in the tree.
export const PATH_RULES: readonly Rule[] = [
  { name: "scratch-directory", pattern: /(?:^|\/)\.?scratch(?:\/|$)/ },
  { name: "backup-file", pattern: /\.bak$/ },
  // An environment file, but not the template that documents its variables.
  { name: "env-file", pattern: /(?:^|\/)\.env(?:\.(?!(?:example|sample|template)$)[^/]*)?$/ },
];

// The rules that match one line of text. Several rules can match; a marked line matches none.
export function checkLine(line: string): string[] {
  if (line.includes(ALLOW_MARKER)) return [];
  return CONTENT_RULES.filter(rule => rule.pattern.test(line)).map(rule => rule.name);
}

export function checkPath(path: string): string[] {
  return PATH_RULES.filter(rule => rule.pattern.test(path)).map(rule => rule.name);
}

// A whole text (a commit message, a pull request's title or body), reported by line number.
export function checkText(where: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split("\n").forEach((line, index) => {
    for (const rule of checkLine(line)) findings.push({ where, line: index + 1, rule });
  });
  return findings;
}

// The added lines of `git diff --unified=0 --src-prefix=a/ --dst-prefix=b/`, with the line number each has in the new file.
export function addedLines(diff: string): { path: string; line: number; text: string }[] {
  const added: { path: string; line: number; text: string }[] = [];
  let path = "", next = 0, inHunk = false;
  for (const row of diff.split("\n")) {
    if (row.startsWith("diff --git ")) { path = ""; inHunk = false; continue; }
    if (!inHunk && row.startsWith("+++ ")) { path = row === "+++ /dev/null" ? "" : row.slice(6); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) { next = Number(hunk[1]); inHunk = true; continue; }
    if (inHunk && row.startsWith("+") && path) added.push({ path, line: next++, text: row.slice(1) });
  }
  return added;
}
