/** Lowercased word and number counts across `texts`, with HTML tags left out. */
export function wordCounts(texts: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const plain = text.replace(/<[^>]+>/g, ' ').toLowerCase();
    for (const word of plain.match(/[\p{L}\p{N}]+/gu) ?? []) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return counts;
}

/** Words `actual` has fewer of than `expected` (missing) and more of (extra), sorted by word. */
export function wordDifference(
  expected: Map<string, number>,
  actual: Map<string, number>
): { missing: [string, number][]; extra: [string, number][] } {
  const missing: [string, number][] = [];
  const extra: [string, number][] = [];
  for (const word of new Set([...expected.keys(), ...actual.keys()])) {
    const diff = (expected.get(word) ?? 0) - (actual.get(word) ?? 0);
    if (diff > 0) missing.push([word, diff]);
    if (diff < 0) extra.push([word, -diff]);
  }
  const byWord = (a: [string, number], b: [string, number]) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  return { missing: missing.sort(byWord), extra: extra.sort(byWord) };
}
