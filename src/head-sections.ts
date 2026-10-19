// An item's head split into the sections its text writes, so `context` can show each one's first paragraph and hand
// out one whole (docs/design.md, section 6, Lean replies). Nothing here changes the head: the sections laid end to end
// are the head, character for character.

export interface HeadSection {
  /** The title without its marks (`问题` for `**问题**：…`); empty for the text before the first title. */
  title: string;
  /** The title line and everything up to the next title line, line ends included. */
  text: string;
}

/** The title of the text before the first section title, in a reader's words. */
export const PREAMBLE = "开头";
/** The most characters of a section's first paragraph the default answer shows. */
export const LEAD_LIMIT = 400;
/** What a section must have left over, after its first paragraph, to be cut: less than this is shown, since the note costs about as much. */
export const MIN_OMIT = 100;

// A line that opens a section: a bold title that stands alone or goes on with a colon or a bracket, or a `#` heading.
const BOLD_TITLE = /^\*\*([^*\n]+)\*\*(?:\s*$|[：:（(])/;
const HASH_TITLE = /^#{1,6}\s+(.+?)\s*$/;
// A title line with no text of its own after the title: the section's text starts below it.
const BARE_TITLE = /^(?:#{1,6}\s+.*|\*\*[^*\n]+\*\*)\s*$/;
const FENCE = /^\s*(?:```|~~~)/;

const lines = (text: string): string[] => text.split(/(?<=\n)/);
const bare = (line: string): string => line.replace(/\r?\n$/, "");

export function splitHead(head: string): HeadSection[] {
  const sections: HeadSection[] = [];
  let fenced = false;
  for (const line of lines(head)) {
    const text = bare(line);
    // A title line inside a fenced block is code, not a title.
    const title = fenced ? undefined : (BOLD_TITLE.exec(text) ?? HASH_TITLE.exec(text))?.[1]?.trim();
    if (FENCE.test(text)) fenced = !fenced;
    const last = sections.at(-1);
    if (title !== undefined || !last) sections.push({ title: title ?? "", text: line });
    else last.text += line;
  }
  return sections;
}

// The line the summary writes where it cut a section short.
const CUT_LINE = /^ {2}… \d+ more characters \(section ".*"\)[ \t]*$/m;
/** The mark of a summary in a text, if the text holds one: a head that carries it was copied from a cut answer, and is not a head. */
export function summaryMark(text: string): string | undefined { return CUT_LINE.exec(text)?.[0].trim(); }

/** A 参考 section is a long table or derivation, shown by its title alone. */
const isReference = (title: string): boolean => title.startsWith("参考");

/** The title line of a section and, below it, the first paragraph: up to the first blank line, a fenced block counted whole. */
function lead(text: string): string {
  const all = lines(text);
  let end = 1, fenced = FENCE.test(bare(all[0]!)), started = !BARE_TITLE.test(bare(all[0]!));
  for (const line of all.slice(1)) {
    const blank = !fenced && !bare(line).trim();
    if (blank && started) break;
    if (!blank) started = true;
    if (FENCE.test(bare(line))) fenced = !fenced;
    end++;
  }
  let shown = all.slice(0, end).join("");
  if ([...shown].length > LEAD_LIMIT) {
    // Whole lines while they fit, the title line at least, and a single long line cut where the limit falls.
    const kept: string[] = [];
    let size = 0;
    for (const line of all.slice(0, end)) {
      const length = [...line].length;
      if (kept.length && size + length > LEAD_LIMIT) break;
      kept.push(line);
      size += length;
    }
    shown = kept.join("");
    if ([...shown].length > LEAD_LIMIT) shown = [...shown].slice(0, LEAD_LIMIT).join("");
  }
  return shown;
}

export interface HeadSummary {
  /** The head as the default answer shows it: each section's first paragraph, then what was left out. */
  text: string;
  /** How many characters were left out in all; zero when the head is shown whole. */
  omitted: number;
  titles: string[];
}

export function summarizeHead(head: string): HeadSummary {
  const sections = splitHead(head);
  let out = "", omitted = 0;
  for (const s of sections) {
    const shown = isReference(s.title) ? lines(s.text)[0]! : lead(s.text);
    const left = s.text.slice(shown.length).trim().length;
    if (left <= MIN_OMIT) { out += s.text; continue; }
    omitted += left;
    out += `${shown.trimEnd()}\n  … ${left} more characters (section "${s.title || PREAMBLE}")\n\n`;
  }
  return { text: out.trimEnd(), omitted, titles: sections.map(s => s.title || PREAMBLE) };
}

/**
 * The sections a caller asked for by title: those with exactly that title, else those whose title starts with it (so
 * `参考` finds every 参考 section). `all` is the whole head. Undefined when nothing matches.
 */
export function selectSections(head: string, name: string): HeadSection[] | undefined {
  if (name === "all") return [{ title: "all", text: head }];
  const sections = splitHead(head), title = (s: HeadSection) => s.title || PREAMBLE;
  const exact = sections.filter(s => title(s) === name);
  if (exact.length) return exact;
  const prefixed = sections.filter(s => title(s).startsWith(name));
  return prefixed.length ? prefixed : undefined;
}

// The bold title of a section and the colon after it, which the text of the title line follows.
const BOLD_TITLE_MARK = /^\*\*[^*\n]+\*\*\s*[：:]?/;

/**
 * What an item's 何时 section says: its first paragraph, on one line. The section is the one `splitHead` finds, so `context` and the
 * candidates read agree on what a title is: bold with the text after it on the same line, or alone with the text in the paragraph
 * below, or a heading. Undefined when the head has no such section or it holds no text; a title inside a fenced block is code and
 * does not count.
 */
export function whenText(head: string): string | undefined {
  // Most heads have no such section: skip the scan.
  if (!head.includes("何时")) return undefined;
  const section = splitHead(head).find(s => s.title === "何时");
  if (!section) return undefined;
  const [titleLine = "", ...below] = lines(section.text).map(bare);
  const first = titleLine.startsWith("**") ? titleLine.replace(BOLD_TITLE_MARK, "").trim() : "", found = first ? [first] : [];
  for (const line of below) {
    if (!line.trim()) { if (found.length) break; continue; }
    // A fenced block ends the paragraph even without a blank line.
    if (FENCE.test(line)) break;
    found.push(line.trim());
  }
  return found.length ? found.join(" ") : undefined;
}
