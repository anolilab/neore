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

/** Starts a watch for `scope` from an empty state; an error drops the rows. */
export const followLive = <T>(
    scope: string,
    watch: (onRows: (rows: T[]) => void, onError: (message: string) => void) => Unsubscribe,
    publish: (next: Scoped<T>) => void,
): Unsubscribe => {
    publish({ ...EMPTY_LIVE, scope });

    return watch(
        (rows) => publish({ error: undefined, rows, scope }),
        (message) => publish({ error: message, rows: undefined, scope }),
    );
};
