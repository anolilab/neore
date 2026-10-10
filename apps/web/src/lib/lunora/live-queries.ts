/**
 * Live `crpc` queries: a WebSocket subscription per ACTIVE query, pushed into
 * the TanStack cache.
 *
 * `lunoraQueryOptions` — what every `crpc.x.y.queryOptions()` used to return —
 * fetches once with an infinite `staleTime` and opens no socket. The app was
 * written against a backend that pushed every change, so screens stayed stale
 * after a mutation until a reload (a created task never appeared on `/tasks`).
 * This restores push semantics without touching the call sites: a manager
 * listening to the query cache, subscribing while a key has observers.
 *
 * - A query SUBSCRIBES when it is a Lunora key (`["lunora", path, args,
 *   shardKey]`), has an enabled observer, and has not opted out with
 *   `meta.lunoraLive === false` — the ONE opt-out, which `crpc`'s
 *   `queryOptions` writes for `{ live: false }` and for `NEVER_LIVE` paths. `skipToken` queries never qualify: their
 *   queryFn is `skipToken`, so they are never active.
 * - It UNSUBSCRIBES `LINGER_MS` after its last observer leaves, and at once when
 *   the cache drops it. Keeping unobserved queries live until gc would keep them
 *   re-running on the one `__root__` Durable Object for five minutes after the
 *   screen that wanted them is gone. The cached value stays; the next observer
 *   resubscribes, and the server's seed push brings it current.
 * - `fetch` (the queryFn) answers from the subscription when one is open —
 *   otherwise the first paint of every live query would run it twice on the
 *   DO, once for the RPC and once for the subscription seed. With no
 *   subscription (SSR, route loaders, opted-out queries) it is a plain RPC.
 * - The socket authenticates with a single-use TICKET (`ws-ticket.ts`), minted
 *   with the RPC bearer right before every (re)connect — never the JWT itself,
 *   which would ride the upgrade URL into the Worker's request logs. It bounces
 *   when the bearer's subject changes. `setAuthToken` alone never reconnects a socket that
 *   opened anonymously, so without the bounce every subscription opened before
 *   the token landed would stay anonymous for the life of the page.
 */
import type { LunoraClient } from "@lunora/client";
import type { Query, QueryCacheNotifyEvent, QueryClient, QueryKey } from "@tanstack/react-query";

import { Entry, NO_VALUE } from "./live-query-entry";
import { resetShardRegistry } from "./shard-routing";
import type { WsTicketMinter } from "./ws-ticket";

export { FIRST_VALUE_TIMEOUT_MS } from "./live-query-entry";

/** The slice of `LunoraClient` this needs — the real signatures, narrowed so tests can fake it. */
export type LiveQueryClient = Pick<LunoraClient, "getAuthToken" | "onAuthTokenChange" | "query" | "setWsToken" | "subscribe">;

type WsTokenProvider = Extract<Parameters<LunoraClient["setWsToken"]>[0], (...args: never[]) => unknown>;

interface LunoraReference {
    __lunoraRef: string;
}

/** How long an unobserved query stays subscribed — covers a quick navigate-and-back. */
export const LINGER_MS = 10_000;

/**
 * How many subscriptions may be SEEDING (subscribed, first value not yet in) at
 * once. The server runs each seed on the one `__root__` Durable Object, and a
 * burst of them is the concurrency trigger for local dev's fatal
 * `Network connection lost.` — eleven seeds sent at once (the `/chat` first
 * paint) killed `wrangler dev` in 2 of 7 runs; three at a time, 0 of 4, and
 * finished as fast (~4s cold), because the DO serialises them anyway.
 */
export const MAX_CONCURRENT_SEEDS = 3;

/** A seed that never answers gives its slot back after this long. */
export const SEED_SLOT_TIMEOUT_MS = 10_000;

/** Opt-out marker: `meta: { lunoraLive: false }` keeps a query a one-shot fetch. */
export const LIVE_META_KEY = "lunoraLive";

/**
 * Where `crpc` puts a live query's call args. The key cannot carry them: since
 * `@lunora/react@alpha.166` its args slot is the wire-encoded STRING, and
 * subscribing with that sends the procedure a string instead of its args.
 */
export const LIVE_ARGS_META_KEY = "lunoraArgs";

/** `{ shardKey }` from a Lunora query key's shard slot (`["lunora", fn, args, shardKey | null]`), or `{}`. */
const shardOptionsOfKey = (queryKey: QueryKey): { shardKey?: string } => (typeof queryKey[3] === "string" ? { shardKey: queryKey[3] } : {});

const isLunoraKey = (queryKey: QueryKey): queryKey is readonly ["lunora", string, unknown, string | null] =>
    queryKey[0] === "lunora" && typeof queryKey[1] === "string";

/**
 * The call args of a Lunora query: from `meta` (the query's, or — after a
 * hydrate drops it — an observer's), else decoded from the key's args slot,
 * which is the encoded string on current `@lunora/react` and the object before.
 */
