// An item head's 参考 sections. A line starting 「**参考：」 opens one; it runs to the next such line or the end of the text.
// The page folds each section; its browser checks read the same title rule through isRefTitle.

/** Whether a line opens a 参考 section. */
export function isRefTitle(line: string): boolean { return /^\*\*参考：/.test(line); }

/** Splits lines into the text before the first section, then one array per section that starts with its title line. Fenced code is not split. */
export function refSplit(lines: string[]): string[][] {
  const out: string[][] = [[]]; let fenced = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && isRefTitle(line)) out.push([line]); else out[out.length - 1]!.push(line);
  }
  return out;
}
