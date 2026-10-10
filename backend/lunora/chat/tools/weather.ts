/**
 * Weather Tool
 * Retrieves weather data using OpenWeather API
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { OPENWEATHER_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, withRetry } from "./utilities";

interface GeocodingResult {
    country: string;
    lat: number;
    local_names?: Record<string, string>;
    lon: number;
    name: string;
    state?: string;
}

interface WeatherData {
    base: string;
    clouds: { all: number };
    cod: number;
    coord: { lat: number; lon: number };
    dt: number;
    id: number;
    main: {
        feels_like: number;
        grnd_level?: number;
        humidity: number;
        pressure: number;
        sea_level?: number;
        temp: number;
        temp_max: number;
        temp_min: number;
    };
    name: string;
    rain?: { "1h"?: number; "3h"?: number };
    snow?: { "1h"?: number; "3h"?: number };
    sys: {
        country: string;
        id?: number;
        sunrise: number;
        sunset: number;
        type?: number;
    };
    timezone: number;
    visibility: number;
    weather: { description: string; icon: string; id: number; main: string }[];
    wind: { deg: number; gust?: number; speed: number };
}

interface AirQualityData {
    coord: { lat: number; lon: number };
    list: {
        components: {
            co: number;
            nh3: number;
            no: number;
            no2: number;
            o3: number;
            pm2_5: number;
            pm10: number;
            so2: number;
        };
        dt: number;
        main: { aqi: number };
    }[];
}

interface ForecastData {
    city: {
        coord: { lat: number; lon: number };
        country: string;
        id: number;
        name: string;
        sunrise: number;
        sunset: number;
        timezone: number;
    };
    list: {
        clouds: { all: number };
        dt: number;
        dt_txt: string;
        main: {
            feels_like: number;
            humidity: number;
            pressure: number;
            temp: number;
            temp_max: number;
            temp_min: number;
        };
        pop: number;
        rain?: { "3h"?: number };
        snow?: { "3h"?: number };
        visibility: number;
        weather: { description: string; icon: string; id: number; main: string }[];
        wind: { deg: number; gust?: number; speed: number };
    }[];
}

const OPENWEATHER_BASE_URL = "https://api.openweathermap.org/data/2.5";
const OPENWEATHER_GEO_URL = "https://api.openweathermap.org/geo/1.0";

/**
 * Geocode a location name to coordinates.
 */
const geocodeLocation = async (location: string, apiKey: string): Promise<GeocodingResult | null> => {
    const response = await fetchWithTimeout(`${OPENWEATHER_GEO_URL}/direct?q=${encodeURIComponent(location)}&limit=1&appid=${apiKey}`);

    await assertOk(response, "Geocoding failed");

    const results = (await response.json()) as GeocodingResult[];

    return results[0] ?? null;
};

/**
 * Reverse geocode coordinates to location name.
 */
const reverseGeocode = async (lat: number, lon: number, apiKey: string): Promise<GeocodingResult | null> => {
    const response = await fetchWithTimeout(`${OPENWEATHER_GEO_URL}/reverse?lat=${lat}&lon=${lon}&limit=1&appid=${apiKey}`);

    await assertOk(response, "Reverse geocoding failed");

    const results = (await response.json()) as GeocodingResult[];

    return results[0] ?? null;
};

/**
 * Get current weather data.
 */
const getCurrentWeather = async (lat: number, lon: number, apiKey: string, units: string): Promise<WeatherData> => {
    const response = await fetchWithTimeout(`${OPENWEATHER_BASE_URL}/weather?lat=${lat}&lon=${lon}&units=${units}&appid=${apiKey}`);

    await assertOk(response, "Weather API failed");

    return (await response.json()) as WeatherData;
};

/**
 * Get air quality data.
 */
