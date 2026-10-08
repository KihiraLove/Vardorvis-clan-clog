/** Bot search is advisory: only an exact, unambiguous name/alias resolves a claim. */
export interface MatchItem {
  id: number;
  name: string;
  aliases: string[];
}
export interface Candidate {
  id: number;
  name: string;
}
export const normalizeItem = (text: string) =>
  text.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');

function distanceAtMostTwo(a: string, b: string): boolean {
  if (
    a.length < 3 ||
    b.length < 3 ||
    a.length > 64 ||
    b.length > 64 ||
    Math.abs(a.length - b.length) > 2
  )
    return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let minimum = i;
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(
        next[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      next[j] = value;
      minimum = Math.min(minimum, value);
    }
    if (minimum > 2) return false;
    previous = next;
  }
  return previous[b.length]! <= 2;
}
function rank(item: MatchItem, query: string): number {
  const keys = [item.name, ...item.aliases].map(normalizeItem);
  if (!query) return 4;
  if (keys.some((key) => key === query)) return 0;
  if (keys.some((key) => key.startsWith(query))) return 1;
  if (keys.some((key) => key.includes(query))) return 2;
  if (keys.some((key) => distanceAtMostTwo(key, query))) return 3;
  return Infinity;
}
export function searchMatches(
  items: MatchItem[],
  raw: string,
  limit = 25,
): Candidate[] {
  const query = normalizeItem(raw);
  return items
    .map((item) => ({ item, score: rank(item, query) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.item.name.localeCompare(b.item.name) ||
        a.item.id - b.item.id,
    )
    .slice(0, limit)
    .map(({ item }) => ({ id: item.id, name: item.name }));
}
export function resolveMatch(
  items: MatchItem[],
  raw: string,
  selectedId?: number,
) {
  // Explicit selections are canonical IDs, not a string that might collide with a name.
  const token = /^item:([1-9]\d*)$/u.exec(raw.trim());
  const id = selectedId ?? (token ? Number(token[1]) : undefined);
  if (id !== undefined) {
    const selected = items.find((item) => item.id === id);
    return selected
      ? { resolution: 'resolved' as const, itemId: selected.id, candidates: [{ id: selected.id, name: selected.name }] }
      : { resolution: 'needs_match' as const, itemId: null, candidates: [] };
  }
  const query = normalizeItem(raw);
  const exact = items.filter((item) =>
    [item.name, ...item.aliases].some((value) => normalizeItem(value) === query),
  );
  if (exact.length === 1)
    return {
      resolution: 'resolved' as const,
      itemId: exact[0]!.id,
      candidates: [{ id: exact[0]!.id, name: exact[0]!.name }],
    };
  return {
    resolution: 'needs_match' as const,
    itemId: null,
    candidates: exact.length
      ? exact.slice(0, 5).map(({ id, name }) => ({ id, name }))
      : searchMatches(items, raw, 5),
  };
}
