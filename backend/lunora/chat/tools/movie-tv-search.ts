/**
 * Movie & TV Search Tool
 * Search for movies and TV shows using TMDB API
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

export interface MediaResult {
    adult?: boolean;
    backdropPath?: string;
    firstAirDate?: string;
    genreIds: number[];
    id: number;
    mediaType: "movie" | "tv";
    originalLanguage: string;
    originalTitle?: string;
    overview: string;
    popularity: number;
    posterPath?: string;
    releaseDate?: string;
    title: string;
    voteAverage: number;
    voteCount: number;
}

export interface MediaDetails extends MediaResult {
    budget?: number;
    cast?: {
        character: string;
        id: number;
        name: string;
        profilePath?: string;
    }[];
    crew?: {
        department: string;
        id: number;
        job: string;
        name: string;
    }[];
    director?: string;
    genres: { id: number; name: string }[];
    numberOfEpisodes?: number;
    numberOfSeasons?: number;
    productionCompanies?: { id: number; logoPath?: string; name: string }[];
    revenue?: number;
    runtime?: number;
    status?: string;
    tagline?: string;
    writers?: string[];
}

interface TMDBSearchResult {
    adult?: boolean;
    backdrop_path?: string;
    first_air_date?: string;
    genre_ids: number[];
    id: number;
    media_type: "movie" | "tv" | "person";
    name?: string;
    original_language: string;
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

interface TMDBMultiSearchResponse {
    results: TMDBSearchResult[];
    total_pages: number;
    total_results: number;
}

interface TMDBDetailsResponse {
    backdrop_path?: string;
    budget?: number;
    first_air_date?: string;
    genres: { id: number; name: string }[];
    id: number;
    name?: string;
    number_of_episodes?: number;
    number_of_seasons?: number;
    original_language: string;
    original_name?: string;
    original_title?: string;
    overview: string;
    popularity: number;
    poster_path?: string;
    production_companies?: { id: number; logo_path?: string; name: string }[];
    release_date?: string;
    revenue?: number;
    runtime?: number;
    status?: string;
    tagline?: string;
    title?: string;
    vote_average: number;
    vote_count: number;
}

interface TMDBCreditsResponse {
    cast: {
        character: string;
        id: number;
        name: string;
        order: number;
        profile_path?: string;
    }[];
    crew: {
        department: string;
        id: number;
        job: string;
        name: string;
    }[];
}

/**
 * Absolute TMDB poster/backdrop URL for a stored relative path, at the requested
 * width. Returns `undefined` when the record has no image, so the caller can omit
 * the field rather than emit a broken URL.
 */
const buildImageUrl = (path: string | undefined | null, size: "w92" | "w185" | "w342" | "w500" | "w780" | "original" = "w500"): string | undefined => {
    if (!path) {
        return undefined;
    }

    return `${TMDB_IMAGE_BASE}/${size}${path}`;
};

/**
 * Search for movies and TV shows.
 */
const searchMedia = async (query: string, apiKey: string): Promise<MediaResult[]> => {
    const response = await fetchWithTimeout(`${TMDB_API_URL}/search/multi?query=${encodeURIComponent(query)}&include_adult=false&language=en-US&page=1`, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
    });

    await assertOk(response, "TMDB API error");

    const data = (await response.json()) as TMDBMultiSearchResponse;

    return data.results
        .filter((item) => item.media_type === "movie" || item.media_type === "tv")
        .map((item) => {
            return {
                adult: item.adult,
                backdropPath: buildImageUrl(item.backdrop_path, "original"),
                firstAirDate: item.first_air_date,
                genreIds: item.genre_ids,
                id: item.id,
                mediaType: item.media_type as "movie" | "tv",
                originalLanguage: item.original_language,
                originalTitle: item.original_title ?? item.original_name,
                overview: item.overview,
                popularity: item.popularity,
                posterPath: buildImageUrl(item.poster_path),
                releaseDate: item.release_date,
                title: item.title ?? item.name ?? "Unknown",
                voteAverage: item.vote_average,
                voteCount: item.vote_count,
            };
        });
};

