/**
 * Trending Media Tools
 * Get trending movies and TV shows from TMDB
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { TMDB_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, withRetry } from "./utilities";

const TMDB_API_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export interface TrendingItem {
    backdropPath?: string;
    firstAirDate?: string;
    genreIds: number[];
    id: number;
    mediaType: "movie" | "tv";
    originalTitle?: string;
    overview: string;
    popularity: number;
    posterPath?: string;
    releaseDate?: string;
    title: string;
    voteAverage: number;
    voteCount: number;
}

interface TMDBTrendingResult {
    backdrop_path?: string;
    first_air_date?: string;
    genre_ids: number[];
    id: number;
    media_type?: "movie" | "tv";
    name?: string;
    original_name?: string;
    original_title?: string;
    overview: string;
    popularity: number;
    poster_path?: string;
    release_date?: string;
    title?: string;
    vote_average: number;
    vote_count: number;
}

interface TMDBTrendingResponse {
    results: TMDBTrendingResult[];
    total_pages: number;
    total_results: number;
}

/**
 * Get the current trending movies.
 */
const buildImageUrl = (path: string | undefined | null, size: "w92" | "w185" | "w342" | "w500" | "w780" | "original" = "w500"): string | undefined => {
    if (!path) {
        return undefined;
    }

    return `${TMDB_IMAGE_BASE}/${size}${path}`;
};

/**
 * Get the current trending movies.
 */
const fetchTrendingMovies = async (timeWindow: "day" | "week", apiKey: string): Promise<TrendingItem[]> => {
    const response = await fetchWithTimeout(`${TMDB_API_URL}/trending/movie/${timeWindow}?language=en-US`, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
    });

    await assertOk(response, "TMDB API error");

    const data = (await response.json()) as TMDBTrendingResponse;

    return data.results.map((item) => {
        return {
            backdropPath: buildImageUrl(item.backdrop_path, "original"),
            genreIds: item.genre_ids,
            id: item.id,
            mediaType: "movie" as const,
            originalTitle: item.original_title,
            overview: item.overview,
            popularity: item.popularity,
            posterPath: buildImageUrl(item.poster_path),
            releaseDate: item.release_date,
            title: item.title ?? "Unknown",
            voteAverage: item.vote_average,
            voteCount: item.vote_count,
        };
    });
};

/**
 * Fetch trending TV shows.
 */
const fetchTrendingTv = async (timeWindow: "day" | "week", apiKey: string): Promise<TrendingItem[]> => {
    const response = await fetchWithTimeout(`${TMDB_API_URL}/trending/tv/${timeWindow}?language=en-US`, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
    });

    await assertOk(response, "TMDB API error");

    const data = (await response.json()) as TMDBTrendingResponse;

    return data.results.map((item) => {
        return {
            backdropPath: buildImageUrl(item.backdrop_path, "original"),
            firstAirDate: item.first_air_date,
            genreIds: item.genre_ids,
            id: item.id,
            mediaType: "tv" as const,
            originalTitle: item.original_name,
            overview: item.overview,
            popularity: item.popularity,
            posterPath: buildImageUrl(item.poster_path),
            title: item.name ?? "Unknown",
            voteAverage: item.vote_average,
            voteCount: item.vote_count,
        };
    });
};

/**
 * Get the current trending movies.
 */
export const trendingMoviesTool = createTool<
    {
        limit?: number;
        timeWindow?: "day" | "week";
    },
    {
        error?: string;
        movies?: TrendingItem[];
        success: boolean;
    },
    ToolContext
>({
    description: "Get the current trending movies. Can filter by daily or weekly trends.",
    execute: async (_context, input) => {
        const { limit = 10, timeWindow = "day" } = input;

        if (!TMDB_API_KEY) {
            return {
                error: "TMDB_API_KEY is not configured",
                success: false,
            };
        }

        const apiKey = TMDB_API_KEY;

        try {
            const movies = await withRetry(() => fetchTrendingMovies(timeWindow, apiKey), { maxRetries: 2 });

            return {
                movies: movies.slice(0, limit),
                success: true,
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Failed to fetch trending movies",
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            limit: z.number().min(1).max(20).optional().default(10).meta({ description: "Maximum number of results" }),
            timeWindow: z.enum(["day", "week"]).optional().default("day").meta({ description: "Time window for trends (day or week)" }),
        })
        .strict(),
    title: "Trending Movies",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

/**
 * Trending TV Shows Tool
 */
export const trendingTvTool = createTool<
    {
        limit?: number;
        timeWindow?: "day" | "week";
    },
    {
        error?: string;
        shows?: TrendingItem[];
        success: boolean;
    },
    ToolContext
>({
    description: "Get the current trending TV shows. Can filter by daily or weekly trends.",
    execute: async (_context, input) => {
        const { limit = 10, timeWindow = "day" } = input;

        if (!TMDB_API_KEY) {
            return {
                error: "TMDB_API_KEY is not configured",
                success: false,
            };
        }

        const apiKey = TMDB_API_KEY;

        try {
            const shows = await withRetry(() => fetchTrendingTv(timeWindow, apiKey), { maxRetries: 2 });

            return {
                shows: shows.slice(0, limit),
                success: true,
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Failed to fetch trending TV shows",
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            limit: z.number().min(1).max(20).optional().default(10).meta({ description: "Maximum number of results" }),
            timeWindow: z.enum(["day", "week"]).optional().default("day").meta({ description: "Time window for trends (day or week)" }),
        })
        .strict(),
    title: "Trending TV Shows",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});
