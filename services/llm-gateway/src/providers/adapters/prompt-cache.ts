/**
 * Auto-inject prompt caching hints for providers that support it.
 *
 * Anthropic models via OpenRouter: inject cache_control on system prompt, last tool definition,
 * and the end of the conversation. This gives 90% discount on cached input tokens.
 */
import type { ModelMessage } from "ai";

import type { ToolDefinition } from "./types.js";

const CACHE_CONTROL = { type: "ephemeral" as const };

/**
 * Put a cache breakpoint on a message through the AI SDK's message-level provider options.
 * Existing provider options on the message are kept; only `anthropic.cacheControl` is added.
 */
const withCacheControl = (message: ModelMessage): ModelMessage =>
    ({
        ...message,
        providerOptions: {
            ...message.providerOptions,
            anthropic: { ...message.providerOptions?.anthropic, cacheControl: CACHE_CONTROL },
        },
    }) as ModelMessage;

/**
 * Inject prompt caching directives into messages for supported providers.
 *
 * For Anthropic models via OpenRouter/Requesty (at most three breakpoints per request,
 * under Anthropic's limit of four):
 *   1. The last system message gets cache_control on its content
 *   2. Last tool definition gets cache_control
 *   3. The last message of the conversation gets cache_control, so the next turn reads
 *      the whole prefix from cache instead of re-billing a growing history
 *
 * Other providers are returned unchanged. This is transparent to the caller — messages
 * are returned with cache hints injected without requiring client-side awareness.
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

    // Breakpoint at the end of the conversation. If that message is the system message, this
    // sets the same breakpoint the system step above set, so the count does not go up.
    const lastIndex = result.length - 1;
    const last = result[lastIndex];

    if (last) {
        result[lastIndex] = withCacheControl(last);
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
