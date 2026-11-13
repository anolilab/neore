import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

/** Every mounted user of `useIsAppActive`: a stack of chats shares one native listener instead of one each. */
const subscribers = new Set<() => void>();
const native: { subscription?: { remove: () => void } } = {};

/**
 * Adds a subscriber to app-state changes. The one native listener is installed with the first subscriber and removed
 * with the last, and each change is passed on to every subscriber.
 */
export const subscribeToAppState = (onChange: () => void): () => void => {
    subscribers.add(onChange);
    native.subscription ??= AppState.addEventListener("change", () => {
        for (const subscriber of subscribers) {
            subscriber();
        }
    });

    return () => {
        subscribers.delete(onChange);

        if (subscribers.size === 0) {
            native.subscription?.remove();
            native.subscription = undefined;
        }
    };
};

/** Backgrounded is the one state in which nothing on screen is seen; "inactive" (a system sheet over the app) still shows it. */
const isActive = (): boolean => AppState.currentState !== "background";

/** Whether the app is in the front: polling that only feeds the screen stops while it is not. */
export const useIsAppActive = (): boolean => useSyncExternalStore(subscribeToAppState, isActive, isActive);
