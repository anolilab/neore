import { LunoraError } from "lunorash/server";
import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../_generated/internal";
import { getCurrentUserInternal } from "../auth/lib/helper";
import { promptsLogger } from "../lib/logger";

/**
 * HTTP action for prompt optimization (wrapper around the internal action).
 */
const optimizePromptHttpAction = async (context: HttpActionCtx, request: Request) => {
    // The caller is resolved HERE and handed to the action by id: an internal
    // action has no identity of its own to read.
    const user = await getCurrentUserInternal(context).catch(() => undefined);

    if (!user?._id) {
        return Response.json({ error: "Not authenticated" }, { headers: { "Content-Type": "application/json" }, status: 401 });
    }

    // Parse the request body
    // `Request.json()` is `Promise<unknown>` — this destructure was reading
    // `.content` off it unchecked.
    const body = (await request.json()) as { content?: unknown; improvementInstructions?: unknown };
    const content = typeof body.content === "string" ? body.content : undefined;

    if (!content) {
        return Response.json(
            { error: "Missing prompt content" },
            {
                headers: { "Content-Type": "application/json" },
                status: 400,
            },
        );
    }

    const improvementInstructions = typeof body.improvementInstructions === "string" ? body.improvementInstructions : undefined;

    try {
        const result = await context.runAction(internal.prompts.functions.optimizePrompt, {
            content,
            improvementInstructions,
            userId: user._id,
        });

        return Response.json(result, {
            headers: { "Content-Type": "application/json" },
            status: 200,
        });
    } catch (error) {
        promptsLogger.error("Error optimizing prompt:", error);

        // Handle rate limit errors
        if (error instanceof LunoraError) {
            const errorData = error.data as { kind?: string; message?: string; retryAfter?: number } | undefined;

            if (errorData?.kind === "RateLimitError") {
                return Response.json(
                    {
                        error: errorData.message || "Rate limit exceeded",
                        kind: "RateLimitError",
                        retryAfter: errorData.retryAfter,
                    },
                    {
                        headers: { "Content-Type": "application/json" },
                        status: 429,
                    },
                );
            }

            return Response.json(
                { error: error.message },
                {
                    headers: { "Content-Type": "application/json" },
                    status: 500,
                },
            );
        }

        return Response.json(
            { error: "Failed to optimize prompt" },
            {
                headers: { "Content-Type": "application/json" },
                status: 500,
            },
        );
    }
};

export default optimizePromptHttpAction;
