/**
 * Ceilings for reads that have no natural bound.
 *
 * **There is one left, and that is the point.** This module used to hold four,
 * on a premise that is no longer true: it said `findMany` refuses an unsized
 * scan, so every former `.collect()` needed a number. It does not — an unbounded
 * `findMany` returns every matching row (verified by writing 40 and reading 40
 * back), which is why GDPR erasure and the cascade deletes already call it with
 * no `limit` at all.
 *
 * So a cap here bought nothing on a read that is already bounded by its own
 * `where` — one organization's members, one user's sessions, one team's members.
 * What it bought was a silent truncation: `revokeUserSessions` would have left
 * sessions alive past 500 and under-reported the count in its own audit entry,
 * and deleting a team would have orphaned its members. Those caps are gone.
 *
 * Keep a number here only when a read has **no per-owner bound** — where the
 * `where` narrows a global catalogue rather than scoping to one user, org or
 * parent row. And prefer `count()` / `exists()` when you only need a number,
 * because a capped read that reports `.length` silently stops counting at the
 * cap.
 */

/**
 * The connector catalogue — `listConnectorCatalog`.
 *
 * A whole-table scan of a global catalogue with nothing per-owner to bound it.
 * It is seeded from a fixed list, so exceeding this would be a seeding bug
 * rather than growth — a runaway guard, not a page size.
 */
export const MAX_CONNECTORS = 500;
