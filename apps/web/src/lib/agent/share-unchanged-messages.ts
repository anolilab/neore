import { replaceEqualDeep } from "@tanstack/react-query";

/** A message's id; `useUIMessages` is generic over a shape that does not declare one. */
const idOf = (message: unknown): string | undefined => {
    const { id } = message as { id?: unknown };

    return typeof id === "string" ? id : undefined;
};

/**
 * Structural sharing for a live message page, matched by message `id`.
 *
 * Every live push is a freshly decoded page, and `combineUIMessages` rebuilds
 * multi-step replies on top of that, so without this every message object is new
 * on every push and every memoized row re-renders for a change to one of them.
 * Matching by id rather than position keeps identity when `loadMore` prepends
 * older messages. Returns `previous` itself when nothing changed.
 */
export const shareUnchangedMessages = <M extends object>(previous: ReadonlyArray<M>, next: M[]): M[] => {
    if (previous.length === 0 || next.length === 0) {
        return next;
    }

    const previousById = new Map<string, M>();

    for (const message of previous) {
        const id = idOf(message);

        if (id !== undefined) {
            previousById.set(id, message);
        }
    }

    let isIdentical = previous.length === next.length;

    const shared = next.map((message, index) => {
        const id = idOf(message);
        const before = id === undefined ? undefined : previousById.get(id);
        // Deep-compares, and on a difference still reuses the unchanged parts inside.
        const result = before === undefined ? message : (replaceEqualDeep(before, message) as M);

        if (result !== previous[index]) {
            isIdentical = false;
        }

        return result;
    });

    return isIdentical ? (previous as M[]) : shared;
};
