/**
 * Unread notifications that arrived since the previous snapshot of the live
 * inbox. The first snapshot (`seen` undefined) announces nothing — those were
 * there before the page opened.
 */
export const findNewArrivals = <T extends { _id: string; read: boolean }>(seen: ReadonlySet<string> | undefined, items: ReadonlyArray<T>): T[] =>
    seen === undefined ? [] : items.filter((item) => !item.read && !seen.has(item._id));
