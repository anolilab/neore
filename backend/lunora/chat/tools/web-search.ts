import z from "zod/v4";

import { internal } from "../../_generated/internal";

/**
 * Web Search Tool
 * Performs web searches using multiple providers (Tavily, Exa, Firecrawl)
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { EXA_API_KEY, PARALLEL_API_KEY, TAVILY_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";
import { deduplicateByDomainAndUrl, fetchWithTimeout, formatError, withRetry } from "./utilities";

export interface WebSearchResult {
    author?: string;
    content: string;
    image?: string;
    publishedDate?: string;
    title: string;
    url: string;
}

interface TavilySearchResult {
    content: string;
    published_date?: string;
    score?: number;
    title: string;
    url: string;
}

interface TavilySearchResponse {
    images?: { url: string }[];
    results: TavilySearchResult[];
}

interface ExaSearchResult {
    author?: string;
    image?: string;
    publishedDate?: string;
    text?: string;
    title: string;
    url: string;
}

interface ExaSearchResponse {
    results: ExaSearchResult[];
}

/**
 * Search using Tavily API.
 */
const searchWithTavily = async (
    query: string,
    maxResults: number,
    topic: "general" | "news",
    apiKey?: string,
    domainFilter?: { excludeDomains?: string[]; includeDomains?: string[] },
): Promise<WebSearchResult[]> => {
    const effectiveKey = apiKey || TAVILY_API_KEY;

    if (!effectiveKey) {
        throw new Error("TAVILY_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.tavily.com/search", {
        body: JSON.stringify({
            api_key: effectiveKey,
            include_answer: false,
            include_images: true,
            max_results: maxResults,
            query,
            search_depth: "advanced",
            topic,
            ...(domainFilter?.includeDomains?.length && { include_domains: domainFilter.includeDomains }),
            ...(domainFilter?.excludeDomains?.length && { exclude_domains: domainFilter.excludeDomains }),
        }),
        headers: {
            "Content-Type": "application/json",
        },
        method: "POST",
    });

    await assertOk(response, "Tavily API error");

    const data = (await response.json()) as TavilySearchResponse;

    return data.results.map((result) => {
        return {
            content: result.content,
            publishedDate: result.published_date,
            title: result.title,
            url: result.url,
        };
    });
};

/**
 * Search using Exa API.
 */
const searchWithExa = async (
    query: string,
    maxResults: number,
    domainFilter?: { excludeDomains?: string[]; includeDomains?: string[] },
): Promise<WebSearchResult[]> => {
    if (!EXA_API_KEY) {
        throw new Error("EXA_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.exa.ai/search", {
        body: JSON.stringify({
            contents: {
                text: { max_characters: 2000 },
            },
            num_results: maxResults,
            query,
            use_autoprompt: true,
            ...(domainFilter?.includeDomains?.length && { include_domains: domainFilter.includeDomains }),
            ...(domainFilter?.excludeDomains?.length && { exclude_domains: domainFilter.excludeDomains }),
        }),
        headers: {
            "Content-Type": "application/json",
            "x-api-key": EXA_API_KEY,
        },
        method: "POST",
    });

    await assertOk(response, "Exa API error");

    const data = (await response.json()) as ExaSearchResponse;

    return data.results.map((result) => {
        return {
            author: result.author,
            content: result.text ?? "",
            image: result.image,
            publishedDate: result.publishedDate,
            title: result.title,
            url: result.url,
        };
    });
};

/**
 * Search using Parallel API (Reddit-focused search).
 */
const searchWithParallel = async (query: string, maxResults: number, sources: ("web" | "news" | "reddit")[] = ["web"]): Promise<WebSearchResult[]> => {
    if (!PARALLEL_API_KEY) {
        throw new Error("PARALLEL_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.parallel.ai/v1/search", {
        body: JSON.stringify({
            max_results: maxResults,
            query,
            sources,
        }),
        headers: {
            Authorization: `Bearer ${PARALLEL_API_KEY}`,
            "Content-Type": "application/json",
        },
        method: "POST",
    });

    await assertOk(response, "Parallel API error");

    const data = (await response.json()) as { results: { excerpt?: string; published_date?: string; title: string; url: string }[] };

    return data.results.map((result) => {
        return {
            content: result.excerpt ?? "",
            publishedDate: result.published_date,
            title: result.title,
            url: result.url,
        };
    });
};

type SearchProvider = "tavily" | "exa" | "parallel" | "auto";

/**
 * Exclude results from these domains.
 */
const webSearchTool = createTool<
    {
        excludeDomains?: string[];
        includeDomains?: string[];
        maxResults?: number;
        provider?: SearchProvider;
        queries: string[];
        topic?: "general" | "news";
    },
    {
        results: {
            query: string;
            results: WebSearchResult[];
        }[];
        totalResults: number;
    },
    ToolContext
>({
    description: `Search the web for information using multiple queries.
IMPORTANT: When searching for time-sensitive information, always include explicit dates or time periods in queries to ensure accurate results.
Use includeDomains to restrict results to specific websites (e.g., ["docs.python.org", "developer.mozilla.org"]).
Use excludeDomains to block specific sites from results.
Returns relevant web pages with titles, URLs, and content snippets.`,
    execute: async (context, input) => {
        // Apply research depth limits to queries and results
        const depthConfig = {
            balanced: { defaultMaxResults: 10, maxQueries: 5 },
            speed: { defaultMaxResults: 5, maxQueries: 2 },
            thorough: { defaultMaxResults: 15, maxQueries: 10 },
        };
        const depth = depthConfig[context.researchDepth || "balanced"];

        const { excludeDomains, includeDomains, maxResults = depth.defaultMaxResults, provider = "auto", queries: rawQueries, topic = "general" } = input;
        const queries = rawQueries.slice(0, depth.maxQueries);
        const domainFilter = includeDomains?.length || excludeDomains?.length ? { excludeDomains, includeDomains } : undefined;

        // Lazy fetch user's Tavily key (BYOK), fall back to env key
        let userTavilyKey: string | undefined;

        if (context.userId) {
            try {
                const userToolKeys = await context.runQuery(internal.auth.functions.getDecryptedToolKeysQuery, { userId: context.userId });

                userTavilyKey = userToolKeys["tavily"];
            } catch {
                // fallback to env key
            }
        }

        const searchResults: { query: string; results: WebSearchResult[] }[] = [];

        // Determine which provider to use
        const getSearchFunction = (): ((query: string, max: number) => Promise<WebSearchResult[]>) => {
            switch (provider) {
                case "exa": {
                    return (q, max) => searchWithExa(q, max, domainFilter);
                }
                case "parallel": {
                    return (q, max) => searchWithParallel(q, max, topic === "news" ? ["news", "web"] : ["web"]);
                }
                case "tavily": {
                    return (q, max) => searchWithTavily(q, max, topic, userTavilyKey, domainFilter);
                }
                default: {
                    // Try providers in order of preference (user key takes priority over env key)
                    if (userTavilyKey || TAVILY_API_KEY) {
                        return (q, max) => searchWithTavily(q, max, topic, userTavilyKey, domainFilter);
                    }

                    if (EXA_API_KEY) {
                        return (q, max) => searchWithExa(q, max, domainFilter);
                    }

                    if (PARALLEL_API_KEY) {
                        return (q, max) => searchWithParallel(q, max, topic === "news" ? ["news", "web"] : ["web"]);
                    }

                    throw new Error("No search provider API key configured. Please set TAVILY_API_KEY, EXA_API_KEY, or PARALLEL_API_KEY.");
                }
            }
        };

        const searchFunction = getSearchFunction();

        // Execute searches in parallel with retry
        const searchPromises = queries.map(async (query) => {
            try {
                const results = await withRetry(() => searchFunction(query, maxResults), {
                    initialDelayMs: 1000,
                    maxRetries: 2,
                });

                return { query, results: deduplicateByDomainAndUrl(results) };
            } catch (error) {
                toolsLogger.error(`Search failed for query "${query}":`, formatError(error));

                return { query, results: [] };
            }
        });

        const results = await Promise.all(searchPromises);

        searchResults.push(...results);

        const totalResults = searchResults.reduce((sum, r) => sum + r.results.length, 0);

        return {
            results: searchResults,
            totalResults,
        };
    },
    inputSchema: z
        .object({
            excludeDomains: z.array(z.string()).optional().meta({ description: "Exclude results from these domains" }),
            includeDomains: z
                .array(z.string())
                .optional()
                .meta({ description: "Only include results from these domains (e.g., ['docs.python.org', 'stackoverflow.com'])" }),
            maxResults: z.number().min(5).max(20).optional().default(10).meta({ description: "Maximum results per query (default: 10)" }),
            provider: z
                .enum(["tavily", "exa", "parallel", "auto"])
                .optional()
                .default("auto")
                .meta({ description: "Search provider to use (auto selects best available)" }),
            queries: z
                .array(z.string().min(1).max(500))
                .min(1)
                .max(10)
                .meta({ description: "Array of search queries. Include explicit dates/years for time-sensitive searches." }),
            topic: z.enum(["general", "news"]).optional().default("general").meta({ description: "Search topic type" }),
        })
        .strict(),
    title: "Web Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default webSearchTool;
