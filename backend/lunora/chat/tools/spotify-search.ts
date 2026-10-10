/**
 * Spotify Search Tool
 * Search Spotify for songs, artists, albums, playlists, and podcasts
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, truncateText, withRetry } from "./utilities";

interface SpotifyAccessToken {
    access_token: string;
    expires_in: number;
    token_type: string;
}

export interface SpotifyArtist {
    externalUrl: string;
    followers: number;
    genres: string[];
    id: string;
    images: { height: number; url: string; width: number }[];
    name: string;
    popularity: number;
}

export interface SpotifyAlbum {
    albumType: string;
    artists: { id: string; name: string }[];
    externalUrl: string;
    id: string;
    images: { height: number; url: string; width: number }[];
    name: string;
    releaseDate: string;
    totalTracks: number;
}

export interface SpotifyTrack {
    album: {
        id: string;
        images: { height: number; url: string; width: number }[];
        name: string;
    };
    artists: { id: string; name: string }[];
    durationMs: number;
    explicit: boolean;
    externalUrl: string;
    id: string;
    name: string;
    popularity: number;
    previewUrl: string | null;
}

export interface SpotifyPlaylist {
    collaborative: boolean;
    description: string | null;
    externalUrl: string;
    id: string;
    images: { height: number; url: string; width: number }[];
    name: string;
    owner: {
        displayName: string;
        id: string;
    };
    public: boolean;
    totalTracks: number;
}

export interface SpotifyShow {
    description: string;
    explicit: boolean;
    externalUrl: string;
    id: string;
    images: { height: number; url: string; width: number }[];
    name: string;
    publisher: string;
    totalEpisodes: number;
}

// Spotify API response types
interface SpotifyApiArtist {
    external_urls: { spotify: string };
    followers: { total: number };
    genres: string[];
    id: string;
    images: { height: number; url: string; width: number }[];
    name: string;
    popularity: number;
}

interface SpotifyApiAlbum {
    album_type: string;
    artists: { id: string; name: string }[];
    external_urls: { spotify: string };
    id: string;
    images: { height: number; url: string; width: number }[];
    name: string;
    release_date: string;
    total_tracks: number;
}

interface SpotifyApiTrack {
    album: {
        id: string;
        images: { height: number; url: string; width: number }[];
        name: string;
    };
    artists: { id: string; name: string }[];
    duration_ms: number;
    explicit: boolean;
    external_urls: { spotify: string };
    id: string;
    name: string;
    popularity: number;
    preview_url: string | null;
}

interface SpotifyApiPlaylist {
    collaborative: boolean;
    description: string | null;
    external_urls: { spotify: string };
    id: string;
    images: { height: number; url: string; width: number }[];
    name: string;
    owner: {
        display_name: string;
        id: string;
    };
    public: boolean;
    tracks: { total: number };
}

interface SpotifyApiShow {
    description: string;
    explicit: boolean;
    external_urls: { spotify: string };
    id: string;
    images: { height: number; url: string; width: number }[];
    name: string;
    publisher: string;
    total_episodes: number;
}

interface SpotifySearchResponse {
    albums?: { items: SpotifyApiAlbum[] };
    artists?: { items: SpotifyApiArtist[] };
    playlists?: { items: SpotifyApiPlaylist[] };
    shows?: { items: SpotifyApiShow[] };
    tracks?: { items: SpotifyApiTrack[] };
}

const SPOTIFY_API_URL = "https://api.spotify.com/v1";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

// Token cache
let cachedToken: { expiresAt: number; token: string } | null = null;

/**
 * Get Spotify access token using client credentials flow.
 */
const getSpotifyAccessToken = async (): Promise<string> => {
    // Check if we have a valid cached token
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
        return cachedToken.token;
    }

    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
        throw new Error("Spotify API credentials not configured. Please set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.");
    }

    const credentials = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");

    const response = await fetchWithTimeout(SPOTIFY_TOKEN_URL, {
        body: "grant_type=client_credentials",
        headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
    });

    await assertOk(response, "Failed to get Spotify access token");

    const data = (await response.json()) as SpotifyAccessToken;

    // Cache the token
    cachedToken = {
        expiresAt: Date.now() + data.expires_in * 1000,
        token: data.access_token,
    };

    return data.access_token;
};

/**
 * Search Spotify for music and podcasts.
 *
 * Search types:
 * - track: Search for songs
 * - artist: Search for artists
 * - album: Search for albums
 * - playlist: Search for playlists
 * - show: Search for podcasts/shows
 * - all: Search across all types
 *
 * Returns detailed information including:
 * - Tracks: name, artists, album, duration, popularity, preview URL
 * - Artists: name, genres, followers, popularity
 * - Albums: name, artists, release date, track count
 * - Playlists: name, description, owner, track count
 * - Shows: name, publisher, episode count, description.
 */
