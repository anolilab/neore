/**
 * Memory Extraction Tests
 *
 * Tests for pure helper functions in the memory extraction pipeline:
 * - Privacy marker detection (hasPrivacyMarker)
 * - Jaccard text similarity
 * - Embedding model selection
 */
import { describe, expect, it } from "vitest";

import { filterPrivateToolResults, hasPrivacyMarker } from "./gate";

const WHITESPACE_RE = /\s+/;
// ── hasPrivacyMarker (privacy gate) ──────────────────────────────────────────

describe(hasPrivacyMarker, () => {
    it("should detect lock emoji marker", () => {
        expect(hasPrivacyMarker("Please don't remember this 🔒")).toBe(true);
        expect(hasPrivacyMarker("🔒")).toBe(true);
        expect(hasPrivacyMarker("text 🔒 more text")).toBe(true);
    });

    it("should detect [no-memory] tag (case-insensitive)", () => {
        expect(hasPrivacyMarker("Hello [no-memory]")).toBe(true);
        expect(hasPrivacyMarker("[NO-MEMORY] secret stuff")).toBe(true);
        expect(hasPrivacyMarker("[No-Memory]")).toBe(true);
    });

    it("should detect <no-memory> tag", () => {
        expect(hasPrivacyMarker("<no-memory> private info")).toBe(true);
    });

    it("should detect [private] tag", () => {
        expect(hasPrivacyMarker("[private] don't save this")).toBe(true);
        expect(hasPrivacyMarker("[PRIVATE]")).toBe(true);
    });

    it("should detect <private> tag", () => {
        expect(hasPrivacyMarker("<private>")).toBe(true);
    });

    it("should NOT flag normal messages", () => {
        expect(hasPrivacyMarker("I like TypeScript")).toBe(false);
        expect(hasPrivacyMarker("My name is Alice")).toBe(false);
        expect(hasPrivacyMarker("")).toBe(false);
        expect(hasPrivacyMarker("Using a private method in Java")).toBe(false);
    });
});

// ── filterPrivateToolResults ───────────────────────────────────────────────

describe(filterPrivateToolResults, () => {
    it("drops only the tool results that carry a privacy marker", () => {
        expect.assertions(1);

        const results = [
            { summary: "Weather in Berlin: 18°C, light rain", toolName: "weather" },
            { summary: "Salary slip for Dana 🔒", toolName: "retrieve" },
            { summary: "<PRIVATE> medical record excerpt", toolName: "retrieve" },
            { summary: "notes [no-memory]", toolName: "knowledge" },
            { summary: "TypeScript 5.9 release notes", toolName: "web_search" },
        ];

        expect(filterPrivateToolResults(results).map((r) => r.toolName)).toStrictEqual(["weather", "web_search"]);
    });

    it("treats a missing list as empty", () => {
        expect.assertions(1);

        expect(filterPrivateToolResults(undefined)).toStrictEqual([]);
    });
});

// ── textSimilarity (Jaccard) ───────────────────────────────────────────────

const textSimilarity = (a: string, b: string): number => {
    const wordsA = new Set(a.split(WHITESPACE_RE).filter(Boolean));
    const wordsB = new Set(b.split(WHITESPACE_RE).filter(Boolean));

    if (wordsA.size === 0 && wordsB.size === 0) return 1;

    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let intersection = 0;

    for (const word of wordsA) {
        if (wordsB.has(word)) intersection += 1;
    }

    const union = wordsA.size + wordsB.size - intersection;

    return union === 0 ? 0 : intersection / union;
};

describe("textSimilarity (Jaccard)", () => {
    it("should return 1 for identical strings", () => {
        expect(textSimilarity("hello world", "hello world")).toBe(1);
    });

    it("should return 0 for completely different strings", () => {
        expect(textSimilarity("alpha beta gamma", "delta epsilon zeta")).toBe(0);
    });

    it("should return 1 for two empty strings", () => {
        expect(textSimilarity("", "")).toBe(1);
    });

    it("should return 0 when one string is empty", () => {
        expect(textSimilarity("hello", "")).toBe(0);
        expect(textSimilarity("", "hello")).toBe(0);
    });

    it("should compute partial similarity correctly", () => {
        // "a b c" vs "a b d" → intersection=2, union=4 → 0.5
        expect(textSimilarity("a b c", "a b d")).toBe(0.5);
    });

    it("should handle word order independence", () => {
        expect(textSimilarity("one two three", "three two one")).toBe(1);
    });

    it("should handle duplicates in one string", () => {
        // Set deduplicates: "a a b" → {a, b}, "a b c" → {a, b, c}
        // intersection=2, union=3 → ~0.667
        const sim = textSimilarity("a a b", "a b c");

        expect(sim).toBeCloseTo(0.667, 2);
    });
});

// Note: MEMORY_EMBEDDING_MODEL_NAME tests removed — dynamic import of extract.ts
// pulls in transitive runtime/AI SDK dependencies that aren't resolvable in vitest.
// The embedding model itself (`GatewayEmbeddingModel`, over the gateway's service
// binding) is covered by `chat/lib/gateway-service-binding.test.ts`.
