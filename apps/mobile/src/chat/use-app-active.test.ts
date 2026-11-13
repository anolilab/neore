import { describe, expect, it, vi } from "vitest";

import { subscribeToAppState } from "./use-app-active";

const appState = vi.hoisted(() => {
    return {
        listeners: [] as (() => void)[],
        removed: 0,
    };
});

// The app state is a native module that cannot load in Node; this one counts the native listeners installed.
// eslint-disable-next-line no-restricted-syntax -- react-native cannot load in Node; there is nothing to inject into the hook
vi.mock(import("react-native"), () => ({
    AppState: {
        addEventListener: (_event: string, listener: () => void) => {
            appState.listeners.push(listener);

            return {
                remove: () => {
                    appState.removed += 1;
                },
            };
        },
        currentState: "active",
    },
} as never));

describe(subscribeToAppState, () => {
    it("installs one native listener for any number of chats, passes each change to all, and removes it with the last", () => {
        const first = vi.fn();
        const second = vi.fn();

        const unsubscribeFirst = subscribeToAppState(first);
        const unsubscribeSecond = subscribeToAppState(second);

        expect(appState.listeners).toHaveLength(1);

        appState.listeners[0]?.();

        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();

        unsubscribeFirst();

        expect(appState.removed).toBe(0);

        unsubscribeSecond();

        expect(appState.removed).toBe(1);

        subscribeToAppState(first)();

        expect(appState.listeners).toHaveLength(2);
        expect(appState.removed).toBe(2);
    });
});
