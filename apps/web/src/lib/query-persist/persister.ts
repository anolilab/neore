/**
 * The per-account query cache: restores the account's last kept reads into the QueryClient and keeps its record
 * current while the app runs. Meant to be loaded on demand, never on the first load.
 *
 * The server stays authoritative. Restored data keeps the `dataUpdatedAt` it was saved with and is marked invalid,
 * so a screen that mounts it refetches (one already showing it refetches at once), and a live seed replaces it
 * (`hydrate` never overwrites newer data).
 *
 * What is kept, and how it is cleaned, is the caller's `policy`; whether a save may reach disk at all (a sign-out
 * holds every write until the identity changes) is its `gate`. The record is encrypted (`encrypted-store.ts`).
 */
import type { DehydratedState, Query, QueryCacheNotifyEvent, QueryClient } from "@tanstack/query-core";
import { dehydrate, hydrate, QueryObserver } from "@tanstack/query-core";

import type { RecordStore } from "./encrypted-store";
import { openRecord, pruneRecords, removeRecord, sealRecord } from "./encrypted-store";

/** One saved read, as `dehydrate` writes it. */
type DehydratedQuery = DehydratedState["queries"][number];

/**
 * A record not written for this long is dropped (any account's, on any account's start), and so is a kept read not
 * refreshed for this long.
 */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Live pushes come in bursts; the record only needs the latest state, at most once a second. */
export const WRITE_THROTTLE_MS = 1000;

export interface PersistPolicy {
    /** What a state is reduced to on its way to disk, and again on its way back in (the rules may have tightened since). */
    sanitize: (state: DehydratedState, userId: string) => DehydratedState;
    /** Called once per save with the whole cache: the filter for the queries this save keeps. */
    select: (queries: ReadonlyArray<Query>, userId: string) => (query: Query) => boolean;
}

export interface WriteGate {
    canWrite: (userId: string) => boolean;
    /** Bumped by every clear: a save scheduled before a clear drops itself, and one sealed during a clear takes its record back out. */
    generation: () => number;
    /** Calls `listener` when `canWrite` may have changed; returns the unsubscribe. A save the closed gate held back is offered again then. */
    subscribe?: (listener: () => void) => () => void;
}

export interface PersistenceOptions {
    /** Bump when the shape of a kept read changes: a record written under another value is dropped, never shown. */
    buster: string;
    gate: WriteGate;
    /** The clock the query cache stamps `dataUpdatedAt` with. */
    now?: () => number;
    policy: PersistPolicy;
    queryClient: QueryClient;
    store: RecordStore;
    userId: string;
}

export interface PersistenceController {
    /** Starts saving: the session is confirmed to be this account's own (not a guest, not impersonated). */
    enableWrites: () => void;

    /**
     * Resolves once the first restore attempt has finished or failed; never rejects. A record it could not hand over (the
     * gate closed, a clear meanwhile) is restored once the gate lets a save through, before that save.
     */
    readonly restored: Promise<void>;
    /** The session turned out not to be one to keep: stop, and drop what was restored and not yet refreshed. */
    revoke: () => void;
    stop: () => void;
    readonly userId: string;
}

interface StoredClient {
    buster: string;
    clientState: DehydratedState;
    timestamp: number;
    userId: string;
}

const isStoredClient = (value: unknown, userId: string): value is StoredClient => {
    const candidate = value as Partial<StoredClient> | null;

    return (
        typeof candidate === "object" &&
        candidate !== null &&
        candidate.userId === userId &&
        typeof candidate.buster === "string" &&
        typeof candidate.timestamp === "number" &&
        typeof candidate.clientState === "object" &&
        Array.isArray(candidate.clientState?.queries) &&
        // Every saved read as `restore` reads it: a malformed one makes the whole record unreadable, dropped like a damaged one.
        candidate.clientState.queries.every(
            (query: unknown) =>
                typeof query === "object" &&
                query !== null &&
                Array.isArray((query as { queryKey?: unknown }).queryKey) &&
                typeof (query as { state?: { dataUpdatedAt?: unknown } }).state?.dataUpdatedAt === "number",
        )
    );
};

