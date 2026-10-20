// The pull requests a text names, and which configured repository each reference means: the one place that reads `Repo#N`,
// `Owner/Repo#N` and pull request URLs (docs/design.md, Watching GitHub). Used by the watch, the look at the board and the item checks.
import type { Project, Snapshot } from "./model.ts";

/** Repositories the board knows, lowercased: the configured projects' and those its items link to (github.com/Ming-Research/<repo>).
 * These are the names a `Repo#N` or `Repo #N` reference may use. */
export function knownRepos(s: Pick<Snapshot, "board" | "items">): Set<string> {
  const out = new Set<string>(), urls: string[] = [];
  for (const project of s.board.projects) if (project.repo) out.add(project.repo.split("/").pop()!.toLowerCase());
  for (const it of Object.values(s.items)) urls.push(...it.links.map(l => l.url), it.ask?.url ?? "");
  for (const url of urls) { const m = /github\.com\/Ming-Research\/([A-Za-z0-9_.-]+)/i.exec(url); if (m) out.add(m[1]!.toLowerCase()); }
  return out;
}
/** A PR a text names. `owner` is set only when the text wrote it: `Owner/Repo#N` or a pull request URL. */
export interface PrRef { repo: string; number: number; owner?: string }
/** PR references in prose. A bare name before `#N` counts as a repository only when the board knows that repository, so "see #341" stays unknown.
 * `Owner/Repo#N` and a pull request URL name the repository themselves. */
export function references(text: string, repos: Set<string>) {
  const qualified: PrRef[] = [], unknown: number[] = [], ranges: Array<[number, number]> = [];
  const patterns = [
    /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\b/gi,
    /(?<![A-Za-z0-9_.\/#-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?: PR)? ?#(\d+)\b/gi,
    /(?<![A-Za-z0-9_.\/#-])()([A-Za-z0-9_.-]+)(?: PR)? ?#(\d+)\b/gi,
  ];
  for (const [i, pattern] of patterns.entries()) for (const match of text.matchAll(pattern)) {
    const owner = match[1]!, repo = match[2]!, number = Number(match[3]);
    if (i === 2 && !repos.has(repo.toLowerCase())) continue;
    ranges.push([match.index, match.index + match[0].length]);
    if (!qualified.some(p => p.repo.toLowerCase() === repo.toLowerCase() && p.number === number)) qualified.push(owner ? { repo, number, owner } : { repo, number });
  }
  for (const match of text.matchAll(/#(\d+)\b/g)) if (!ranges.some(([a, b]) => match.index >= a && match.index < b) && !unknown.includes(Number(match[1]))) unknown.push(Number(match[1]));
  return { qualified, unknown };
}
/** A PR as the board watches it: `repo` is the `Owner/Name` a project configures. */
export interface PrId { repo: string; number: number }
export const prKey = (p: PrId): string => `${p.repo.toLowerCase()}#${p.number}`;
/** The configured repository a reference names, or none: `Owner/Repo` must match a project's repo, a bare `Repo` exactly one. */
function repoOf(projects: readonly Project[], ref: PrRef): string | undefined {
  const repos = projects.flatMap(p => p.repo ? [p.repo] : []);
  if (ref.owner) return repos.find(repo => repo.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase());
  const named = repos.filter(repo => repo.split("/").pop()!.toLowerCase() === ref.repo.toLowerCase());
  return named.length === 1 ? named[0] : undefined;
}
/** The PRs a text names that belong to a configured repository. */
export function pullsIn(s: Pick<Snapshot, "board" | "items">, text: string, repos: Set<string> = knownRepos(s)): PrId[] {
  const out = new Map<string, PrId>();
  for (const ref of references(text, repos).qualified) {
    const repo = repoOf(s.board.projects, ref);
    if (repo) out.set(prKey({ repo, number: ref.number }), { repo, number: ref.number });
  }
  return [...out.values()];
}