/**
 * Search for movies and TV shows by title.
 */
const getMediaDetails = async (id: number, mediaType: "movie" | "tv", apiKey: string): Promise<MediaDetails> => {
    const [detailsResponse, creditsResponse] = await Promise.all([
        fetchWithTimeout(`${TMDB_API_URL}/${mediaType}/${id}?language=en-US`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        }),
        fetchWithTimeout(`${TMDB_API_URL}/${mediaType}/${id}/credits?language=en-US`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        }),
    ]);

    await assertOk(detailsResponse, "TMDB API error");

    const details = (await detailsResponse.json()) as TMDBDetailsResponse;
    const credits = creditsResponse.ok ? ((await creditsResponse.json()) as TMDBCreditsResponse) : null;

    if (!creditsResponse.ok) {
        await creditsResponse.body?.cancel();
    }

    const cast = credits?.cast
        .toSorted((a, b) => a.order - b.order)
        .slice(0, 8)
        .map((c) => {
            return {
                character: c.character,
                id: c.id,
                name: c.name,
                profilePath: buildImageUrl(c.profile_path, "w185"),
            };
        });

    const directors = credits?.crew.filter((c) => c.job === "Director").map((c) => c.name);
    const writers = credits?.crew.filter((c) => c.department === "Writing" || c.job === "Screenplay" || c.job === "Writer").map((c) => c.name);

    return {
        backdropPath: buildImageUrl(details.backdrop_path, "original"),
        budget: details.budget,
        cast,
        director: directors?.[0],
        firstAirDate: details.first_air_date,
        genreIds: details.genres.map((g) => g.id),
        genres: details.genres,
        id: details.id,
        mediaType,
        numberOfEpisodes: details.number_of_episodes,
        numberOfSeasons: details.number_of_seasons,
        originalLanguage: details.original_language,
        originalTitle: details.original_title ?? details.original_name,
        overview: details.overview,
        popularity: details.popularity,
        posterPath: buildImageUrl(details.poster_path),
        productionCompanies: details.production_companies?.map((p) => {
            return {
                id: p.id,
                logoPath: buildImageUrl(p.logo_path, "w185"),
                name: p.name,
            };
        }),
        releaseDate: details.release_date,
        revenue: details.revenue,
        runtime: details.runtime,
        status: details.status,
        tagline: details.tagline,
        title: details.title ?? details.name ?? "Unknown",
        voteAverage: details.vote_average,
        voteCount: details.vote_count,
        writers: writers ? [...new Set(writers)] : undefined,
    };
};

/**
 * Search for movies and TV shows by title.
 */
const movieTvSearchTool = createTool<
    {
        includeDetails?: boolean;
        query: string;
    },
    {
        details?: MediaDetails;
        error?: string;
        results?: MediaResult[];
        success: boolean;
    },
    ToolContext
>({
    description: "Search for movies and TV shows by title. Returns information including ratings, release dates, and cast details.",
    execute: async (_context, input) => {
        const { includeDetails = true, query } = input;

        if (!TMDB_API_KEY) {
            return {
                error: "TMDB_API_KEY is not configured",
                success: false,
            };
        }

        const apiKey = TMDB_API_KEY;

        try {
            const results = await withRetry(() => searchMedia(query, apiKey), { maxRetries: 2 });

            if (results.length === 0) {
                return {
                    results: [],
                    success: true,
                };
            }

            let details: MediaDetails | undefined;

            if (includeDetails && results[0]) {
                details = await withRetry(() => getMediaDetails(results[0]!.id, results[0]!.mediaType, apiKey), {
                    maxRetries: 2,
                });
            }

            return {
                details,
                results,
                success: true,
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Failed to search movies/TV",
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            includeDetails: z
                .boolean()
                .optional()
                .default(true)
                .meta({ description: "Include detailed information for the top result (cast, crew, runtime, etc.)" }),
            query: z.string().min(1).max(200).meta({ description: "Movie or TV show title to search for" }),
        })
        .strict(),
    title: "Movie & TV Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default movieTvSearchTool;
