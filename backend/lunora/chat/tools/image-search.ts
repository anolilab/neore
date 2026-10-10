import z from "zod/v4";

import { internal } from "../../_generated/internal";

/**
 * Image Search Tool
 * Searches the web for existing images related to a query.
 * Uses Tavily's image search capability and Exa as fallback.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { EXA_API_KEY, TAVILY_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, isSafeUrl, withRetry } from "./utilities";

const IMAGE_EXTENSION_RE = /\.(?:jpg|jpeg|png|gif|webp|svg)(?:\?|$)/i;

export interface ImageSearchResult {
    description?: string;
    sourceUrl?: string;
    title: string;
    url: string;
}

/**
 * Search for images using Tavily API.
 */
const searchImagesWithTavily = async (query: string, maxResults: number, apiKey?: string): Promise<ImageSearchResult[]> => {
    const effectiveKey = apiKey || TAVILY_API_KEY;

    if (!effectiveKey) {
        throw new Error("TAVILY_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.tavily.com/search", {
        body: JSON.stringify({
            api_key: effectiveKey,
            include_answer: false,
            include_images: true,
            max_results: Math.min(maxResults, 5),
            query: `${query} images photos`,
            search_depth: "basic",
            topic: "general",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
    });

    await assertOk(response, "Tavily API error");

    const data = (await response.json()) as {
        images?: { description?: string; url: string }[];
        results: { content: string; title: string; url: string }[];
    };

    const results: ImageSearchResult[] = [];

    // Primary: use Tavily's dedicated images array
    if (data.images && data.images.length > 0) {
        for (const img of data.images.slice(0, maxResults)) {
            if (!isSafeUrl(img.url)) {
                continue;
            }

            results.push({
                description: img.description,
                title: img.description || query,
                url: img.url,
            });
        }
    }

    // Secondary: extract image URLs from search results
    if (results.length < maxResults && data.results) {
        for (const result of data.results) {
            if (results.length >= maxResults) {
                break;
            }

            // Check if the URL itself points to an image
            if (IMAGE_EXTENSION_RE.test(result.url) && isSafeUrl(result.url)) {
                results.push({
                    description: result.content?.slice(0, 200),
                    sourceUrl: result.url,
                    title: result.title,
                    url: result.url,
                });
            }
        }
    }

    return results;
};

/**
 * Search for images using Exa API.
 */
const searchImagesWithExa = async (query: string, maxResults: number): Promise<ImageSearchResult[]> => {
    if (!EXA_API_KEY) {
        throw new Error("EXA_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.exa.ai/search", {
        body: JSON.stringify({
            contents: {
                text: { max_characters: 200 },
            },
            num_results: maxResults,
            query: `${query} images photos`,
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
        results: { image?: string; text?: string; title: string; url: string }[];
    };

    return data.results
        .filter((r) => r.image && isSafeUrl(r.image))
        .map((r) => {
            return {
                description: r.text?.slice(0, 200),
                sourceUrl: r.url,
                title: r.title,
                url: r.image!,
            };
        });
};

/**
 * Maximum number of images to return (default: 8).
 */
const imageSearchTool = createTool<
    {
        maxResults?: number;
        query: string;
    },
    {
        results: ImageSearchResult[];
        totalResults: number;
    },
    ToolContext
>({
    description: `Search the web for existing images related to a query. Returns URLs of images found online.
Use this for visual references, photos of places/people/things, diagrams, infographics, screenshots, etc.
NOT for generating new images - use imageGeneration for that.`,
    execute: async (context, input) => {
        const { maxResults = 8, query } = input;

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

        let results: ImageSearchResult[] = [];

        // Try Tavily first
        if (userTavilyKey || TAVILY_API_KEY) {
            try {
                results = await withRetry(() => searchImagesWithTavily(query, maxResults, userTavilyKey), { maxRetries: 1 });
            } catch (error) {
                toolsLogger.warn(`[ImageSearch] Tavily failed:`, error);
            }
        }

        // Fallback to Exa
        if (results.length === 0 && EXA_API_KEY) {
            try {
                results = await withRetry(() => searchImagesWithExa(query, maxResults), { maxRetries: 1 });
            } catch (error) {
                toolsLogger.warn(`[ImageSearch] Exa failed:`, error);
            }
        }

        return {
            results,
            totalResults: results.length,
        };
    },
    inputSchema: z
        .object({
            maxResults: z.number().min(1).max(20).optional().default(8).meta({ description: "Maximum number of images to return (default: 8)" }),
            query: z.string().min(1).max(500).meta({ description: "Search query for finding images" }),
        })
        .strict(),
    title: "Image Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default imageSearchTool;
