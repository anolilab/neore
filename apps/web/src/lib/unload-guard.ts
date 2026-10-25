/**
 * Asks the browser to confirm before the tab closes or reloads, while work
 * only this tab holds is in flight (a local-model reply, a file upload).
 * Backend jobs survive a closed tab and must not take a guard.
 *
 * Each caller holds one guard and releases it when its work ends. The listener
 * exists only while at least one guard is held, so overlapping jobs do not
 * drop the warning early.
 */
const held = new Set<symbol>();

const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    // Browsers show their own text, so there is no message to set.
    event.preventDefault();
};

/** Hold a guard. The returned function releases it, once. */
export const acquireUnloadGuard = (): (() => void) => {
    if (typeof window === "undefined") {
        return () => {};
    }

    const guard = Symbol("unload-guard");

    held.add(guard);

    if (held.size === 1) {
        window.addEventListener("beforeunload", onBeforeUnload);
    }

    return () => {
        if (held.delete(guard) && held.size === 0) {
            window.removeEventListener("beforeunload", onBeforeUnload);
        }
    };
};
