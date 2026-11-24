/**
 * `injectPromptCaching` places Anthropic cache breakpoints for OpenRouter only: the system prompt
 * and the end of the conversation. Anthropic allows at most four breakpoints per request, counting
 * any already present, and every other provider must come back untouched.
 */
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { injectPromptCaching } from "../providers/adapters/prompt-cache.js";
import type { ToolDefinition } from "../providers/adapters/types.js";

const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

const CACHE = { type: "ephemeral" };

const system: ModelMessage = { content: "You are helpful.", role: "system" };

const growingConversation = (turns: number): ModelMessage[] => [
    system,
    ...Array.from({ length: turns }, (_, index): ModelMessage => {
        const text = `turn ${index}`;

        return index % 2 === 0 ? { content: text, role: "user" } : { content: text, role: "assistant" };
    }),
];

const hinted = (text: string, role: "assistant" | "user"): ModelMessage => {
    return {
        content: text,
        providerOptions: { anthropic: { cacheControl: CACHE } },
        role,
    };
};

const tools: ToolDefinition[] = [
    { description: "Search the web", name: "search", parameters: { type: "object" } },
    { description: "Fetch a page", name: "fetch", parameters: { type: "object" } },
];

const breakpointsOn = (messages: ModelMessage[]): number[] =>
    messages.flatMap((message, index) => (message.providerOptions?.anthropic?.cacheControl === undefined ? [] : [index]));

describe("injectPromptCaching", () => {
    it("places the system and conversation-end breakpoints for openrouter", () => {
        const messages = growingConversation(5);
        const result = injectPromptCaching(messages, "openrouter", tools);

        expect(breakpointsOn(result.messages)).toEqual([0, messages.length - 1]);
        expect(result.messages.at(-1)?.providerOptions?.anthropic?.cacheControl).toEqual(CACHE);
    });

    it("leaves tool definitions untouched, since the gateway's tool conversion drops tool hints", () => {
        const result = injectPromptCaching(growingConversation(3), "openrouter", tools);

        expect(result.tools).toBe(tools);
        expect(result.tools?.every((tool) => tool.cache_control === undefined)).toBe(true);
    });

    it("counts breakpoints already on the incoming messages against the limit", () => {
        const messages: ModelMessage[] = [
            hinted("a", "user"),
            hinted("b", "user"),
            hinted("c", "user"),
            hinted("d", "user"),
            { content: "latest", role: "user" },
        ];
        const result = injectPromptCaching(messages, "openrouter", tools);

        expect(breakpointsOn(result.messages)).toEqual([0, 1, 2, 3]);
    });

    it("fills the remaining budget with the system prompt and the conversation end, and stops at four", () => {
        const messages: ModelMessage[] = [system, hinted("a", "assistant"), hinted("b", "assistant"), { content: "latest", role: "user" }];
        const result = injectPromptCaching(messages, "openrouter", tools);

        expect(breakpointsOn(result.messages)).toEqual([0, 1, 2, 3]);
        expect(breakpointsOn(result.messages)).toHaveLength(ANTHROPIC_MAX_CACHE_BREAKPOINTS);
    });

    it("keeps the other provider options already on the last message", () => {
        const last: ModelMessage = {
            content: "latest question",
            providerOptions: { openrouter: { trace: "abc" } },
            role: "user",
        };
        const result = injectPromptCaching([system, last], "openrouter");

        expect(result.messages.at(-1)?.providerOptions).toEqual({
            anthropic: { cacheControl: CACHE },
            openrouter: { trace: "abc" },
        });
    });

    it("keeps the other provider options already on the system message", () => {
        const withOptions: ModelMessage = {
            content: "You are helpful.",
            providerOptions: { openrouter: { trace: "abc" } },
            role: "system",
        };
        const result = injectPromptCaching([withOptions, { content: "hi", role: "user" }], "openrouter");

        expect(result.messages[0]?.providerOptions).toEqual({
            anthropic: { cacheControl: CACHE },
            openrouter: { trace: "abc" },
        });
    });

    it("does not add a second breakpoint when the last message is the system message", () => {
        const result = injectPromptCaching([system], "openrouter");

        expect(breakpointsOn(result.messages)).toEqual([0]);
    });

    it("handles an empty conversation without a message breakpoint", () => {
        const result = injectPromptCaching([], "openrouter", tools);

        expect(result.messages).toEqual([]);
        expect(result.tools).toBe(tools);
    });

    it("does not mutate the caller's messages", () => {
        const messages = growingConversation(3);
        const before = structuredClone(messages);

        injectPromptCaching(messages, "openrouter", tools);

        expect(messages).toEqual(before);
    });

    it("stays under Anthropic's breakpoint limit however long the conversation grows", () => {
        for (const turns of [1, 2, 10, 60]) {
            const result = injectPromptCaching(growingConversation(turns), "openrouter", tools);
            const count = breakpointsOn(result.messages).length;

            expect(count).toBe(2);
            expect(count).toBeLessThan(ANTHROPIC_MAX_CACHE_BREAKPOINTS);
        }
    });

    it.each(["anthropic", "custom", "openai", "google", "groq", "cloudflare", "requesty"])("leaves %s messages and tools unchanged", (provider) => {
        const messages = growingConversation(4);
        const result = injectPromptCaching(messages, provider, tools);

        expect(result.messages).toBe(messages);
        expect(result.tools).toBe(tools);
        expect(breakpointsOn(result.messages)).toEqual([]);
    });

    it("returns undefined tools for an out-of-scope provider that sent none", () => {
        const result = injectPromptCaching(growingConversation(2), "custom");

        expect(result.tools).toBeUndefined();
    });
});
