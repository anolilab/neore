/**
 * Outbound `fetch` with a deadline.
 *
 * ## Why this is a security control, not a nicety
 *
 * Every unsharded procedure in this app runs on the ONE `__root__` Durable
 * Object, so they serialize app-wide (see "Sharding and concurrency" in the root
 * AGENTS.md). An outbound call with no deadline therefore holds that shard for as
 * long as the remote end cares to stall — which makes a slow or hostile third
 * party into an app-wide denial of service, without needing to touch us directly.
 *
 * That is not theoretical here. `getChangelogs` fetched Featurebase with no
 * timeout and no negative caching, so a bad API key meant a multi-second stall on
 * every* page load; one observed call sat 8.5s and blocked five other
 * first-paint queries for 5.8s. It was the first of these to be fixed, and the
 * rest of the tree had the same shape.
 *
 * ## Choosing a timeout
 *
 * Pick the smallest bound the call can actually live within — a deadline that is
 * too generous is barely better than none. The three constants below cover the
 * shapes in this tree; reach for an explicit `timeoutMs` when a call genuinely
 * does not fit one.
 *
 * ## What this must NOT be used for
 *
 * **Streaming responses.** `AbortSignal.timeout()` bounds the WHOLE request,
 * body included, so wrapping a stream kills it mid-flight once the deadline
 * passes — a long model generation would be truncated for no reason. The two
 * streaming call sites (`chat/lib/gateway-client.ts`, `gateway-language-model.ts`)
 * are deliberately excluded and say so at the call site.
 *
 * ## Not to be confused with `chat/tools/utilities.ts#fetchWithTimeout`
 *
 * That one is for AI-TOOL fetches of user-supplied URLs: it refuses unsafe hosts
 * (`isSafeUrl`) and defaults `redirect: "manual"`, because there the URL is
 * attacker-influenced and SSRF is the threat. This one is for calls to hosts WE
 * chose — the gateway, R2, Resend, messenger APIs — where the threat is a stalled
 * response holding the `__root__` shard. Different risks, so deliberately
 * different functions; do not merge them.
 */

/** Control-plane calls that should be instant: webhooks, notifications, small REST. */
export const FETCH_TIMEOUT_SHORT_MS = 5000;

/** The default for an ordinary JSON request/response against a third party. */
export const FETCH_TIMEOUT_MS = 15_000;

/** Uploads, downloads and non-streaming model calls, which are legitimately slow. */
export const FETCH_TIMEOUT_LONG_MS = 60_000;

export type FetchWithDeadlineInit = RequestInit & {
    timeoutMs?: number;
    /**
     * The transport, when it is not the global `fetch` — a service binding's
     * (`lib/services.ts#serviceFetch`). The deadline applies the same way.
     */
    via?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
};

/**
 * `fetch`, with a deadline that defaults to {@link FETCH_TIMEOUT_MS}.
 *
 * A caller-supplied `signal` is COMBINED with the deadline rather than replaced,
 * so cancellation still propagates — overwriting it would silently break every
 * caller that passes one, which is the kind of regression a wrapper like this is
 * supposed to prevent rather than introduce.
 */
export const fetchWithDeadline = async (input: RequestInfo | URL, init: FetchWithDeadlineInit = {}): Promise<Response> => {
    const { signal, timeoutMs = FETCH_TIMEOUT_MS, via, ...rest } = init;
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestInit = { ...rest, signal: signal ? AbortSignal.any([signal, deadline]) : deadline };

    return via === undefined ? await fetch(input as RequestInfo, requestInit) : await via(input as Request | string | URL, requestInit);
};

/** How much of an error body {@link assertOk} keeps when asked to read it. */
export const HTTP_ERROR_BODY_MAX_CHARS = 500;

/**
 * A non-2xx response, thrown by {@link assertOk} / {@link fetchOk}.
 *
 * `message` is `"<prefix>: <status> <statusText>"` — the exact string the
 * hand-written `throw new Error(...)` branches produced, so converting a call
 * site does not change what a tool reports. `body` is set only when the caller
 * asked for it, truncated to {@link HTTP_ERROR_BODY_MAX_CHARS}.
 */
export class HttpError extends Error {
    public readonly body: string | undefined;

    public readonly status: number;

    public readonly statusText: string;

    public constructor(prefix: string, status: number, statusText: string, body?: string) {
        super(`${prefix}: ${status} ${statusText}`);
        this.name = "HttpError";
        this.status = status;
        this.statusText = statusText;
        this.body = body;
    }
}

export interface AssertOkOptions {
    /** Read (and truncate) the error body onto `HttpError.body` instead of cancelling it. */
    includeBody?: boolean;
}

/**
 * Returns `response` when it is OK; otherwise disposes of its body and throws an
 * {@link HttpError}.
 *
 * The body MUST be consumed or cancelled on every early return: a Worker that
 * leaves a failed response's stream unread holds a socket nobody drains, and
 * `wrangler dev` escalates that into a fatal `Network connection lost.` (root
 * AGENTS.md, "Local dev"). This is the one place that does it, so a call site
 * cannot forget. Transport-agnostic — it works on a response from
 * {@link fetchWithDeadline} or from the SSRF-guarded tool `fetchWithTimeout`.
 */
export const assertOk = async (response: Response, prefix = "Request failed", options: AssertOkOptions = {}): Promise<Response> => {
    if (response.ok) {
        return response;
    }

    let body: string | undefined;

    if (options.includeBody) {
        const text = await response.text().catch(() => "");

        body = text.slice(0, HTTP_ERROR_BODY_MAX_CHARS);
    } else {
        await response.body?.cancel();
    }

    throw new HttpError(prefix, response.status, response.statusText, body);
};

export type FetchOkInit = AssertOkOptions & FetchWithDeadlineInit & { errorPrefix?: string };

/** Runs {@link fetchWithDeadline}, then {@link assertOk}: resolves only with an OK response. */
export const fetchOk = async (input: RequestInfo | URL, init: FetchOkInit = {}): Promise<Response> => {
    const { errorPrefix, includeBody, ...fetchInit } = init;

    return await assertOk(await fetchWithDeadline(input, fetchInit), errorPrefix, { includeBody });
};