const searchSpotify = async (query: string, types: string[], limit: number, market?: string): Promise<SpotifySearchResponse> => {
    const accessToken = await getSpotifyAccessToken();

    const params = new URLSearchParams({
        limit: limit.toString(),
        q: query,
        type: types.join(","),
    });

    if (market) {
        params.set("market", market);
    }

    const response = await fetchWithTimeout(`${SPOTIFY_API_URL}/search?${params.toString()}`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        // Cancel the body we are about to discard — an unread response stream
        // leaves the runtime holding a socket nobody drains, which `wrangler
        // dev` escalates into a fatal `Network connection lost.` (see the
        // changelog fetch in `changelog/functions.ts`).
        await response.body?.cancel();

        if (response.status === 401) {
            // Token expired, clear cache and retry
            cachedToken = null;
            throw new Error("Spotify token expired, please retry");
        }

        throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as SpotifySearchResponse;
};

/**
 * Format duration from milliseconds to mm:ss.
 */
const formatDuration = (ms: number): string => {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);

    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

/**
 * Search Spotify for music and podcasts.
 *
 * Search types:
 * - track: Search for songs
 * - artist: Search for artists
 * - album: Search for albums
 * - playlist: Search for playlists
 * - show: Search for podcasts/shows
 * - all: Search across all types
 *
 * Returns detailed information including:
 * - Tracks: name, artists, album, duration, popularity, preview URL
 * - Artists: name, genres, followers, popularity
 * - Albums: name, artists, release date, track count
 * - Playlists: name, description, owner, track count
 * - Shows: name, publisher, episode count, description.
 */
const spotifySearchTool = createTool<
    {
        market?: string;
        maxResults?: number;
        query: string;
        searchType?: "track" | "artist" | "album" | "playlist" | "show" | "all";
    },
    {
        albums?: SpotifyAlbum[];
        artists?: SpotifyArtist[];
        error?: string;
        playlists?: SpotifyPlaylist[];
        searchType: string;
        shows?: SpotifyShow[];
        success: boolean;
        tracks?: SpotifyTrack[];
    },
    ToolContext
>({
    description: `Search Spotify for music and podcasts.

Search types:
- track: Search for songs
- artist: Search for artists
- album: Search for albums
- playlist: Search for playlists
- show: Search for podcasts/shows
- all: Search across all types

Returns detailed information including:
- Tracks: name, artists, album, duration, popularity, preview URL
- Artists: name, genres, followers, popularity
- Albums: name, artists, release date, track count
- Playlists: name, description, owner, track count
- Shows: name, publisher, episode count, description`,
    execute: async (_context, input) => {
        const { market, maxResults = 10, query, searchType = "track" } = input;

        // Map search type to Spotify API types
        const typeMap: Record<string, string[]> = {
            album: ["album"],
            all: ["track", "artist", "album", "playlist", "show"],
            artist: ["artist"],
            playlist: ["playlist"],
            show: ["show"],
            track: ["track"],
        };

        const types = typeMap[searchType] || ["track"];

        try {
            const data = await withRetry(() => searchSpotify(query, types, maxResults, market), { maxRetries: 2 });

            const result: {
                albums?: SpotifyAlbum[];
                artists?: SpotifyArtist[];
                playlists?: SpotifyPlaylist[];
                searchType: string;
                shows?: SpotifyShow[];
                success: boolean;
                tracks?: SpotifyTrack[];
            } = {
                searchType,
                success: true,
            };

            // Process tracks
            if (data.tracks?.items) {
                result.tracks = data.tracks.items.map((track) => {
                    return {
                        album: {
                            id: track.album.id,
                            images: track.album.images,
                            name: track.album.name,
                        },
                        artists: track.artists.map((a) => {
                            return { id: a.id, name: a.name };
                        }),
                        durationFormatted: formatDuration(track.duration_ms),
                        durationMs: track.duration_ms,
                        explicit: track.explicit,
                        externalUrl: track.external_urls.spotify,
                        id: track.id,
                        name: track.name,
                        popularity: track.popularity,
                        previewUrl: track.preview_url,
                    };
                }) as SpotifyTrack[];
            }

            // Process artists
            if (data.artists?.items) {
                result.artists = data.artists.items.map((artist) => {
                    return {
                        externalUrl: artist.external_urls.spotify,
                        followers: artist.followers.total,
                        genres: artist.genres,
                        id: artist.id,
                        images: artist.images,
                        name: artist.name,
                        popularity: artist.popularity,
                    };
                });
            }

            // Process albums
            if (data.albums?.items) {
                result.albums = data.albums.items.map((album) => {
                    return {
                        albumType: album.album_type,
                        artists: album.artists.map((a) => {
                            return { id: a.id, name: a.name };
                        }),
                        externalUrl: album.external_urls.spotify,
                        id: album.id,
                        images: album.images,
                        name: album.name,
                        releaseDate: album.release_date,
                        totalTracks: album.total_tracks,
                    };
                });
            }

            // Process playlists
            if (data.playlists?.items) {
                result.playlists = data.playlists.items.map((playlist) => {
                    return {
                        collaborative: playlist.collaborative,
                        description: playlist.description ? truncateText(playlist.description, 200) : null,
                        externalUrl: playlist.external_urls.spotify,
                        id: playlist.id,
                        images: playlist.images,
                        name: playlist.name,
                        owner: {
                            displayName: playlist.owner.display_name,
                            id: playlist.owner.id,
                        },
                        public: playlist.public,
                        totalTracks: playlist.tracks.total,
                    };
                });
            }

            // Process shows (podcasts)
            if (data.shows?.items) {
                result.shows = data.shows.items.map((show) => {
                    return {
                        description: truncateText(show.description, 300),
                        explicit: show.explicit,
                        externalUrl: show.external_urls.spotify,
                        id: show.id,
                        images: show.images,
                        name: show.name,
                        publisher: show.publisher,
                        totalEpisodes: show.total_episodes,
                    };
                });
            }

            return result;
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Spotify search failed",
                searchType,
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            market: z.string().length(2).optional().meta({ description: "ISO 3166-1 alpha-2 country code for market-specific results (e.g., US, GB, DE)" }),
            maxResults: z.number().min(1).max(50).optional().default(10).meta({ description: "Maximum results per type to return" }),
            query: z.string().min(1).max(256).meta({ description: "Search query (artist name, song title, album, etc.)" }),
            searchType: z
                .enum(["track", "artist", "album", "playlist", "show", "all"])
                .optional()
                .default("track")
                .meta({ description: "Type of content to search for" }),
        })
        .strict(),
    title: "Spotify Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default spotifySearchTool;
