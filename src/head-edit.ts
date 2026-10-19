// A head changed in parts: whole sections replaced by title, and short texts replaced where they stand, each found in the
// head as it was before the call (docs/design.md, section 6, Changing things). The edits are all located first, none
// may overlap, and they are made at once, so the order they are written in changes nothing and one that does not fit
// refuses the whole call. The answer shows every change as the lines before and after it, so the writer need not read
// the head back to check.
import { PREAMBLE, splitHead } from "./head-sections.ts";

export interface SectionEdit {
  /** The title of the section to replace, as `context` lists it. */
  title: string;
  /** The whole new section: its title line first, as the section is written, and no other title line. */
  text: string;
}
export interface Replacement {
  /** Text that occurs exactly once in the head. */
  old: string;
  /** What replaces it; empty deletes it. */
  new: string;
}
export interface HeadEdits { sections?: readonly SectionEdit[]; replace?: readonly Replacement[] }

/** A refusal in the caller's words; the write turns it into the board's own error. */
export class HeadEditError extends Error {}

/** How much of the text around a change one line of the answer keeps, and the most one line holds. */
export const AROUND = 40;
export const LINE_LIMIT = 200;
/** The most lines of one change shown on each side, and the most changes shown. */
export const SIDE_LINES = 3;
export const MAX_CHANGES = 30;
/** How much of a text an error quotes. */
const QUOTE = 60;

/** The part of the head one edit replaces, in the head as it was. */
interface Region { start: number; end: number; text: string; label: string }

const quote = (text: string): string => JSON.stringify([...text].length > QUOTE ? `${[...text].slice(0, QUOTE).join("")}…` : text);
const lineAt = (head: string, offset: number): number => 1 + (head.slice(0, offset).match(/\n/g)?.length ?? 0);
const lineStart = (text: string, offset: number): number => offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
const lineEnd = (text: string, offset: number): number => { const at = text.indexOf("\n", offset); return at === -1 ? text.length : at; };
const trimEnd = (text: string, start: number, end: number): number => { while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--; return end; };

/** Where `part` starts in `text`, every place, places that overlap each other included. */
function occurrences(text: string, part: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(part); i !== -1; i = text.indexOf(part, i + 1)) at.push(i);
  return at;
}

/** The regions of the sections to replace, each with its new text: the title line, then the section's own trailing blank lines, so the sections around it stay as they were. */
function sectionRegions(head: string, edits: readonly SectionEdit[]): Region[] {
  // A head with no text has one empty section in `splitHead`; there is nothing in it to replace.
  const parts = splitHead(head).filter(s => s.text !== "");
  const titles = parts.map(s => `"${s.title || PREAMBLE}"`);
  let offset = 0;
  const where = parts.map(s => { const start = offset; offset += s.text.length; return { ...s, start }; });
  return edits.map((edit, i) => {
    const label = `sections[${i}] "${edit.title}"`;
    const found = where.filter(s => (s.title || PREAMBLE) === edit.title);
    if (found.length === 0) throw new HeadEditError(`sections[${i}].title: no section is titled "${edit.title}"; this head has ${titles.join(", ") || "no text"}`);
    if (found.length > 1) throw new HeadEditError(`sections[${i}].title: ${found.length} sections are titled "${edit.title}"; change them with replace, or give the whole head`);
    const given = splitHead(edit.text);
    if (given.length !== 1 || (given[0]!.title || PREAMBLE) !== edit.title) {
      throw new HeadEditError(`sections[${i}].text: must be the one section "${edit.title}", its title line first and no other title line; it holds ${given.map(s => `"${s.title || PREAMBLE}"`).join(", ")}`);
    }
    const old = found[0]!;
    // The blank lines that end the old section end the new one, whatever the new text ends with.
    const tail = /\s*$/.exec(old.text)![0];
    return { start: old.start, end: old.start + old.text.length, text: edit.text.replace(/\s+$/, "") + tail, label };
  });
}

/** The regions of the texts to replace: each must be in the head exactly once. */
function replaceRegions(head: string, edits: readonly Replacement[]): Region[] {
  return edits.map((edit, i) => {
    if (!edit.old.trim()) throw new HeadEditError(`replace[${i}].old: give text that is not blank`);
    const at = occurrences(head, edit.old);
    if (at.length === 0) throw new HeadEditError(`replace[${i}].old: ${quote(edit.old)} occurs 0 times in the head; copy it exactly from context (section "all"), punctuation and line breaks included`);
    if (at.length > 1) {
      const lines = at.slice(0, 5).map(start => lineAt(head, start));
      throw new HeadEditError(`replace[${i}].old: ${quote(edit.old)} occurs ${at.length} times in the head (lines ${lines.join(", ")}${at.length > 5 ? ", …" : ""}); add words around it so that it occurs exactly once`);
    }
    return { start: at[0]!, end: at[0]! + edit.old.length, text: edit.new, label: `replace[${i}]` };
  });
}

