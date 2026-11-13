// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { subscribeToAppState, useIsAppActive } from "./use-app-active";

const appState = vi.hoisted(() => {
    return {
        listeners: [] as (() => void)[],
        removed: 0,
        state: "active",
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
        get currentState() {
            return appState.state;
        },
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

describe(useIsAppActive, () => {
    it("is false only while the app is in the background, not for a system sheet over it", () => {
        const seen: boolean[] = [];
        const Probe = () => {
            seen.push(useIsAppActive());

            return null;
        };
        const root = createRoot(document.createElement("div"));
        /** The phone reports a new app state: the native listener installed last hears it. */
        const dispatch = (state: string) => {
            act(() => {
                appState.state = state;
                appState.listeners.at(-1)?.();
            });
        };

        // React reads this to allow `act` outside a testing library.
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
        act(() => {
            root.render(createElement(Probe));
        });

        dispatch("background");
        const inBackground = seen.at(-1);

        dispatch("inactive");
        const underSheet = seen.at(-1);

        dispatch("active");
        const inFront = seen.at(-1);

        act(() => {
            root.unmount();
        });

        expect([inBackground, underSheet, inFront]).toStrictEqual([false, true, true]);
    });
});
