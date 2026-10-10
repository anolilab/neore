import { skipToken, useQuery } from "@tanstack/react-query";
import type { LanguageModelUsage } from "ai";
import { useMemo } from "react";

import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

import { DEFAULT_MESSAGE_OPTS } from "../constants/query-options";
import { getValidThreadId } from "./use-validated-thread";

("use client");

/**
 * Hook to get aggregated token usage for a thread.
 * Reads from the composite query (getThreadWithData) which already fetches
 * usage alongside thread, messages, and suggestions in a single call.
 * Uses `select` to extract only the usage field, so the component only
 * re-renders when usage actually changes — not on every message update.
 */
const useThreadUsage = (threadId: string | undefined): LanguageModelUsage | undefined => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading } = useLunoraAuth();
    const validThreadId = getValidThreadId(threadId);

    // Only run query when authenticated, not loading, and threadId is valid
    const shouldQuery = isAuthenticated && !isLoading && !!validThreadId;

    // Stabilize query options to prevent unnecessary re-subscriptions
    const queryOptions = useMemo(
        () => (shouldQuery ? { messageOpts: DEFAULT_MESSAGE_OPTS, threadId: validThreadId! } : skipToken),
        [shouldQuery, validThreadId],
    );

    const { data: usage } = useQuery({
        ...crpc.chat.composite.getThreadWithData.queryOptions(queryOptions),
        select: (data) => data?.usage,
    });

    if (!usage) {
        return undefined;
    }

    // `LanguageModelUsage` only carries cached/reasoning counts inside the detail
    // objects — there are no top-level `cachedInputTokens`/`reasoningTokens` fields.
    return {
        inputTokenDetails: {
            cacheReadTokens: usage.cachedInputTokens,
            cacheWriteTokens: undefined,
            noCacheTokens: undefined,
        },
        inputTokens: usage.inputTokens,
        outputTokenDetails: {
            reasoningTokens: usage.reasoningTokens,
            textTokens: usage.outputTokens,
        },
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
    };
};

export default useThreadUsage;
