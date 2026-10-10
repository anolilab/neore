/**
 * Auto-inject prompt caching hints for providers that support it.
 *
 * Anthropic models via OpenRouter: inject cache_control on system prompt + last tool definition.
 * This gives 90% discount on cached input tokens.
 */
import type { ModelMessage } from "ai";

import type { ToolDefinition } from "./types.js";

const CACHE_CONTROL = { type: "ephemeral" as const };

/**
 * Inject prompt caching directives into messages for supported providers.
 *
 * For Anthropic models via OpenRouter/Requesty:
 *   1. System/developer messages get cache_control on content
 *   2. Last tool definition gets cache_control
 *
 * This is transparent to the caller — messages are returned with
 * cache hints injected without requiring client-side awareness.
 */
export const injectPromptCaching = (
    messages: ModelMessage[],
    provider: string,
    toolSchemas?: ToolDefinition[],
): { messages: ModelMessage[]; tools?: ToolDefinition[] } => {
    // Only inject for providers that proxy to Anthropic with caching support
    if (provider !== "openrouter" && provider !== "requesty") {
        return { messages, tools: toolSchemas };
    }

    const result = [...messages];

    // Find the last system message and inject cache_control on its content
    for (let i = result.length - 1; i >= 0; i--) {
        const message = result[i]!;

        if (message.role === "system") {
            if (typeof message.content === "string") {
                // Convert string content to structured format with cache control
                result[i] = {
                    ...message,
                    content: message.content,
                    // AI SDK experimental provider options for cache control
                    providerOptions: {
                        anthropic: { cacheControl: CACHE_CONTROL },
                    },
                } as ModelMessage;
            }

            break; // Only cache the last system message
        }
    }

    // Inject cache_control on the last tool definition for Anthropic prompt caching
    let cachedTools = toolSchemas;

    if (toolSchemas && toolSchemas.length > 0) {
        cachedTools = [...toolSchemas];
        const lastTool = cachedTools[cachedTools.length - 1]!;

        cachedTools[cachedTools.length - 1] = {
            ...lastTool,
            cache_control: CACHE_CONTROL,
        };
    }

    return { messages: result, tools: cachedTools };
};
