/**
 * Auto-inject prompt caching hints for providers that support it.
 *
 * Anthropic models via OpenRouter: inject cache_control on the system prompt, the last tool
 * definition, and the end of the conversation. This gives 90% discount on cached input tokens.
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
 * Breakpoints are added in priority order, and only while the request stays within the
 * provider's limit of four. Breakpoints already on the incoming messages and tools count
 * against that limit.
 *   1. The last system message gets cache_control on its content (OpenRouter and Requesty)
 *   2. The last tool definition gets cache_control (OpenRouter and Requesty)
 *   3. The last message of the conversation gets cache_control, so the next turn reads
 *      the whole prefix from cache (OpenRouter only: the Requesty converter drops
 *      message-level provider options, so the hint would never be sent)
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

    const existing =
        messages.filter((message) => hasMessageBreakpoint(message)).length + (toolSchemas ?? []).filter((tool) => tool.cache_control !== undefined).length;
    let budget = MAX_CACHE_BREAKPOINTS - existing;

    const result = [...messages];

    // 1. Find the last system message and inject cache_control on its content
    for (let i = result.length - 1; i >= 0; i--) {
        const message = result[i]!;

        if (message.role === "system") {
            if (budget > 0 && typeof message.content === "string" && !hasMessageBreakpoint(message)) {
                // Convert string content to structured format with cache control
                result[i] = {
                    ...message,
                    content: message.content,
                    // AI SDK experimental provider options for cache control
                    providerOptions: {
                        anthropic: { cacheControl: CACHE_CONTROL },
                    },
                } as ModelMessage;
                budget--;
            }

            break; // Only cache the last system message
        }
    }

    // 2. Inject cache_control on the last tool definition for Anthropic prompt caching
    let cachedTools = toolSchemas;
    const lastTool = toolSchemas?.at(-1);

    if (toolSchemas && lastTool && budget > 0 && lastTool.cache_control === undefined) {
        cachedTools = [...toolSchemas];
        cachedTools[cachedTools.length - 1] = {
            ...lastTool,
            cache_control: CACHE_CONTROL,
        };
        budget--;
    }

    // 3. Breakpoint at the end of the conversation. Skipped when the system step already
    // tagged that message, and for Requesty, whose converter would drop it.
    const lastIndex = result.length - 1;
    const last = result[lastIndex];

    if (last && provider === "openrouter" && budget > 0 && !hasMessageBreakpoint(last)) {
        result[lastIndex] = withCacheControl(last);
    }

    return { messages: result, tools: cachedTools };
};
