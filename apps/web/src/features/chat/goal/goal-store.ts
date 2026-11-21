import { GOAL_DEFAULT_ROUNDS, GOAL_MAX_ROUNDS } from "@neore/backend/chat/goals";
import { create } from "zustand";

/** The round caps the composer offers; the backend allows any whole number up to {@link GOAL_MAX_ROUNDS}. */
export const GOAL_ROUND_CHOICES = [3, GOAL_DEFAULT_ROUNDS, GOAL_MAX_ROUNDS] as const;

interface GoalComposerState {
    /** The next message is a goal: the agent keeps working until a review confirms it is met. */
    enabled: boolean;
    maxRounds: number;
    setEnabled: (enabled: boolean) => void;
    setMaxRounds: (maxRounds: number) => void;
}

/** Composer state for "run until done". A goal is a deliberate act, so it is spent by the message that carries it. */
export const useGoalComposer = create<GoalComposerState>()((set) => {
    return {
        enabled: false,
        maxRounds: GOAL_DEFAULT_ROUNDS,
        setEnabled: (enabled) => set({ enabled }),
        setMaxRounds: (maxRounds) => set({ maxRounds }),
    };
});

/** The goal a chat pins (`chat/goals/functions.ts#setPinnedGoal`): the text and review rounds every message in the chat runs with. */
export interface PinnedGoal {
    maxRounds: number;
    text: string;
}

/**
 * The `goal` field of a `/v1/chat` body for `text`, or `undefined` when the message carries none. A goal armed for this
 * message wins over the chat's pin; without one, the pin applies. Blank text carries no goal.
 */
export const goalForMessage = (text: string, pinned?: PinnedGoal | null): { maxRounds: number; text: string } | undefined => {
    const { enabled, maxRounds } = useGoalComposer.getState();
    const trimmed = text.trim();

    if (!trimmed) {
        return undefined;
    }

    if (enabled) {
        return { maxRounds, text: trimmed };
    }

    return pinned ? { maxRounds: pinned.maxRounds, text: pinned.text } : undefined;
};
