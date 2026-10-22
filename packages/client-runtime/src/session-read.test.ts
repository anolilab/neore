import { LunoraClient } from "@lunora/client";
import { getIdentityStore } from "@lunora/client/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionAtomLike, SessionReadRetryPolicy } from "./session-read";
import {
    createSessionReadFetch,
    createSharedSessionRead,
    isSessionChangingRequest,
    isSessionReadRequest,
    keepRetryingFailedSessionReads,
    readWithRetry,
    retryAfterMs,
    SessionReadFailedError,
} from "./session-read";

const POLICY: SessionReadRetryPolicy = { attempts: 4, baseDelayMs: 100, maxDelayMs: 5000 };
const SESSION_URL = "http://localhost:8788/api/auth/get-session";
const USER = { id: "user_1", name: "Ada" };

const rateLimited = (retryAfterSeconds = 7): Response =>
    Response.json({ message: "Too many requests. Please try again later." }, { headers: { "X-Retry-After": String(retryAfterSeconds) }, status: 429 });

const signedIn = (): Response => Response.json({ session: { id: "s_1" }, user: USER });

/** Better-auth answers 200 with a `null` body when there is no session. */
const signedOut = (): Response => Response.json(null);

/** A fetch that answers from a script, one response (or thrown error) per call. */
const scripted = (...answers: (Error | (() => Response))[]) => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: Request | string | URL) => {
        calls.push(input instanceof Request ? input.url : String(input));

        const next = answers.shift();

        if (!next) {
            throw new Error("fetch called more often than scripted");
        }

        if (next instanceof Error) {
            throw next;
        }

        return next();
    });

    return { calls, fetchImpl };
};

const noSleep = vi.fn(async (_ms: number) => {});

afterEach(() => {
    noSleep.mockClear();
});

describe(retryAfterMs, () => {
    it("reads better-auth's X-Retry-After seconds", () => {
        expect(retryAfterMs(new Headers({ "X-Retry-After": "7" }))).toBe(7000);
    });

    it("reads a standard Retry-After, as seconds or an HTTP date", () => {
        const now = Date.parse("2026-09-28T12:00:00Z");

        expect(retryAfterMs(new Headers({ "Retry-After": "3" }), now)).toBe(3000);
        expect(retryAfterMs(new Headers({ "Retry-After": "Mon, 28 Sep 2026 12:00:05 GMT" }), now)).toBe(5000);
    });

    it("is undefined when the server did not say", () => {
        expect(retryAfterMs(new Headers())).toBeUndefined();
        expect(retryAfterMs(new Headers({ "Retry-After": "soon" }))).toBeUndefined();
    });
});