const getAirQuality = async (lat: number, lon: number, apiKey: string): Promise<AirQualityData> => {
    const response = await fetchWithTimeout(`${OPENWEATHER_BASE_URL}/air_pollution?lat=${lat}&lon=${lon}&appid=${apiKey}`);

    await assertOk(response, "Air quality API failed");

    return (await response.json()) as AirQualityData;
};

/**
 * Get weather forecast.
 */
const getForecast = async (lat: number, lon: number, apiKey: string, units: string): Promise<ForecastData> => {
    const response = await fetchWithTimeout(`${OPENWEATHER_BASE_URL}/forecast?lat=${lat}&lon=${lon}&units=${units}&appid=${apiKey}`);

    await assertOk(response, "Forecast API failed");

    return (await response.json()) as ForecastData;
};

/**
 * Get AQI description.
 */
const getAQIDescription = (aqi: number): string => {
    switch (aqi) {
        case 1: {
            return "Good";
        }
        case 2: {
            return "Fair";
        }
        case 3: {
            return "Moderate";
        }
        case 4: {
            return "Poor";
        }
        case 5: {
            return "Very Poor";
        }
        default: {
            return "Unknown";
        }
    }
};

/**
 * Get current weather conditions, air quality, and forecast for a location.
 */
const weatherTool = createTool<
    {
        includeAirQuality?: boolean;
        includeForecast?: boolean;
        latitude?: number;
        location?: string;
        longitude?: number;
        units?: "metric" | "imperial";
    },
    {
        airQuality?: {
            aqi: number;
            aqiDescription: string;
            components: {
                co: number;
                no2: number;
                o3: number;
                pm2_5: number;
                pm10: number;
            };
        };
        current: {
            cloudiness: number;
            feelsLike: number;
            humidity: number;
            pressure: number;
            sunrise: string;
            sunset: string;
            temperature: number;
            visibility: number;
            weather: {
                description: string;
                icon: string;
                main: string;
            };
            windDirection: number;
            windSpeed: number;
        };
        forecast?: {
            datetime: string;
            feelsLike: number;
            humidity: number;
            precipitationProbability: number;
            temperature: number;
            weather: {
                description: string;
                main: string;
            };
        }[];
        location: {
            coordinates: { lat: number; lon: number };
            country: string;
            name: string;
            state?: string;
        };
        units: "metric" | "imperial";
    },
    ToolContext
