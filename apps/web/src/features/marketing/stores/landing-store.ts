"use client";

/**
 * Landing Store - Zustand store for landing page state
 *
 * Manages composer text, sticky bar visibility, and expanded state.
 */

import type { DraftFrom } from "@neore/backend/not-typed-text";
import { parseNotTypedDraft } from "@neore/backend/not-typed-text";
import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";

/**
 * SessionStorage key for landing page initial message handoff to chat
 */
export const LANDING_MESSAGE_KEY = "landing-initial-message";

/** Beside it: where the handed-off text came from when the person did not type it (`features/chat/core/utils/draft-origin.ts`). */
export const LANDING_MESSAGE_FROM_KEY = "landing-initial-message-from";

/**
 * Hands `text` to the new chat's composer (`/chat?initialMessage=true`). `from` marks text the person did not type (forwarded
 * messages, an onboarding template); without it a mark left by an earlier hand-off is cleared. Throws when sessionStorage is
 * unavailable.
 */
export const handOffLandingMessage = (text: string, from?: DraftFrom): void => {
    // The earlier text goes before its mark, and the new mark goes in before the new text: a write that fails part way
    // (a full quota) leaves no text, never text without its mark.
    sessionStorage.removeItem(LANDING_MESSAGE_KEY);

    if (from === undefined) {
        sessionStorage.removeItem(LANDING_MESSAGE_FROM_KEY);
    } else {
        sessionStorage.setItem(LANDING_MESSAGE_FROM_KEY, from);
    }

    sessionStorage.setItem(LANDING_MESSAGE_KEY, text);
};

/** Takes the hand-off (`handOffLandingMessage`) out of sessionStorage: its text and mark, an unknown mark read as a link's (fail closed). */
export const takeLandingMessage = (): { from: DraftFrom | undefined; text: string } | undefined => {
    const text = sessionStorage.getItem(LANDING_MESSAGE_KEY);

    if (!text) {
        return undefined;
    }

    const from = parseNotTypedDraft(sessionStorage.getItem(LANDING_MESSAGE_FROM_KEY) ?? undefined);

    sessionStorage.removeItem(LANDING_MESSAGE_KEY);
    sessionStorage.removeItem(LANDING_MESSAGE_FROM_KEY);

    return { from: from === null ? "promptLink" : from, text };
};

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
