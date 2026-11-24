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

interface Hintable {
    providerOptions?: unknown;
}

interface AnthropicOptions {
    anthropic?: { cacheControl?: unknown };
}

interface Part extends Hintable {
    type: string;
}

const hasMessageBreakpoint = (message: ModelMessage): boolean => message.providerOptions?.anthropic?.cacheControl !== undefined;

const hasPartBreakpoint = (part: Hintable): boolean => (part.providerOptions as AnthropicOptions | undefined)?.anthropic?.cacheControl !== undefined;

const contentParts = (message: ModelMessage): Part[] => (Array.isArray(message.content) ? (message.content as Part[]) : []);

const lastToolResultIndex = (parts: Part[]): number => {
    for (let index = parts.length - 1; index >= 0; index--) {
        if (parts[index]?.type === "tool-result") {
            return index;
        }
    }

    return -1;
};

/**
 * Breakpoints a message sends to the provider, counted the way OpenRouter emits them:
 * - A message-level hint on a tool message is repeated on every tool result, so it costs one slot per result.
 * - Content-part hints count on user and tool messages. OpenRouter ignores them on assistant messages.
 */
const countMessageBreakpoints = (message: ModelMessage): number => {
    const parts = contentParts(message);

    if (message.role === "tool") {
        const results = parts.filter((part) => part.type === "tool-result");

        return hasMessageBreakpoint(message) ? results.length : results.filter((part) => hasPartBreakpoint(part)).length;
    }

    if (message.role === "user") {
        return (hasMessageBreakpoint(message) ? 1 : 0) + parts.filter((part) => hasPartBreakpoint(part)).length;
    }

    return hasMessageBreakpoint(message) ? 1 : 0;
};

/** Whether the message already ends the cached prefix, so a second hint would duplicate it. */
const hasEndBreakpoint = (message: ModelMessage): boolean => {
    if (hasMessageBreakpoint(message)) {
        return true;
    }

    if (message.role !== "tool") {
        return false;
    }

    const parts = contentParts(message);
    const part = parts[lastToolResultIndex(parts)];

    return part !== undefined && hasPartBreakpoint(part);
};

/**
 * Put a cache breakpoint on a message or a content part. Existing provider options are kept;
 * only `anthropic.cacheControl` is added.
 */
const withHint = <T extends Hintable>(target: T): T => {
    const options = (target.providerOptions ?? {}) as AnthropicOptions;

    return { ...target, providerOptions: { ...options, anthropic: { ...options.anthropic, cacheControl: CACHE_CONTROL } } } as T;
};

/**
 * Hint the last tool result instead of the tool message. OpenRouter repeats a message-level hint on
 * every result, so a multi-result tool message would spend several breakpoints on one hint.
 */
const hintLastToolResult = (message: ModelMessage): ModelMessage => {
    const parts = contentParts(message);
    const index = lastToolResultIndex(parts);

    if (index === -1) {
        return message;
    }

    return { ...message, content: parts.map((part, partIndex) => (partIndex === index ? withHint(part) : part)) } as ModelMessage;
};

export interface PromptCacheOptions {
    /**
     * Hint the end of the conversation too, so the next turn can read the whole prefix. Turn this off for
     * one-shot calls, which never read their own prefix back and would only pay the cache-write premium.
     */
    endOfConversation?: boolean;
}

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
 *      prefix from cache. A tool message is hinted on its last tool result.
 *
 * Other providers are returned unchanged. This is transparent to the caller — messages are
 * returned with cache hints injected without requiring client-side awareness.
 */
export const injectPromptCaching = (
    messages: ModelMessage[],
    provider: string,
    toolSchemas?: ToolDefinition[],
    options: PromptCacheOptions = {},
): { messages: ModelMessage[]; tools?: ToolDefinition[] } => {
    if (provider !== "openrouter") {
        return { messages, tools: toolSchemas };
    }

    const { endOfConversation = true } = options;
    let budget = MAX_CACHE_BREAKPOINTS - messages.reduce((total, message) => total + countMessageBreakpoints(message), 0);

    const result = [...messages];

    // 1. Find the last system message and inject cache_control on its content
    for (let i = result.length - 1; i >= 0; i--) {
        const message = result[i]!;

        if (message.role === "system") {
            if (budget > 0 && typeof message.content === "string" && !hasMessageBreakpoint(message)) {
                // Merges into the existing provider options, so other providers' options on this message survive
                result[i] = withHint(message);
                budget--;
            }

            break; // Only cache the last system message
        }
    }

    // 2. Breakpoint at the end of the conversation. Skipped when the system step already tagged
    // that message, since then it already carries a breakpoint.
    const lastIndex = result.length - 1;
    const last = result[lastIndex];

    if (endOfConversation && last && budget > 0 && !hasEndBreakpoint(last)) {
        result[lastIndex] = last.role === "tool" ? hintLastToolResult(last) : withHint(last);
    }

    return { messages: result, tools: toolSchemas };
};