>({
    description: "Get current weather conditions, air quality, and forecast for a location. Provide either a location name or coordinates.",
    execute: async (_context, input) => {
        const { includeAirQuality = true, includeForecast = true, latitude, location, longitude, units = "metric" } = input;

        if (!OPENWEATHER_API_KEY) {
            throw new Error("OPENWEATHER_API_KEY is not configured");
        }

        const apiKey = OPENWEATHER_API_KEY;

        let lat: number;
        let lon: number;
        let locationInfo: GeocodingResult | null;

        // Resolve coordinates
        if (latitude !== undefined && longitude !== undefined) {
            lat = latitude;
            lon = longitude;
            // Reverse geocode to get location name
            locationInfo = await withRetry(() => reverseGeocode(lat, lon, apiKey), { maxRetries: 2 });
        } else if (location) {
            locationInfo = await withRetry(() => geocodeLocation(location, apiKey), { maxRetries: 2 });

            if (!locationInfo) {
                throw new Error(`Location "${location}" not found`);
            }

            lat = locationInfo.lat;
            lon = locationInfo.lon;
        } else {
            throw new Error("Either location or coordinates must be provided");
        }

        // Fetch weather data in parallel
        const [currentWeather, airQuality, forecast] = await Promise.all([
            withRetry(() => getCurrentWeather(lat, lon, apiKey, units), { maxRetries: 2 }),
            includeAirQuality ? withRetry(() => getAirQuality(lat, lon, apiKey), { maxRetries: 2 }).catch(() => null) : null,
            includeForecast ? withRetry(() => getForecast(lat, lon, apiKey, units), { maxRetries: 2 }).catch(() => null) : null,
        ]);

        const result: {
            airQuality?: {
                aqi: number;
                aqiDescription: string;
                components: {
                    co: number;
                    no2: number;
                    o3: number;
                    pm2_5: number;
                    pm10: number;
                };
            };
            current: {
                cloudiness: number;
                feelsLike: number;
                humidity: number;
                pressure: number;
                sunrise: string;
                sunset: string;
                temperature: number;
                visibility: number;
                weather: {
                    description: string;
                    icon: string;
                    main: string;
                };
                windDirection: number;
                windSpeed: number;
            };
            forecast?: {
                datetime: string;
                feelsLike: number;
                humidity: number;
                precipitationProbability: number;
                temperature: number;
                weather: {
                    description: string;
                    main: string;
                };
            }[];
            location: {
                coordinates: { lat: number; lon: number };
                country: string;
                name: string;
                state?: string;
            };
            units: "metric" | "imperial";
        } = {
            current: {
                cloudiness: currentWeather.clouds.all,
                feelsLike: currentWeather.main.feels_like,
                humidity: currentWeather.main.humidity,
                pressure: currentWeather.main.pressure,
                sunrise: new Date(currentWeather.sys.sunrise * 1000).toISOString(),
                sunset: new Date(currentWeather.sys.sunset * 1000).toISOString(),
                temperature: currentWeather.main.temp,
                visibility: currentWeather.visibility,
                weather: {
                    description: currentWeather.weather[0]?.description ?? "",
                    icon: currentWeather.weather[0]?.icon ?? "",
                    main: currentWeather.weather[0]?.main ?? "Unknown",
                },
                windDirection: currentWeather.wind.deg,
                windSpeed: currentWeather.wind.speed,
            },
            location: {
                coordinates: { lat, lon },
                country: locationInfo?.country ?? currentWeather.sys.country,
                name: locationInfo?.name ?? currentWeather.name,
                state: locationInfo?.state,
            },
            units,
        };

        if (airQuality && airQuality.list[0]) {
            const aq = airQuality.list[0];

            result.airQuality = {
                aqi: aq.main.aqi,
                aqiDescription: getAQIDescription(aq.main.aqi),
                components: {
                    co: aq.components.co,
                    no2: aq.components.no2,
                    o3: aq.components.o3,
                    pm2_5: aq.components.pm2_5,
                    pm10: aq.components.pm10,
                },
            };
        }

        if (forecast) {
            // Get one forecast per day (every 8th item = 24 hours)
            result.forecast = forecast.list
                .filter((_, i) => i % 8 === 0)
                .map((item) => {
                    return {
                        datetime: item.dt_txt,
                        feelsLike: item.main.feels_like,
                        humidity: item.main.humidity,
                        precipitationProbability: item.pop * 100,
                        temperature: item.main.temp,
                        weather: {
                            description: item.weather[0]?.description ?? "",
                            main: item.weather[0]?.main ?? "Unknown",
                        },
                    };
                });
        }

        return result;
    },
    inputSchema: z
        .object({
            includeAirQuality: z.boolean().optional().default(true).meta({ description: "Include air quality data" }),
            includeForecast: z.boolean().optional().default(true).meta({ description: "Include 5-day forecast" }),
            latitude: z.number().min(-90).max(90).optional().meta({ description: "Latitude coordinate" }),
            location: z.string().optional().meta({ description: "Location name (city, address, or place)" }),
            longitude: z.number().min(-180).max(180).optional().meta({ description: "Longitude coordinate" }),
            units: z.enum(["metric", "imperial"]).optional().default("metric").meta({ description: "Temperature units (metric=Celsius, imperial=Fahrenheit)" }),
        })
        .strict()
        .refine((data) => data.location || (data.latitude !== undefined && data.longitude !== undefined), {
            error: "Either location or both latitude and longitude must be provided",
        }),
    title: "Weather",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default weatherTool;
