/**
 * Academic Search Tool
 * Search for academic papers and research using Firecrawl
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { EXA_API_KEY, FIRECRAWL_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";
import { deduplicateByUrl, fetchWithTimeout, formatError, withRetry } from "./utilities";

export interface AcademicResult {
    authors?: string[];
    citations?: number;
    journal?: string;
    publishedDate?: string;
    summary: string;
    title: string;
    url: string;
}

interface FirecrawlSearchResult {
    description?: string;
    markdown?: string;
    title?: string;
    url: string;
}

interface FirecrawlSearchResponse {
    data: FirecrawlSearchResult[];
}

/**
 * Search using Firecrawl for academic content.
 */
const searchAcademic = async (query: string, maxResults: number): Promise<AcademicResult[]> => {
    if (!FIRECRAWL_API_KEY) {
        throw new Error("FIRECRAWL_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.firecrawl.dev/v1/search", {
        body: JSON.stringify({
            limit: maxResults,
            query: `${query} academic paper research`,
            scrapeOptions: {
                formats: ["markdown"],
            },
        }),
        headers: {
            Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
            "Content-Type": "application/json",
        },
        method: "POST",
    });

    await assertOk(response, "Firecrawl API error");

    const data = (await response.json()) as FirecrawlSearchResponse;

    return data.data.map((result) => {
        return {
            summary: result.description ?? result.markdown?.slice(0, 500) ?? "",
            title: result.title ?? "Untitled",
            url: result.url,
        };
    });
};

/**
 * Search using Exa for academic content.
 */
const searchAcademicWithExa = async (query: string, maxResults: number): Promise<AcademicResult[]> => {
    if (!EXA_API_KEY) {
        throw new Error("EXA_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.exa.ai/search", {
        body: JSON.stringify({
            contents: {
                text: { max_characters: 1000 },
            },
            include_domains: [
                "arxiv.org",
                "scholar.google.com",
                "pubmed.ncbi.nlm.nih.gov",
                "semanticscholar.org",
                "researchgate.net",
                "academia.edu",
                "nature.com",
                "sciencedirect.com",
                "ieee.org",
                "springer.com",
                "wiley.com",
                "jstor.org",
            ],
            num_results: maxResults,
            query,
            type: "neural",
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
        results: {
            author?: string;
            publishedDate?: string;
            text?: string;
            title: string;
            url: string;
        }[];
    };

    return data.results.map((result) => {
        return {
            authors: result.author ? [result.author] : undefined,
            publishedDate: result.publishedDate,
            summary: result.text ?? "",
            title: result.title,
            url: result.url,
        };
    });
};

/**
 * Search for academic papers, research articles, and scientific publications.
 */
const academicSearchTool = createTool<
    {
        maxResults?: number;
        queries: string[];
    },
    {
        results: {
            papers: AcademicResult[];
            query: string;
        }[];
        totalPapers: number;
    },
    ToolContext
>({
    description:
        "Search for academic papers, research articles, and scientific publications. Supports multiple queries and returns results from academic sources like arXiv, PubMed, and Google Scholar.",
    execute: async (_context, input) => {
        const { maxResults = 20, queries } = input;

        // Determine which search function to use
        const searchFunction = EXA_API_KEY ? searchAcademicWithExa : searchAcademic;

        const searchResults = await Promise.all(
            queries.map(async (query) => {
                try {
                    const papers = await withRetry(() => searchFunction(query, maxResults), {
                        initialDelayMs: 1000,
                        maxRetries: 2,
                    });

                    return { papers: deduplicateByUrl(papers), query };
                } catch (error) {
                    toolsLogger.error(`Academic search failed for query "${query}":`, formatError(error));

                    return { papers: [], query };
                }
            }),
        );

        const totalPapers = searchResults.reduce((sum, r) => sum + r.papers.length, 0);

        return {
            results: searchResults,
            totalPapers,
        };
    },
    inputSchema: z
        .object({
            maxResults: z.number().min(5).max(30).optional().default(20).meta({ description: "Maximum results per query (default: 20)" }),
            queries: z.array(z.string().min(1).max(300)).min(1).max(5).meta({ description: "Array of academic search queries" }),
        })
        .strict(),
    title: "Academic Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default academicSearchTool;
