"use client";

import { create } from "zustand";
import type { StateStorage } from "zustand/middleware";
import { createJSONStorage, persist } from "zustand/middleware";

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
 * Whether the saved layout has been read in this page. Until it has, the store holds an empty layout, and a write would replace the
 * saved panes with it when the read fails (zustand swallows a failed read: its `onRehydrateStorage` callback is the only signal).
 */
const savedLayout = { read: false };

const guardedLocalStorage: StateStorage = {
    // A value that does not parse is treated as no saved layout. Otherwise it would fail every read, and the write guard would then block
    // every save for good.
    getItem: (name) => {
        const raw = localStorage.getItem(name);

        if (raw === null) {
            return null;
        }

        try {
            JSON.parse(raw);

            return raw;
        } catch {
            return null;
        }
    },
    removeItem: (name) => localStorage.removeItem(name),
    setItem: (name, value) => {
        if (savedLayout.read) {
            localStorage.setItem(name, value);
        }
    },
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
            onRehydrateStorage: () => (_state, error) => {
                savedLayout.read = error === undefined;
            },
            storage: createJSONStorage(() => guardedLocalStorage),
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

    const read = async (): Promise<void> => {
        await useSplitLayoutStore.persist.rehydrate();

        // zustand resolves a read that failed too: only a store that has hydrated holds the saved layout.
        if (!useSplitLayoutStore.persist.hasHydrated()) {
            throw new Error("The saved split layout could not be read.");
        }
    };

    hydration.pending ??= read().finally(() => {
        hydration.pending = undefined;
    });

    return hydration.pending;
};

/**
 * The saved layout for the split view's own start. A layout that cannot be read starts empty instead of holding the view back: the
 * route's chat still shows. The chat-opening paths use `hydrateSplitLayout` directly, so they can fall back on a failed read.
 */
export const readSavedLayoutOrEmpty = async (): Promise<void> => {
    try {
        await hydrateSplitLayout();
    } catch {
        // The saved layout stays empty; a later read may still succeed.
    }
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

    try {
        await hydrateSplitLayout();
    } catch {
        // An unreadable layout has no pane to move to: the caller goes to the chat list instead.
        return undefined;
    }

    const deleted = new Set(deletedIds);
    const candidates = useSplitLayoutStore.getState().layout.panes.filter((id) => !deleted.has(id));
    // Read in parallel: the first candidate, in pane order, that reads wins.
    const reads = await Promise.all(candidates.map((id) => readable(fetchThread, id)));

    return candidates[reads.indexOf(true)];
};

/** Whether the address names one of these chats: a delete that has moved the route on must not move it again. */
export const routeIsOn = (threadIds: ReadonlyArray<string>): boolean => globalThis.location.pathname.split("/").some((part) => threadIds.includes(part));

/** What opening a chat as a pane did: it was already open, it opened, every pane is taken, or a later click has overtaken this one. */
export type PaneOpenResult = "focused" | "full" | "opened" | "superseded";

/** Dispatches one open action once the saved layout is in. */
const openPane = async (threadId: string, type: "open" | "openBeside", after: string | undefined, isCurrent: () => boolean): Promise<PaneOpenResult> => {
    await hydrateSplitLayout();

    // A click a later one has overtaken changes nothing: the later click's pane is the one wanted.
    if (!isCurrent()) {
        return "superseded";
    }

    const wasOpen = useSplitLayoutStore.getState().layout.panes.includes(threadId);

    useSplitLayoutStore.getState().dispatch(type === "open" ? { threadId, type } : { after, threadId, type });

    if (wasOpen) {
        return "focused";
    }

    return useSplitLayoutStore.getState().layout.panes.includes(threadId) ? "opened" : "full";
};

/**
 * Opens a chat as a new pane at the end. `"focused"` when it was already open, `"full"` when every pane is taken (nothing changes).
 * Loads the saved layout first, so a click before the split view has mounted does not lose the panes saved earlier.
 */
export const openThreadInSplitView = (threadId: string): Promise<PaneOpenResult> => openPane(threadId, "open", undefined, () => true);

/**
 * Opens a chat as a pane right after `afterThreadId`'s pane, or after the focused one when that chat has no pane: the side panel a
 * sub-agent link opens. Same results as `openThreadInSplitView`.
 */
export const openThreadBesideFocusedPane = (threadId: string, afterThreadId?: string, isCurrent: () => boolean = () => true): Promise<PaneOpenResult> =>
    openPane(threadId, "openBeside", afterThreadId, isCurrent);

/**
 * Shows a chat in the main view while the split view is on: focuses its pane, or puts it in place of the focused pane, as a route
 * change does. A route that already names the chat does not change, so the main view needs this to move focus to it.
 */
export const showThreadInSplitView = async (threadId: string, isCurrent: () => boolean = () => true): Promise<void> => {
    await hydrateSplitLayout();

    if (isCurrent()) {
        useSplitLayoutStore.getState().dispatch({ threadId, type: "show" });
    }
};
