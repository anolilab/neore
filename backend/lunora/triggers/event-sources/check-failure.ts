/**
 * Which failed checks count toward pausing a watcher. Only a failure the owner can fix does: an address the
 * server will not fetch, a page that is not text, a selector that matches nothing, a thread nobody can read
 * any more, an answer of 4xx. A timeout, a network error, a 5xx or a rate limit heals on its own, so the
 * watcher backs off and tries again instead of stopping.
 */
import { HttpError } from "../../lib/fetch-timeout";

/** A failure of a check that has a cause the owner can cure. Anything else thrown by a check is transient. */
export class EventCheckError extends Error {
    public constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "EventCheckError";
    }
}

/** 4xx answers that say "later", not "this address is wrong". */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 425, 429]);

export const isOwnerFixableCheckFailure = (error: unknown): boolean => {
    if (error instanceof EventCheckError) {
        return true;
    }

    return error instanceof HttpError && error.status >= 400 && error.status < 500 && !RETRYABLE_CLIENT_STATUSES.has(error.status);
};
