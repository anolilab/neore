/**
 * A "Needs you" card in the chat asks the live view card above the composer to take control of the thread's browser:
 * the card owns the lease and the view, so the request goes to it rather than to the backend directly.
 */
type Listener = (threadId: string) => boolean;

const listeners = new Set<Listener>();

/** Asks the live view card of `threadId` to take control. `false`: no card of that thread is mounted to take it. */
export const requestBrowserControl = (threadId: string): boolean => {
    let taken = false;

    for (const listener of listeners) {
        taken = listener(threadId) || taken;
    }

    return taken;
};

/** The live view card's side: `listener` answers whether it took the request (its thread, and it may control). */
export const onBrowserControlRequest = (listener: Listener): (() => void) => {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};
