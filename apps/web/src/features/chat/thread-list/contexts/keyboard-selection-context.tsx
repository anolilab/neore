import type { ReactNode } from "react";
import { createContext, use, useLayoutEffect, useState } from "react";
import type { StoreApi } from "zustand";
import { createStore, useStore } from "zustand";

interface KeyboardSelection {
    threadId: string | undefined;
}

const KeyboardSelectionContext = createContext<StoreApi<KeyboardSelection> | null>(null);

const NO_SELECTION = createStore<KeyboardSelection>(() => {
    return { threadId: undefined };
});

/**
 * Holds the thread the arrow keys have selected in one list. Rows read it through `useIsKeyboardSelected`, so moving the selection
 * re-renders the row it leaves and the row it reaches, not every row. Each list has its own: another copy of the list keeps its own.
 */
export const KeyboardSelectionProvider = ({ children, threadId }: { children: ReactNode; threadId: string | undefined }) => {
    const [store] = useState(() =>
        createStore<KeyboardSelection>(() => {
            return { threadId };
        }),
    );

    useLayoutEffect(() => {
        store.setState({ threadId });
    }, [store, threadId]);

    return <KeyboardSelectionContext value={store}>{children}</KeyboardSelectionContext>;
};

/** Whether the arrow keys have this thread's row selected: `false` outside a list. */
export const useIsKeyboardSelected = (threadId: string): boolean =>
    useStore(use(KeyboardSelectionContext) ?? NO_SELECTION, (selection: KeyboardSelection) => selection.threadId === threadId);
