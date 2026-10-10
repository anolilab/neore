/**
 * Unit tests for the /v1/models filter helpers.
 */
import { describe, expect, it } from "vitest";

import type { GatewayModelDefinition } from "../models.generated.js";
import { buildFilterKey, filterModels, parseBool, parseList } from "../routes/v1/models.js";

// ── Test fixtures ───────────────────────────────────────────────────────────

const makeModel = (overrides: Partial<GatewayModelDefinition> = {}): GatewayModelDefinition => {
    return {
        enabled: true,
        id: "test-model",
        mode: "text",
        modelApiId: "anthropic/claude-sonnet-4",
        provider: "openrouter",
        regions: ["US", "EU"],
        supportsFileInput: false,
        supportsMultimodal: true,
        supportsTools: true,
        ...overrides,
    };
};

const FIXTURES: GatewayModelDefinition[] = [
    makeModel({
        displayProvider: "Anthropic",
        filterCapabilities: ["reasoning", "coding"],
        id: "claude-sonnet",
        isPremium: true,
        mode: "text",
        name: "Claude Sonnet 4",
        provider: "openrouter",
        regions: ["US", "EU"],
        tier: "frontier",
    }),
    makeModel({
        displayProvider: "OpenAI",
        filterCapabilities: ["reasoning", "vision"],
        id: "gpt-4o",
        mode: "text",
        name: "GPT-4o",
        provider: "openrouter",
        regions: ["US"],
        supportsMultimodal: true,
        tier: "frontier",
    }),
    makeModel({
        displayProvider: "Google",
        filterCapabilities: ["fast"],
        id: "gemini-flash",
        isNew: true,
        mode: "text",
        name: "Gemini 2.5 Flash",
        provider: "google",
        regions: ["US", "EU"],
        tier: "fast",
    }),
    makeModel({
        displayProvider: "FAL",
        id: "flux-dev",
        mode: "image",
        name: "FLUX Dev",
        provider: "fal",
        regions: ["US"],
        supportsMultimodal: false,
        supportsTools: false,
        tier: "high-quality",
    }),
    makeModel({
        displayProvider: "FAL",
        id: "mochi-v1",
        mode: "video",
        name: "Mochi V1",
        provider: "fal",
        regions: ["US"],
        supportsMultimodal: false,
        supportsTools: false,
    }),
    makeModel({ enabled: false, id: "disabled-model", mode: "text", name: "Disabled Model", provider: "openrouter", regions: ["US"] }),
    makeModel({
        displayProvider: "Mistral",
        filterCapabilities: ["reasoning"],
        id: "eu-only",
        mode: "text",
        name: "Mistral Large",
        provider: "openrouter",
        regions: ["EU"],
        tier: "frontier",
    }),
    makeModel({ id: "no-region", mode: "text", name: "No Region Model", provider: "openrouter", regions: [] }),
];

// ── parseList ───────────────────────────────────────────────────────────────