describe(readWithRetry, () => {
    it("retries a 429 after the wait the server named, and returns the recovered answer", async () => {
        const { fetchImpl } = scripted(() => rateLimited(2), signedIn);

        const response = await readWithRetry(async () => await fetchImpl(SESSION_URL), { policy: POLICY, sleep: noSleep });

        expect(response.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(noSleep).toHaveBeenCalledExactlyOnceWith(2000);
    });

    it("backs off exponentially when no wait is named, through 5xx and network failures", async () => {
        const { fetchImpl } = scripted(() => new Response(null, { status: 503 }), new TypeError("fetch failed"), signedIn);

        const response = await readWithRetry(async () => await fetchImpl(SESSION_URL), { policy: POLICY, sleep: noSleep });

        expect(response.status).toBe(200);
        expect(noSleep.mock.calls.map(([ms]) => ms)).toStrictEqual([100, 200]);
    });

    it("caps a long server wait at the policy's ceiling", async () => {
        const { fetchImpl } = scripted(() => rateLimited(60), signedIn);

        await readWithRetry(async () => await fetchImpl(SESSION_URL), { policy: POLICY, sleep: noSleep });

        expect(noSleep).toHaveBeenCalledExactlyOnceWith(5000);
    });

    it("rejects with the failure, never an empty answer, when every attempt fails", async () => {
        const { fetchImpl } = scripted(rateLimited, rateLimited, rateLimited, rateLimited);

        await expect(readWithRetry(async () => await fetchImpl(SESSION_URL), { policy: POLICY, sleep: noSleep })).rejects.toMatchObject({
            name: "SessionReadFailedError",
            status: 429,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(POLICY.attempts);
    });

    it("returns an ANSWER at once: a 401 is not retried", async () => {
        const { fetchImpl } = scripted(() => new Response(null, { status: 401 }));

        const response = await readWithRetry(async () => await fetchImpl(SESSION_URL), { policy: POLICY, sleep: noSleep });

        expect(response.status).toBe(401);
        expect(noSleep).not.toHaveBeenCalled();
    });

    it("stops when the caller aborts", async () => {
        const controller = new AbortController();
        const { fetchImpl } = scripted(rateLimited, signedIn);
        const sleep = vi.fn(async () => {
            controller.abort();
        });

        await expect(readWithRetry(async () => await fetchImpl(SESSION_URL), { policy: POLICY, signal: controller.signal, sleep })).rejects.toThrow();
        expect(fetchImpl).toHaveBeenCalledOnce();
    });
});

describe(isSessionReadRequest, () => {
    it("matches only a GET of get-session", () => {
        expect(isSessionReadRequest(SESSION_URL)).toBe(true);
        expect(isSessionReadRequest("/api/auth/get-session?disableCookieCache=true")).toBe(true);
        expect(isSessionReadRequest(SESSION_URL, { method: "POST" })).toBe(false);
        expect(isSessionReadRequest("http://localhost:8788/api/auth/token")).toBe(false);
        expect(isSessionReadRequest("http://localhost:8788/_lunora/rpc", { method: "POST" })).toBe(false);
    });
});

describe(createSessionReadFetch, () => {
    it("passes every other request straight through, 429 included", async () => {
        const { fetchImpl } = scripted(rateLimited);
        const wrapped = createSessionReadFetch(fetchImpl, { onExhausted: "throw", policy: POLICY, sleep: noSleep });

        const response = await wrapped("http://localhost:8788/_lunora/rpc", { method: "POST" });

        expect(response.status).toBe(429);
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it("respond mode: an exhausted read is an ERROR response, not an empty session", async () => {
        const { fetchImpl } = scripted(rateLimited, rateLimited, rateLimited, rateLimited);
        const wrapped = createSessionReadFetch(fetchImpl, { onExhausted: "respond", policy: POLICY, sleep: noSleep });

        const response = await wrapped(SESSION_URL);

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({ code: "SESSION_READ_FAILED" });
    });

    it("throw mode: an exhausted read rejects", async () => {
        const { fetchImpl } = scripted(rateLimited, rateLimited, rateLimited, rateLimited);
        const wrapped = createSessionReadFetch(fetchImpl, { onExhausted: "throw", policy: POLICY, sleep: noSleep });

        await expect(wrapped(SESSION_URL)).rejects.toBeInstanceOf(SessionReadFailedError);
    });
});

/**
 * The real `LunoraClient` identity probe behind the wrapper: this is the read
 * whose 429 used to settle as `unauthenticated` and hide the dashboard shell.
 */
describe("Lunora identity probe through the session-read fetch", () => {
    const clientWith = (fetchImpl: ReturnType<typeof scripted>["fetchImpl"]) => {
        const client = new LunoraClient({
            fetch: createSessionReadFetch(fetchImpl, { onExhausted: "throw", policy: POLICY, sleep: noSleep }) as typeof fetch,
            url: "http://localhost:8788",
        });

        client.setAuthToken("jwt");

        return client;
    };

    /** Subscribe to the identity store and wait for it to leave `loading`. */
    const settledStatus = async (client: LunoraClient): Promise<string> => {
        const store = getIdentityStore(client);

        // The subscription ends with the client (`client.close()` in each test).
        return await new Promise((resolve) => {
            const check = () => {
                const status = store.getStatus();

                if (status !== "loading") {
                    resolve(status);
                }
            };

            store.subscribe(check);
            check();
        });
    };

    // The bug, pinned: WITHOUT the wrapper one 429 settles a signed-in user as signed out.
    it("control: the bare client reads a 429 probe as unauthenticated", async () => {
        const { fetchImpl } = scripted(rateLimited);
        const client = new LunoraClient({ fetch: fetchImpl as typeof fetch, url: "http://localhost:8788" });

        client.setAuthToken("jwt");

        await expect(settledStatus(client)).resolves.toBe("unauthenticated");
        client.close();
    });

    it("retries a rate-limited probe and recovers the signed-in user", async () => {
        const { calls, fetchImpl } = scripted(rateLimited, signedIn);
        const client = clientWith(fetchImpl);

        await expect(settledStatus(client)).resolves.toBe("authenticated");
        expect(getIdentityStore(client).getUser()).toMatchObject(USER);
        expect(calls.every((url) => url.endsWith("/api/auth/get-session"))).toBe(true);
        client.close();
    });

    it("settles a probe that stays rate-limited as unreachable, never unauthenticated", async () => {
        const { fetchImpl } = scripted(rateLimited, rateLimited, rateLimited, rateLimited);
        const client = clientWith(fetchImpl);

        const status = await settledStatus(client);

        expect(status).toBe("unreachable");
        client.close();
    });

    it("still signs out on a SUCCESSFUL read that finds no session", async () => {
        const { fetchImpl } = scripted(signedOut);
        const client = clientWith(fetchImpl);

        await expect(settledStatus(client)).resolves.toBe("unauthenticated");
        client.close();
    });
});

describe(keepRetryingFailedSessionReads, () => {
    type State = ReturnType<SessionAtomLike["get"]>;

    const fakeAtom = (initial: Partial<State>) => {
        let state: State = { error: null, isPending: false, isRefetching: false, refetch: vi.fn(), ...initial };
        const listeners = new Set<() => void>();

        return {
            atom: {
                get: () => state,
                listen: (listener: () => void) => {
                    listeners.add(listener);

                    return () => listeners.delete(listener);
                },
            } satisfies SessionAtomLike,
            set: (next: Partial<State>) => {
                state = { ...state, ...next };

                for (const listener of listeners) {
                    listener();
                }
            },
            state: () => state,
        };
    };

    const timers = () => {
        const pending: { callback: () => void; ms: number }[] = [];

        return {
            clearTimer: vi.fn(),
            pending,
            setTimer: (callback: () => void, ms: number) => {
                pending.push({ callback, ms });

                return pending.length as unknown as ReturnType<typeof setTimeout>;
            },
        };
    };

    it("re-reads a failed session with growing backoff until it succeeds", () => {
        const { atom, set, state } = fakeAtom({});
        const clock = timers();

        keepRetryingFailedSessionReads(atom, { baseDelayMs: 1000, ...clock });

        set({ error: { status: 503 } });
        expect(clock.pending.map(({ ms }) => ms)).toStrictEqual([1000]);

        clock.pending[0]?.callback();
        expect(state().refetch).toHaveBeenCalledOnce();

        set({ isRefetching: true });
        set({ error: { status: 503 }, isRefetching: false });
        expect(clock.pending.map(({ ms }) => ms)).toStrictEqual([1000, 2000]);

        clock.pending[1]?.callback();
        set({ error: null });
        set({ error: { status: 503 } });
        // A success resets the backoff.
        expect(clock.pending.at(-1)?.ms).toBe(1000);
    });

    it("leaves a 401 alone: that is an answer, not a failure", () => {
        const { atom, set } = fakeAtom({});
        const clock = timers();

        keepRetryingFailedSessionReads(atom, clock);
        set({ error: { status: 401 } });

        expect(clock.pending).toHaveLength(0);
    });
});

describe(isSessionChangingRequest, () => {
    it("every auth POST changes the session except the read-only checks", () => {
        expect(isSessionChangingRequest("/api/auth/sign-in/email", { method: "POST" })).toBe(true);
        expect(isSessionChangingRequest("/api/auth/sign-out", { method: "POST" })).toBe(true);
        expect(isSessionChangingRequest("/api/auth/organization/set-active", { method: "POST" })).toBe(true);
        expect(isSessionChangingRequest("/api/auth/admin/impersonate-user", { method: "POST" })).toBe(true);
        expect(isSessionChangingRequest("/api/auth/get-session", { method: "POST" })).toBe(true);
        expect(isSessionChangingRequest("/api/auth/organization/has-permission", { method: "POST" })).toBe(false);
    });

    it("a GET changes nothing, except the ones that land a sign-in", () => {
        expect(isSessionChangingRequest("/api/auth/get-session")).toBe(false);
        expect(isSessionChangingRequest("/api/auth/list-sessions")).toBe(false);
        expect(isSessionChangingRequest("/api/auth/magic-link/verify?token=x")).toBe(true);
        expect(isSessionChangingRequest("/api/auth/verify-email?token=x")).toBe(true);
    });
});

describe(createSharedSessionRead, () => {
    /** Reads that stay open until `answer` is called; it answers every one still open. */
    const gatedRead = () => {
        const open: ((response: Response) => void)[] = [];
        const readSession = vi.fn(
            async () =>
                await new Promise<Response>((resolve) => {
                    open.push(resolve);
                }),
        );

        return {
            answer: (makeResponse: () => Response) => {
                const pending = [...open];

                open.length = 0;

                for (const resolve of pending) {
                    resolve(makeResponse());
                }
            },
            readSession,
        };
    };

    it("concurrent readers join ONE read, and each gets its own readable copy", async () => {
        const { answer, readSession } = gatedRead();
        const shared = createSharedSessionRead({ policy: POLICY, readSession, sleep: noSleep });

        const reads = [shared.read(), shared.read(), shared.read()];

        await Promise.resolve();
        answer(signedIn);

        const bodies = await Promise.all(reads.map(async (read) => await read.then(async (response) => await response.json())));

        expect(readSession).toHaveBeenCalledOnce();
        expect(bodies).toStrictEqual([
            { session: { id: "s_1" }, user: USER },
            { session: { id: "s_1" }, user: USER },
            { session: { id: "s_1" }, user: USER },
        ]);
    });

    it("reuses an answered read while fresh, and reads again once it is not", async () => {
        let now = 1000;
        const readSession = vi.fn(async () => signedIn());
        const shared = createSharedSessionRead({ freshForMs: 5000, now: () => now, policy: POLICY, readSession, sleep: noSleep });

        await shared.read();
        now += 4999;
        await shared.read();

        expect(readSession).toHaveBeenCalledOnce();

        now += 1;
        await shared.read();

        expect(readSession).toHaveBeenCalledTimes(2);
    });

    it("reuses an answered EMPTY read too: only a successful answer is cached", async () => {
        const readSession = vi.fn(async () => signedOut());
        const shared = createSharedSessionRead({ policy: POLICY, readSession, sleep: noSleep });

        await expect(shared.read().then(async (response) => await response.json())).resolves.toBeNull();
        await expect(shared.read().then(async (response) => await response.json())).resolves.toBeNull();

        expect(readSession).toHaveBeenCalledOnce();
    });

    it("invalidate() sends the next reader to the network, and a read that raced it is not cached", async () => {
        const { answer, readSession } = gatedRead();
        const shared = createSharedSessionRead({ policy: POLICY, readSession, sleep: noSleep });

        const before = shared.read();

        await Promise.resolve();
        // Sign-in starts while the read is out: its answer may predate the new session.
        shared.invalidate();

        const after = shared.read();

        expect(readSession).toHaveBeenCalledTimes(2);

        answer(signedIn);
        await before;
        await after;

        await shared.read();

        // `before`'s answer was not cached; `after`'s was.
        expect(readSession).toHaveBeenCalledTimes(2);
    });

    it("a FAILED read reaches every reader as a failure, is not cached, and the next reader retries", async () => {
        const { fetchImpl } = scripted(rateLimited, rateLimited, rateLimited, rateLimited, signedIn);
        const shared = createSharedSessionRead({ policy: POLICY, readSession: async () => await fetchImpl(SESSION_URL), sleep: noSleep });

        const results = await Promise.allSettled([shared.read(), shared.read()]);

        expect(results.map((result) => result.status)).toStrictEqual(["rejected", "rejected"]);
        expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(SessionReadFailedError);

        await expect(shared.read().then(async (response) => await response.json())).resolves.toMatchObject({ user: USER });
        expect(fetchImpl).toHaveBeenCalledTimes(5);
    });

    it("one caller's abort ends its own wait, not the read the others share", async () => {
        const { answer, readSession } = gatedRead();
        const shared = createSharedSessionRead({ policy: POLICY, readSession, sleep: noSleep });
        const controller = new AbortController();

        const aborted = shared.read(controller.signal);
        const kept = shared.read();

        controller.abort();
        await Promise.resolve();
        answer(signedIn);

        await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
        await expect(kept.then(async (response) => await response.json())).resolves.toMatchObject({ user: USER });
        expect(readSession).toHaveBeenCalledOnce();
    });

    it("through createSessionReadFetch: a plain read is shared, a read with its own query is not", async () => {
        const readSession = vi.fn(async () => signedIn());
        const shared = createSharedSessionRead({ policy: POLICY, readSession, sleep: noSleep });
        const { fetchImpl } = scripted(signedIn);
        const wrapped = createSessionReadFetch(fetchImpl, { onExhausted: "respond", policy: POLICY, shared, sleep: noSleep });

        await wrapped(SESSION_URL);
        await wrapped("http://localhost:3000/api/auth/get-session");
        await wrapped(`${SESSION_URL}?disableCookieCache=true`);

        expect(readSession).toHaveBeenCalledOnce();
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it("through createSessionReadFetch: an exhausted shared read is still an error, never an empty session", async () => {
        const { fetchImpl } = scripted(rateLimited, rateLimited, rateLimited, rateLimited);
        const shared = createSharedSessionRead({ policy: POLICY, readSession: async () => await fetchImpl(SESSION_URL), sleep: noSleep });

        const respond = createSessionReadFetch(fetchImpl, { onExhausted: "respond", shared });
        const response = await respond(SESSION_URL);

        expect(response.status).toBe(503);

        const { fetchImpl: again } = scripted(rateLimited, rateLimited, rateLimited, rateLimited);
        const sharedAgain = createSharedSessionRead({ policy: POLICY, readSession: async () => await again(SESSION_URL), sleep: noSleep });
        const thrower = createSessionReadFetch(again, { onExhausted: "throw", shared: sharedAgain });

        await expect(thrower(SESSION_URL)).rejects.toBeInstanceOf(SessionReadFailedError);
    });
});
