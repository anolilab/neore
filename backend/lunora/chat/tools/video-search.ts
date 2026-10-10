import z from "zod/v4";

import { internal } from "../../_generated/internal";

/**
 * Video Search Tool
 * Searches the web for existing videos related to a query.
 * Uses Tavily search and YouTube oEmbed for video metadata.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { EXA_API_KEY, TAVILY_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, isSafeUrl, withRetry } from "./utilities";

const TRAILING_ID_RE = /\/(\d+)/;
const VIDEO_PATH_ID_RE = /\/video\/([a-z0-9]+)/i;

export interface VideoSearchResult {
    description?: string;
    embedUrl?: string;
    platform?: "youtube" | "vimeo" | "dailymotion" | "other";
    thumbnailUrl?: string;
    title: string;
    url: string;
}

/**
 * Extract video platform info from a URL.
 */
const parseVideoPlatform = (url: string): { embedUrl?: string; platform: VideoSearchResult["platform"] } => {
    try {
        const u = new URL(url);

        // YouTube
        if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) {
            let videoId: string | null = null;

            videoId = u.hostname.includes("youtu.be") ? u.pathname.slice(1).split("/", 1)[0] || null : u.searchParams.get("v");

            return {
                embedUrl: videoId ? `https://www.youtube.com/embed/${encodeURIComponent(videoId)}` : undefined,
                platform: "youtube",
            };
        }

        // Vimeo
        if (u.hostname.includes("vimeo.com")) {
            const match = u.pathname.match(TRAILING_ID_RE);

            return {
                embedUrl: match?.[1] ? `https://player.vimeo.com/video/${match[1]}` : undefined,
                platform: "vimeo",
            };
        }

        // Dailymotion
        if (u.hostname.includes("dailymotion.com")) {
            const match = u.pathname.match(VIDEO_PATH_ID_RE);

            return {
                embedUrl: match?.[1] ? `https://www.dailymotion.com/embed/video/${encodeURIComponent(match[1])}` : undefined,
                platform: "dailymotion",
            };
        }
    } catch {
        // Invalid URL
    }

    return { platform: "other" };
};

/**
 * Search for videos using Tavily API.
 */
const searchVideosWithTavily = async (query: string, maxResults: number, apiKey?: string): Promise<VideoSearchResult[]> => {
    const effectiveKey = apiKey || TAVILY_API_KEY;

    if (!effectiveKey) {
        throw new Error("TAVILY_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.tavily.com/search", {
        body: JSON.stringify({
            api_key: effectiveKey,
            include_answer: false,
            include_domains: ["youtube.com", "youtu.be", "vimeo.com", "dailymotion.com"],
            max_results: Math.min(maxResults * 2, 10), // Fetch extra, filter to video URLs
            query: `${query} video`,
            search_depth: "basic",
            topic: "general",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
    });

    await assertOk(response, "Tavily API error");

    const data = (await response.json()) as {
        results: { content: string; title: string; url: string }[];
    };

    return data.results
        .filter((r) => isSafeUrl(r.url))
        .slice(0, maxResults)
        .map((result) => {
            const { embedUrl, platform } = parseVideoPlatform(result.url);

            return {
                description: result.content?.slice(0, 300),
                embedUrl,
                platform,
                title: result.title,
                url: result.url,
            };
        });
};

/**
 * Search for videos using Exa API.
 */
const searchVideosWithExa = async (query: string, maxResults: number): Promise<VideoSearchResult[]> => {
    if (!EXA_API_KEY) {
        throw new Error("EXA_API_KEY is not configured");
    }

    const response = await fetchWithTimeout("https://api.exa.ai/search", {
        body: JSON.stringify({
            contents: {
                text: { max_characters: 300 },
            },
            include_domains: ["youtube.com", "youtu.be", "vimeo.com", "dailymotion.com"],
            num_results: maxResults,
            query: `${query} video`,
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
        .filter((r) => isSafeUrl(r.url))
        .map((result) => {
            const { embedUrl, platform } = parseVideoPlatform(result.url);

            return {
                description: result.text?.slice(0, 300),
                embedUrl,
                platform,
                thumbnailUrl: result.image && isSafeUrl(result.image) ? result.image : undefined,
                title: result.title,
                url: result.url,
            };
        });
};

/**
 * Maximum number of videos to return (default: 5).
 */
const videoSearchTool = createTool<
    {
        maxResults?: number;
        query: string;
    },
    {
        results: VideoSearchResult[];
        totalResults: number;
    },
    ToolContext
>({
    description: `Search the web for existing videos related to a query. Returns URLs of videos found on YouTube, Vimeo, and other platforms.
Use this for finding video content like tutorials, reviews, presentations, music videos, etc.
NOT for generating new videos - use videoGeneration for that.`,
    execute: async (context, input) => {
        const { maxResults = 5, query } = input;

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

        let results: VideoSearchResult[] = [];

        // Try Tavily first
        if (userTavilyKey || TAVILY_API_KEY) {
            try {
                results = await withRetry(() => searchVideosWithTavily(query, maxResults, userTavilyKey), { maxRetries: 1 });
            } catch (error) {
                toolsLogger.warn(`[VideoSearch] Tavily failed:`, error);
            }
        }

        // Fallback to Exa
        if (results.length === 0 && EXA_API_KEY) {
            try {
                results = await withRetry(() => searchVideosWithExa(query, maxResults), { maxRetries: 1 });
            } catch (error) {
                toolsLogger.warn(`[VideoSearch] Exa failed:`, error);
            }
        }

        return {
            results,
            totalResults: results.length,
        };
    },
    inputSchema: z
        .object({
            maxResults: z.number().min(1).max(10).optional().default(5).meta({ description: "Maximum number of videos to return (default: 5)" }),
            query: z.string().min(1).max(500).meta({ description: "Search query for finding videos" }),
        })
        .strict(),
    title: "Video Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default videoSearchTool;
