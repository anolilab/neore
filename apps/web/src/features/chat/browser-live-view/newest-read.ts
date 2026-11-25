/**
 * The newest answer of one query read two ways: its live subscription and a one-shot read past it (a live query's
 * refetch answers the subscription's last push, and a `.global()` write such as a renewed grant pushes nothing,
 * `docs/agents/lunora-upstream.md`). The "Needs you" card and, for a grantee, the live view card read both and show
 * whichever answered last.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { hashKey } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";

/**
 * A one-shot read of a live query, under its own key, read past its subscription. The "Needs you" card and the live view
 * card build the same key for the status, so one read serves both.
 */
export const freshRead = <T extends { queryKey: QueryKey }>(options: T, enabled: boolean): T & { enabled: boolean; staleTime: number } => {
    return { ...options, enabled, queryKey: [...options.queryKey, "fresh"] as unknown as T["queryKey"], staleTime: 0 };
};

/** What the card takes from a TanStack query result. */
export interface QueryRead<T> {
    data: T | undefined;
    dataUpdatedAt: number;
    errorUpdatedAt: number;
    isError: boolean;
}

export interface NewestRead<T> {
    /** When `data` first came, on this device's clock. */
    at: number;
    data: T | undefined;
    /** A read failed after `data` came: whether it still holds is not known. */
    failed: boolean;
}

/**
 * An answer as first seen. A fresh read's every answer is new. A live query's refetch hands back its last push again,
 * the same object (structural sharing), with a later `dataUpdatedAt`: a live answer is new only as a new object, and
 * keeps its first arrival.
 */
interface Arrival {
    at: number;
    data: unknown;
}

interface Seen {
    /** The latest failure of either read seen so far: a read that recovers by answering its last push again keeps it. */
    failedAt: number;
    fresh?: Arrival;
    /** The live query's key (hashed) these were seen under: another (a chat switch) starts afresh. */
    key: string;
    /** Which read's answer changed last. */
    last: "fresh" | "live";
    live?: Arrival;
}

/** Whether `read` brought an answer not seen before; `byObject`: only a new object is (see {@link Arrival}). */
const changed = (read: QueryRead<unknown>, before: Arrival | undefined, byObject: boolean): boolean => {
    if (read.data === undefined) {
        return false;
    }

    return before?.data !== read.data || (!byObject && before.at !== read.dataUpdatedAt);
};

/** Which read changed last, once one did: both in one render, the later to arrive, a tie to the read past the subscription. */
const lastChanged = (live: QueryRead<unknown>, fresh: QueryRead<unknown>, liveChanged: boolean, freshChanged: boolean): Seen["last"] => {
    if (liveChanged === freshChanged) {
        return fresh.dataUpdatedAt >= live.dataUpdatedAt ? "fresh" : "live";
    }

    return freshChanged ? "fresh" : "live";
};

/**
 * Whether the fresh answer is the newer: by the server's clock (`now`), which every answer carries, an empty one too (a
 * read sent before a push can arrive after it); on the same `now`, the one `wins` picks when it picks exactly one (a
 * denial over an answer that shows the chat), else the one that changed last.
 */
const freshIsNewer = <T extends { now: number }>(live: T | undefined, fresh: T, last: Seen["last"], wins?: (answer: T) => boolean): boolean => {
    if (live === undefined) {
        return true;
    }

    if (live.now !== fresh.now) {
        return fresh.now > live.now;
    }

    if (wins !== undefined && wins(live) !== wins(fresh)) {
        return wins(fresh);
    }

    return last === "fresh";
};

/**
 * The newer answer of `live` and `fresh` (see {@link freshIsNewer}). `failed` when a failure of either came after the
 * answer taken: a newer answer stands over an older failure, from either read, but an answer older on the server's clock
 * that arrives after a failure does not, since the one taken is the answer the failure leaves unknown. A failure stays
 * once its read recovers: a live query that recovers by answering its last push again brings no answer newer than it.
 * `queryKey`: the live query's key. All that is held belongs to it: once the key changes (another chat, site, run or
 * ask), nothing seen under the last one counts, its failure least of all. `winsTie`: the answer that stands on an equal
 * `now` whatever arrived last (the live view passes a denial, as the "Needs you" card's access rule decides it).
 */
export const useNewestRead = <T extends { now: number }>(
    live: QueryRead<T>,
    fresh: QueryRead<T>,
    queryKey: QueryKey,
    winsTie?: (answer: T) => boolean,
): NewestRead<T> => {
    const key = hashKey(queryKey);
    const [held, setSeen] = useState<Seen>({ failedAt: 0, key, last: "live" });
    const seen: Seen = held.key === key ? held : { failedAt: 0, key, last: "live" };
    const liveChanged = changed(live, seen.live, true);
    const freshChanged = changed(fresh, seen.fresh, false);
    const liveAt = liveChanged || seen.live === undefined ? live.dataUpdatedAt : seen.live.at;
    const freshAt = freshChanged || seen.fresh === undefined ? fresh.dataUpdatedAt : seen.fresh.at;
    // A live replay is no answer from the server (its arrival stays the first): it clears no failure seen before it.
    const failedAt = Math.max(seen.failedAt, live.isError ? live.errorUpdatedAt : 0, fresh.isError ? fresh.errorUpdatedAt : 0);
    let { last } = seen;

    if (liveChanged || freshChanged) {
        last = lastChanged(live, fresh, liveChanged, freshChanged);
        setSeen({ failedAt, fresh: { at: freshAt, data: fresh.data }, key, last, live: { at: liveAt, data: live.data } });
    } else if (failedAt !== seen.failedAt || seen !== held) {
        setSeen({ ...seen, failedAt });
    }

    const newest =
        fresh.data !== undefined && freshIsNewer(live.data, fresh.data, last, winsTie) ? { at: freshAt, data: fresh.data } : { at: liveAt, data: live.data };

    // A failure in the millisecond the answer came is taken as after it: which came first is not known, and the card fails
    // closed.
    return { ...newest, failed: failedAt > 0 && (newest.data === undefined || failedAt >= newest.at) };
};

