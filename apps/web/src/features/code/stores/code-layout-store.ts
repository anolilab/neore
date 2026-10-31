"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { Layout, LayoutAction } from "@/features/code/lib/layout";
import { initialLayout, layoutReducer, parseLayout } from "@/features/code/lib/layout";

type CodeLayoutState = {
    dispatch: (action: LayoutAction) => void;
    layout: Layout;
};

/**
 * The open tabs and split of the Code workspace, kept in this browser. Hydration is manual
 * (`persist.rehydrate()` in an effect) so the server render and the first client render agree.
 */
export const useCodeLayoutStore = create<CodeLayoutState>()(
    persist(
        (set, get) => {
            return {
                dispatch: (action) => {
                    const next = layoutReducer(get().layout, action);

                    if (next !== get().layout) {
                        set({ layout: next });
                    }
                },
                layout: initialLayout(),
            };
        },
        {
            merge: (persisted, current) => {
                return { ...current, layout: parseLayout((persisted as { layout?: unknown } | undefined)?.layout) };
            },
            name: "code-layout",
            partialize: (state) => {
                return { layout: state.layout };
            },
            skipHydration: true,
            version: 1,
        },
    ),
);
