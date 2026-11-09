import useAfterFirstPaint from "@/hooks/use-after-first-paint";

import { useThreadPaneState } from "../thread/use-thread-pane-state";
import type { GoalVerdictView } from "./goal-view";

export interface ThreadGoalView {
    costMicrodollars: number;
    createdAt: number;
    goalId: string;
    maxCostMicrodollars: number;
    maxRounds: number;
    round: number;
    startMessageId: string;
    status: "active" | "met" | "stopped";
    stopReason?: "cost_limit" | "daily_limit" | "error" | "review_failed" | "round_limit" | "superseded" | "unsupported" | "user";
    text: string;
    verdicts: GoalVerdictView[];
}

/**
 * The thread's latest goal: live, so each round's verdict appears as it lands. Read after first
 * paint (the thread draws without it), and only for a real thread.
 */
export const useThreadGoal = (threadId: string | undefined): ThreadGoalView | null => {
    const ready = useAfterFirstPaint();
    const { data } = useThreadPaneState(threadId, { enabled: threadId !== "default" && ready });

    return data?.goal ?? null;
};
