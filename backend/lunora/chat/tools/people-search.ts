import z from "zod/v4";

import { internal } from "../../_generated/internal";

/**
 * People Search Tool
 * Searches for information about people using web search providers.
 * Returns biographical info, social profiles, professional details.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { EXA_API_KEY, TAVILY_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";
import { deduplicateByUrl, extractDomain, fetchWithTimeout, formatError, truncateText, withRetry } from "./utilities";

export interface PersonSearchResult {
    description: string;
    name: string;
    source: string;
    title?: string;
    url: string;
}

/**
 * Search for people using Exa API (best for entity search).
 */
const searchPeopleWithExa = async (query: string, maxResults: number): Promise<PersonSearchResult[]> => {
    if (!EXA_API_KEY) {
        throw new Error("EXA_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.exa.ai/search", {
        body: JSON.stringify({
            contents: {
                text: { max_characters: 1500 },
            },
            // Focus on people-related sources
            include_domains: ["linkedin.com", "twitter.com", "x.com", "github.com", "wikipedia.org", "crunchbase.com"],
            num_results: maxResults,
            query,
            use_autoprompt: true,
        }),
        headers: {
            "Content-Type": "application/json",
            "x-api-key": EXA_API_KEY,
        },
        method: "POST",
    });

    await assertOk(response, "Exa API error");

    const data = (await response.json()) as {
        results: { author?: string; text?: string; title: string; url: string }[];
    };

    return data.results.map((r) => {
        return {
            description: truncateText(r.text ?? "", 500),
            name: r.author || r.title,
            source: extractDomain(r.url),
            title: r.title,
            url: r.url,
        };
    });
};

/**
 * Search for people using Tavily API (fallback).
 */
const searchPeopleWithTavily = async (query: string, maxResults: number, apiKey?: string): Promise<PersonSearchResult[]> => {
    const effectiveKey = apiKey || TAVILY_API_KEY;

    if (!effectiveKey) {
        throw new Error("TAVILY_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.tavily.com/search", {
        body: JSON.stringify({
            api_key: effectiveKey,
            include_domains: ["linkedin.com", "twitter.com", "x.com", "github.com", "wikipedia.org", "crunchbase.com"],
            max_results: maxResults,
            query,
            search_depth: "advanced",
            topic: "general",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
    });

    await assertOk(response, "Tavily API error");

    const data = (await response.json()) as {
        results: { content: string; title: string; url: string }[];
    };

    return data.results.map((r) => {
        return {
            description: truncateText(r.content, 500),
            name: r.title,
            source: extractDomain(r.url),
            title: r.title,
            url: r.url,
        };
    });
};

/**
 * Maximum number of results (default: 5).
 */
const peopleSearchTool = createTool<
    {
        maxResults?: number;
        query: string;
    },
    {
        results: PersonSearchResult[];
        totalResults: number;
    },
    ToolContext
>({
    description: `Search for information about people. Returns biographical data, professional profiles, and social media links.
Use this to find details about specific individuals — their background, roles, companies, social profiles, etc.
Works best with full names and optional context (e.g., "John Smith CEO Acme Corp").`,
    execute: async (context, input) => {
        const { maxResults = 5, query } = input;
        const enrichedQuery = `${query} person biography profile`;

        // Lazy fetch user's Tavily key (BYOK)
        let userTavilyKey: string | undefined;

        if (context.userId) {
            try {
                const userToolKeys = await context.runQuery(internal.auth.functions.getDecryptedToolKeysQuery, { userId: context.userId });

                userTavilyKey = userToolKeys["tavily"];
            } catch {
                // fallback to env key
            }
        }

        let results: PersonSearchResult[] = [];

        // Try Exa first (better for entity search)
        if (EXA_API_KEY) {
            try {
                results = await withRetry(() => searchPeopleWithExa(enrichedQuery, maxResults), { maxRetries: 1 });
            } catch (error) {
                toolsLogger.warn(`[PeopleSearch] Exa failed:`, formatError(error));
            }
        }

        // Fallback to Tavily
        if (results.length === 0 && (userTavilyKey || TAVILY_API_KEY)) {
            try {
                results = await withRetry(() => searchPeopleWithTavily(enrichedQuery, maxResults, userTavilyKey), { maxRetries: 1 });
            } catch (error) {
                toolsLogger.warn(`[PeopleSearch] Tavily failed:`, formatError(error));
            }
        }

        const deduplicated = deduplicateByUrl(results);

        return {
            results: deduplicated,
            totalResults: deduplicated.length,
        };
    },
    inputSchema: z
        .object({
            maxResults: z.number().min(1).max(10).optional().default(5).meta({ description: "Maximum number of results (default: 5)" }),
            query: z.string().min(1).max(500).meta({ description: "Person name and optional context (e.g., 'Elon Musk Tesla', 'Jane Doe software engineer')" }),
        })
        .strict(),
    title: "People Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default peopleSearchTool;
