/**
 * @file "The session read failed" is not "there is no session".
 *
 * Three things read the session over HTTP, and each turned a FAILED read into
 * "signed out":
 *
 * - Lunora's identity probe (`LunoraClient.getCurrentUser`, `GET
 *   /api/auth/get-session`) returns `null` for ANY non-2xx answer, so a 429
 *   settled the auth status as `unauthenticated` and `<Authenticated>` hid the
 *   whole dashboard shell (no breadcrumb, no sidebar) over a valid session.
 * - better-auth's session atom (`authClient.useSession`) settles a first read
 *   that failed as `{ data: null, isPending: false }` — indistinguishable from
 *   "nobody" to every consumer — and never asks again.
 * - the server-side token fetch (`lunora-auth-start.ts#getToken`, `GET
 *   /api/auth/token`) answered `undefined` for a 429, the root route set
 *   `isAuthenticated: false`, and every guarded route redirected to sign-in.
 *
 * better-auth rate-limits `/api/auth/*` per client IP (see `rateLimit` in
 * `backend/lunora/auth.ts`), so many people behind one office NAT or VPN share
 * a bucket and can hit this without doing anything unusual.
 *
 * The rule everywhere: only a SUCCESSFUL answer can say "signed out". A 429, a
 * 5xx or a network failure is retried with backoff (honouring the server's
 * `X-Retry-After` / `Retry-After`), and when the retries run out the failure is
 * reported AS a failure — a thrown error, or the error response — never as an
 * empty session.
 *
 * ✅ Safe to import anywhere (no browser or server APIs beyond `fetch`)
 */

/**
 * What the app knows about the session. `unknown` is the state this file
 * exists for: the read failed, so the user may well be signed in.
 */
export type SessionAuthStatus = "authenticated" | "unauthenticated" | "unknown";

/** Statuses that say "try again", not "no". 401/403 are answers and are never retried. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** better-auth's rate limiter sets `X-Retry-After` (seconds); proxies use the standard `Retry-After`. */
const RETRY_AFTER_HEADERS = ["x-retry-after", "retry-after"] as const;

const DIGITS_RE = /^\d+$/;

export const isRetryableStatus = (status: number): boolean => RETRYABLE_STATUSES.has(status);

/**
 * How long the server asked us to wait, in ms, or `undefined` when it did not
 * say. Accepts delta-seconds and an HTTP-date.
 */
export const retryAfterMs = (headers: Headers, now: number = Date.now()): number | undefined => {
    for (const name of RETRY_AFTER_HEADERS) {
        const raw = headers.get(name)?.trim();

        if (!raw) {
            continue;
        }

        if (DIGITS_RE.test(raw)) {
            return Number(raw) * 1000;
        }

        const date = Date.parse(raw);

        if (!Number.isNaN(date)) {
            return Math.max(0, date - now);
        }
    }

    return undefined;
};

/** A session read that failed; `status` is absent for a network failure. */
export class SessionReadFailedError extends Error {
    public override readonly cause: unknown;

    public readonly status: number | undefined;

    public constructor(status: number | undefined, cause?: unknown) {
        super(status === undefined ? "Session read failed: network error" : `Session read failed: HTTP ${String(status)}`);
        this.name = "SessionReadFailedError";
        this.status = status;
        this.cause = cause;
    }
}

export interface SessionReadRetryPolicy {
    /** Total attempts, the first included. */
    attempts: number;
    /** First backoff step; each later one doubles. */
    baseDelayMs: number;
    /** Ceiling for a single wait, the server's `Retry-After` included. */
    maxDelayMs: number;
}

/**
 * Browser policy: 6 attempts, waits of 1, 2, 4, 8, 15 s (or longer when the
 * server asks, up to 15 s) — about 30 s in all. better-auth's window is 10 s,
 * and its `X-Retry-After` names the moment it reopens, so one honoured wait
 * normally clears a 429.
 */
export const BROWSER_SESSION_READ_POLICY: SessionReadRetryPolicy = { attempts: 6, baseDelayMs: 1000, maxDelayMs: 15_000 };

/**
 * On the server a read is never retried: a render must not sit out a rate
 * limit window. The failure is still reported as a failure, and the browser
 * retries once it hydrates.
 */
