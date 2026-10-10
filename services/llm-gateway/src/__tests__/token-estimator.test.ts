/**
 * Tests for token estimation and middle-out compression.
 */
import { describe, expect, it } from "vitest";

import { applyMiddleOut, estimateMessageTokens, estimateTokens } from "../lib/token-estimator.js";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe("estimateMessageTokens", () => {
    it("returns 0 for empty messages list with no system", () => {
        expect(estimateMessageTokens([])).toBe(0);
    });

    it("counts system prompt tokens", () => {
        const tokens = estimateMessageTokens([], "Hello world");

        // "Hello world" = 11 chars / 4 = 2.75 → ceil = 3, + 4 overhead = 7
        expect(tokens).toBe(7);
    });

    it("counts message content tokens with overhead", () => {
        const messages = [{ content: "Hello", role: "user" }];
        // "Hello" = 5 chars / 4 = 1.25 → ceil = 2, + 4 overhead = 6
        const tokens = estimateMessageTokens(messages);

        expect(tokens).toBe(6);
    });

    it("handles array content parts", () => {
        const messages = [
            {
                content: [
                    { text: "What is", type: "text" }, // 7 chars
                    { text: " this?", type: "text" }, // 6 chars
                ],
                role: "user",
            },
        ];
        // 13 chars / 4 = 3.25 → ceil = 4, + 4 = 8
        const tokens = estimateMessageTokens(messages);

        expect(tokens).toBe(8);
    });

    it("accumulates tokens across multiple messages", () => {
        const messages = [
            { content: "Hi", role: "user" }, // 2 chars → ceil(0.5)=1 + 4 = 5
            { content: "Hello", role: "assistant" }, // 5 chars → ceil(1.25)=2 + 4 = 6
        ];
        const tokens = estimateMessageTokens(messages);

        expect(tokens).toBe(11);
    });
});

describe("estimateTokens", () => {
    it("returns withinLimit=true when under threshold", () => {
        const messages = [{ content: "Hi", role: "user" }];
        const result = estimateTokens(messages, 1000);

        expect(result.withinLimit).toBe(true);
        expect(result.overflowBy).toBe(0);
    });

    it("returns withinLimit=false and overflowBy>0 when over threshold", () => {
        // Generate a large message
        const largeContent = "a".repeat(4000); // ~1000 tokens
        const messages = [{ content: largeContent, role: "user" }];
        const result = estimateTokens(messages, 100, undefined, 0.95);

        expect(result.withinLimit).toBe(false);
        expect(result.overflowBy).toBeGreaterThan(0);
        expect(result.estimatedTokens).toBeGreaterThan(95); // 95% of 100
    });

    it("respects custom threshold", () => {
        const messages = [{ content: "a".repeat(400), role: "user" }]; // ~100 tokens
        // With threshold=0.5, limit = 50 tokens
        const result = estimateTokens(messages, 100, undefined, 0.5);

        expect(result.withinLimit).toBe(false);
    });

    it("includes system prompt in estimate", () => {
        const system = "a".repeat(4000); // ~1000 tokens
        const messages = [{ content: "Hi", role: "user" }];
        const result = estimateTokens(messages, 100, system, 0.95);

        expect(result.withinLimit).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Middle-out compression
// ---------------------------------------------------------------------------

describe("applyMiddleOut", () => {
    it("returns compressed=false when already within limit", () => {
        const messages = [
            { content: "Hello", role: "user" },
            { content: "Hi", role: "assistant" },
        ];
        const result = applyMiddleOut(messages, 100_000);

        expect(result.compressed).toBe(false);
        expect(result.messages).toEqual(messages);
    });

    it("removes middle messages to fit context window", () => {
        // 20 messages, each ~250 tokens → total ~5000 tokens
        const messages: { content: string; role: string }[] = [];

        for (let i = 0; i < 10; i++) {
            // ~125 tokens each
            messages.push({ content: "a".repeat(500), role: "user" }, { content: "b".repeat(500), role: "assistant" });
        }

        // contextWindow = 1000 tokens → 90% = 900 tokens
        const result = applyMiddleOut(messages, 1000);

        expect(result.compressed).toBe(true);
        expect(result.compressedTokens).toBeLessThanOrEqual(900);
        expect(result.originalTokens).toBeGreaterThan(900);
    });

    it("preserves the last keepPairs user/assistant pairs", () => {
        const messages: { content: string; role: string }[] = [];

        for (let i = 0; i < 6; i++) {
            messages.push(
                { content: `user message ${i} ${"a".repeat(400)}`, role: "user" },
                { content: `assistant reply ${i} ${"b".repeat(400)}`, role: "assistant" },
            );
        }

        const result = applyMiddleOut(messages, 1000, 3);

        // Last 3 pairs = last 6 messages
        const lastUserMessage = messages[messages.length - 2]!;
        const lastAssistantMessage = messages[messages.length - 1]!;

        const resultContent = result.messages.map((m) => m.content);

        expect(resultContent).toContain(lastUserMessage.content);
        expect(resultContent).toContain(lastAssistantMessage.content);
    });

    it("injects a compression notice when messages are removed", () => {
        const messages: { content: string; role: string }[] = [];

        for (let i = 0; i < 10; i++) {
            messages.push({ content: "a".repeat(500), role: "user" }, { content: "b".repeat(500), role: "assistant" });
        }

        const result = applyMiddleOut(messages, 1000);

        if (result.compressed) {
            const notice = result.messages[0];

            expect(notice?.role).toBe("system");
            expect(notice?.content).toContain("truncated");
        }
    });

    it("handles conversation shorter than keepPairs threshold", () => {
        // Only 1 pair — should not crash
        const messages = [
            { content: "a".repeat(300), role: "user" },
            { content: "b".repeat(300), role: "assistant" },
        ];
        // Very tight context window
        const result = applyMiddleOut(messages, 50, 3);

        // With only 1 pair and keepPairs=3, no middle messages to remove
        // compression notice still added but no messages removed
        expect(result).toBeDefined();
    });

    it("returns originalTokens and compressedTokens", () => {
        const messages: { content: string; role: string }[] = [];

        for (let i = 0; i < 10; i++) {
            messages.push({ content: "a".repeat(500), role: "user" }, { content: "b".repeat(500), role: "assistant" });
        }

        const result = applyMiddleOut(messages, 500);

        expect(result.originalTokens).toBeGreaterThan(0);
        expect(result.compressedTokens).toBeGreaterThan(0);

        if (result.compressed) {
            expect(result.originalTokens).toBeGreaterThan(result.compressedTokens);
        }
    });
});
