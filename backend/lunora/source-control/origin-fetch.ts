/**
 * The one way a driver reaches a host with a token: a requester bound to ONE
 * origin. It sends the token to that origin only. A path that resolves anywhere
 * else is refused, and a redirect is followed only while it stays on the origin
 * (a renamed repository answers 301 on the same host); one that leaves it is an
 * error and the token never goes along. Every response has a deadline, and a
 * failed response's body is cancelled before the error is thrown.
 */
import type { FetchWithDeadlineInit } from "../lib/fetch-timeout";
import { assertOk, FETCH_TIMEOUT_MS, fetchWithDeadline, HttpError } from "../lib/fetch-timeout";

/** A host request that did not succeed. `status` is the host's; `0` means the request itself was refused. */
export class HostApiError extends Error {
    public readonly rateLimited: boolean;

    public readonly status: number;

    public constructor(message: string, status: number, rateLimited = false) {
        super(message);
        this.name = "HostApiError";
        this.rateLimited = rateLimited;
        this.status = status;
    }
}

export interface HostRequestOptions {
    query?: Record<string, number | string>;
}

/** Resolves with an OK response, or throws {@link HostApiError}. */
export type HostRequest = (path: string, options?: HostRequestOptions) => Promise<Response>;

export interface BoundRequesterConfig {
    headers?: Record<string, string>;
    /** Redirects followed (same origin only) before giving up. */
    maxRedirects?: number;
    origin: string;
    timeoutMs?: number;
    token: string;
    via?: FetchWithDeadlineInit["via"];
}

const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

const isRateLimited = (response: Response): boolean =>
    response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));

export const createBoundRequester = ({
    headers = {},
    maxRedirects = 2,
    origin,
    timeoutMs = FETCH_TIMEOUT_MS,
    token,
    via,
}: BoundRequesterConfig): HostRequest => {
    const bound = new URL(origin);
    const boundOrigin = bound.origin;

    return async (path, options = {}) => {
        // A token never travels in cleartext, whatever origin a caller derived.
        if (bound.protocol !== "https:") {
            throw new HostApiError("A host token is only sent over https", 0);
        }

        if (!path.startsWith("/") || path.startsWith("//")) {
            throw new HostApiError("A host path must start with a single slash", 0);
        }

        let url = new URL(path, boundOrigin);

        const queryEntries = Object.entries(options.query ?? {});

        for (const [name, value] of queryEntries) {
            url.searchParams.set(name, String(value));
        }

        for (let hop = 0; ; hop += 1) {
            if (url.origin !== boundOrigin) {
                throw new HostApiError("The request left the host's origin", 0);
            }

            const response = await fetchWithDeadline(url, {
                headers: { ...headers, Authorization: `Bearer ${token}` },
                // Followed by hand below, so a Location header cannot carry the token elsewhere.
                redirect: "manual",
                timeoutMs,
                via,
            }).catch(() => {
                throw new HostApiError("The host could not be reached", 0);
            });

            if (!REDIRECT_STATUSES.has(response.status)) {
                try {
                    return await assertOk(response, "Host API error");
                } catch (error) {
                    throw error instanceof HttpError ? new HostApiError(error.message, error.status, isRateLimited(response)) : error;
                }
            }

            const location = response.headers.get("location");

            await response.body?.cancel();

            if (location === null || hop >= maxRedirects) {
                throw new HostApiError("The host redirected the request too many times", 0);
            }

            try {
                url = new URL(location, url);
            } catch {
                throw new HostApiError("The host sent a redirect that is not a URL", 0);
            }
        }
    };
};
