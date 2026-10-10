/**
 * X (Twitter) Search Tool
 * Search X posts using XAI API
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { XAI_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";
import { deduplicateByUrl, fetchWithTimeout, formatError, withRetry } from "./utilities";

const AT_PREFIX_RE = /^@/;

export interface XPost {
    authorName?: string;
    authorUsername: string;
    authorVerified?: boolean;
    createdAt?: string;
    images?: string[];
    likes?: number;
    replies?: number;
    retweets?: number;
    text: string;
    url: string;
}

interface XSearchResult {
    author?: {
        name?: string;
        username: string;
        verified?: boolean;
    };
    created_at?: string;
    images?: string[];
    metrics?: {
        likes?: number;
        replies?: number;
        retweets?: number;
    };
    text: string;
    url: string;
}

interface XSearchResponse {
    results: XSearchResult[];
}

/**
 * Normalize X handle (remove @ if present).
 */
const normalizeHandle = (handle: string): string => handle.replace(AT_PREFIX_RE, "").toLowerCase();

/**
 * Search X using XAI API.
 */
const searchX = async (
    query: string,
    options: {
        excludeHandles?: string[];
        fromDate?: string;
        includeHandles?: string[];
        maxResults?: number;
        toDate?: string;
    } = {},
): Promise<XPost[]> => {
    if (!XAI_API_KEY) {
        throw new Error("XAI_API_KEY is not configured");
    }

    // Build search query with filters
    let searchQuery = query;

    if (options.includeHandles && options.includeHandles.length > 0) {
        const handles = options.includeHandles.map((item) => normalizeHandle(item));

        searchQuery += ` (${handles.map((h) => `from:${h}`).join(" OR ")})`;
    }

    if (options.excludeHandles && options.excludeHandles.length > 0) {
        const handles = options.excludeHandles.map((item) => normalizeHandle(item));

        searchQuery += ` ${handles.map((h) => `-from:${h}`).join(" ")}`;
    }

    const body: { end_time?: string; max_results: number; query: string; start_time?: string } = {
        max_results: options.maxResults ?? 20,
        query: searchQuery,
    };

    if (options.fromDate) {
        body.start_time = options.fromDate;
    }

    if (options.toDate) {
        body.end_time = options.toDate;
    }

    const response = await fetchWithTimeout("https://api.x.ai/v1/search", {
        body: JSON.stringify(body),
        headers: {
            Authorization: `Bearer ${XAI_API_KEY}`,
            "Content-Type": "application/json",
        },
        method: "POST",
    });

    await assertOk(response, "XAI API error");

    const data = (await response.json()) as XSearchResponse;

    return data.results.map((result) => {
        return {
            authorName: result.author?.name,
            authorUsername: result.author?.username ?? "unknown",
            authorVerified: result.author?.verified,
            createdAt: result.created_at,
            images: result.images,
            likes: result.metrics?.likes,
            replies: result.metrics?.replies,
            retweets: result.metrics?.retweets,
            text: result.text,
            url: result.url,
        };
    });
};

/**
 * Calculate default from date (15 days ago).
 */
const getDefaultFromDate = (): string => {
    const date = new Date();

    date.setDate(date.getDate() - 15);

    return date.toISOString();
};

/**
 * Search X (formerly Twitter) for posts and discussions.
 */
const xSearchTool = createTool<
    {
        excludeHandles?: string[];
        fromDate?: string;
        includeHandles?: string[];
        maxResults?: number;
        queries: string[];
        toDate?: string;
    },
    {
        results: {
            posts: XPost[];
            query: string;
        }[];
        totalPosts: number;
    },
    ToolContext
>({
    description:
        "Search X (formerly Twitter) for posts and discussions. Supports filtering by date range and specific user handles. Returns post content, author info, and engagement metrics.",
    execute: async (_context, input) => {
        const { excludeHandles, fromDate = getDefaultFromDate(), includeHandles, maxResults = 20, queries, toDate } = input;

        const searchResults = await Promise.all(
            queries.map(async (query) => {
                try {
                    const posts = await withRetry(
                        () =>
                            searchX(query, {
                                excludeHandles,
                                fromDate,
                                includeHandles,
                                maxResults,
                                toDate,
                            }),
                        {
                            initialDelayMs: 1000,
                            maxRetries: 2,
                        },
                    );

                    return { posts: deduplicateByUrl(posts), query };
                } catch (error) {
                    toolsLogger.error(`X search failed for query "${query}":`, formatError(error));

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
            excludeHandles: z.array(z.string()).max(10).optional().meta({ description: "Exclude posts from these handles (max 10)" }),
            fromDate: z.string().optional().meta({ description: "Start date for search (ISO 8601 format). Default: 15 days ago" }),
            includeHandles: z.array(z.string()).max(10).optional().meta({ description: "Only include posts from these handles (max 10)" }),
            maxResults: z.number().min(5).max(50).optional().default(20).meta({ description: "Maximum results per query" }),
            queries: z.array(z.string().min(1).max(300)).min(1).max(5).meta({ description: "Array of search queries for X" }),
            toDate: z.string().optional().meta({ description: "End date for search (ISO 8601 format). Default: now" }),
        })
        .strict()
        .refine((data) => !(data.includeHandles?.length && data.excludeHandles?.length), {
            error: "Cannot use both includeHandles and excludeHandles at the same time",
        }),
    title: "X (Twitter) Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default xSearchTool;
