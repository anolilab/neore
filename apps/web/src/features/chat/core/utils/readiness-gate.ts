/**
 * A boolean you can wait on.
 *
 * `ChatProvider.sendMessage` used to return early — logging
 * "[ChatProvider] Not authenticated" and nothing else — when the user hit send
 * before the session query had resolved. The text had already left the
 * composer, so it was simply gone. A send now waits on this gate (flipped by an
 * effect as the session lands) and gives up only after a timeout, restoring the
 * composer and showing an error rather than dropping the input.
 */
export interface ReadinessGate {
    isReady: () => boolean;
    set: (ready: boolean) => void;
    /** Resolves `true` once ready, or `false` after `timeoutMs` without it. */
    wait: (timeoutMs: number) => Promise<boolean>;
}

export const createReadinessGate = (initial = false): ReadinessGate => {
    let ready = initial;
    const waiters = new Set<() => void>();

    return {
        isReady: () => ready,
        set: (next) => {
            ready = next;

            if (next) {
                for (const wake of waiters) {
                    wake();
                }

                waiters.clear();
            }
        },
        wait: async (timeoutMs) => {
            if (ready) {
                return true;
            }

            return await new Promise<boolean>((resolve) => {
                const pending: { timer?: ReturnType<typeof setTimeout> } = {};
                const wake = () => {
                    clearTimeout(pending.timer);
                    resolve(true);
                };

                pending.timer = setTimeout(() => {
                    waiters.delete(wake);
                    resolve(false);
                }, timeoutMs);

                waiters.add(wake);
            });
        },
    };
};
