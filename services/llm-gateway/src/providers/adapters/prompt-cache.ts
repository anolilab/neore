/**
 * Auto-inject prompt caching hints for providers that support it.
 *
 * Anthropic models via OpenRouter: inject cache_control on the system prompt and at the end of the
 * conversation. This gives 90% discount on cached input tokens.
 */
import type { ModelMessage } from "ai";

import type { ToolDefinition } from "./types.js";

const CACHE_CONTROL = { type: "ephemeral" as const };

/** The provider's per-request limit on cache breakpoints. */
const MAX_CACHE_BREAKPOINTS = 4;

const hasMessageBreakpoint = (message: ModelMessage): boolean => message.providerOptions?.anthropic?.cacheControl !== undefined;

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
 * Only OpenRouter is in scope. It forwards message-level cache hints. Requesty's converter drops
 * message-level options and tool cache hints, and the gateway's tool conversion drops them too, so
 * a tool hint never reached the provider and is not set here.
 *
 * Breakpoints are added in priority order, and only while the request stays within the provider's
 * limit of four. Breakpoints already on the incoming messages count against that limit.
 *   1. The last system message gets cache_control on its content
 *   2. The last message of the conversation gets cache_control, so the next turn reads the whole
 *      prefix from cache
 *
 * Other providers are returned unchanged. This is transparent to the caller — messages are
 * returned with cache hints injected without requiring client-side awareness.
 */
export const injectPromptCaching = (
    messages: ModelMessage[],
    provider: string,
    toolSchemas?: ToolDefinition[],
): { messages: ModelMessage[]; tools?: ToolDefinition[] } => {
    if (provider !== "openrouter") {
        return { messages, tools: toolSchemas };
    }

    let budget = MAX_CACHE_BREAKPOINTS - messages.filter((message) => hasMessageBreakpoint(message)).length;

    const result = [...messages];

    // 1. Find the last system message and inject cache_control on its content
    for (let i = result.length - 1; i >= 0; i--) {
        const message = result[i]!;

        if (message.role === "system") {
            if (budget > 0 && typeof message.content === "string" && !hasMessageBreakpoint(message)) {
                // Merges into the existing provider options, so other providers' options on this message survive
                result[i] = withCacheControl(message);
                budget--;
            }

            break; // Only cache the last system message
        }
    }

    // 2. Breakpoint at the end of the conversation. Skipped when the system step already tagged
    // that message, since then it already carries a breakpoint.
    const lastIndex = result.length - 1;
    const last = result[lastIndex];

    if (last && budget > 0 && !hasMessageBreakpoint(last)) {
        result[lastIndex] = withCacheControl(last);
    }

    return { messages: result, tools: toolSchemas };
};
