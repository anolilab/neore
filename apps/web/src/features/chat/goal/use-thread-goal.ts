import type { Id } from "@neore/backend/dataModel";
import { skipToken, useQuery } from "@tanstack/react-query";

import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useCRPC } from "@/lib/lunora/crpc";

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
    const crpc = useCRPC();
    const ready = useAfterFirstPaint();
    const { data } = useQuery(
        crpc.chat.goals.functions.getThreadGoal.queryOptions(threadId && threadId !== "default" && ready ? { threadId: threadId as Id<"threads"> } : skipToken),
    );

    return data ?? null;
};
