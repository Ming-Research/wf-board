import type { Decision, Item, Note } from "../../src/model.ts";
import type { Priority } from "../../src/legacy-model.ts";

export interface LegacyItem extends Partial<Omit<Item, "ask" | "deps">> {
  id: string;
  priority?: Priority;
  agent?: string;
  area?: string;
  text?: string;
  ask?: string;
  askUrl?: string;
  askChat?: boolean;
  deps?: Array<string | { id: string; why?: string }>;
  qs?: string[];
}
export interface LegacyDecision extends Partial<Omit<Decision, "confidence">> {
  id: string;
  status: Decision["status"];
  confidence?: string;
}
export interface LegacyNote extends Omit<Note, "rev"> { id: string; rev?: number }
export interface LegacyState {
  items: LegacyItem[];
  decisions: LegacyDecision[];
  notes: LegacyNote[];
  archived: Record<string, { at: string }>;
}
export interface LegacyRules {
  statusOf(it: LegacyItem): NonNullable<Item["status"]>;
  priorityOf(it: LegacyItem): Priority | "";
  effPriorityOf(it: LegacyItem): Priority | "";
  raisedBy(it: LegacyItem): LegacyItem | null;
  needsOwner(it: LegacyItem): boolean;
  onCycle(): Set<string>;
  inArchive(it: LegacyItem): boolean;
  isArchived(it: LegacyItem): boolean;
  checksOf(it: LegacyItem): Array<{ text: string; target?: LegacyItem }>;
  ancestors(it: LegacyItem): LegacyItem[];
  lineOf(it: LegacyItem): LegacyItem;
  groupOf(it: LegacyItem): string;
  agentFor(it: LegacyItem): string;
  isLeaf(it: LegacyItem): boolean;
  byPriority(a: LegacyItem, b: LegacyItem): number;
  homeOf(d: LegacyDecision): string | null;
  cardsUnder(it: LegacyItem): LegacyDecision[];
  ruledUnder(it: LegacyItem): LegacyDecision[];
  latestOf(it: LegacyItem): string;
  tops(): LegacyItem[];
}
export function legacyRules(state: LegacyState): LegacyRules;
