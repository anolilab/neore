import { afterEach, describe, expect, it, vi } from "vitest";

// Import from the shared constants file (no transitive runtime/BetterAuth deps)
import { getMissingEnvVariables, isToolAvailable, TOOL_ENV_REQUIREMENTS, TOOL_ENV_REQUIREMENTS_OR } from "./tool-env-requirements";

describe("TOOL_ENV_REQUIREMENTS", () => {
    it("should map tools to their required env vars", () => {
        expect(TOOL_ENV_REQUIREMENTS["webSearch"]).toEqual(["TAVILY_API_KEY"]);
        expect(TOOL_ENV_REQUIREMENTS["spotifySearch"]).toEqual(["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"]);
    });

    it("should keep retrieve in OR-logic requirements, not the standard ones", () => {
        expect(TOOL_ENV_REQUIREMENTS["retrieve"]).toBeUndefined();
        expect(TOOL_ENV_REQUIREMENTS_OR["retrieve"]).toBeDefined();
    });

    it("should not list tools that have no external dependency", () => {
        expect(TOOL_ENV_REQUIREMENTS["dateTime"]).toBeUndefined();
        expect(TOOL_ENV_REQUIREMENTS["createDocument"]).toBeUndefined();
        expect(TOOL_ENV_REQUIREMENTS["searchMemory"]).toBeUndefined();
        expect(TOOL_ENV_REQUIREMENTS["knowledgeSearch"]).toBeUndefined();
    });

    it("should cover all crypto tools with same key", () => {
        expect(TOOL_ENV_REQUIREMENTS["coinData"]).toEqual(["COINGECKO_API_KEY"]);
        expect(TOOL_ENV_REQUIREMENTS["coinDataByContract"]).toEqual(["COINGECKO_API_KEY"]);
        expect(TOOL_ENV_REQUIREMENTS["coinOhlc"]).toEqual(["COINGECKO_API_KEY"]);
    });

    it("should cover all TMDB-dependent tools", () => {
        expect(TOOL_ENV_REQUIREMENTS["movieTvSearch"]).toEqual(["TMDB_API_KEY"]);
        expect(TOOL_ENV_REQUIREMENTS["trendingMovies"]).toEqual(["TMDB_API_KEY"]);
        expect(TOOL_ENV_REQUIREMENTS["trendingTv"]).toEqual(["TMDB_API_KEY"]);
    });
});

describe("isToolAvailable", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("should return true for tools with no env requirements", () => {
        expect(isToolAvailable("dateTime")).toBe(true);
        expect(isToolAvailable("createDocument")).toBe(true);
        expect(isToolAvailable("searchMemory")).toBe(true);
    });

    it("should return true for unknown tool names", () => {
        expect(isToolAvailable("nonExistentTool")).toBe(true);
    });

    it("should return false when required env var is missing", () => {
        vi.stubEnv("TAVILY_API_KEY", "");
        expect(isToolAvailable("webSearch")).toBe(false);
    });

    it("should return true when required env var is present", () => {
        vi.stubEnv("TAVILY_API_KEY", "test-key");
        expect(isToolAvailable("webSearch")).toBe(true);
    });

    it("should require ALL env vars for multi-key tools", () => {
        vi.stubEnv("SPOTIFY_CLIENT_ID", "id");
        vi.stubEnv("SPOTIFY_CLIENT_SECRET", "");
        expect(isToolAvailable("spotifySearch")).toBe(false);

        vi.stubEnv("SPOTIFY_CLIENT_SECRET", "secret");
        expect(isToolAvailable("spotifySearch")).toBe(true);
    });

    it("should handle E2B-dependent tools", () => {
        vi.stubEnv("E2B_API_KEY", "");
        expect(isToolAvailable("codeExecution")).toBe(false);
        expect(isToolAvailable("shellExecution")).toBe(false);
        expect(isToolAvailable("fileOperations")).toBe(false);

        vi.stubEnv("E2B_API_KEY", "key");
        expect(isToolAvailable("codeExecution")).toBe(true);
    });

    it("should handle Amadeus tools needing both ID and secret", () => {
        vi.stubEnv("AMADEUS_CLIENT_ID", "id");
        expect(isToolAvailable("flightTracker")).toBe(false);

        vi.stubEnv("AMADEUS_CLIENT_SECRET", "secret");
        expect(isToolAvailable("flightTracker")).toBe(true);
    });

    describe("browser tool", () => {
        it("needs no env var: the browser-renderer is a service binding, part of every deploy", () => {
            expect(TOOL_ENV_REQUIREMENTS["browser"]).toBeUndefined();
            expect(TOOL_ENV_REQUIREMENTS_OR["browser"]).toBeUndefined();
            expect(isToolAvailable("browser")).toBe(true);
        });

        it("is not gated on a Browserbase key", () => {
            // There is no Browserbase code path; the key is not an alternative.
            vi.stubEnv("BROWSERBASE_API_KEY", "");
            expect(isToolAvailable("browser")).toBe(true);
        });
    });

    // Retrieve multi-provider tests (OR-logic)
    describe("retrieve tool multi-provider", () => {
        it("should be unavailable when no provider is configured", () => {
            vi.stubEnv("EXA_API_KEY", "");
            vi.stubEnv("FIRECRAWL_API_KEY", "");
            expect(isToolAvailable("retrieve")).toBe(false);
        });

        it("should be available when only Exa is configured", () => {
            vi.stubEnv("EXA_API_KEY", "exa-key");
            vi.stubEnv("FIRECRAWL_API_KEY", "");
            expect(isToolAvailable("retrieve")).toBe(true);
        });

        it("should be available when only Firecrawl is configured", () => {
            vi.stubEnv("EXA_API_KEY", "");
            vi.stubEnv("FIRECRAWL_API_KEY", "fc-key");
            expect(isToolAvailable("retrieve")).toBe(true);
        });
    });
});

describe("getMissingEnvVariables", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("should return empty for always-available tools", () => {
        expect(getMissingEnvVariables("dateTime")).toEqual([]);
    });

    it("should return missing vars for standard tools", () => {
        vi.stubEnv("TAVILY_API_KEY", "");
        expect(getMissingEnvVariables("webSearch")).toEqual(["TAVILY_API_KEY"]);
    });

    it("should return empty when OR-logic tool is available", () => {
        vi.stubEnv("EXA_API_KEY", "exa-key");
        vi.stubEnv("FIRECRAWL_API_KEY", "");
        expect(getMissingEnvVariables("retrieve")).toEqual([]);
    });

    it("should return all missing vars when OR-logic tool is unavailable", () => {
        vi.stubEnv("EXA_API_KEY", "");
        vi.stubEnv("FIRECRAWL_API_KEY", "");
        const missing = getMissingEnvVariables("retrieve");

        expect(missing).toContain("EXA_API_KEY");
        expect(missing).toContain("FIRECRAWL_API_KEY");
    });
});
