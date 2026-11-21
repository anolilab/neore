/**
 * A "Needs you" card in the chat asks the live view card above the composer to take control of the thread's browser:
 * the card owns the lease and the view, so the request goes to it rather than to the backend directly.
 */
import { createContext } from "react";

type Listener = (threadId: string) => boolean;

/**
 * `false` where no live view card is mounted for the messages' thread (a comparison column, whose minimal composer has
 * none): a "Needs you" card there offers no Take control and points to the model's own chat instead.
 */
export const BrowserLiveViewHereContext = createContext<boolean>(true);

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
