/**
 * The one way a driver reaches a host with a token: a requester bound to ONE
 * origin. It sends the token to that origin only. A path that resolves anywhere
 * else is refused, and a redirect of a read is followed only while it stays on the
 * origin (a renamed repository answers 301 on the same host); one that leaves it is
 * an error and the token never goes along. A redirect of a WRITE is never followed:
 * it would resend the body, and a write must not run twice. Every response has a deadline, and a
 * failed response's body is cancelled before the error is thrown.
 */
import type { FetchWithDeadlineInit } from "../lib/fetch-timeout";
import { assertOk, FETCH_TIMEOUT_MS, fetchWithDeadline, HttpError } from "../lib/fetch-timeout";

/** A host request that did not succeed. `status` is the host's; `0` means the request itself was refused. */
export class HostApiError extends Error {
    /** The host's own words for a refused write, untrusted text; set only for a write the host answered. */
    public readonly detail: string | undefined;

    public readonly rateLimited: boolean;

    public readonly status: number;

    /** A write that may have reached the host: the answer never arrived, so the host may have acted on it. */
    public readonly unconfirmed: boolean;

    public constructor(message: string, status: number, rateLimited = false, extra: { detail?: string; unconfirmed?: boolean } = {}) {
        super(message);
        this.name = "HostApiError";
        this.detail = extra.detail;
        this.rateLimited = rateLimited;
        this.status = status;
        this.unconfirmed = extra.unconfirmed ?? false;
    }
}

/** The `message` of a host's JSON error body, or `undefined` when there is none. */
const messageOf = (body: string | undefined): string | undefined => {
    try {
        const parsed = JSON.parse(body ?? "") as { message?: unknown };

        return typeof parsed.message === "string" ? parsed.message : undefined;
    } catch {
        return undefined;
    }
};

export interface HostRequestOptions {
    /** A JSON body. Sent only with a non-GET method, and never replayed after a redirect. */
    json?: unknown;
    /** `GET` unless a write says otherwise. */
    method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
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

        const method = options.method ?? "GET";
        const body = method === "GET" || options.json === undefined ? undefined : JSON.stringify(options.json);
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
                body,
                headers: { ...headers, ...(body !== undefined && { "Content-Type": "application/json" }), Authorization: `Bearer ${token}` },
                method,
                // Followed by hand below, so a Location header cannot carry the token elsewhere.
                redirect: "manual",
                timeoutMs,
                via,
            }).catch(() => {
                throw new HostApiError("The host could not be reached", 0, false, { unconfirmed: method !== "GET" });
            });

            if (!REDIRECT_STATUSES.has(response.status)) {
                try {
                    return await assertOk(response, "Host API error", { includeBody: method !== "GET" });
                } catch (error) {
                    throw error instanceof HttpError
                        ? new HostApiError(error.message, error.status, isRateLimited(response), { detail: messageOf(error.body) })
                        : error;
                }
            }

            const location = response.headers.get("location");

            // A body that fails to cancel is already gone: the redirect is judged on its headers alone.
            await response.body?.cancel().catch(() => undefined);

            if (method !== "GET") {
                throw new HostApiError("The host redirected a write", 0);
            }

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
