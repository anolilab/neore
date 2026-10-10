import { dehydrate, hashKey, hydrate, QueryClient, QueryObserver, skipToken } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveQueryClient } from "./live-queries";
import {
    FIRST_VALUE_TIMEOUT_MS,
    LINGER_MS,
    LIVE_ARGS_META_KEY,
    LiveQueryManager,
    MAX_CONCURRENT_SEEDS,
    SEED_SLOT_TIMEOUT_MS,
    tokenSubject,
} from "./live-queries";

type OnData = (value: unknown) => void;
type OnError = (error: { code?: string; message: string }) => void;

interface FakeSubscription {
    args: unknown;
    onData: OnData;
    onError?: OnError;
    path: string;
    unsubscribe: ReturnType<typeof vi.fn>;
}

const createClient = () => {
    let token: string | null = null;
    const tokenListeners = new Set<(token: string | null) => void>();
    const subscriptions: FakeSubscription[] = [];

    return {
        client: {
            getAuthToken: () => token,
            onAuthTokenChange: (listener: (token: string | null) => void) => {
                tokenListeners.add(listener);

                return () => tokenListeners.delete(listener);
            },
            query: vi.fn(async (_reference: never, _args: never) => "rpc"),
            setWsToken: vi.fn(),
            subscribe: vi.fn((reference: never, args: never, onData: OnData, options?: { onError?: OnError }) => {
                const subscription: FakeSubscription = {
                    args,
                    onData,
                    onError: options?.onError,
                    path: (reference as { __lunoraRef: string }).__lunoraRef,
                    unsubscribe: vi.fn(),
                };

                subscriptions.push(subscription);

                return subscription.unsubscribe;
            }),
        },
        setToken: (next: string | null) => {
            token = next;

            for (const listener of tokenListeners) {
                listener(next);
            }
        },
        subscriptions,
    };
};

const jwt = (sub: string, iat = 1): string => `h.${btoa(JSON.stringify({ iat, sub }))}.s`;

const key = (path: string, args: Record<string, unknown> = {}) => ["lunora", path, args, null] as const;

