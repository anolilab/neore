"use client";

import type { StateCreator } from "zustand";
import { create } from "zustand";
import { devtools, persist, subscribeWithSelector } from "zustand/middleware";

import type { UserOptimizerStyle } from "@/features/chat/prompt-improvement/lib/optimizer-client";

interface PromptImprovementState {
    addImprovedPrompt: (prompt: string) => void;
    currentPrompt: string;
    currentPromptIndex: number;
    dismiss: () => void;
    error: Error | null;
    hasImproved: boolean;
    improvedPrompts: string[];
    improvementInstructions: string;
    isImproving: boolean;
    isOpen: boolean;
    /** Iterate textarea content. Persisted only while panel is open. */
    iterateInput: string;
    nextPrompt: () => void;
    open: (currentPrompt: string, threadId: string | undefined) => void;
    previousPrompt: () => void;
    retryCount: number;
    setCurrentPrompt: (prompt: string) => void;
    setError: (error: Error | null) => void;
    setHasImproved: (hasImproved: boolean) => void;
    setImprovedPrompts: (prompts: string[]) => void;
    setImprovementInstructions: (instructions: string) => void;
    setIsImproving: (isImproving: boolean) => void;
    setIterateInput: (value: string) => void;
    setRetryCount: (count: number) => void;
    setStyle: (style: UserOptimizerStyle) => void;
    /** Optimizer style chosen by the user. Persisted across sessions. */
    style: UserOptimizerStyle;
    threadId: string | undefined;
}

/**
 * Split out of the `create()(devtools(persist(subscribeWithSelector(…))))` chain so
 * no call sits four levels deep. The explicit `StateCreator` annotation is what
 * lets `set` keep its type outside the `create<T>()` call.
 */
const initialiseState: StateCreator<PromptImprovementState> = (set) => {
    return {
        addImprovedPrompt: (prompt) => {
            set((state) => {
                return {
                    currentPromptIndex: state.improvedPrompts.length,
                    hasImproved: true,
                    improvedPrompts: [...state.improvedPrompts, prompt],
                };
            });
        },
        currentPrompt: "",
        currentPromptIndex: 0,
        dismiss: () => {
            set({
                error: null,
                improvementInstructions: "",
                isOpen: false,
                iterateInput: "",
                retryCount: 0,
            });
        },
        error: null,
        hasImproved: false,
        improvedPrompts: [],
        improvementInstructions: "",
        isImproving: false,
        isOpen: false,
        iterateInput: "",

        nextPrompt: () => {
            set((state) => {
                const nextIndex = Math.min(state.currentPromptIndex + 1, state.improvedPrompts.length - 1);

                return { currentPromptIndex: nextIndex };
            });
        },

        open: (currentPrompt, threadId) => {
            set((state) => {
                const shouldClearPrompts = state.threadId !== undefined && state.threadId !== threadId;

                return {
                    currentPrompt,
                    currentPromptIndex: shouldClearPrompts ? 0 : Math.min(state.currentPromptIndex, state.improvedPrompts.length - 1),
                    error: null,
                    hasImproved: shouldClearPrompts ? false : state.improvedPrompts.length > 0,
                    improvedPrompts: shouldClearPrompts ? [] : state.improvedPrompts,
                    improvementInstructions: "",
                    isOpen: true,
                    iterateInput: "",
                    retryCount: 0,
                    threadId,
                };
            });
        },

        previousPrompt: () => {
            set((state) => {
                const previousIndex = Math.max(state.currentPromptIndex - 1, 0);

                return { currentPromptIndex: previousIndex };
            });
        },

        retryCount: 0,

        setCurrentPrompt: (prompt) => {
            set((state) => {
                if (state.isOpen) {
                    return { currentPrompt: prompt };
                }

                return state;
            });
        },

        setError: (error) => {
            set({ error });
        },

        setHasImproved: (hasImproved) => {
            set({ hasImproved });
        },

        setImprovedPrompts: (prompts) => {
            set({
                currentPromptIndex: 0,
                hasImproved: prompts.length > 0,
                improvedPrompts: prompts,
            });
        },

        setImprovementInstructions: (instructions) => {
            set({ improvementInstructions: instructions });
        },

        setIsImproving: (isImproving) => {
            set({ isImproving });
        },

        setIterateInput: (value) => {
            set({ iterateInput: value });
        },

        setRetryCount: (count) => {
            set({ retryCount: count });
        },

        setStyle: (style) => {
            set({ style });
        },

        style: "basic" as UserOptimizerStyle,

        threadId: undefined,
    };
};

const persistedState = persist(subscribeWithSelector(initialiseState), {
    name: "prompt-improvement-store",
    /** Only persist the user's optimizer-style preference. Everything else is ephemeral. */
    partialize: (state) => {
        return { style: state.style };
    },
    version: 1,
});

const usePromptImprovementStore = create<PromptImprovementState>()(
    devtools(persistedState, { enabled: process.env.NODE_ENV === "development", name: "prompt-improvement-store" }),
);

export default usePromptImprovementStore;
