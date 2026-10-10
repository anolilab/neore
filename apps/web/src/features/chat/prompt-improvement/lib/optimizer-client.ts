/**
 * Shared client for the prompt-optimizer endpoints exposed by the LLM Gateway.
 *
 * Three flavors:
 *   - user-prompt optimization      → POST /v1/chat/improve-prompt
 *   - system-prompt optimization    → POST /v1/chat/optimize-system-prompt
 *   - iterate (refine with feedback)→ POST /v1/chat/iterate-prompt
 *
 * All three return `{ improvedPrompt: string }` on success.
 */

import env from "@/lib/env";
import { ContentError, ErrorFactory, NetworkError, RateLimitError, ValidationError } from "@/lib/errors";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROMPT_CHARS = 10_000;
/** Longer ceiling for system prompts since they tend to be larger blocks. */
const MAX_SYSTEM_PROMPT_CHARS = 20_000;

export type UserOptimizerStyle = "basic" | "professional" | "planning";
export type SystemOptimizerStyle = "general" | "analytical" | "output-format";

interface BaseArgs {
    jwtToken?: string;

    /**
     * Optional Lunora thread id. Omitted when the optimizer is invoked from
     * a settings page or any context without a real chat thread — the backend
     * creates a temporary thread bound to the user in that case.
     */
    threadId?: string;
}

interface OptimizeUserPromptArgs extends BaseArgs {
    improvementInstructions?: string;
    prompt: string;
    style?: UserOptimizerStyle;
}

interface OptimizeSystemPromptArgs extends BaseArgs {
    improvementInstructions?: string;
    modelId?: string;
    prompt: string;
    style?: SystemOptimizerStyle;
}

interface IteratePromptArgs extends BaseArgs {
    iterateInput: string;
    lastOptimizedPrompt: string;
    mode?: "user" | "system";
}

const validatePromptLength = (value: string, fieldLabel: string, maxChars: number): void => {
    if (!value.trim()) {
        throw new ValidationError(`${fieldLabel} cannot be empty`, "prompt");
    }

    if (value.trim().length > maxChars) {
        throw new ContentError(`${fieldLabel} is too long. Please keep it under ${maxChars.toLocaleString()} characters.`, "prompt");
    }
};

const post = async (url: string, body: Record<string, unknown>, jwtToken?: string): Promise<{ improvedPrompt: string }> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            body: JSON.stringify(body),
            headers: {
                "Content-Type": "application/json",
                ...(jwtToken && { Authorization: `Bearer ${jwtToken}` }),
            },
            method: "POST",
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            if (response.status === 429) {
                const errorData: any = await response.json().catch(() => {
                    return {};
                });
                const retryAfter = errorData.retryAfter || 60_000;

                throw new RateLimitError(errorData.message || "Rate limit exceeded. Please try again later.", retryAfter);
            }

            const errorData: any = await response.json().catch(() => {
                return {};
            });

            throw ErrorFactory.fromResponse(response, errorData.error);
        }

        const data: any = await response.json();

        if (!data.improvedPrompt) {
            throw new Error("No improved prompt received from server");
        }

        return { improvedPrompt: data.improvedPrompt as string };
    } catch (error: any) {
        if (error?.name === "AbortError") {
            throw new NetworkError("Request timed out. Please try again.", true);
        }

        if (error instanceof TypeError && error.message.includes("fetch")) {
            throw new NetworkError("Connection error. Please check your internet connection.", true);
        }

        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
};

export const optimizeUserPromptRequest = async ({ improvementInstructions, jwtToken, prompt, style, threadId }: OptimizeUserPromptArgs): Promise<string> => {
    validatePromptLength(prompt, "Prompt", MAX_PROMPT_CHARS);

    const { improvedPrompt } = await post(
        `${env.VITE_LLM_GATEWAY_URL}/v1/chat/improve-prompt`,
        {
            improvementInstructions: improvementInstructions?.trim() || undefined,
            prompt: prompt.trim(),
            style,
            threadId,
        },
        jwtToken,
    );

    return improvedPrompt;
};

export const optimizeSystemPromptRequest = async ({
    improvementInstructions,
    jwtToken,
    modelId,
    prompt,
    style,
    threadId,
}: OptimizeSystemPromptArgs): Promise<string> => {
    validatePromptLength(prompt, "System prompt", MAX_SYSTEM_PROMPT_CHARS);

    const { improvedPrompt } = await post(
        `${env.VITE_LLM_GATEWAY_URL}/v1/chat/optimize-system-prompt`,
        {
            improvementInstructions: improvementInstructions?.trim() || undefined,
            modelId,
            prompt: prompt.trim(),
            style,
            threadId,
        },
        jwtToken,
    );

    return improvedPrompt;
};

export const iteratePromptRequest = async ({ iterateInput, jwtToken, lastOptimizedPrompt, mode, threadId }: IteratePromptArgs): Promise<string> => {
    validatePromptLength(lastOptimizedPrompt, "Previous prompt", MAX_SYSTEM_PROMPT_CHARS);

    if (!iterateInput.trim()) {
        throw new ValidationError("Feedback cannot be empty", "instructions");
    }

    const { improvedPrompt } = await post(
        `${env.VITE_LLM_GATEWAY_URL}/v1/chat/iterate-prompt`,
        {
            iterateInput: iterateInput.trim(),
            lastOptimizedPrompt: lastOptimizedPrompt.trim(),
            mode,
            threadId,
        },
        jwtToken,
    );

    return improvedPrompt;
};
