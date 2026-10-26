/**
 * Formats an epoch-ms instant the way SQLite's `datetime('now')` stores it: UTC,
 * `YYYY-MM-DD HH:MM:SS`. `usage_log.created_at` is stored that way, and it is compared as text,
 * so a bound must use the same format: an ISO string has a `T` where the column has a space, and
 * on the bound's own date every stored row sorts before it.
 */
export const sqliteTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
