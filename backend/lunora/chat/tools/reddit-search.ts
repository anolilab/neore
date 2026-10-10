/**
 * Reddit Search Tool
 * Search Reddit content using Parallel API
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { PARALLEL_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";
import { deduplicateByUrl, fetchWithTimeout, formatError, withRetry } from "./utilities";

const SUBREDDIT_RE = /reddit\.com\/r\/([^/]+)/;

export interface RedditPost {
    author?: string;
    content: string;
    createdAt?: string;
    isNsfw?: boolean;
    numComments?: number;
    score?: number;
    subreddit: string;
    title: string;
    url: string;
}

interface ParallelSearchResult {
    excerpt?: string;
    published_date?: string;
    title?: string;
    url: string;
}

interface ParallelSearchResponse {
    results: ParallelSearchResult[];
}

/**
 * Extract subreddit from Reddit URL.
 */
const extractSubreddit = (url: string): string => {
    const match = url.match(SUBREDDIT_RE);

    return match?.[1] ?? "unknown";
};

/**
 * Search Reddit using Parallel API.
 */
const searchReddit = async (query: string, maxResults: number): Promise<RedditPost[]> => {
    if (!PARALLEL_API_KEY) {
        throw new Error("PARALLEL_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.parallel.ai/v1/search", {
        body: JSON.stringify({
            max_results: Math.max(maxResults, 10), // Minimum 10 results
            query,
            sources: ["reddit"],
        }),
        headers: {
            Authorization: `Bearer ${PARALLEL_API_KEY}`,
            "Content-Type": "application/json",
        },
        method: "POST",
    });

    await assertOk(response, "Parallel API error");

    const data = (await response.json()) as ParallelSearchResponse;

    return data.results.map((result) => {
        return {
            content: result.excerpt ?? "",
            createdAt: result.published_date,
            subreddit: extractSubreddit(result.url),
            title: result.title ?? "",
            url: result.url,
        };
    });
};

/**
 * Search Reddit for posts and discussions across multiple queries.
 */
const redditSearchTool = createTool<
    {
        maxResults?: number;
        queries: string[];
    },
    {
        results: {
            posts: RedditPost[];
            query: string;
        }[];
        totalPosts: number;
    },
    ToolContext
>({
    description: "Search Reddit for posts and discussions across multiple queries. Returns post titles, content excerpts, and subreddit information.",
    execute: async (_context, input) => {
        const { maxResults = 20, queries } = input;

        const searchResults = await Promise.all(
            queries.map(async (query) => {
                try {
                    const posts = await withRetry(() => searchReddit(query, maxResults), {
                        initialDelayMs: 1000,
                        maxRetries: 2,
                    });

                    return { posts: deduplicateByUrl(posts), query };
                } catch (error) {
                    toolsLogger.error(`Reddit search failed for query "${query}":`, formatError(error));

                    return { posts: [], query };
                }
            }),
        );

        const totalPosts = searchResults.reduce((sum, r) => sum + r.posts.length, 0);

        return {
            results: searchResults,
            totalPosts,
        };
    },
    inputSchema: z
        .object({
            maxResults: z.number().min(10).max(50).optional().default(20).meta({ description: "Maximum results per query (minimum 10)" }),
            queries: z.array(z.string().min(1).max(200)).min(1).max(5).meta({ description: "Array of search queries for Reddit" }),
        })
        .strict(),
    title: "Reddit Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default redditSearchTool;