/** One line of the answer: the line of text, cut to the change and what is around it when it is long. */
function windowed(line: string, from: number, to: number): string {
  from = Math.min(Math.max(from, 0), line.length);
  to = Math.min(Math.max(to, from), line.length);
  let start = Math.max(0, from - AROUND), end = Math.min(line.length, to + AROUND);
  if (end - start > LINE_LIMIT) end = start + LINE_LIMIT;
  // Never cut a character that takes two code units in half.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start]!)) start++;
  if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end--;
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

/** The lines of `text` that hold its characters from `start` to `end`, each cut around the change, at most `SIDE_LINES` of them. */
function sideLines(text: string, start: number, end: number): string[] {
  const first = lineStart(text, start), last = lineEnd(text, trimEnd(text, start, end));
  const lines = text.slice(first, last).split("\n").map(line => line.replace(/\r$/, ""));
  const shown: string[] = [];
  let offset = first;
  for (const line of lines.slice(0, SIDE_LINES)) {
    shown.push(windowed(line, start - offset, end - offset));
    offset += line.length + 1;
  }
  if (lines.length > SIDE_LINES) shown.push(`… ${lines.length - SIDE_LINES} more lines`);
  return shown;
}

/**
 * The answer for the regions that changed the text: for each, in head order, where it is (the edit, the section and the line in
 * the head as it was) and the lines before and after it, `-` and `+`, a long line cut around the change.
 */
function showChanges(before: string, after: string, regions: readonly Region[]): string {
  const sections = (() => { let offset = 0; return splitHead(before).map(s => { const start = offset; offset += s.text.length; return { title: s.title || PREAMBLE, start, end: offset }; }); })();
  const out: string[] = [];
  let delta = 0, changed = 0;
  for (const region of regions) {
    const was = before.slice(region.start, region.end), start = region.start + delta;
    delta += region.text.length - was.length;
    if (was === region.text) continue;
    changed++;
    if (changed > MAX_CHANGES) continue;
    const section = sections.find(s => region.start >= s.start && region.start < s.end)?.title;
    const first = lineAt(before, region.start), last = lineAt(before, trimEnd(before, region.start, region.end));
    out.push(`${region.label}${region.label.startsWith("replace") && section ? ` in ${section}` : ""} · line ${first}${last > first ? `–${last}` : ""}`);
    out.push(...sideLines(before, region.start, region.end).map(line => `  - ${line}`));
    // A replacement that left no text, where it removed whole lines, has no line to show.
    const wholeLines = lineStart(before, region.start) === region.start && (region.end === before.length || before[region.end - 1] === "\n");
    if (region.text === "" && wholeLines) out.push("  + (deleted)");
    else out.push(...sideLines(after, start, start + region.text.length).map(line => `  + ${line}`));
  }
  if (!changed) return "head unchanged: every edit left the text as it was";
  const lines = [`head changed in ${changed} ${changed === 1 ? "place" : "places"}${changed > MAX_CHANGES ? ` (the first ${MAX_CHANGES} shown)` : ""}; lines are numbered as in the head before this write:`, ...out];
  return lines.join("\n");
}

/**
 * `head` with the edits made, and the answer that shows them. Every edit is located in `head` as it is now, a text to replace
 * exactly once; sections are told apart by title (`splitHead`). Refuses, naming the edit, a text found other than once, a
 * title that is no section or the title of several, a new section that is not exactly that section, edits that overlap, and
 * edits that would leave the head blank.
 */
export function editHead(head: string, edits: HeadEdits): { head: string; shown: string } {
  if (edits.sections?.length === 0) throw new HeadEditError("sections: give at least one section, or leave it out");
  if (edits.replace?.length === 0) throw new HeadEditError("replace: give at least one pair of old and new text, or leave it out");
  const regions = [...sectionRegions(head, edits.sections ?? []), ...replaceRegions(head, edits.replace ?? [])].sort((a, b) => a.start - b.start || a.end - b.end);
  let previous: Region | undefined;
  for (const region of regions) {
    if (previous && region.start < previous.end) throw new HeadEditError(`${previous.label} and ${region.label} change the same text (line ${lineAt(head, region.start)}); every edit must change a part of the head of its own`);
    previous = region;
  }
  let result = "", at = 0;
  for (const region of regions) { result += head.slice(at, region.start) + region.text; at = region.end; }
  result += head.slice(at);
  if (!result.trim()) throw new HeadEditError("the edits would leave the head blank; a head keeps some text");
  return { head: result, shown: showChanges(head, result, regions) };
}