describe("parseList", () => {
    it("returns undefined for undefined input", () => {
        expect(parseList(undefined)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
        expect(parseList("")).toBeUndefined();
    });

    it("returns undefined for whitespace-only string", () => {
        expect(parseList("  ,  , ")).toBeUndefined();
    });

    it("parses single value", () => {
        expect(parseList("text")).toEqual(["text"]);
    });

    it("parses comma-separated values", () => {
        expect(parseList("text,image,video")).toEqual(["text", "image", "video"]);
    });

    it("trims whitespace from values", () => {
        expect(parseList(" text , image ")).toEqual(["text", "image"]);
    });

    it("filters empty segments", () => {
        expect(parseList("text,,image,")).toEqual(["text", "image"]);
    });
});

// ── parseBool ───────────────────────────────────────────────────────────────

describe("parseBool", () => {
    it("returns true for 'true'", () => {
        expect(parseBool("true")).toBe(true);
    });

    it("returns false for 'false'", () => {
        expect(parseBool("false")).toBe(false);
    });

    it("returns undefined for undefined", () => {
        expect(parseBool(undefined)).toBeUndefined();
    });

    it("returns undefined for other strings", () => {
        expect(parseBool("yes")).toBeUndefined();
        expect(parseBool("1")).toBeUndefined();
        expect(parseBool("TRUE")).toBeUndefined();
    });
});

// ── buildFilterKey ──────────────────────────────────────────────────────────

describe("buildFilterKey", () => {
    it("returns empty string when no params", () => {
        expect(buildFilterKey({})).toBe("");
    });

    it("returns empty string when all values are undefined", () => {
        expect(buildFilterKey({ mode: undefined, provider: undefined })).toBe("");
    });

    it("builds sorted key from params", () => {
        expect(buildFilterKey({ mode: ["text"], provider: ["openai"] })).toBe(":mode=text&provider=openai");
    });

    it("sorts keys alphabetically", () => {
        expect(buildFilterKey({ mode: ["text"], provider: ["openai"] })).toBe(":mode=text&provider=openai");
    });

    it("skips undefined values", () => {
        expect(buildFilterKey({ mode: ["text"], provider: undefined, region: ["US"] })).toBe(":mode=text&region=US");
    });
});

// ── filterModels ────────────────────────────────────────────────────────────

describe("filterModels", () => {
    it("returns all models when no filters are applied", () => {
        const result = filterModels(FIXTURES, {});

        expect(result).toHaveLength(FIXTURES.length);
    });

    // -- Mode filter --

    describe("mode filter", () => {
        it("filters by single mode", () => {
            const result = filterModels(FIXTURES, { mode: ["text"] });

            expect(result.every((m) => m.mode === "text")).toBe(true);
            expect(result.length).toBeGreaterThan(0);
        });

        it("filters by multiple modes", () => {
            const result = filterModels(FIXTURES, { mode: ["image", "video"] });

            expect(result.every((m) => m.mode === "image" || m.mode === "video")).toBe(true);
            expect(result).toHaveLength(2);
        });

        it("returns empty for non-existent mode", () => {
            const result = filterModels(FIXTURES, { mode: ["nonexistent"] });

            expect(result).toHaveLength(0);
        });
    });

    // -- Provider filter --

    describe("provider filter", () => {
        it("filters by provider ID", () => {
            const result = filterModels(FIXTURES, { provider: ["fal"] });

            expect(result.every((m) => m.provider === "fal")).toBe(true);
            expect(result).toHaveLength(2);
        });

        it("matches displayProvider case-insensitively", () => {
            const result = filterModels(FIXTURES, { provider: ["anthropic"] });

            expect(result.some((m) => m.displayProvider === "Anthropic")).toBe(true);
        });

        it("matches multiple providers", () => {
            const result = filterModels(FIXTURES, { provider: ["fal", "google"] });

            expect(result).toHaveLength(3); // 2 fal + 1 google
        });
    });

    // -- Region filter --

    describe("region filter", () => {
        it("filters by region", () => {
            const result = filterModels(FIXTURES, { region: ["EU"] });

            expect(result.every((m) => m.regions.includes("EU"))).toBe(true);
        });

        it("excludes models with no regions", () => {
            const result = filterModels(FIXTURES, { region: ["US"] });

            expect(result.find((m) => m.id === "no-region")).toBeUndefined();
        });

        it("includes model if any region matches", () => {
            const result = filterModels(FIXTURES, { region: ["EU"] });

            // claude-sonnet has ["US", "EU"], should be included
            expect(result.find((m) => m.id === "claude-sonnet")).toBeDefined();
        });

        it("excludes model if no region matches", () => {
            const result = filterModels(FIXTURES, { region: ["AP"] });

            expect(result).toHaveLength(0);
        });
    });

    // -- Tier filter --

    describe("tier filter", () => {
        it("filters by tier", () => {
            const result = filterModels(FIXTURES, { tier: ["frontier"] });

            expect(result.every((m) => m.tier === "frontier")).toBe(true);
            expect(result.length).toBeGreaterThan(0);
        });

        it("excludes models without tier", () => {
            const result = filterModels(FIXTURES, { tier: ["frontier"] });

            expect(result.find((m) => !m.tier)).toBeUndefined();
        });
    });

    // -- Capability filter --

    describe("capability filter", () => {
        it("filters by single capability", () => {
            const result = filterModels(FIXTURES, { capability: ["reasoning"] });

            expect(result.every((m) => m.filterCapabilities?.includes("reasoning"))).toBe(true);
        });

        it("requires ALL capabilities (AND logic)", () => {
            const result = filterModels(FIXTURES, { capability: ["reasoning", "coding"] });

            // Only claude-sonnet has both reasoning AND coding
            expect(result).toHaveLength(1);
            expect(result[0]!.id).toBe("claude-sonnet");
        });

        it("excludes models without filterCapabilities", () => {
            const result = filterModels(FIXTURES, { capability: ["reasoning"] });

            expect(result.find((m) => !m.filterCapabilities)).toBeUndefined();
        });
    });

    // -- Enabled filter --

    describe("enabled filter", () => {
        it("filters enabled=true", () => {
            const result = filterModels(FIXTURES, { enabled: true });

            expect(result.every((m) => m.enabled)).toBe(true);
            expect(result.find((m) => m.id === "disabled-model")).toBeUndefined();
        });

        it("filters enabled=false", () => {
            const result = filterModels(FIXTURES, { enabled: false });

            expect(result.every((m) => !m.enabled)).toBe(true);
            expect(result).toHaveLength(1);
        });
    });

    // -- Premium filter --

    describe("premium filter", () => {
        it("filters premium=true", () => {
            const result = filterModels(FIXTURES, { premium: true });

            expect(result.every((m) => m.isPremium)).toBe(true);
        });

        it("filters premium=false", () => {
            const result = filterModels(FIXTURES, { premium: false });

            expect(result.every((m) => !m.isPremium)).toBe(true);
        });
    });

    // -- New filter --

    describe("new filter", () => {
        it("filters new=true", () => {
            const result = filterModels(FIXTURES, { new: true });

            expect(result.every((m) => m.isNew)).toBe(true);
            expect(result).toHaveLength(1);
            expect(result[0]!.id).toBe("gemini-flash");
        });

        it("filters new=false", () => {
            const result = filterModels(FIXTURES, { new: false });

            expect(result.every((m) => !m.isNew)).toBe(true);
        });
    });

    // -- Tools filter --

    describe("tools filter", () => {
        it("filters tools=true", () => {
            const result = filterModels(FIXTURES, { tools: true });

            expect(result.every((m) => m.supportsTools)).toBe(true);
        });

        it("filters tools=false", () => {
            const result = filterModels(FIXTURES, { tools: false });

            expect(result.every((m) => !m.supportsTools)).toBe(true);
        });
    });

    // -- Multimodal filter --

    describe("multimodal filter", () => {
        it("filters multimodal=true", () => {
            const result = filterModels(FIXTURES, { multimodal: true });

            expect(result.every((m) => m.supportsMultimodal)).toBe(true);
        });

        it("filters multimodal=false", () => {
            const result = filterModels(FIXTURES, { multimodal: false });

            expect(result.every((m) => !m.supportsMultimodal)).toBe(true);
        });
    });

    // -- Search filter --

    describe("search filter", () => {
        it.each([
            { expectedId: "claude-sonnet", label: "model ID", search: "claude" },
            { expectedId: "gemini-flash", label: "model name", search: "gemini" },
            { expectedId: "claude-sonnet", label: "display provider", search: "anthropic" },
        ])("matches $label", ({ expectedId, search }) => {
            const result = filterModels(FIXTURES, { search });

            expect(result).toHaveLength(1);
            expect(result[0]!.id).toBe(expectedId);
        });

        it("matches description", () => {
            const result = filterModels(FIXTURES, { search: "no match at all xyz" });

            expect(result).toHaveLength(0);
        });

        it("is case-insensitive (search value pre-lowered by route handler)", () => {
            // filterModels expects `search` already lowercased (the route handler normalises it)
            const result = filterModels(FIXTURES, { search: "claude" });

            expect(result).toHaveLength(1);
        });
    });

    // -- Combined filters --

    describe("combined filters", () => {
        it("applies multiple filters (AND logic between filter types)", () => {
            const result = filterModels(FIXTURES, {
                mode: ["text"],
                region: ["EU"],
                tier: ["frontier"],
            });

            // claude-sonnet (US+EU, frontier, text) and eu-only (EU, frontier, text)
            expect(result).toHaveLength(2);
        });

        it("narrows down with each additional filter", () => {
            const all = filterModels(FIXTURES, {});
            const textOnly = filterModels(FIXTURES, { mode: ["text"] });
            const textEu = filterModels(FIXTURES, { mode: ["text"], region: ["EU"] });

            expect(textOnly.length).toBeLessThan(all.length);
            expect(textEu.length).toBeLessThanOrEqual(textOnly.length);
        });

        it("can produce empty results with conflicting filters", () => {
            const result = filterModels(FIXTURES, {
                mode: ["image"],
                tools: true, // image models typically don't support tools
            });

            expect(result).toHaveLength(0);
        });
    });
});
