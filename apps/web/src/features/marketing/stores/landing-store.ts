"use client";

/**
 * Landing Store - Zustand store for landing page state
 *
 * Manages composer text, sticky bar visibility, and expanded state.
 */

import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";

/**
 * SessionStorage key for landing page initial message handoff to chat
 */
export const LANDING_MESSAGE_KEY = "landing-initial-message";

interface LandingStore {
    // Composer state
    composerText: string;

    isExpanded: boolean;
    // Sticky bar state
    isSticky: boolean;

    reset: () => void;
    // Actions
    setComposerText: (text: string) => void;
    setIsExpanded: (expanded: boolean) => void;
    setIsSticky: (sticky: boolean) => void;
}

const initialState = {
    composerText: "",
    isExpanded: false,
    isSticky: false,
};

export const useLandingStore = create<LandingStore>()(
    devtools(
        subscribeWithSelector((set) => {
            return {
                ...initialState,

                reset: () => {
                    set(initialState);
                },

                setComposerText: (text) => {
                    set({ composerText: text });
                },

                setIsExpanded: (expanded) => {
                    set({ isExpanded: expanded });
                },

                setIsSticky: (sticky) => {
                    set({ isSticky: sticky });
                },
            };
        }),
        { enabled: process.env.NODE_ENV === "development", name: "landing-store" },
    ),
);

// Stable selector functions
export const selectComposerText = (state: LandingStore) => state.composerText;
export const selectIsSticky = (state: LandingStore) => state.isSticky;
export const selectIsExpanded = (state: LandingStore) => state.isExpanded;

// Action selectors
export const selectSetComposerText = (state: LandingStore) => state.setComposerText;
export const selectSetIsSticky = (state: LandingStore) => state.setIsSticky;
export const selectSetIsExpanded = (state: LandingStore) => state.setIsExpanded;
export const selectReset = (state: LandingStore) => state.reset;
