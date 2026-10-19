// The pause side of the activity index: who pauses whom, kept as a graph a commit changes in place, so that replaying a
// history costs the items a commit changes and their subtrees, not the whole board (docs/design.md, section 5, the activity
// index). `pausedBy` of src/rules.ts is the definition the page shows; this walk is the same one over the fields it reads.

/** What the pause spans read of an item: its project, whether it is a record, its pause and the items it owns. */
export interface PauseShape {
  readonly group: string;
  readonly record: boolean;
  readonly paused?: { readonly at: string; readonly reason: string };
  readonly owned: readonly string[];
}

/** A pause that begins or ends for an item when a commit changes some shapes. */
export interface PauseEvent {
  readonly id: string;
  /** Whether the item is paused after the commit; before it, it was the other way. */
  readonly paused: boolean;
  /** Of a pause that begins: when the item that pauses it set the pause, if that item was not paused before the commit. */
  readonly since?: string;
}

export function sameShape(a: PauseShape | null, b: PauseShape | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.group === b.group && a.record === b.record && a.paused?.at === b.paused?.at && a.paused?.reason === b.paused?.reason
    && !a.paused === !b.paused && a.owned.length === b.owned.length && a.owned.every((id, i) => id === b.owned[i]);
}

export class PauseGraph {
  private readonly shapes = new Map<string, PauseShape>();
  /** For an item, the items that own it in ascending order of id; the first is its parent, as in src/rules.ts (an item has one owner, which a write checks). */
  private readonly owners = new Map<string, string[]>();

  static from(shapes: Iterable<readonly [string, PauseShape]>): PauseGraph {
    const graph = new PauseGraph();
    for (const [id, shape] of shapes) graph.set(id, shape);
    return graph;
  }

  shape(id: string): PauseShape | null {
    return this.shapes.get(id) ?? null;
  }

  /** The nearest item at or above `id`, in the same project, with a pause and not a record; none when the item is not paused. */
  pausedBy(id: string): string | undefined {
    const first = this.shapes.get(id);
    if (!first) return undefined;
    const seen = new Set<string>();
    for (let current: string | undefined = id; current !== undefined && !seen.has(current); current = this.owners.get(current)?.[0]) {
      seen.add(current);
      const shape = this.shapes.get(current);
      if (!shape || shape.group !== first.group) break;
      if (!shape.record && shape.paused) return current;
    }
    return undefined;
  }

  /** Every paused item with the item that pauses it. */
  *sources(): Iterable<[string, string]> {
    for (const id of this.shapes.keys()) {
      const source = this.pausedBy(id);
      if (source !== undefined) yield [id, source];
    }
  }

  /**
   * Replace the shapes of the given items (null: the item is gone) and say which items began or stopped being paused.
   * Only an item whose own project, record mark or pause changed, an item that was added to or removed from an owner's list,
   * and what hangs under either, can change; the others are not looked at.
   */
  apply(changes: ReadonlyMap<string, PauseShape | null>): PauseEvent[] {
    const old = new Map<string, PauseShape | null>();
    const seeds: string[] = [];
    for (const [id, next] of changes) {
      const was = this.shapes.get(id) ?? null;
      old.set(id, was);
      if (!was !== !next || (was && next && (was.group !== next.group || was.record !== next.record || !was.paused !== !next.paused))) seeds.push(id);
      const oldOwned = new Set(was?.owned), newOwned = new Set(next?.owned);
      for (const target of oldOwned) if (!newOwned.has(target)) seeds.push(target);
      for (const target of newOwned) if (!oldOwned.has(target)) seeds.push(target);
    }
    // What hangs under a seed, by the owned lists as they were and as they will be.
    const affected = new Set<string>();
    for (let id = seeds.pop(); id !== undefined; id = seeds.pop()) {
      if (affected.has(id)) continue;
      affected.add(id);
      seeds.push(...(this.shapes.get(id)?.owned ?? []), ...(changes.get(id)?.owned ?? []));
    }
    const sourceBefore = new Map<string, string | undefined>();
    for (const id of affected) sourceBefore.set(id, this.pausedBy(id));
    for (const [id, next] of changes) this.set(id, next);
    const events: PauseEvent[] = [];
    for (const id of affected) {
      const source = this.pausedBy(id);
      if (!!sourceBefore.get(id) === !!source) continue;
      if (source === undefined) { events.push({ id, paused: false }); continue; }
      // The source is newly paused when it was not paused before this commit: its own pause time starts the span.
      const wasPaused = old.has(source) ? old.get(source)?.paused : this.shapes.get(source)?.paused;
      events.push({ id, paused: true, ...(wasPaused ? {} : { since: this.shapes.get(source)!.paused!.at }) });
    }
    return events;
  }

  private set(id: string, shape: PauseShape | null): void {
    for (const target of new Set(this.shapes.get(id)?.owned)) {
      const list = this.owners.get(target)!.filter(owner => owner !== id);
      if (list.length) this.owners.set(target, list); else this.owners.delete(target);
    }
    if (!shape) { this.shapes.delete(id); return; }
    this.shapes.set(id, shape);
    for (const target of new Set(shape.owned)) this.owners.set(target, [...this.owners.get(target) ?? [], id].sort());
  }
}
