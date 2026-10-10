/**
 * YouTube Search Tool
 * Search and retrieve YouTube video information
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { SUPADATA_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, formatError, withRetry } from "./utilities";

export interface YouTubeVideo {
    channelId: string;
    channelTitle: string;
    description: string;
    duration?: string;
    likeCount?: number;
    publishedAt: string;
    thumbnails: {
        default?: string;
        high?: string;
        medium?: string;
    };
    title: string;
    transcript?: string;
    url: string;
    videoId: string;
    viewCount?: number;
}

interface SupadataVideoResponse {
    channel: {
        id: string;
        name: string;
    };
    description: string;
    duration?: string;
    id: string;
    publishedAt: string;
    statistics?: {
        likeCount?: string;
        viewCount?: string;
    };
    thumbnails: {
        default?: { url: string };
        high?: { url: string };
        medium?: { url: string };
    };
    title: string;
}

interface SupadataSearchResponse {
    videos: SupadataVideoResponse[];
}

interface SupadataTranscriptResponse {
    content?: string;
    segments?: { text: string }[];
}

/**
 * Search YouTube videos using Supadata API.
 */
const searchYouTube = async (query: string, maxResults: number, timeRange?: string): Promise<YouTubeVideo[]> => {
    if (!SUPADATA_API_KEY) {
        throw new Error("SUPADATA_API_KEY is not configured");
    }

    // Build search parameters
    const params = new URLSearchParams({
        limit: maxResults.toString(),
        query,
    });

    if (timeRange && timeRange !== "anytime") {
        params.append("publishedAfter", getPublishedAfterDate(timeRange));
    }

    const response = await fetchWithTimeout(`https://api.supadata.ai/v1/youtube/search?${params.toString()}`, {
        headers: {
            Authorization: `Bearer ${SUPADATA_API_KEY}`,
        },
    });

    await assertOk(response, "Supadata API error");

    const data = (await response.json()) as SupadataSearchResponse;

    return data.videos.map((video) => {
        return {
            channelId: video.channel.id,
            channelTitle: video.channel.name,
            description: video.description,
            duration: video.duration,
            likeCount: video.statistics?.likeCount ? parseInt(video.statistics.likeCount, 10) : undefined,
            publishedAt: video.publishedAt,
            thumbnails: {
                default: video.thumbnails.default?.url,
                high: video.thumbnails.high?.url,
                medium: video.thumbnails.medium?.url,
            },
            title: video.title,
            url: `https://www.youtube.com/watch?v=${video.id}`,
            videoId: video.id,
            viewCount: video.statistics?.viewCount ? parseInt(video.statistics.viewCount, 10) : undefined,
        };
    });
};

/**
 * Get video transcript.
 */
const getTranscript = async (videoId: string): Promise<string | null> => {
    if (!SUPADATA_API_KEY) {
        return null;
    }

    try {
        const response = await fetchWithTimeout(`https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}`, {
            headers: {
                Authorization: `Bearer ${SUPADATA_API_KEY}`,
            },
        });

        if (!response.ok) {
            await response.body?.cancel();

            return null;
        }

        const data = (await response.json()) as SupadataTranscriptResponse;

        if (data.content) {
            return data.content;
        }

        if (data.segments) {
            return data.segments.map((s) => s.text).join(" ");
        }

        return null;
    } catch {
        return null;
    }
};

/**
 * Calculate published after date based on time range.
 */
const getPublishedAfterDate = (timeRange: string): string => {
    const now = new Date();

    switch (timeRange) {
        case "day": {
            now.setDate(now.getDate() - 1);
            break;
        }
        case "month": {
            now.setMonth(now.getMonth() - 1);
            break;
        }
        case "week": {
            now.setDate(now.getDate() - 7);
            break;
        }
        case "year": {
            now.setFullYear(now.getFullYear() - 1);
            break;
        }
        default: {
            return "";
        }
    }

    return now.toISOString();
};

/**
 * YouTube Search Tool
 */
const youtubeSearchTool = createTool<
    {
        includeTranscripts?: boolean;
        maxResults?: number;
        query: string;
        timeRange?: "day" | "week" | "month" | "year" | "anytime";
    },
    {
        totalResults: number;
        videos: YouTubeVideo[];
    },
    ToolContext
>({
    description:
        "Search for YouTube videos and optionally retrieve their transcripts. Returns video metadata including title, description, view counts, and more.",
    execute: async (_context, input) => {
        const { includeTranscripts = false, maxResults = 10, query, timeRange = "anytime" } = input;

        const videos = await withRetry(() => searchYouTube(query, maxResults, timeRange), {
            initialDelayMs: 1000,
            maxRetries: 2,
        });

        // Fetch transcripts if requested. Collected by position rather than written
        // back onto the search results, which are the caller's objects.
        const transcriptsByIndex = new Map<number, string>();

        if (includeTranscripts && videos.length > 0) {
            // Limit transcript fetching to avoid rate limits
            const videosToFetchTranscripts = videos.slice(0, 5);

            await Promise.all(
                videosToFetchTranscripts.map(async (video, index) => {
                    try {
                        const transcript = await withRetry(() => getTranscript(video.videoId), {
                            maxRetries: 1,
                        });

                        if (transcript) {
                            transcriptsByIndex.set(index, transcript);
                        }
                    } catch (error) {
                        toolsLogger.warn(`Failed to get transcript for ${video.videoId}:`, formatError(error));
                    }
                }),
            );
        }

        return {
            totalResults: videos.length,
            videos: videos.map((video, index) => {
                const transcript = transcriptsByIndex.get(index);

                return transcript ? { ...video, transcript } : video;
            }),
        };
    },
    inputSchema: z
        .object({
            includeTranscripts: z
                .boolean()
                .optional()
                .default(false)
                .meta({ description: "Include video transcripts (slower, requires additional API calls)" }),
            maxResults: z.number().min(1).max(20).optional().default(10).meta({ description: "Maximum number of videos to return (default: 10)" }),
            query: z.string().min(1).max(300).meta({ description: "Search query for YouTube videos" }),
            timeRange: z.enum(["day", "week", "month", "year", "anytime"]).optional().default("anytime").meta({ description: "Filter by upload time" }),
        })
        .strict(),
    title: "YouTube Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default youtubeSearchTool;
