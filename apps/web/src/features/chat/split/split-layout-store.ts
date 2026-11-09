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

// The read in flight, shared by every caller that arrives before it settles. Cleared on settle, so a failed read can be retried.
const hydration: { pending?: Promise<void> } = {};

/**
 * Reads the saved layout once. Callers that arrive while the read is pending await the same one, so a later read cannot replace a
 * pane that an earlier caller already opened.
 */
export const hydrateSplitLayout = (): Promise<void> => {
    if (useSplitLayoutStore.persist.hasHydrated()) {
        return Promise.resolve();
    }

    hydration.pending ??= Promise.resolve(useSplitLayoutStore.persist.rehydrate()).finally(() => {
        hydration.pending = undefined;
    });

    return hydration.pending;
};

/** Whether the chat reads: a missing chat answers null or fails, and either way it is not a survivor. */
const readable = async (fetchThread: (threadId: string) => Promise<unknown>, threadId: string): Promise<boolean> => {
    try {
        return (await fetchThread(threadId)) != null;
    } catch {
        return false;
    }
};

/**
 * The chat the route moves to when the routed chat is deleted along with `deletedIds`: the first open pane whose chat still reads, so
 * the other panes stay. A chat that `fetchThread` cannot read (deleted elsewhere) is passed over. Undefined when the preference is off
 * or no pane survives; the caller then goes to `/chat`. Waits for the saved layout first, so a delete before it loads still finds it.
 */
export const survivingPaneAfterDelete = async (
    deletedIds: Iterable<string>,
    fetchThread: (threadId: string) => Promise<unknown>,
): Promise<string | undefined> => {
    if (useUIStateStore.getState().preferences.splitViewEnabled !== true) {
        return undefined;
    }

    await hydrateSplitLayout();

    const deleted = new Set(deletedIds);

    for (const id of useSplitLayoutStore.getState().layout.panes) {
        if (!deleted.has(id) && (await readable(fetchThread, id))) {
            return id;
        }
    }

    return undefined;
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
