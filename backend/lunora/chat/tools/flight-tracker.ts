/**
 * Flight Tracker Tool
 * Track flight information using Amadeus API
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import { fetchWithTimeout, withRetry } from "./utilities";

interface FlightLeg {
    aircraft?: {
        code: string;
        name?: string;
    };
    airline: {
        code: string;
        name?: string;
    };
    arrival: {
        actualTime?: string;
        airport: string;
        airportName?: string;
        estimatedTime?: string;
        scheduledTime: string;
        terminal?: string;
    };
    departure: {
        actualTime?: string;
        airport: string;
        airportName?: string;
        estimatedTime?: string;
        scheduledTime: string;
        terminal?: string;
    };
    duration?: string;
    flightNumber: string;
    status: string;
}

export interface FlightData {
    date: string;
    flightNumber: string;
    legs: FlightLeg[];
    status: string;
}

interface AmadeusTokenResponse {
    access_token: string;
    expires_in: number;
    token_type: string;
}

interface AmadeusFlightStatus {
    flightDesignator: {
        carrierCode: string;
        flightNumber: number;
    };
    flightPoints: {
        arrival?: {
            terminal?: { code: string };
            timings: {
                qualifier: string;
                value: string;
            }[];
        };
        departure?: {
            terminal?: { code: string };
            timings: {
                qualifier: string;
                value: string;
            }[];
        };
        iataCode: string;
    }[];
    id: string;
    legs: {
        aircraftEquipment?: { aircraftType: string };
        boardPointIataCode: string;
        offPointIataCode: string;
        scheduledLegDuration?: string;
    }[];
    scheduledDepartureDate: string;
    segments: {
        boardPointIataCode: string;
        offPointIataCode: string;
        partnership?: {
            operatingFlight?: {
                carrierCode: string;
                flightNumber: number;
            };
        };
        scheduledSegmentDuration?: string;
    }[];
    type: string;
}

interface AmadeusFlightStatusResponse {
    data: AmadeusFlightStatus[];
    dictionaries?: {
        locations?: Record<string, { cityCode: string; countryCode: string }>;
    };
}

const AMADEUS_API_URL = "https://api.amadeus.com/v2";
const AMADEUS_AUTH_URL = "https://api.amadeus.com/v1/security/oauth2/token";

let cachedToken: { expiresAt: number; token: string } | null = null;

/**
 * Get Amadeus access token.
 */
const getAmadeusToken = async (): Promise<string> => {
    // Check cached token
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
        return cachedToken.token;
    }

    if (!AMADEUS_CLIENT_ID || !AMADEUS_CLIENT_SECRET) {
        throw new Error("AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET are required");
    }

    const response = await fetchWithTimeout(AMADEUS_AUTH_URL, {
        body: new URLSearchParams({
            client_id: AMADEUS_CLIENT_ID,
            client_secret: AMADEUS_CLIENT_SECRET,
            grant_type: "client_credentials",
        }),
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
    });

    await assertOk(response, "Amadeus authentication failed");

    const data = (await response.json()) as AmadeusTokenResponse;

    cachedToken = {
        expiresAt: Date.now() + data.expires_in * 1000,
        token: data.access_token,
    };

    return cachedToken.token;
};

/**
 * Get timing value with priority: actual > estimated > scheduled.
 */
const getBestTiming = (
    timings: { qualifier: string; value: string }[] | undefined,
): {
    actual?: string;
    estimated?: string;
    scheduled?: string;
} => {
    if (!timings) {
        return {};
    }

    const result: { actual?: string; estimated?: string; scheduled?: string } = {};

    for (const timing of timings) {
        switch (timing.qualifier) {
            case "ATA":
            case "ATD": {
                result.actual = timing.value;
                break;
            }
            case "ETA":
            case "ETD": {
                result.estimated = timing.value;
                break;
            }
            case "STA":
            case "STD": {
                result.scheduled = timing.value;
                break;
            }
            default: {
                break;
            }
        }
    }

    return result;
};

/**
 * Determine flight status from data.
 */
const determineFlightStatus = (flight: AmadeusFlightStatus): string => {
    const departurePoint = flight.flightPoints.find((p) => p.departure);
    const arrivalPoint = flight.flightPoints.find((p) => p.arrival);

    const dependencyTiming = getBestTiming(departurePoint?.departure?.timings);
    const arrayTiming = getBestTiming(arrivalPoint?.arrival?.timings);

    if (arrayTiming.actual) {
        return "Arrived";
    }

    if (dependencyTiming.actual) {
        return "In Flight";
    }

    if (dependencyTiming.estimated || arrayTiming.estimated) {
        return "Scheduled";
    }

    return "Unknown";
};