/**
 * The highest grant revision any answer of the chat carried so far (`getThreadBrowser` and `getHumanCheck` name the
 * caller's grant revision on every answer to a grantee; the owner's carry none). Every write to the grant advances it:
 * a removal pushes a denial with a higher one, and a renewal pushes nothing but advances it too, so a one-shot read
 * after a renewal carries the new one. A one-shot read from a replica that still holds a removed grant answers on a
 * later server clock than the removal's push, with the older revision: only the revision tells it is older. `queryKey`:
 * the chat's (the status's live key); another chat starts afresh.
 */
export const useGrantRevision = (queryKey: QueryKey, answers: ReadonlyArray<{ revision?: number } | undefined>): number | undefined => {
    const key = hashKey(queryKey);
    const [held, setHeld] = useState<{ highest?: number; key: string }>({ key });
    // No answer at all in the cache (a sign-in to another account clears it, and the chat stays open): what was seen
    // belonged to the last account's grant, so the next answers start afresh, as on a new mount.
    let highest = held.key === key && answers.some((answer: { revision?: number } | undefined) => answer !== undefined) ? held.highest : undefined;

    for (const answer of answers) {
        const revision = answer?.revision;

        if (revision !== undefined && (highest === undefined || revision > highest)) {
            highest = revision;
        }
    }

    if (held.key !== key || held.highest !== highest) {
        setHeld({ ...(highest !== undefined && { highest }), key });
    }

    return highest;
};

/**
 * `read` with its answer dropped when that answer saw an older grant revision than `highest` ({@link useGrantRevision}):
 * the card then reads as if that read had not answered, before it chooses the newest answer or decides access. An
 * answer with no revision (the owner's) and one at the highest pass as they are.
 */
export const atGrantRevision = <T extends { revision?: number }, R extends { data: T | undefined }>(read: R, highest: number | undefined): R =>
    read.data?.revision !== undefined && highest !== undefined && read.data.revision < highest ? { ...read, data: undefined } : read;

/** What a read past a recovered subscription needs of its one-shot query. */
interface OneShotRead {
    refetch: (options: { cancelRefetch: boolean }) => Promise<{ isError: boolean }>;
}

/** The reads a recovery sent or joined: another card of the chat that finds one out asks at the same recovery. */
const recoveryReads = new WeakSet<Promise<unknown>>();

/**
 * The read past a recovered subscription: it joins one already out (`cancelRefetch: false`), as every card of the chat
 * asks at the same moment and one read answers them all. A read already out that no recovery sent or joined was sent
 * before the recovery: its failure says nothing of the server since, so once it settles failed, one more goes (joined
 * the same way); a card that finds the read another card's recovery sent waits on that one alone. Whether one is out
 * is the cache's word: a query the card does not keep enabled does not say so in its result.
 */
const readJoined = async (query: OneShotRead, sentBefore: boolean): Promise<void> => {
    const result = await query.refetch({ cancelRefetch: false });

    if (sentBefore && result.isError) {
        await query.refetch({ cancelRefetch: false });
    }
};

export const readPastRecovery = (client: QueryClient, queryKey: QueryKey, query: OneShotRead): void => {
    const cached = client.getQueryCache().find({ exact: true, queryKey });
    const out = cached?.state.fetchStatus === "fetching" ? cached.promise : undefined;
    const read = readJoined(query, out !== undefined && !recoveryReads.has(out));
    // The read is out now, joined or sent: its promise names it.
    const sent = client.getQueryCache().find({ exact: true, queryKey })?.promise;

    if (sent !== undefined) {
        recoveryReads.add(sent);
    }

    read.catch(() => undefined);
};

/**
 * Reads once past a live query that recovers (answers again after it failed) while the card still holds a failure
 * (`failed`): the subscription's first answer back is often its last push again, which clears no failure, so without this
 * read the card would wait for Try again. The read's own answer decides: a failing one keeps the failure, a newer answer
 * clears it. A retry under way is no recovery: a query with no answer yet goes from failed to pending as it retries.
 * `queryKey`: the live query's key; a failure under another key (the last chat's) is no failure of this one.
 */
export const useReadOnRecovery = (
    { isError, isSuccess }: { isError: boolean; isSuccess: boolean },
    queryKey: QueryKey,
    failed: boolean,
    read: () => void,
): void => {
    const key = hashKey(queryKey);
    const failedSince = useRef({ failed: isError, key });
    const readIfFailed = useEffectEvent((): void => {
        if (failed) {
            read();
        }
    });

    useEffect(() => {
        if (failedSince.current.key !== key) {
            failedSince.current = { failed: isError, key };
        } else if (isError) {
            failedSince.current.failed = true;
        } else if (isSuccess && failedSince.current.failed) {
            failedSince.current.failed = false;
            readIfFailed();
        }
    }, [isError, isSuccess, key]);
};
