import z from "zod/v4";

import { internal } from "../../_generated/internal";

/**
 * Company Search Tool
 * Searches for company/organization information using web search providers.
 * Returns company details, founding info, products, leadership, etc.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { EXA_API_KEY, TAVILY_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";
import { deduplicateByUrl, extractDomain, fetchWithTimeout, formatError, truncateText, withRetry } from "./utilities";

export interface CompanySearchResult {
    description: string;
    name: string;
    source: string;
    title?: string;
    url: string;
}

/**
 * Search for companies using Exa API.
 */
const searchCompaniesWithExa = async (query: string, maxResults: number): Promise<CompanySearchResult[]> => {
    if (!EXA_API_KEY) {
        throw new Error("EXA_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.exa.ai/search", {
        body: JSON.stringify({
            contents: {
                text: { max_characters: 1500 },
            },
            include_domains: ["crunchbase.com", "linkedin.com", "wikipedia.org", "bloomberg.com", "pitchbook.com", "glassdoor.com", "g2.com"],
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
        results: { text?: string; title: string; url: string }[];
    };

    return data.results.map((r) => {
        return {
            description: truncateText(r.text ?? "", 500),
            name: r.title,
            source: extractDomain(r.url),
            title: r.title,
            url: r.url,
        };
    });
};

/**
 * Search for companies using Tavily API (fallback).
 */
const searchCompaniesWithTavily = async (query: string, maxResults: number, apiKey?: string): Promise<CompanySearchResult[]> => {
    const effectiveKey = apiKey || TAVILY_API_KEY;

    if (!effectiveKey) {
        throw new Error("TAVILY_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.tavily.com/search", {
        body: JSON.stringify({
            api_key: effectiveKey,
            include_domains: ["crunchbase.com", "linkedin.com", "wikipedia.org", "bloomberg.com", "pitchbook.com"],
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
const companySearchTool = createTool<
    {
        maxResults?: number;
        query: string;
    },
    {
        results: CompanySearchResult[];
        totalResults: number;
    },
    ToolContext
>({
    description: `Search for information about companies and organizations. Returns company details, founding info, products, leadership, funding, and more.
Use this to find details about businesses — their industry, size, products, leadership team, funding history, etc.
Works best with company names and optional context (e.g., "Stripe payments", "OpenAI artificial intelligence").`,
    execute: async (context, input) => {
        const { maxResults = 5, query } = input;
        const enrichedQuery = `${query} company organization`;

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

        let results: CompanySearchResult[] = [];

        // Try Exa first (better for entity search)
        if (EXA_API_KEY) {
            try {
                results = await withRetry(() => searchCompaniesWithExa(enrichedQuery, maxResults), { maxRetries: 1 });
            } catch (error) {
                toolsLogger.warn(`[CompanySearch] Exa failed:`, formatError(error));
            }
        }

        // Fallback to Tavily
        if (results.length === 0 && (userTavilyKey || TAVILY_API_KEY)) {
            try {
                results = await withRetry(() => searchCompaniesWithTavily(enrichedQuery, maxResults, userTavilyKey), { maxRetries: 1 });
            } catch (error) {
                toolsLogger.warn(`[CompanySearch] Tavily failed:`, formatError(error));
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
            query: z.string().min(1).max(500).meta({ description: "Company name and optional context (e.g., 'Stripe payments company', 'Tesla Inc')" }),
        })
        .strict(),
    title: "Company Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default companySearchTool;
