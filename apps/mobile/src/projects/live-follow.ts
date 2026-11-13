import type { Unsubscribe } from "@lunora/client";

export interface Live<T> {
    error: string | undefined;
    /** `undefined` until the first answer, and again after an error: rows of a failed query are not trusted. */
    rows: T[] | undefined;
}

/** A `Live` tagged with the signed-in user and query it belongs to. */
export interface Scoped<T> extends Live<T> {
    scope: string;
}

export const EMPTY_LIVE: Live<never> = { error: undefined, rows: undefined };

/** What `followLive` reads of the Lunora client: `true` once the live connection has answered the screen's subscription. */
export interface SyncState {
    /**
     * `synced` is the screen's own subscription's acknowledgement on a live socket, not the client's aggregate (which also
     * waits on, and settles with, every other subscription). Only such a report can end a refusal.
     */
    isOwnAck?: boolean;
    synced: boolean;
}

/** Which of the client's subscriptions is the screen's: its own `id` when known, else every one of its query. */
export interface OwnSubscription {
    functionPath: string;
    id?: string;
}

/**
 * Whether the screen's subscription is answered on the current socket, from the client's `syncStatus()` and
 * `debug().subscriptions` (`acked`: "acknowledged on the current socket"). The aggregate `synced` also waits on unrelated
 * subscriptions and queued writes. `debug()` carries no args, so the narrowest key is the subscription's `id`
 * ({@link subscriptionIdOf}): another project's subscription to the same query never blocks this one. Without it (the
 * screen joined a subscription already open) every subscription of the query counts. Over HTTP polling the client sets
 * no `acked`, so the aggregate is all there is.
 */
export const ownSyncState = (
    status: { connection: string; synced: boolean },
    subscriptions: ReadonlyArray<{ acked: boolean; functionPath: string; id: string }>,
    own: OwnSubscription,
): SyncState => {
    if (status.connection !== "connected") {
        return { synced: status.synced };
    }

    const isMine = (subscription: { functionPath: string; id: string }): boolean => {
        if (own.id === undefined) {
            return subscription.functionPath === own.functionPath;
        }

        return subscription.id === own.id;
    };
    const mine = subscriptions.filter((subscription) => isMine(subscription));

    return { isOwnAck: true, synced: mine.length > 0 && mine.every((subscription) => subscription.acked) };
};

/**
 * The `id` of the subscription a `subscribe` call opened: the one of its query that is in the client's debug snapshot
 * after the call and was not before. `undefined` when the call joined a subscription already open (deduped by query and
 * args, so it opened none) or the snapshot cannot tell (more than one appeared).
 */
export const subscriptionIdOf = (
    before: ReadonlyArray<{ functionPath: string; id: string }>,
    after: ReadonlyArray<{ functionPath: string; id: string }>,
    functionPath: string,
): string | undefined => {
    const known = new Set(before.map((subscription) => subscription.id));
    const opened = after.filter((subscription) => subscription.functionPath === functionPath && !known.has(subscription.id));

    return opened.length === 1 ? opened[0]?.id : undefined;
};

/**
 * What a screen may show: the state only when it belongs to the current scope.
 * Between a user change and the new subscription's effect, the old user's rows
 * would otherwise still render.
 */
export const liveFor = <T>(state: Scoped<T>, scope: string | undefined): Live<T> => {
    if (scope === undefined || state.scope !== scope) {
        return EMPTY_LIVE;
    }

    return { error: state.error, rows: state.rows };
};

/**
 * Starts a watch for `scope` from an empty state; an error drops the rows. Each answer with rows from the server is
 * reported (`onAnswered`): it proves the connection works, which lets the write controls back on after a reconnect.
 * Rows handed over while `watch` is still subscribing are not: that is the Lunora client replaying a value it held (a
 * joined subscription or the read cache), from before the server was asked, and the server may still refuse the
 * subscription. An error is a refusal by the server, not a lost connection, so it reports nothing.
 *
 * After a reconnect the server may answer an unchanged subscription with a `resume` frame, which calls no rows callback.
 * `watchSync` (the client's `onSyncStatus`) covers it: the client counts the subscription answered then, so a later
 * report of `synced` is reported too. Its first report, made while it is being registered, is the state as it already
 * stood (a held or cached value counts as unanswered there, and nothing was asked since), so it is not. A refusal is
 * reported `synced` too: the client marks the subscription answered (`markQueryRejected`, which emits the sync status)
 * BEFORE it calls the error callback (`failSubscription`), in one call. So a `synced` report waits a microtask and is
 * dropped when the error came in between, and a refused subscription counts no `synced` until its rows arrive again. It
 * is dropped as well when any later report came before it ran (the connection dropped, say): only the latest counts.
 */
export const followLive = <T>(
    scope: string,
    watch: (onRows: (rows: T[]) => void, onError: (message: string) => void) => Unsubscribe,
    publish: (next: Scoped<T>) => void,
    onAnswered: () => void = () => {},
    watchSync?: (listener: (status: SyncState) => void) => Unsubscribe,
): Unsubscribe => {
    publish({ ...EMPTY_LIVE, scope });

    let isSubscribing = true;
    let isRefused = false;
    // Refused, then unanswered since: the next acknowledgement is a new connection's.
    let isAwaitingNewAnswer = false;
    let isStopped = false;
    const stop = watch(
        (rows) => {
            isRefused = false;
            publish({ error: undefined, rows, scope });

            if (!isSubscribing) {
                onAnswered();
            }
        },
        (message) => {
            isRefused = true;
            isAwaitingNewAnswer = false;
            publish({ error: message, rows: undefined, scope });
        },
    );

    let isRegistering = true;
    // Reports so far: only the latest one's check may report, so one followed by a drop (or by anything) never lands.
    let reports = 0;
    const stopSync = watchSync?.((status) => {
        reports += 1;

        // A refused subscription that goes unanswered (a new connection) and is acknowledged again was answered again: the
        // refusal ends. Refused once more, Lunora calls the error callback before this report's check runs, so it stands.
        // Only the subscription's own acknowledgement says so: the aggregate (HTTP polling) also flips with other subscriptions.
        if (isRefused && status.isOwnAck === true && !status.synced) {
            isAwaitingNewAnswer = true;
        } else if (isRefused && isAwaitingNewAnswer && status.isOwnAck === true && status.synced) {
            isRefused = false;
            isAwaitingNewAnswer = false;
        }

        if (isRegistering || !status.synced) {
            return;
        }

        const report = reports;

        queueMicrotask(() => {
            // Still the latest report (no drop or other report since), no refusal and no unsubscribe: the read was answered.
            if (report === reports && !isRefused && !isStopped) {
                onAnswered();
            }
        });
    });

    isRegistering = false;
    isSubscribing = false;

    return () => {
        isStopped = true;
        stopSync?.();
        stop();
    };
};
