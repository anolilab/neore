"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import type { SplitAction, SplitLayout } from "./split-layout";
import { initialSplitLayout, parseSplitLayout, splitLayoutReducer } from "./split-layout";

type SplitLayoutState = {
    dispatch: (action: SplitAction) => void;
    layout: SplitLayout;
    /** Each pane's header title, reported by the pane once its chat has loaded. Not saved: a reload reads them again. */
    setTitle: (threadId: string, title: string) => void;
    titles: Record<string, string>;
};

/**
 * The chats open side by side, kept in this browser. Hydration is manual (`persist.rehydrate()`, see `hydrateSplitLayout`)
 * so the server render and the first client render agree.
 */
export const useSplitLayoutStore = create<SplitLayoutState>()(
    persist(
        (set, get) => {
            return {
                dispatch: (action) => {
                    const next = splitLayoutReducer(get().layout, action);

                    if (next !== get().layout) {
                        set({ layout: next });
                    }
                },
                layout: initialSplitLayout(),
                setTitle: (threadId, title) => {
                    if (get().titles[threadId] !== title) {
                        set({ titles: { ...get().titles, [threadId]: title } });
                    }
                },
                titles: {},
            };
        },
        {
            merge: (persisted, current) => {
                return { ...current, layout: parseSplitLayout((persisted as { layout?: unknown } | undefined)?.layout) };
            },
            name: "chat-split-layout",
            partialize: (state) => {
                return { layout: state.layout };
            },
            skipHydration: true,
            version: 1,
        },
    ),
);

/** Reads the saved layout once. A second call finds it loaded and leaves the live layout alone. */
export const hydrateSplitLayout = async (): Promise<void> => {
    if (!useSplitLayoutStore.persist.hasHydrated()) {
        await useSplitLayoutStore.persist.rehydrate();
    }
};

/**
 * The chat the route moves to when the routed chat is deleted along with `deletedIds`: the first open pane that survives, so the
 * other panes stay. Undefined when the preference is off or no pane survives; the caller then goes to `/chat`.
 */
export const survivingPaneAfterDelete = (deletedIds: Iterable<string>): string | undefined => {
    if (useUIStateStore.getState().preferences.splitViewEnabled !== true) {
        return undefined;
    }

    const deleted = new Set(deletedIds);

    return useSplitLayoutStore.getState().layout.panes.find((id) => !deleted.has(id));
};

/**
 * Opens a chat as a new pane. `"focused"` when it was already open, `"full"` when every pane is taken (nothing changes).
 * Loads the saved layout first, so a click before the split view has mounted does not lose the panes saved earlier.
 */
export const openThreadInSplitView = async (threadId: string): Promise<"focused" | "full" | "opened"> => {
    await hydrateSplitLayout();

    const wasOpen = useSplitLayoutStore.getState().layout.panes.includes(threadId);

    useSplitLayoutStore.getState().dispatch({ threadId, type: "open" });

    if (wasOpen) {
        return "focused";
    }

    return useSplitLayoutStore.getState().layout.panes.includes(threadId) ? "opened" : "full";
};