const CACHE_EVENTS: ReadonlySet<string> = new Set(["added", "removed", "updated"]);

/**
 * One seal at a time per account in this tab, across controllers: a slow seal must not land after a newer one, and the
 * removal a stale one does after a clear must run before the next session's first seal, not in the middle of it.
 */
const sealing = new Map<string, Promise<void>>();

const serialized = async (userId: string, task: () => Promise<void>): Promise<void> => {
    // What is stored never rejects, so a failed seal does not stop the next one.
    const run = (sealing.get(userId) ?? Promise.resolve()).then(task);
    const settled = run.catch(() => undefined);

    sealing.set(userId, settled);
    await run.finally(() => {
        if (sealing.get(userId) === settled) {
            sealing.delete(userId);
        }
    });
};

/** A kept read is settled data: a query saved mid-fetch must not come back as fetching with nothing in flight. */
const asSettled = (state: DehydratedState): DehydratedState => {
    return {
        mutations: [],
        queries: state.queries.map((query: DehydratedQuery) => {
            return { ...query, promise: undefined, state: { ...query.state, fetchStatus: "idle" as const } };
        }),
    };
};

/**
 * Starts the account's cache. The caller starts it only once the previous account's reads can no longer land: their
 * fetches cancelled and their live subscriptions closed (`live-queries.ts` does both as a new token arrives). Data
 * that arrives after this start counts as this account's.
 */