const argsOf = (query: Query): Record<string, unknown> => {
    const fromMeta =
        query.options.meta?.[LIVE_ARGS_META_KEY] ??
        query.observers.find((observer) => observer.options.meta?.[LIVE_ARGS_META_KEY])?.options.meta?.[LIVE_ARGS_META_KEY];

    if (fromMeta !== undefined) {
        return fromMeta as Record<string, unknown>;
    }

    const keyed = query.queryKey[2];

    return ((typeof keyed === "string" ? JSON.parse(keyed) : keyed) ?? {}) as Record<string, unknown>;
};

const optedOut = (query: Query): boolean => {
    if (query.options.meta?.[LIVE_META_KEY] === false) {
        return true;
    }

    // A dehydrated query can come back without its meta; the observers' options
    // are what the call site actually passed.
    return query.observers.some((observer) => observer.options.meta?.[LIVE_META_KEY] === false);
};

/**
 * The JWT subject, or the token itself when it is not a JWT. Only compared, never
 * trusted — the backend verifies the token on upgrade.
 */
export const tokenSubject = (token: string | null): string | null => {
    if (!token) {
        return null;
    }

    const payload = token.split(".", 3)[1];

    if (!payload) {
        return token;
    }

    try {
        const json = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as { sub?: unknown };

        return typeof json.sub === "string" ? json.sub : token;
    } catch {
        return token;
    }
};

export class LiveQueryManager {
    private readonly entries = new Map<string, Entry>();

    /** Server pushes per query hash — lets an in-flight RPC detect it lost a race. */
    private readonly pushes = new Map<string, number>();

    /** Entries waiting for a seed slot, in the order their queries asked. */
    private readonly queue: string[] = [];

    private seeding = 0;

    private disconnectCache: (() => void) | undefined;

    private disconnectToken: (() => void) | undefined;

    public constructor(
        private readonly client: LiveQueryClient,
        private readonly queryClient: QueryClient,
        private readonly mintWsTicket: WsTicketMinter,
    ) {}

    /** Starts watching the cache and wires the socket's credential. Returns `disconnect`. */
    public connect(): () => void {
        this.disconnectCache = this.queryClient.getQueryCache().subscribe((event) => {
            this.onCacheEvent(event);
        });

        // A provider, so every (re)connect mints a fresh ticket for the CURRENT token.
        this.client.setWsToken(this.wsTokenProvider());

        let subject = tokenSubject(this.client.getAuthToken());

        this.disconnectToken = this.client.onAuthTokenChange((token) => {
            const next = tokenSubject(token);

            // A routine refresh of the same user's JWT keeps the socket: its
            // identity is still right, and a bounce re-seeds every subscription.
            if (next === subject) {
                return;
            }

            subject = next;
            // Another user's grants are not this one's: shared objects re-resolve.
            resetShardRegistry();
            // A NEW function identity is what makes `setWsToken` close the open
            // sockets; the client resends every subscription on reconnect.
            this.client.setWsToken(this.wsTokenProvider());
        });

        return () => {
            this.disconnect();
        };
    }

    public disconnect(): void {
        this.disconnectCache?.();
        this.disconnectToken?.();
        this.disconnectCache = undefined;
        this.disconnectToken = undefined;

        // `release` deletes from `entries`, so iterate a snapshot of the keys.
        const hashes = [...this.entries.keys()];

        for (const hash of hashes) {
            this.release(hash);
        }
    }

    /** Number of open subscriptions — for tests and the measurement script. */
    public get size(): number {
        return this.entries.size;
    }

    public isSubscribed(queryHash: string): boolean {
        return this.entries.has(queryHash);
    }

    /**
     * The live queryFn. Answers from an open subscription; otherwise RPC, guarded
     * against a push that lands while the RPC is in flight (the RPC's snapshot
     * would be OLDER than what the push already wrote to the cache).
     */
    public async fetch(queryKey: QueryKey, queryHash: string, reference: LunoraReference, args: Record<string, unknown>): Promise<unknown> {
        const entry = this.entries.get(queryHash);

        if (entry && entry.error === undefined) {
            if (entry.hasValue) {
                return entry.value;
            }

            const value = await entry.firstValue();

            if (value !== NO_VALUE) {
                return value;
            }
        }

        const pushesBefore = this.pushes.get(queryHash) ?? 0;
        const result = await this.client.query(reference as never, args as never, shardOptionsOfKey(queryKey));

        if ((this.pushes.get(queryHash) ?? 0) !== pushesBefore) {
            return this.queryClient.getQueryData(queryKey) ?? result;
        }

        return result;
    }

    /**
     * Resolved by the client at every (re)connect. No bearer means an anonymous
     * socket; a failed mint throws, and the client retries with backoff.
     */
    private wsTokenProvider(): WsTokenProvider {
        return async () => {
            const bearer = this.client.getAuthToken();

            return bearer ? await this.mintWsTicket(bearer) : undefined;
        };
    }

