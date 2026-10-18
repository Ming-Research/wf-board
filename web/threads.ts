// Stub for the first push, so the new tests fail on what they check and not on a missing file.
export function threadOrder<T extends { id: string; at: string; anchor?: { kind: string; id?: string } }>(notes: readonly T[]): Array<{ note: T; depth: number }> {
  return notes.slice().sort((x, y) => String(x.at).localeCompare(String(y.at))).map(note => ({ note, depth: 0 }));
}