/**
 * Track a flight by airline code, flight number, and date.
 */
const fetchFlightStatus = async (carrierCode: string, flightNumber: string, date: string): Promise<FlightData | null> => {
    const token = await getAmadeusToken();

    const response = await fetchWithTimeout(
        `${AMADEUS_API_URL}/schedule/flights?carrierCode=${carrierCode}&flightNumber=${flightNumber}&scheduledDepartureDate=${date}`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        },
    );

    if (!response.ok) {
        await response.body?.cancel();

        if (response.status === 404) {
            return null;
        }

        throw new Error(`Amadeus API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as AmadeusFlightStatusResponse;

    if (!data.data || data.data.length === 0) {
        return null;
    }

    const flight = data.data[0];
    const status = determineFlightStatus(flight!);

    // Build flight legs
    const legs: FlightLeg[] = [];

    for (let i = 0; i < flight!.flightPoints.length - 1; i += 1) {
        const dependencyPoint = flight!.flightPoints[i]!;
        const arrayPoint = flight!.flightPoints[i + 1]!;

        if (!dependencyPoint.departure || !arrayPoint.arrival) {
            continue;
        }

        const dependencyTiming = getBestTiming(dependencyPoint.departure?.timings);
        const arrayTiming = getBestTiming(arrayPoint.arrival?.timings);

        const leg: FlightLeg = {
            airline: {
                code: flight!.flightDesignator.carrierCode,
            },
            arrival: {
                actualTime: arrayTiming.actual,
                airport: arrayPoint.iataCode,
                estimatedTime: arrayTiming.estimated,
                scheduledTime: arrayTiming.scheduled ?? "",
                terminal: arrayPoint.arrival?.terminal?.code,
            },
            departure: {
                actualTime: dependencyTiming.actual,
                airport: dependencyPoint.iataCode,
                estimatedTime: dependencyTiming.estimated,
                scheduledTime: dependencyTiming.scheduled ?? "",
                terminal: dependencyPoint.departure?.terminal?.code,
            },
            flightNumber: `${flight!.flightDesignator.carrierCode}${flight!.flightDesignator.flightNumber}`,
            status,
        };

        // Add aircraft info if available
        const legData = flight!.legs?.find((l) => l.boardPointIataCode === dependencyPoint.iataCode && l.offPointIataCode === arrayPoint.iataCode);

        if (legData?.aircraftEquipment) {
            leg.aircraft = {
                code: legData.aircraftEquipment.aircraftType,
            };
        }

        if (legData?.scheduledLegDuration) {
            leg.duration = legData.scheduledLegDuration;
        }

        legs.push(leg);
    }

    return {
        date,
        flightNumber: `${flight!.flightDesignator.carrierCode}${flight!.flightDesignator.flightNumber}`,
        legs,
        status,
    };
};

/**
 * Track a flight by airline code, flight number, and date.
 */
const flightTrackerTool = createTool<
    {
        carrierCode: string;
        date: string;
        flightNumber: string;
    },
    {
        error?: string;
        flight?: FlightData;
        success: boolean;
    },
    ToolContext
>({
    description: "Track a flight by airline code, flight number, and date. Returns departure/arrival times, status, and terminal information.",
    execute: async (_context, input) => {
        const { carrierCode, date, flightNumber } = input;

        try {
            const flight = await withRetry(() => fetchFlightStatus(carrierCode.toUpperCase(), flightNumber, date), {
                initialDelayMs: 1000,
                maxRetries: 2,
            });

            if (!flight) {
                return {
                    error: `Flight ${carrierCode}${flightNumber} not found for ${date}`,
                    success: false,
                };
            }

            return { flight, success: true };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Failed to fetch flight data",
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            carrierCode: z.string().length(2).meta({ description: "2-letter airline carrier code (e.g., 'AA' for American Airlines, 'UA' for United)" }),
            date: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .meta({ description: "Scheduled departure date in YYYY-MM-DD format" }),
            flightNumber: z.string().min(1).max(4).meta({ description: "Flight number (e.g., '100', '1234')" }),
        })
        .strict(),
    title: "Flight Tracker",
});

export default flightTrackerTool;
