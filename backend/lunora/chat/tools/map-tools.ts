/**
 * Map Tools
 * Location search and nearby places using Google Maps API
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { GOOGLE_MAPS_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, haversineDistance, withRetry } from "./utilities";

export interface GeocodingResult {
    addressComponents: {
        longName: string;
        shortName: string;
        types: string[];
    }[];
    coordinates: {
        lat: number;
        lng: number;
    };
    formattedAddress: string;
    placeId: string;
    types: string[];
}

export interface NearbyPlace {
    address: string;
    coordinates: {
        lat: number;
        lng: number;
    };
    distance?: number;
    name: string;
    openNow?: boolean;
    phoneNumber?: string;
    photos?: { maxWidth: number; photoReference: string }[];
    placeId: string;
    priceLevel?: number;
    rating?: number;
    types: string[];
    userRatingsTotal?: number;
    website?: string;
}

interface GoogleGeocodingResponse {
    error_message?: string;
    results: {
        address_components: {
            long_name: string;
            short_name: string;
            types: string[];
        }[];
        formatted_address: string;
        geometry: {
            location: {
                lat: number;
                lng: number;
            };
        };
        place_id: string;
        types: string[];
    }[];
    status: string;
}

interface GoogleNearbySearchResponse {
    error_message?: string;
    results: {
        geometry: {
            location: {
                lat: number;
                lng: number;
            };
        };
        name: string;
        opening_hours?: {
            open_now?: boolean;
        };
        photos?: {
            photo_reference: string;
        }[];
        place_id: string;
        price_level?: number;
        rating?: number;
        types: string[];
        user_ratings_total?: number;
        vicinity: string;
    }[];
    status: string;
}

interface GooglePlaceDetailsResponse {
    result: {
        formatted_phone_number?: string;
        opening_hours?: {
            weekday_text?: string[];
        };
        reviews?: {
            author_name: string;
            rating: number;
            text: string;
            time: number;
        }[];
        website?: string;
    };
    status: string;
}

const GOOGLE_MAPS_API_URL = "https://maps.googleapis.com/maps/api";

/**
 * Geocode a location (address to coordinates or coordinates to address).
 */
const geocode = async (query: string | { lat: number; lng: number }, apiKey: string): Promise<GeocodingResult[]> => {
    const url =
        typeof query === "string"
            ? `${GOOGLE_MAPS_API_URL}/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}`
            : `${GOOGLE_MAPS_API_URL}/geocode/json?latlng=${query.lat},${query.lng}&key=${apiKey}`;

    const response = await fetchWithTimeout(url);

    await assertOk(response, "Google Maps API error");

    const data = (await response.json()) as GoogleGeocodingResponse;

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
        throw new Error(`Geocoding failed: ${data.error_message ?? data.status}`);
    }

    return data.results.map((result) => {
        return {
            addressComponents: result.address_components.map((comp) => {
                return {
                    longName: comp.long_name,
                    shortName: comp.short_name,
                    types: comp.types,
                };
            }),
            coordinates: {
                lat: result.geometry.location.lat,
                lng: result.geometry.location.lng,
            },
            formattedAddress: result.formatted_address,
            placeId: result.place_id,
            types: result.types,
        };
    });
};

/**
 * Search for nearby places.
 */
const nearbySearch = async (
    location: { lat: number; lng: number },
    radius: number,
    type: string | undefined,
    keyword: string | undefined,
    apiKey: string,
): Promise<NearbyPlace[]> => {
    const params = new URLSearchParams({
        key: apiKey,
        location: `${location.lat},${location.lng}`,
        radius: radius.toString(),
    });

    if (type) {
        params.append("type", type);
    }

    if (keyword) {
        params.append("keyword", keyword);
    }

    const response = await fetchWithTimeout(`${GOOGLE_MAPS_API_URL}/place/nearbysearch/json?${params.toString()}`);

    await assertOk(response, "Google Maps API error");

    const data = (await response.json()) as GoogleNearbySearchResponse;

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
        throw new Error(`Nearby search failed: ${data.error_message ?? data.status}`);
    }

    return data.results.map((place) => {
        const distance = haversineDistance(location.lat, location.lng, place.geometry.location.lat, place.geometry.location.lng);

        return {
            address: place.vicinity,
            coordinates: {
                lat: place.geometry.location.lat,
                lng: place.geometry.location.lng,
            },
            distance: Math.round(distance * 100) / 100, // Round to 2 decimal places
            name: place.name,
            openNow: place.opening_hours?.open_now,
            // Return opaque photo_reference tokens — never the server-side API key.
            // Frontend should fetch images via an authenticated proxy that resolves the key.
            photos: place.photos?.slice(0, 3).map((p) => {
                return { maxWidth: 400, photoReference: p.photo_reference };
            }),
            placeId: place.place_id,
            priceLevel: place.price_level,
            rating: place.rating,
            types: place.types,
            userRatingsTotal: place.user_ratings_total,
        };
    });
};

/**
 * Geocode an address to coordinates or reverse geocode coordinates to an address.
 */
const getPlaceDetails = async (placeId: string, apiKey: string): Promise<Partial<NearbyPlace>> => {
    const response = await fetchWithTimeout(
        `${GOOGLE_MAPS_API_URL}/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=formatted_phone_number,website,opening_hours,reviews&key=${encodeURIComponent(apiKey)}`,
    );

    if (!response.ok) {
        await response.body?.cancel();

        return {};
    }

    const data = (await response.json()) as GooglePlaceDetailsResponse;

    if (data.status !== "OK") {
        return {};
    }

    return {
        phoneNumber: data.result.formatted_phone_number,
        website: data.result.website,
    };
};