export const SERVER_SESSION_READ_POLICY: SessionReadRetryPolicy = { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

const defaultPolicy = (): SessionReadRetryPolicy => (globalThis.window === undefined ? SERVER_SESSION_READ_POLICY : BROWSER_SESSION_READ_POLICY);

const defaultSleep = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
};

/** Wait before retry number `retry` (0-based): the server's ask when it made one, else exponential; capped. */
export const retryDelayMs = (policy: SessionReadRetryPolicy, retry: number, serverAskMs: number | undefined): number => {
    const backoff = policy.baseDelayMs * 2 ** retry;

    return Math.min(serverAskMs ?? backoff, policy.maxDelayMs);
};

export interface ReadWithRetryOptions {
    policy: SessionReadRetryPolicy;
    /** The caller's abort: stops the retries, rejecting with its reason. */
    signal?: AbortSignal | null;
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `read` until it answers something other than a retryable failure.
 *
 * Resolves with the first non-retryable response (a 2xx, or an answer such as
 * 401). Rejects with `SessionReadFailedError` when every attempt failed — the
 * caller decides what a failure means, but it is never an empty session.
 */
export const readWithRetry = async (read: () => Promise<Response>, { policy, signal, sleep = defaultSleep }: ReadWithRetryOptions): Promise<Response> => {
    let lastFailure: SessionReadFailedError | undefined;

    for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
        let serverAskMs: number | undefined;

        // The caller gave up (better-auth aborts a superseded session read): stop, do not retry for nobody.
        signal?.throwIfAborted();

        try {
            const response = await read();

            if (!isRetryableStatus(response.status)) {
                return response;
            }

            serverAskMs = retryAfterMs(response.headers);
            lastFailure = new SessionReadFailedError(response.status);
            // Nobody will read this body; an unconsumed one is a `wrangler dev` crash trigger (CLAUDE.md).

            await response.body?.cancel().catch(() => undefined);
        } catch (error) {
            // An abort is the caller giving up, not the server failing.
            if (error instanceof DOMException && error.name === "AbortError") {
                throw error;
            }

            lastFailure = new SessionReadFailedError(undefined, error);
        }

        if (attempt < policy.attempts - 1) {
            await sleep(retryDelayMs(policy, attempt, serverAskMs));
        }
    }

    throw lastFailure ?? new SessionReadFailedError(undefined);
};

/** What `fetch` accepts as its first argument. */
type RequestInput = Request | string | URL;

const urlOf = (input: RequestInput): string => {
    if (typeof input === "string") {
        return input;
    }

    if (input instanceof URL) {
        return input.href;
    }

    return input.url;
};

/** A `GET …/get-session` — the session READ. The `POST` form refreshes the session and is left alone. */
export const isSessionReadRequest = (input: RequestInput, init?: RequestInit): boolean => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    if (method !== "GET") {
        return false;
    }

    try {
        return new URL(urlOf(input), "http://localhost").pathname.endsWith("/get-session");
    } catch {
        return false;
    }
};

type FetchLike = (input: RequestInput, init?: RequestInit) => Promise<Response>;

/** A read with its own query (`disableCookieCache`, …) asks for something the shared read does not answer. */
const hasQuery = (input: RequestInput): boolean => {
    try {
        return new URL(urlOf(input), "http://localhost").search !== "";
    } catch {
        return true;
    }
};

/**
 * Requests that cannot change who is signed in, though they are not GETs.
 * Every other non-GET auth request (sign-in/up/out, set-active organization,
 * impersonate / stop-impersonating, update-user, revoke-session, the session
 * refresh `POST /get-session`, …) invalidates the shared read.
 */
const READ_ONLY_AUTH_POSTS = ["/organization/has-permission", "/admin/has-permission", "/organization/check-slug"];

/** GETs that DO change the session — they land the user signed in. */
const SESSION_CHANGING_GETS = ["/verify-email", "/magic-link/verify"];

/** Whether an auth request may change the session, so a cached read of it is stale from here on. */
export const isSessionChangingRequest = (input: RequestInput, init?: RequestInit): boolean => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let pathname: string;

    try {
        pathname = new URL(urlOf(input), "http://localhost").pathname;
    } catch {
        return true;
    }

    if (method === "GET" || method === "HEAD") {
        return SESSION_CHANGING_GETS.some((path) => pathname.endsWith(path));
    }

    return READ_ONLY_AUTH_POSTS.every((path) => !pathname.endsWith(path));
};

