/** One decimal place, without a trailing ".0" — `4`, `4.3`. */
export const formatRating = (rating: number): string => String(Math.round(rating * 10) / 10);

/**
 * The part of a Lunora query key that names the function, without its args —
 * `["lunora", ref, args, shardKey]` → `["lunora", ref]` — so one invalidation
 * covers every argument combination of that query.
 */
export const functionQueryPrefix = (queryKey: ReadonlyArray<unknown>): unknown[] => queryKey.slice(0, 2);

export const MARKETPLACE_PAGE_SIZE = 24;
export const SEARCH_DEBOUNCE_MS = 300;