/**
 * Geocode an address to coordinates or reverse geocode coordinates to an address.
 */
export const findPlaceTool = createTool<
    {
        latitude?: number;
        longitude?: number;
        query?: string;
    },
    {
        error?: string;
        results?: GeocodingResult[];
        success: boolean;
    },
    ToolContext
>({
    description:
        "Geocode an address to coordinates or reverse geocode coordinates to an address. Provide either a text query (address/place name) or coordinates.",
    execute: async (_context, input) => {
        const { latitude, longitude, query } = input;

        if (!GOOGLE_MAPS_API_KEY) {
            return {
                error: "GOOGLE_MAPS_API_KEY is not configured",
                success: false,
            };
        }

        const apiKey = GOOGLE_MAPS_API_KEY;

        try {
            let results: GeocodingResult[];

            if (query) {
                results = await withRetry(() => geocode(query, apiKey), { maxRetries: 2 });
            } else if (latitude !== undefined && longitude !== undefined) {
                results = await withRetry(() => geocode({ lat: latitude, lng: longitude }, apiKey), { maxRetries: 2 });
            } else {
                return {
                    error: "Either query or coordinates must be provided",
                    success: false,
                };
            }

            return { results, success: true };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Geocoding failed",
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            latitude: z.number().min(-90).max(90).optional().meta({ description: "Latitude for reverse geocoding" }),
            longitude: z.number().min(-180).max(180).optional().meta({ description: "Longitude for reverse geocoding" }),
            query: z.string().optional().meta({ description: "Address or place name to search for" }),
        })
        .strict()
        .refine((data) => data.query || (data.latitude !== undefined && data.longitude !== undefined), {
            error: "Either query or both latitude and longitude must be provided",
        }),
    title: "Find Place",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

/**
 * Include additional place details (phone, website).
 */
export const nearbyPlacesSearchTool = createTool<
    {
        includeDetails?: boolean;
        keyword?: string;
        latitude?: number;
        location?: string;
        longitude?: number;
        radius?: number;
        type?: string;
    },
    {
        error?: string;
        places?: NearbyPlace[];
        searchCenter?: { lat: number; lng: number };
        success: boolean;
    },
    ToolContext
>({
    description: `Search for nearby places around a location. Provide either a location name or coordinates.
Supported types: restaurant, cafe, bar, hotel, hospital, pharmacy, gas_station, supermarket, bank, atm, gym, park, museum, airport, subway_station, bus_station, parking, shopping_mall, and more.`,
    execute: async (_context, input) => {
        const { includeDetails = false, keyword, latitude, location, longitude, radius = 5000, type } = input;

        if (!GOOGLE_MAPS_API_KEY) {
            return {
                error: "GOOGLE_MAPS_API_KEY is not configured",
                success: false,
            };
        }

        const apiKey = GOOGLE_MAPS_API_KEY;

        try {
            let searchCenter: { lat: number; lng: number };

            // Resolve location to coordinates
            if (location) {
                const geocodeResults = await withRetry(() => geocode(location, apiKey), { maxRetries: 2 });

                if (!geocodeResults[0]) {
                    return {
                        error: `Location "${location}" not found`,
                        success: false,
                    };
                }

                searchCenter = geocodeResults[0].coordinates;
            } else if (latitude !== undefined && longitude !== undefined) {
                searchCenter = { lat: latitude, lng: longitude };
            } else {
                return {
                    error: "Either location or coordinates must be provided",
                    success: false,
                };
            }

            // Search for nearby places
            let places = await withRetry(() => nearbySearch(searchCenter, radius, type, keyword, apiKey), { maxRetries: 2 });

            // Sort by distance
            places = places.toSorted((a, b) => (a.distance ?? 0) - (b.distance ?? 0));

            // Limit results
            places = places.slice(0, 20);

            // Fetch additional details if requested
            if (includeDetails && places.length > 0) {
                const detailsPromises = places.slice(0, 10).map(async (place) => {
                    const details = await getPlaceDetails(place.placeId, apiKey).catch(() => {
                        return {};
                    });

                    return { ...place, ...details };
                });

                const placesWithDetails = await Promise.all(detailsPromises);

                places = [...placesWithDetails, ...places.slice(10)];
            }

            return {
                places,
                searchCenter,
                success: true,
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Nearby search failed",
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            includeDetails: z.boolean().optional().default(false).meta({ description: "Include additional place details (phone, website)" }),
            keyword: z.string().optional().meta({ description: "Keyword to filter results" }),
            latitude: z.number().min(-90).max(90).optional().meta({ description: "Latitude of search center" }),
            location: z.string().optional().meta({ description: "Location name to search around" }),
            longitude: z.number().min(-180).max(180).optional().meta({ description: "Longitude of search center" }),
            radius: z.number().min(100).max(50_000).optional().default(5000).meta({ description: "Search radius in meters (max 50km)" }),
            type: z.string().optional().meta({ description: "Place type filter (e.g., restaurant, cafe, hotel)" }),
        })
        .strict()
        .refine((data) => data.location || (data.latitude !== undefined && data.longitude !== undefined), {
            error: "Either location or both latitude and longitude must be provided",
        }),
    title: "Nearby Places Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});
