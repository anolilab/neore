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
    synced: boolean;
}

/**
 * Whether the subscriptions of one query (`functionPath`, its `__lunoraRef`) are answered on the current socket, from the
 * client's `syncStatus()` and `debug().subscriptions` (`acked`: "acknowledged on the current socket"). The aggregate
 * `synced` also waits on unrelated subscriptions and queued writes, which could keep a project screen's writes off for
 * as long as either lasts. Over HTTP polling the client sets no `acked`, so the aggregate is all there is.
 */
export const ownSyncState = (
    status: { connection: string; synced: boolean },
    subscriptions: ReadonlyArray<{ acked: boolean; functionPath: string }>,
    functionPath: string,
): SyncState => {
    if (status.connection !== "connected") {
        return { synced: status.synced };
    }

    const own = subscriptions.filter((subscription) => subscription.functionPath === functionPath);

    return { synced: own.length > 0 && own.every((subscription) => subscription.acked) };
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
 * dropped when the error came in between, and a refused subscription counts no `synced` until its rows arrive again.
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
            publish({ error: message, rows: undefined, scope });
        },
    );

    let isRegistering = true;
    let isReportPending = false;
    const stopSync = watchSync?.((status) => {
        if (isRegistering || isReportPending || !status.synced) {
            return;
        }

        isReportPending = true;
        queueMicrotask(() => {
            isReportPending = false;

            if (!isRefused && !isStopped) {
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