/**
 * One page load used to read the session THREE times — better-auth's session
 * atom (`authClient.useSession`), the TanStack `["session"]` query
 * (`features/auth/hooks/session-user-management.ts`, `authClient.getSession`)
 * and Lunora's identity probe (`LunoraClient.getCurrentUser`, straight to the
 * backend origin). Each had its own cache, none knew of the others, and they
 * fire within a moment of each other — the TanStack one often only after
 * Lunora's probe has opened `<Authenticated>` and mounted the dashboard shell.
 *
 * This is the one read they share: concurrent readers join the read in flight,
 * and a read that ANSWERED is reused for `freshForMs`. Anything that may change
 * the session calls `invalidate()` (see `isSessionChangingRequest`; the auth
 * client calls it when such a request starts AND when it finishes), after
 * which the next reader goes to the network. A FAILED read (retries exhausted)
 * is never cached: every reader sees the failure, and the next one tries again.
 */
export interface SharedSessionRead {
    /** Drop the cached read; the next reader starts a fresh one. A read still in flight is not reused either. */
    invalidate: () => void;
    /** A fresh copy of the shared answer. Rejects with `SessionReadFailedError` when it failed, or with the caller's abort. */
    read: (signal?: AbortSignal | null) => Promise<Response>;
}

export interface SharedSessionReadOptions {
    /** How long an answered read is reused. Short: it only has to span one page load's readers. */
    freshForMs?: number;
    now?: () => number;
    policy?: SessionReadRetryPolicy;
    /** The one network read — a `GET …/get-session` carrying the session cookie. */
    readSession: () => Promise<Response>;
    sleep?: (ms: number) => Promise<void>;
}

/** Long enough for one page load's three readers (the last one waits for `<Authenticated>` to open), short enough to be invisible. */
export const SHARED_SESSION_READ_FRESH_MS = 10_000;

interface ResponseSnapshot {
    body: string;
    headers: [string, string][];
    status: number;
    statusText: string;
}

const snapshotOf = async (response: Response): Promise<ResponseSnapshot> => {
    return {
        body: await response.text(),
        headers: [...response.headers.entries()],
        status: response.status,
        statusText: response.statusText,
    };
};

/** `new Response(body, …)` throws for these statuses unless the body is null. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const responseOf = (snapshot: ResponseSnapshot): Response =>
    new Response(NULL_BODY_STATUSES.has(snapshot.status) ? null : snapshot.body, {
        headers: snapshot.headers,
        status: snapshot.status,
        statusText: snapshot.statusText,
    });

/** The caller's abort ends ITS wait, not the shared read other callers still want. */
const untilAborted = async <T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> => {
    if (!signal) {
        return await promise;
    }

    signal.throwIfAborted();

    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        };

        signal.addEventListener("abort", onAbort, { once: true });
        promise
            .finally(() => {
                signal.removeEventListener("abort", onAbort);
            })
            .then(resolve)
            .catch(reject);
    });
};

export const createSharedSessionRead = ({
    freshForMs = SHARED_SESSION_READ_FRESH_MS,
    now = Date.now,
    policy,
    readSession,
    sleep,
}: SharedSessionReadOptions): SharedSessionRead => {
    let generation = 0;
    let flight: { generation: number; promise: Promise<ResponseSnapshot> } | undefined;
    let cached: { at: number; generation: number; snapshot: ResponseSnapshot } | undefined;

    const start = (): Promise<ResponseSnapshot> => {
        const startedAt = generation;
        const promise = (async () => {
            const response = await readWithRetry(readSession, { policy: policy ?? defaultPolicy(), sleep });
            const snapshot = await snapshotOf(response);

            // An invalidation while this read was out means it may predate the change: answer its waiters, cache nothing.
            if (startedAt === generation) {
                cached = { at: now(), generation: startedAt, snapshot };
            }

            return snapshot;
        })();
        const current = { generation: startedAt, promise };

        flight = current;

        const settle = () => {
            if (flight === current) {
                flight = undefined;
            }
        };

        // Settled either way; the readers handle the outcome.
        void promise.finally(settle).catch(() => undefined);

        return promise;
    };

    return {
        invalidate: () => {
            generation += 1;
            cached = undefined;
            flight = undefined;
        },
        read: async (signal) => {
            signal?.throwIfAborted();

            if (cached?.generation === generation && now() - cached.at < freshForMs) {
                return responseOf(cached.snapshot);
            }

            const promise = flight?.generation === generation ? flight.promise : start();

            return responseOf(await untilAborted(promise, signal));
        },
    };
};

