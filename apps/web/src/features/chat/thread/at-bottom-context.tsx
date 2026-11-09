"use client";

import type { FC, ReactNode } from "react";
import { createContext, use, useState, useSyncExternalStore } from "react";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

/**
 * Whether one thread's viewport is scrolled to the bottom. Each `Thread` owns its own, so with several threads mounted at
 * once (the split view) scrolling one does not change what the others do. Without a provider the global store value is used.
 */
interface AtBottomStore {
    get: () => boolean;
    set: (value: boolean) => void;
    subscribe: (listener: () => void) => () => void;
}

const createAtBottomStore = (): AtBottomStore => {
    let value = true;
    const listeners = new Set<() => void>();

    return {
        get: () => value,
        set: (next) => {
            if (next === value) {
                return;
            }

            value = next;

            for (const listener of listeners) {
                listener();
            }
        },
        subscribe: (listener) => {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
    };
};

const AtBottomContext = createContext<AtBottomStore | null>(null);

export const AtBottomProvider: FC<{ children: ReactNode }> = ({ children }) => {
    const [store] = useState(createAtBottomStore);

    return <AtBottomContext value={store}>{children}</AtBottomContext>;
};

const noopSubscribe = (): (() => void) => () => {};

export const useIsAtBottom = (): boolean => {
    const local = use(AtBottomContext);
    const global = useChatUIStore((state) => state.isAtBottom);
    const localValue = useSyncExternalStore(local?.subscribe ?? noopSubscribe, local?.get ?? (() => true), () => true);

    return local ? localValue : global;
};

export const useSetIsAtBottom = (): ((value: boolean) => void) => {
    const local = use(AtBottomContext);
    const setGlobal = useChatUIStore((state) => state.setIsAtBottom);

    return local ? local.set : setGlobal;
};
