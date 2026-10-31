/**
 * The decisions of Develop's freshness, pure so each is pinned by a table: what is a new review request, when a
 * watched repository is polled next, what a cached list keeps. No clock, database or host in here.
 */
import type { ReadFailure } from "./read-host";
/** Repositories one user can watch: each is a poll every few minutes against their own API budget. */
export const MAX_WATCHED_REPOSITORIES = 20;

/** The cached list of a repository keeps this many pull requests that ask for a review; page one of the host's list is 100. */
export const MAX_CACHED_REQUESTS = 50;

const TITLE_MAX_CHARS = 300;

export const MINUTE_MS = 60 * 1000;

/** The pace of a repository nobody has told us about: a 304 costs the host nothing, so this is cheap. */
export const POLL_INTERVAL_MS = 5 * MINUTE_MS;

/** With a webhook heard from lately, polling is the safety net and slows down; without one it never does. */
export const POLL_INTERVAL_WITH_WEBHOOK_MS = 30 * MINUTE_MS;

/** A webhook counts as working for this long after its last delivery. */
export const WEBHOOK_TRUST_MS = 7 * 24 * 60 * MINUTE_MS;

/** A poll in flight holds its repository this long; a poll that never reports back is dispatched again after it. */
export const POLL_LEASE_MS = 5 * MINUTE_MS;

/** A refresh on open skips a repository checked this recently. */
export const REFRESH_MIN_AGE_MS = 30 * 1000;

const FAILURE_DELAY_MS: Record<ReadFailure, number> = {
    // Only the person can fix these (sign in again, grant access, name an existing repository): asking sooner changes nothing.
    forbidden: 60 * MINUTE_MS,
    host_error: 10 * MINUTE_MS,
    needs_reconnect: 60 * MINUTE_MS,
    not_connected: 60 * MINUTE_MS,
    not_found: 60 * MINUTE_MS,
    rate_limited: 15 * MINUTE_MS,
};

/** How long after a poll the next one is due. */
export const nextPollDelay = (outcome: ReadFailure | "ok", { now, webhookSeenAt }: { now: number; webhookSeenAt: number }): number => {
    if (outcome !== "ok") {
        return FAILURE_DELAY_MS[outcome];
    }

    return webhookSeenAt > 0 && now - webhookSeenAt <= WEBHOOK_TRUST_MS ? POLL_INTERVAL_WITH_WEBHOOK_MS : POLL_INTERVAL_MS;
};

export interface CachedRequest {
    authorLogin: string;
    number: number;
    title: string;
    updatedAt: number;
    url: string;
}

/** What the cache keeps of a driver's summaries: the fields the list shows, bounded. */
export const cachedRequestsOf = (requested: ReadonlyArray<CachedRequest>): CachedRequest[] =>
    requested.slice(0, MAX_CACHED_REQUESTS).map(({ authorLogin, number, title, updatedAt, url }) => {
        return { authorLogin, number, title: title.slice(0, TITLE_MAX_CHARS), updatedAt, url };
    });

/** The requests in `next` that were not in `previous`: a review newly asked for. One that left and came back is new again. */
export const enteredRequests = (previous: ReadonlyArray<Pick<CachedRequest, "number">>, next: ReadonlyArray<CachedRequest>): CachedRequest[] => {
    const known = new Set(previous.map((entry) => entry.number));

    return next.filter((entry) => !known.has(entry.number));
};

/**
 * One notification per request: the pull request's last-update time makes a later request on the same pull
 * request a new key, while a poll recorded twice (a redelivery, a sweep beside the tick) writes one row.
 */
export const requestDedupeKey = (hostOrigin: string, repo: string, request: Pick<CachedRequest, "number" | "updatedAt">): string =>
    `review-request:${hostOrigin}:${repo}#${request.number}:${request.updatedAt}`;
