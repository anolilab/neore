/**
 * `injectPromptCaching` places Anthropic cache breakpoints for OpenRouter and Requesty only:
 * the system prompt, the last tool, and the end of the conversation. Anthropic allows at most
 * four breakpoints per request, and every other provider must come back untouched.
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

const tools: ToolDefinition[] = [
    { description: "Search the web", name: "search", parameters: { type: "object" } },
    { description: "Fetch a page", name: "fetch", parameters: { type: "object" } },
];

const breakpointsOn = (messages: ModelMessage[]): number[] =>
    messages.flatMap((message, index) => (message.providerOptions?.anthropic?.cacheControl === undefined ? [] : [index]));

const countBreakpoints = (messages: ModelMessage[], toolDefinitions: ToolDefinition[] | undefined): number =>
    breakpointsOn(messages).length + (toolDefinitions ?? []).filter((tool) => tool.cache_control !== undefined).length;

describe("injectPromptCaching", () => {
    it.each(["openrouter", "requesty"])("places a breakpoint on the last message for %s", (provider) => {
        const messages = growingConversation(5);
        const result = injectPromptCaching(messages, provider, tools);

        expect(breakpointsOn(result.messages)).toEqual([0, messages.length - 1]);
        expect(result.messages.at(-1)?.providerOptions?.anthropic?.cacheControl).toEqual(CACHE);
    });

    it("keeps the system breakpoint and the last-tool breakpoint alongside it", () => {
        const result = injectPromptCaching(growingConversation(3), "openrouter", tools);

        expect(result.messages[0]?.providerOptions?.anthropic?.cacheControl).toEqual(CACHE);
        expect(result.tools?.[0]?.cache_control).toBeUndefined();
        expect(result.tools?.[1]?.cache_control).toEqual(CACHE);
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

    it("does not add a second breakpoint when the last message is the system message", () => {
        const result = injectPromptCaching([system], "openrouter");

        expect(breakpointsOn(result.messages)).toEqual([0]);
    });

    it("handles an empty conversation without a message breakpoint", () => {
        const result = injectPromptCaching([], "openrouter", tools);

        expect(result.messages).toEqual([]);
        expect(result.tools?.[1]?.cache_control).toEqual(CACHE);
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
            const count = countBreakpoints(result.messages, result.tools);

            expect(count).toBe(3);
            expect(count).toBeLessThan(ANTHROPIC_MAX_CACHE_BREAKPOINTS);
        }
    });

    it.each(["anthropic", "custom", "openai", "google", "groq", "cloudflare"])("leaves %s messages and tools unchanged", (provider) => {
        const messages = growingConversation(4);
        const result = injectPromptCaching(messages, provider, tools);

        expect(result.messages).toBe(messages);
        expect(result.tools).toBe(tools);
        expect(breakpointsOn(result.messages)).toEqual([]);
        expect(tools.every((tool) => tool.cache_control === undefined)).toBe(true);
    });

    it("returns undefined tools for an out-of-scope provider that sent none", () => {
        const result = injectPromptCaching(growingConversation(2), "custom");

        expect(result.tools).toBeUndefined();
    });
});