    private onCacheEvent(event: QueryCacheNotifyEvent): void {
        const { query } = event;

        if (!isLunoraKey(query.queryKey)) {
            return;
        }

        switch (event.type) {
            case "observerAdded":
            case "observerOptionsUpdated":
            case "observerRemoved": {
                this.reconcile(query);

                return;
            }
            case "removed": {
                this.release(query.queryHash);

                break;
            }
            default:
        }
    }

    private reconcile(query: Query): void {
        const wanted = query.isActive() && !optedOut(query);
        const entry = this.entries.get(query.queryHash);

        if (wanted) {
            if (entry) {
                entry.stopLingering();
            } else {
                this.open(query);
            }

            return;
        }

        if (!entry || entry.isLingering) {
            return;
        }

        // Disabled or opted out while still observed: stop now. Unobserved: linger.
        if (query.getObserversCount() > 0) {
            this.release(query.queryHash);

            return;
        }

        entry.linger(LINGER_MS, () => {
            this.release(query.queryHash);
        });
    }

    private open(query: Query): void {
        const path = query.queryKey[1] as string;

        this.entries.set(query.queryHash, new Entry(path, argsOf(query), query.queryKey));
        this.queue.push(query.queryHash);
        this.pump();
    }

    /** Starts queued subscriptions while seed slots are free. */
    private pump(): void {
        while (this.seeding < MAX_CONCURRENT_SEEDS && this.queue.length > 0) {
            // A released entry is gone from `entries`; `start` skips it.
            this.start(this.queue.shift() as string);
        }
    }

    /**
     * The one place a seed slot is given back — `Entry.settle` / `Entry.close`
     * report whether the entry held one (first answer, error, slot timeout, release).
     */
    private freeSlot(heldSlot: boolean): void {
        if (!heldSlot) {
            return;
        }

        this.seeding -= 1;
        this.pump();
    }

    private settle(entry: Entry): void {
        this.freeSlot(entry.settle());
    }

    private start(hash: string): void {
        const entry = this.entries.get(hash);

        if (!entry?.beginSeeding(SEED_SLOT_TIMEOUT_MS, () => this.settle(entry))) {
            return;
        }

        const { path } = entry;

        this.seeding += 1;

        try {
            const unsubscribe = this.client.subscribe(
                { __lunoraRef: path } as never,
                entry.args as never,
                (value) => {
                    // An identity bounce resets the client's copy to `undefined`
                    // until the reseed lands; that is not data.
                    if (value === undefined || this.entries.get(hash) !== entry) {
                        return;
                    }

                    entry.receive(value);
                    this.pushes.set(hash, (this.pushes.get(hash) ?? 0) + 1);
                    this.queryClient.setQueryData(entry.queryKey, value);
                    this.settle(entry);
                },
                {
                    // A shared thread's or page's key names its owner's shard;
                    // the client opens a socket to that shard for it.
                    ...shardOptionsOfKey(entry.queryKey),
                    onError: (error) => {
                        if (this.entries.get(hash) !== entry) {
                            return;
                        }

                        // The subscription failed (auth, a throwing query,
                        // TOO_MANY_SUBSCRIPTIONS). The query keeps working as a
                        // one-shot fetch: `fetch` falls back to RPC, which reports
                        // the error through TanStack's own retry and error state.
                        entry.fail(error);
                        this.settle(entry);

                        if (import.meta.env?.DEV) {
                            console.warn(`[lunora] live query ${path} is not live: ${error.code ?? "ERROR"} ${error.message}`);
                        }
                    },
                },
            );

            entry.attach(unsubscribe);
        } catch (error) {
            this.release(hash);

            if (import.meta.env?.DEV) {
                console.warn(`[lunora] could not subscribe to ${path}`, error);
            }
        }
    }

    private release(hash: string): void {
        const entry = this.entries.get(hash);

        if (!entry) {
            return;
        }

        this.entries.delete(hash);
        this.pushes.delete(hash);
        this.freeSlot(entry.close());
    }
}

const managers = new WeakMap<object, LiveQueryManager>();

/**
 * Installs the manager for a client/QueryClient pair. Browser only: on the server
 * a query fetches once and is dehydrated, and the browser subscribes on hydrate.
 */
export const connectLiveQueries = (client: LiveQueryClient, queryClient: QueryClient, mintWsTicket: WsTicketMinter): (() => void) => {
    if (typeof window === "undefined" || managers.has(client)) {
        return () => {};
    }

    const manager = new LiveQueryManager(client, queryClient, mintWsTicket);

    managers.set(client, manager);

    const disconnect = manager.connect();

    return () => {
        disconnect();
        managers.delete(client);
    };
};

export const getLiveQueryManager = (client: object): LiveQueryManager | undefined => managers.get(client);
