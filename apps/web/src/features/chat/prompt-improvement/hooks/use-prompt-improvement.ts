import { useCallback, useState } from "react";

import type { UserOptimizerStyle } from "@/features/chat/prompt-improvement/lib/optimizer-client";
import { iteratePromptRequest, optimizeUserPromptRequest } from "@/features/chat/prompt-improvement/lib/optimizer-client";
import usePromptImprovementStore from "@/features/chat/prompt-improvement/stores/prompt-improvement-store";
import getSessionToken from "@/lib/auth/server-functions";
import { ContentError, ErrorFactory, ErrorUtilities, NetworkError, RateLimitError, ValidationError } from "@/lib/errors";
import { promptToast } from "@/lib/toast";

interface ImproveOptions {
    improvementInstructions?: string;
    style?: UserOptimizerStyle;
}

/**
 * Hook used by the composer prompt-improvement panel.
 *
 * `threadId` is optional — when omitted the backend creates a temporary
 * thread for the optimization run.
 */
const usePromptImprovement = (threadId: string | undefined) => {
    const [isImproving, setIsImproving] = useState(false);
    const [retryCount, setRetryCount] = useState(0);

    const setStoreIsImproving = usePromptImprovementStore.getState().setIsImproving;
    const setStoreRetryCount = usePromptImprovementStore.getState().setRetryCount;

    const getJwtToken = useCallback(async (): Promise<string | undefined> => {
        const token = await getSessionToken();

        return token ?? undefined;
    }, []);

    const improvePrompt = useCallback(
        async (prompt: string, options?: ImproveOptions): Promise<string> => {
            setIsImproving(true);
            setStoreIsImproving(true);

            promptToast.improving("prompt-improvement");

            try {
                const jwtToken = await getJwtToken();
                const improved = await optimizeUserPromptRequest({
                    improvementInstructions: options?.improvementInstructions,
                    jwtToken,
                    prompt,
                    style: options?.style,
                    threadId,
                });

                promptToast.improved("prompt-improvement");
                setRetryCount(0);
                setStoreRetryCount(0);

                return improved;
            } catch (error: any) {
                promptToast.failed(error, undefined, "prompt-improvement");

                if (error?.data?.kind === "RateLimitError") {
                    throw ErrorFactory.fromBackendError(error);
                }

                if (error instanceof RateLimitError || error instanceof ValidationError || error instanceof NetworkError || error instanceof ContentError) {
                    throw error;
                }

                throw ErrorFactory.fromResponse(new Response(null, { status: 500 }), error.message || "Failed to improve prompt");
            } finally {
                setIsImproving(false);
                setStoreIsImproving(false);
            }
        },
        [getJwtToken, threadId, setStoreIsImproving, setStoreRetryCount],
    );

    const improvePromptWithRetry = useCallback(
        async (prompt: string, options?: ImproveOptions, maxRetries: number = 3): Promise<string> => {
            let lastError: Error;

            for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
                try {
                    return await improvePrompt(prompt, options);
                } catch (error: any) {
                    lastError = error;

                    if (error instanceof ValidationError || error instanceof RateLimitError || error instanceof ContentError) {
                        throw error;
                    }

                    if (attempt === maxRetries) {
                        throw error;
                    }

                    if (!ErrorUtilities.isRetryable(error)) {
                        throw error;
                    }

                    const delay = ErrorUtilities.getRetryDelay(error, attempt);

                    await new Promise((resolve) => {
                        setTimeout(resolve, delay);
                    });
                    setRetryCount(attempt);
                    setStoreRetryCount(attempt);
                }
            }

            throw lastError!;
        },
        [improvePrompt, setStoreRetryCount],
    );

    const iterate = useCallback(
        async (lastOptimizedPrompt: string, iterateInput: string, mode: "user" | "system" = "user"): Promise<string> => {
            setIsImproving(true);
            setStoreIsImproving(true);

            try {
                const jwtToken = await getJwtToken();

                return await iteratePromptRequest({
                    iterateInput,
                    jwtToken,
                    lastOptimizedPrompt,
                    mode,
                    threadId,
                });
            } finally {
                setIsImproving(false);
                setStoreIsImproving(false);
            }
        },
        [getJwtToken, threadId, setStoreIsImproving],
    );

    return {
        improvePrompt: improvePromptWithRetry,
        isImproving,
        iterate,
        retryCount,
    };
};

export default usePromptImprovement;