export const startQueryPersistence = (options: PersistenceOptions): PersistenceController => {
    const { buster, gate, now = Date.now, policy, queryClient, store, userId } = options;

    /**
     * Each query's data count at this start. Data held then came in before this account's token: across an account
     * switch that is the previous account's, even when stamped in the same millisecond. A query is kept only once data
     * arrives for it after this start, or when it is restored.
     */
    const atStart = new WeakMap<Query, number>();

    for (const query of queryClient.getQueryCache().getAll()) {
        atStart.set(query, query.state.dataUpdateCount);
    }

    const isReadSinceStart = (query: Query): boolean => query.state.dataUpdateCount > (atStart.get(query) ?? 0);
    /** What the restore handed over, with its data count then: any later data, even stamped the same millisecond, counts it up. */
    const restoredCount = new WeakMap<Query, number>();
    const isRestored = (query: Query): boolean => restoredCount.get(query) === query.state.dataUpdateCount;
    const state = { isDirty: false, isHeldByGate: false, isRestoreDone: false, isRestoring: true, isSaving: false, stopped: false, writes: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** The generation the queued save was scheduled under. */
    let timerGeneration = -1;
    let unsubscribe: (() => void) | undefined;

    const mayWrite = (generation: number): boolean => !state.stopped && state.writes && generation === gate.generation() && gate.canWrite(userId);

    const write = async (generation: number): Promise<void> => {
        if (!mayWrite(generation)) {
            // Only the gate closed (no clear, no stop): this change is offered again when it opens.
            state.isHeldByGate = !state.stopped && state.writes && generation === gate.generation() && !gate.canWrite(userId);

            return;
        }

        const keep = policy.select(queryClient.getQueryCache().getAll(), userId);
        const dehydrated = dehydrate(queryClient, {
            shouldDehydrateMutation: () => false,
            // A read older than the cache's age limit is not carried into a fresh record: it would outlive the limit.
            shouldDehydrateQuery: (query: Query) =>
                keep(query) && (isReadSinceStart(query) || isRestored(query)) && now() - query.state.dataUpdatedAt <= MAX_AGE_MS,
        });
        const record: StoredClient = { buster, clientState: asSettled(policy.sanitize(dehydrated, userId)), timestamp: now(), userId };

        const seal = await sealRecord(store, userId, JSON.stringify(record), record.timestamp);

        // Stopped, or a clear landed, while the record was sealed: it must not survive that. Only this seal goes, never
        // a record another tab wrote after it.
        if (seal !== undefined && (state.stopped || generation !== gate.generation() || !gate.canWrite(userId))) {
            await removeRecord(store, userId, seal);
        }
    };

    const parse = (text: string | undefined): unknown => {
        try {
            return text === undefined ? undefined : JSON.parse(text);
        } catch {
            return undefined;
        }
    };

    /**
     * `hydrate`'s `gcTime` reaches only a query it creates: one already in the cache keeps its own, and its collection
     * may be counting down under it already. An observer that comes and goes restarts that count under the new time;
     * not while the query fetches (that restarts it when done, and an observer leaving could cancel the fetch).
     */
    const keepRestored = (query: Query): void => {
        query.setOptions({ ...query.options, gcTime: MAX_AGE_MS });

        if (query.getObserversCount() === 0 && query.state.fetchStatus === "idle") {
            new QueryObserver(queryClient, { ...query.options, enabled: false, queryKey: query.queryKey }).subscribe(() => undefined)();
        }
    };

    /** Whether the record is settled for this session: handed over, absent, or dropped. Not when it is held back unread. */
    const restore = async (): Promise<boolean> => {
        const generation = gate.generation();
        const opened = await openRecord(store, userId);

        if (opened === undefined) {
            return true;
        }

        // Stopped (an account switch) or cleared (a sign-out) while the record was read: it is no longer this session's to show or remove.
        const isStale = (): boolean => state.stopped || generation !== gate.generation();
        const parsed = parse(opened.text);

        if (!isStoredClient(parsed, userId) || parsed.buster !== buster || parsed.timestamp < now() - MAX_AGE_MS) {
            // Unreadable (a lost key, another shape) or old: drop it, and the network fills the cache. Not a record written
            // since it was read (another tab, a newer session), and not between this tab's seal of the key and of the record.
            if (!isStale()) {
                await serialized(userId, async () => await removeRecord(store, userId, opened.seal));
            }

            return true;
        }

        if (isStale() || !gate.canWrite(userId)) {
            return false;
        }

        const cutoff = now() - MAX_AGE_MS;
        const clientState = asSettled(
            policy.sanitize(
                { ...parsed.clientState, queries: parsed.clientState.queries.filter((query: DehydratedQuery) => query.state.dataUpdatedAt >= cutoff) },
                userId,
            ),
        );

        const queryCache = queryClient.getQueryCache();
        // A read that arrived since this start is live, whatever its stamp (a clock that stepped back, a server time):
        // the saved value never replaces it. `hydrate` alone keeps only one stamped later than the saved value.
        const restorable = clientState.queries.filter((query: DehydratedQuery) => {
            const existing = queryCache.get(query.queryHash);

            return existing === undefined || !isReadSinceStart(existing);
        });
        const before = new Map(restorable.map((query: DehydratedQuery) => [query.queryHash, queryCache.get(query.queryHash)?.state]));

        // A restored entry nobody watches yet must outlive the default five minutes, or the next save forgets it.
        hydrate(queryClient, { ...clientState, queries: restorable }, { defaultOptions: { queries: { gcTime: MAX_AGE_MS } } });

        // `hydrate` skips an entry the cache holds newer data for: only one whose state it replaced is restored.
        for (const [queryHash, previous] of before) {
            const query = queryCache.get(queryHash);

            if (query && query.state !== previous) {
                // Counted from here: data arriving later makes it a read of this session's, whatever the replaced count was.
                atStart.set(query, query.state.dataUpdateCount);
                restoredCount.set(query, query.state.dataUpdateCount);

                if (previous !== undefined) {
                    keepRestored(query);
                }
            }
        }

        // Restored data is old: a screen that mounts it fetches (a live read's `staleTime` is infinite, so only this makes
        // it), and one already showing it fetches now. Not awaited: the restore is done once the data shows, not once the
        // network answers. A fetch already in flight is kept, not restarted.
        void queryClient.invalidateQueries({ predicate: isRestored, refetchType: "active" }, { cancelRefetch: false });

        return true;
    };

    /** Restores the record, unless it is held back (the gate closed, a clear meanwhile): then the next save retries first. */
    const attemptRestore = async (): Promise<void> => {
        state.isRestoring = true;

        // A store that fails to read leaves the record unread: no save may replace it, and the next change tries again. An
        // unreadable record (another key, damaged) is not a failure: `restore` drops it and counts it settled.
        let isDone = false;

        try {
            isDone = await restore();
        } catch {
            // A blocked or failing store: nothing is shown, and the network fills the cache.
        }

        try {
            await pruneRecords(store, now() - MAX_AGE_MS);
        } catch {
            // Expired records go on a later start.
        }

        state.isRestoring = false;
        state.isRestoreDone = isDone;

        // Held back because the gate closed while the record was read: offered again when it next opens.
        if (!isDone && !state.stopped && !gate.canWrite(userId)) {
            state.isHeldByGate = true;
        }
    };

    const schedule = (): void => {
        if (timer !== undefined) {
            // A clear since that save was queued drops it: this change needs a save of its own after it.
            if (timerGeneration !== gate.generation()) {
                state.isDirty = true;
            }

            return;
        }

        if (!mayWrite(gate.generation())) {
            // A change while only the gate is closed is offered again when it opens.
            state.isHeldByGate ||= !state.stopped && state.writes && !gate.canWrite(userId);

            return;
        }

        // A save replaces the whole record: one this session has not restored yet is restored first, or it is lost.
        if (!state.isRestoreDone) {
            if (!state.isRestoring) {
                void (async () => {
                    await attemptRestore();

                    // Restored: the save that asked for it goes now. A failed read waits for the next change, not a loop.
                    if (!state.stopped && state.isRestoreDone) {
                        schedule();
                    }
                })();
            }

            return;
        }

        // One save queued or sealing at a time: a change meanwhile is saved once after it, not once per interval it waited.
        if (state.isSaving) {
            state.isDirty = true;

            return;
        }

        const generation = gate.generation();

        timerGeneration = generation;
        timer = setTimeout(() => {
            timer = undefined;
            state.isSaving = true;

            void serialized(userId, async () => {
                // The save takes the cache as it is now: only a change after this needs another. One a clear dropped
                // takes nothing, so a change waiting for it stays waiting.
                if (generation === gate.generation()) {
                    state.isDirty = false;
                }

                await write(generation);
            })
                .catch(() => {
                    // Quota, a blocked store, a lost key: the cache just is not kept this time.
                })
                .finally(() => {
                    state.isSaving = false;

                    if (state.isDirty) {
                        state.isDirty = false;
                        schedule();
                    }
                });
        }, WRITE_THROTTLE_MS);
    };

    const restored = (async () => {
        await attemptRestore();

        if (!state.stopped) {
            unsubscribe = queryClient.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
                if (CACHE_EVENTS.has(event.type)) {
                    schedule();
                }
            });
            schedule();
        }
    })();

    const unsubscribeGate = gate.subscribe?.(() => {
        if (!(state.isHeldByGate && gate.canWrite(userId))) {
            return;
        }

        state.isHeldByGate = false;
        schedule();
    });

    const stop = (): void => {
        state.stopped = true;
        clearTimeout(timer);
        timer = undefined;
        unsubscribe?.();
        unsubscribeGate?.();
    };

    return {
        enableWrites: () => {
            state.writes = true;
            schedule();
        },
        restored,
        revoke: () => {
            stop();
            void restored.then(() => queryClient.removeQueries({ predicate: isRestored }));
        },
        stop,
        userId,
    };
};
