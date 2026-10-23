// Project list helpers with no DOM, so the unit tests can import them.

// The copy with the later updatedAt (ISO 8601 text sorts in time order).
const newer = (fetched, held) =>
  held && held.updatedAt > fetched.updatedAt ? held : fetched;

// Merge a fetched page into a list, one project per id. An index list is
// eventual: right after a save it can return the version before it. A
// project held locally with a later updatedAt is kept, and is left out when
// that later version no longer matches the current filters.
export function mergePage(list, items, held = [], matches = () => true) {
  const local = new Map();
  for (const p of held) local.set(p.id, newer(p, local.get(p.id)));
  const fresh = items
    .map((p) => newer(p, local.get(p.id)))
    .filter((p) => matches(p));
  return [...new Map([...list, ...fresh].map((p) => [p.id, p])).values()];
}

// Put a saved project in a list in place of its earlier copy. keep is false
// when the project no longer belongs in the list.
export const placeProject = (list, project, keep = true) => [
  ...list.filter((p) => p.id !== project.id),
  ...(keep ? [project] : []),
];
