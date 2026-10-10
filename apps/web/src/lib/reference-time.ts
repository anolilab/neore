/**
 * The "now" a dashboard query compares against, passed to the backend as an
 * argument: a Lunora query must not read the clock itself, because a live
 * subscription re-runs it.
 *
 * Floored to the minute so the value — and therefore the query key — is the same
 * across renders and between a route loader and the hook that reads the same
 * cache entry. The windows these queries use are hours or days, so a minute of
 * granularity does not change what is shown.
 */
const MINUTE_MS = 60_000;

export const referenceNow = (): number => Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