export interface SessionReadFetchOptions extends Partial<ReadWithRetryOptions> {
    /**
     * What an exhausted read turns into.
     *
     * - `"throw"`: reject with `SessionReadFailedError`. For Lunora's identity
     *   probe: a thrown probe settles as `unreachable`, which keeps the
     *   `<Authenticated>` gate open with the last known user — the upstream
     *   contract for "could not ask" — where a returned 429 would settle as
     *   `unauthenticated`.
     * - `"respond"`: answer with a synthetic 503 carrying the failure. For
     *   better-auth's client: better-fetch turns it into `{ error }`, and the
     *   session atom keeps the session it had instead of clearing it (it clears
     *   only on 401).
     */
    onExhausted: "respond" | "throw";

    /**
     * Answer plain session reads from this one shared read instead of the
     * caller's own request (browser only — see `shared-session.ts`). A read
     * with a query string still goes out on its own.
     */
    shared?: SharedSessionRead;
}

/**
 * Wrap `fetch` so a session READ retries through a 429/5xx/network failure.
 * Every other request passes straight through, untouched.
 */
export const createSessionReadFetch =
    (baseFetch: FetchLike, { onExhausted, policy, shared, sleep }: SessionReadFetchOptions): FetchLike =>
    async (input, init) => {
        if (!isSessionReadRequest(input, init)) {
            return await baseFetch(input, init);
        }

        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);

        // Re-sending the same input is safe: a GET carries no body to consume.
        const read = async () => await baseFetch(input, init);

        try {
            if (shared && !hasQuery(input)) {
                return await shared.read(signal);
            }

            return await readWithRetry(read, {
                policy: policy ?? defaultPolicy(),
                signal,
                sleep,
            });
        } catch (error) {
            if (onExhausted === "throw" || !(error instanceof SessionReadFailedError)) {
                throw error;
            }

            return Response.json({ code: "SESSION_READ_FAILED", message: error.message }, { status: 503, statusText: "Session read failed" });
        }
    };

/** The slice of better-auth's session atom (`authClient.$store.atoms.session`) the recovery needs. */
export interface SessionAtomLike {
    get: () => { error: unknown; isPending: boolean; isRefetching: boolean; refetch?: () => Promise<unknown> | void };
    listen: (listener: () => void) => () => void;
}

export interface SessionAtomRecoveryOptions {
    /** First re-read after a failed one; doubles per consecutive failure. */
    baseDelayMs?: number;
    clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
    maxDelayMs?: number;
    setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

const errorStatus = (error: unknown): number | undefined => {
    const status = (error as { status?: unknown } | null | undefined)?.status;

    return typeof status === "number" ? status : undefined;
};

/**
 * Keep re-reading the session while better-auth's atom holds a FAILED read.
 *
 * The atom settles a failure and then waits for an outside trigger (focus
 * refetch is off in this app), so a first read that ran out of retries would
 * leave `useSession()` empty for the rest of the page's life. A 401 is an
 * answer — "no session" — and is left alone; so is a success, which resets the
 * backoff. Returns the unsubscribe.
 */
export const keepRetryingFailedSessionReads = (
    atom: SessionAtomLike,
    { baseDelayMs = 15_000, clearTimer = clearTimeout, maxDelayMs = 120_000, setTimer = setTimeout }: SessionAtomRecoveryOptions = {},
): (() => void) => {
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onChange = () => {
        const { error, isPending, isRefetching, refetch } = atom.get();

        if (isRefetching || (isPending && !error)) {
            return;
        }

        if (!error || errorStatus(error) === 401) {
            failures = 0;

            if (timer !== undefined) {
                clearTimer(timer);
                timer = undefined;
            }

            return;
        }

        if (timer !== undefined || !refetch) {
            return;
        }

        const delay = Math.min(baseDelayMs * 2 ** failures, maxDelayMs);

        failures += 1;
        timer = setTimer(() => {
            timer = undefined;
            void Promise.resolve(refetch()).catch(() => undefined);
        }, delay);
    };

    // `listen`, not `subscribe`: it neither fires now nor mounts the atom (mounting starts a session fetch).
    const unsubscribe = atom.listen(onChange);

    return () => {
        unsubscribe();

        if (timer !== undefined) {
            clearTimer(timer);
        }
    };
};
