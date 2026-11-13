import { useEffect, useSyncExternalStore } from "react";

/**
 * Messages whose rows must stay mounted however the list is scrolled, because something in them holds state
 * a remount would lose (an open diff comment box with unsent text, the diff dialog). The message list adds
 * them to the virtualizer's range. Counted per id, so two holders in one row release it only when both have.
 */
const counts = new Map<string, number>();
const listeners = new Set<() => void>();
const EMPTY: ReadonlySet<string> = new Set();
const store: { snapshot: ReadonlySet<string> } = { snapshot: EMPTY };

const publish = (): void => {
    store.snapshot = counts.size === 0 ? EMPTY : new Set(counts.keys());

    for (const listener of listeners) {
        listener();
    }
};

const pin = (messageId: string): (() => void) => {
    counts.set(messageId, (counts.get(messageId) ?? 0) + 1);
    publish();

    return () => {
        const left = (counts.get(messageId) ?? 1) - 1;

        if (left > 0) {
            counts.set(messageId, left);
        } else {
            counts.delete(messageId);
        }

        publish();
    };
};

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};

const getSnapshot = (): ReadonlySet<string> => store.snapshot;
const getServerSnapshot = (): ReadonlySet<string> => EMPTY;

/** Keeps the row of `messageId` mounted while `active`. */
export const useKeepRowMounted = (messageId: string | undefined, active: boolean): void => {
    useEffect(() => {
        if (messageId === undefined || !active) {
            return undefined;
        }

        return pin(messageId);
    }, [active, messageId]);
};

/** The ids of the messages whose rows are held mounted. */
export const usePinnedRowIds = (): ReadonlySet<string> => useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