describe(LiveQueryManager, () => {
    let queryClient: QueryClient;
    let fake: ReturnType<typeof createClient>;
    let manager: LiveQueryManager;
    let mintWsTicket: ReturnType<typeof vi.fn<(bearer: string) => Promise<string | undefined>>>;

    beforeEach(() => {
        vi.useFakeTimers();
        queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
        fake = createClient();
        mintWsTicket = vi.fn(async (bearer: string) => `ticket-for-${tokenSubject(bearer) ?? ""}`);
        // The fake implements the slice structurally; `LunoraClient`'s generic
        // `query`/`subscribe` signatures are what the cast stands in for.
        manager = new LiveQueryManager(fake.client as unknown as LiveQueryClient, queryClient, mintWsTicket);
        manager.connect();
    });

    afterEach(() => {
        manager.disconnect();
        queryClient.clear();
        vi.useRealTimers();
    });

    const observe = (queryKey: ReturnType<typeof key>, extra: Record<string, unknown> = {}) => {
        const observer = new QueryObserver(queryClient, {
            queryFn: async ({ queryKey: k }) => await manager.fetch(k, hashKey(k), { __lunoraRef: queryKey[1] }, queryKey[2]),
            queryKey,
            ...extra,
        });

        return observer.subscribe(() => {});
    };

    it("subscribes when a query gains an observer and pushes into the cache", async () => {
        const unobserve = observe(key("tasks_functions:getTaskBoard", { a: 1 }));

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]).toMatchObject({ args: { a: 1 }, path: "tasks_functions:getTaskBoard" });

        fake.subscriptions[0]!.onData(["task"]);
        await vi.runAllTimersAsync();

        expect(queryClient.getQueryData(key("tasks_functions:getTaskBoard", { a: 1 }))).toStrictEqual(["task"]);

        fake.subscriptions[0]!.onData(["task", "new task"]);

        expect(queryClient.getQueryData(key("tasks_functions:getTaskBoard", { a: 1 }))).toStrictEqual(["task", "new task"]);

        unobserve();
    });

    it("subscribes with the call args, not the key's encoded args string", () => {
        // `@lunora/react` keys args as their wire-encoded string; `crpc` puts the
        // object in meta. Subscribing with the string lost every required arg.
        const encoded = ["lunora", "chat_functions:getThread", '{"threadId":"t1"}', null] as const;
        const observer = new QueryObserver(queryClient, {
            meta: { [LIVE_ARGS_META_KEY]: { threadId: "t1" } },
            queryFn: async () => "rpc",
            queryKey: encoded,
        });
        const unobserve = observer.subscribe(() => {});

        expect(fake.subscriptions[0]).toMatchObject({ args: { threadId: "t1" }, path: "chat_functions:getThread" });

        unobserve();
    });

    it("decodes a string args slot when no meta carries the args", () => {
        const unobserve = observe(["lunora", "x:y", '{"a":1}', null] as unknown as ReturnType<typeof key>);

        expect(fake.subscriptions[0]).toMatchObject({ args: { a: 1 } });

        unobserve();
    });

    it("answers the queryFn from the subscription instead of a second RPC", async () => {
        const unobserve = observe(key("x:y"));

        fake.subscriptions[0]!.onData("pushed");
        await vi.runAllTimersAsync();

        expect(fake.client.query).not.toHaveBeenCalled();
        expect(queryClient.getQueryData(key("x:y"))).toBe("pushed");

        unobserve();
    });

    it("falls back to RPC when the subscription errors", async () => {
        const unobserve = observe(key("x:y"));

        fake.subscriptions[0]!.onError!({ code: "TOO_MANY_SUBSCRIPTIONS", message: "cap" });
        await vi.runAllTimersAsync();

        expect(fake.client.query).toHaveBeenCalledTimes(1);
        expect(queryClient.getQueryData(key("x:y"))).toBe("rpc");

        unobserve();
    });

    it("falls back to RPC when no first value arrives in time", async () => {
        const unobserve = observe(key("x:y"));

        await vi.advanceTimersByTimeAsync(FIRST_VALUE_TIMEOUT_MS + 1);

        expect(fake.client.query).toHaveBeenCalledTimes(1);
        expect(queryClient.getQueryData(key("x:y"))).toBe("rpc");

        unobserve();
    });

    it("keeps a newer push over an RPC snapshot that resolves after it", async () => {
        // The RPC answers "older" on a timer the test advances only AFTER the push.
        const RPC_LATENCY_MS = 50;

        fake.client.query.mockImplementationOnce(async () => {
            await new Promise((resolve) => {
                setTimeout(resolve, RPC_LATENCY_MS);
            });

            return "older";
        });

        // No subscription for this key: an unobserved prefetch.
        const fetching = manager.fetch(key("x:y"), hashKey(key("x:y")), { __lunoraRef: "x:y" }, {});
        const unobserve = observe(key("x:y"));

        fake.subscriptions[0]!.onData("newer");
        await vi.advanceTimersByTimeAsync(RPC_LATENCY_MS);

        expect(await fetching).toBe("newer");

        unobserve();
    });

    it("unsubscribes after the linger once the last observer leaves", () => {
        const unobserve = observe(key("x:y"));

        unobserve();

        expect(fake.subscriptions[0]!.unsubscribe).not.toHaveBeenCalled();

        vi.advanceTimersByTime(LINGER_MS);

        expect(fake.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
        expect(manager.size).toBe(0);
    });

    it("keeps the subscription when an observer returns within the linger", () => {
        observe(key("x:y"))();

        vi.advanceTimersByTime(LINGER_MS / 2);

        const unobserve = observe(key("x:y"));

        vi.advanceTimersByTime(LINGER_MS * 2);

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]!.unsubscribe).not.toHaveBeenCalled();

        unobserve();
    });

    it("unsubscribes at once when the cache drops the query (gc, clear)", () => {
        observe(key("x:y"));

        queryClient.clear();

        expect(fake.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
        expect(manager.size).toBe(0);
    });

    it("does not subscribe an opted-out query", () => {
        const unobserve = observe(key("x:y"), { meta: { lunoraLive: false } });

        expect(fake.subscriptions).toHaveLength(0);

        unobserve();
    });

    it("does not subscribe a disabled or skipped query, and subscribes once it is enabled", () => {
        const skipped = observe(key("x:skipped"), { queryFn: skipToken });
        const observer = new QueryObserver(queryClient, { enabled: false, queryFn: async () => "rpc", queryKey: key("x:y") });
        const unobserve = observer.subscribe(() => {});

        expect(fake.subscriptions).toHaveLength(0);

        observer.setOptions({ enabled: true, queryFn: async () => "rpc", queryKey: key("x:y") });

        expect(fake.subscriptions).toHaveLength(1);

        observer.setOptions({ enabled: false, queryFn: async () => "rpc", queryKey: key("x:y") });

        expect(fake.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);

        skipped();
        unobserve();
    });

    it("ignores queries that are not Lunora keys", () => {
        const observer = new QueryObserver(queryClient, { queryFn: async () => 1, queryKey: ["something-else"] });
        const unobserve = observer.subscribe(() => {});

        expect(fake.subscriptions).toHaveLength(0);

        unobserve();
    });

    it("subscribes a query hydrated from SSR once it is observed, without refetching", async () => {
        const server = new QueryClient();

        await server.prefetchQuery({ queryFn: async () => "ssr", queryKey: key("x:y") });
        hydrate(queryClient, dehydrate(server));

        expect(fake.subscriptions).toHaveLength(0);

        const unobserve = observe(key("x:y"));

        expect(fake.subscriptions).toHaveLength(1);
        expect(queryClient.getQueryData(key("x:y"))).toBe("ssr");
        expect(fake.client.query).not.toHaveBeenCalled();

        fake.subscriptions[0]!.onData("live");

        expect(queryClient.getQueryData(key("x:y"))).toBe("live");

        unobserve();
    });

    it("hands the socket a provider that mints a ticket for the current token, never the token itself", async () => {
        const provider = fake.client.setWsToken.mock.calls[0]![0] as () => Promise<string | undefined>;

        await expect(provider()).resolves.toBeUndefined();
        expect(mintWsTicket).not.toHaveBeenCalled();

        fake.setToken(jwt("user-1"));

        await expect(provider()).resolves.toBe("ticket-for-user-1");
        expect(mintWsTicket).toHaveBeenLastCalledWith(jwt("user-1"));
    });

    it("mints a fresh ticket on every (re)connect", async () => {
        fake.setToken(jwt("user-1"));

        const provider = fake.client.setWsToken.mock.calls.at(-1)![0] as () => Promise<string | undefined>;

        await provider();
        await provider();

        expect(mintWsTicket).toHaveBeenCalledTimes(2);
    });

    it("lets a failed mint throw, so the client retries instead of opening anonymously", async () => {
        fake.setToken(jwt("user-1"));
        mintWsTicket.mockRejectedValueOnce(new Error("ws-ticket: 503"));

        const provider = fake.client.setWsToken.mock.calls.at(-1)![0] as () => Promise<string | undefined>;

        await expect(provider()).rejects.toThrow("503");
    });

    it("reconnects the socket when the token's subject changes, not on a refresh", () => {
        expect(fake.client.setWsToken).toHaveBeenCalledTimes(1);

        fake.setToken(jwt("user-1"));

        expect(fake.client.setWsToken).toHaveBeenCalledTimes(2);

        fake.setToken(jwt("user-1", 2));

        expect(fake.client.setWsToken).toHaveBeenCalledTimes(2);

        fake.setToken(jwt("user-2"));
        fake.setToken(null);

        expect(fake.client.setWsToken).toHaveBeenCalledTimes(4);
    });

    it("seeds at most MAX_CONCURRENT_SEEDS subscriptions at once", () => {
        const unobserve = Array.from({ length: MAX_CONCURRENT_SEEDS + 2 }, (_, index) => observe(key(`x:q${String(index)}`)));

        expect(fake.subscriptions).toHaveLength(MAX_CONCURRENT_SEEDS);
        expect(manager.size).toBe(MAX_CONCURRENT_SEEDS + 2);

        // A first value frees a slot…
        fake.subscriptions[0]!.onData("a");

        expect(fake.subscriptions).toHaveLength(MAX_CONCURRENT_SEEDS + 1);

        // …and so does an error.
        fake.subscriptions[1]!.onError!({ message: "boom" });

        expect(fake.subscriptions).toHaveLength(MAX_CONCURRENT_SEEDS + 2);

        for (const stop of unobserve) {
            stop();
        }
    });

    it("gives a slot back when a seed never answers, and skips queued entries that were released", () => {
        const first = Array.from({ length: MAX_CONCURRENT_SEEDS }, (_, index) => observe(key(`x:q${String(index)}`)));
        const queued = observe(key("x:queued"), { meta: {} });
        const waiting = observe(key("x:waiting"));

        queryClient.removeQueries({ queryKey: key("x:queued") });
        vi.advanceTimersByTime(SEED_SLOT_TIMEOUT_MS);

        expect(fake.subscriptions.map((subscription) => subscription.path)).toStrictEqual(["x:q0", "x:q1", "x:q2", "x:waiting"]);

        for (const stop of [...first, queued, waiting]) {
            stop();
        }
    });

    it("gives a seeding slot back exactly once when released, and the queue moves on", () => {
        const unobserve = Array.from({ length: MAX_CONCURRENT_SEEDS + 1 }, (_, index) => observe(key(`x:q${String(index)}`)));

        expect(fake.subscriptions).toHaveLength(MAX_CONCURRENT_SEEDS);

        // Release a SEEDING entry (still waiting for its first value)…
        queryClient.removeQueries({ queryKey: key("x:q0") });

        expect(fake.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
        expect(fake.subscriptions).toHaveLength(MAX_CONCURRENT_SEEDS + 1);

        // …its slot timeout must not free a second slot later.
        vi.advanceTimersByTime(SEED_SLOT_TIMEOUT_MS);
        const late = observe(key("x:late"));

        // The two surviving seeds timed out; the queued one and the late one fit.
        expect(fake.subscriptions.map((subscription) => subscription.path)).toStrictEqual(["x:q0", "x:q1", "x:q2", "x:q3", "x:late"]);

        for (const stop of [...unobserve, late]) {
            stop();
        }
    });

    it("does not free a slot when a settled entry is released", () => {
        const unobserve = Array.from({ length: MAX_CONCURRENT_SEEDS + 2 }, (_, index) => observe(key(`x:q${String(index)}`)));

        fake.subscriptions[0]!.onData("a");

        // q0 settled and freed its slot, which q3 took.
        expect(fake.subscriptions).toHaveLength(MAX_CONCURRENT_SEEDS + 1);

        queryClient.removeQueries({ queryKey: key("x:q0") });

        // Releasing the settled q0 frees nothing: q4 still waits.
        expect(fake.subscriptions).toHaveLength(MAX_CONCURRENT_SEEDS + 1);

        for (const stop of unobserve) {
            stop();
        }
    });

    it("tears down a subscription whose entry was released before subscribe returned", () => {
        fake.client.subscribe.mockImplementationOnce((reference: never, args: never, onData: OnData, options?: { onError?: OnError }) => {
            const subscription: FakeSubscription = {
                args,
                onData,
                onError: options?.onError,
                path: (reference as { __lunoraRef: string }).__lunoraRef,
                unsubscribe: vi.fn(),
            };

            fake.subscriptions.push(subscription);
            // The cache drops the query while the client is still subscribing.
            queryClient.removeQueries({ queryKey: key("x:y") });

            return subscription.unsubscribe;
        });

        const unobserve = observe(key("x:y"));

        // Torn down by `attach`, since `close` ran before there was anything to close.
        expect(fake.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);

        unobserve();
    });

    it("ignores the undefined an identity bounce resets the client's value to", () => {
        const unobserve = observe(key("x:y"));

        fake.subscriptions[0]!.onData("value");
        fake.subscriptions[0]!.onData(undefined);

        expect(queryClient.getQueryData(key("x:y"))).toBe("value");

        unobserve();
    });
});

describe(tokenSubject, () => {
    it("reads the JWT subject", () => {
        expect(tokenSubject(jwt("abc"))).toBe("abc");
    });

    it("falls back to the token for a non-JWT and null for none", () => {
        expect(tokenSubject("opaque")).toBe("opaque");
        expect(tokenSubject(null)).toBeNull();
    });
});
