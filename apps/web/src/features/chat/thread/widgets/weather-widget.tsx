"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { formatDate } from "@neore/ui/utils/locale-format";
import { Droplets, Eye, Wind } from "lucide-react";
import type { FC } from "react";
import { memo } from "react";

export interface WeatherData {
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
}

const AQI_COLORS: Record<number, { bg: string; text: string }> = {
    1: { bg: "bg-green-100 dark:bg-green-900/40", text: "text-green-700 dark:text-green-300" },
    2: { bg: "bg-yellow-100 dark:bg-yellow-900/40", text: "text-yellow-700 dark:text-yellow-300" },
    3: { bg: "bg-orange-100 dark:bg-orange-900/40", text: "text-orange-700 dark:text-orange-300" },
    4: { bg: "bg-red-100 dark:bg-red-900/40", text: "text-red-700 dark:text-red-300" },
    5: { bg: "bg-purple-100 dark:bg-purple-900/40", text: "text-purple-700 dark:text-purple-300" },
};

const getWeatherGradient = (main: string): string => {
    const lower = main.toLowerCase();

    if (lower.includes("clear") || lower.includes("sun")) {
        return "from-amber-50 to-sky-50 dark:from-amber-950/20 dark:to-sky-950/20";
    }

    if (lower.includes("cloud")) {
        return "from-gray-50 to-slate-100 dark:from-gray-900/30 dark:to-slate-900/30";
    }

    if (lower.includes("rain") || lower.includes("drizzle")) {
        return "from-blue-50 to-slate-100 dark:from-blue-950/20 dark:to-slate-900/30";
    }

    if (lower.includes("snow")) {
        return "from-blue-50 to-white dark:from-blue-950/20 dark:to-gray-900/30";
    }

    if (lower.includes("thunder")) {
        return "from-gray-100 to-purple-50 dark:from-gray-900/30 dark:to-purple-950/20";
    }

    return "from-sky-50 to-blue-50 dark:from-sky-950/20 dark:to-blue-950/20";
};

const formatDay = (datetime: string, locale: string): string => {
    const date = new Date(datetime);

    return Number.isNaN(date.getTime()) ? "" : formatDate(date, locale, { weekday: "short" });
};

const getDailyForecast = (
    forecast: WeatherData["forecast"],
    locale: string,
): {
    day: string;
    dayKey: string;
    precipitationProbability: number;
    temperature: number;
    weather: { description: string; main: string };
}[] => {
    if (!forecast || forecast.length === 0) {
        return [];
    }

    // Group by day and pick one entry per day (midday preferred)
    const byDay = new Map<string, (typeof forecast)[number]>();

    for (const entry of forecast) {
        const dayKey = entry.datetime.split("T", 1)[0] ?? entry.datetime.slice(0, 10);
        const existing = byDay.get(dayKey);

        if (existing) {
            // Prefer entries closer to midday (12:00)
            const existingHour = new Date(existing.datetime).getHours();
            const newHour = new Date(entry.datetime).getHours();

            if (Math.abs(newHour - 12) < Math.abs(existingHour - 12)) {
                byDay.set(dayKey, entry);
            }
        } else {
            byDay.set(dayKey, entry);
        }
    }

    return [...byDay].slice(0, 5).map(([dayKey, entry]) => {
        return {
            day: formatDay(entry.datetime, locale),
            dayKey,
            precipitationProbability: entry.precipitationProbability,
            temperature: Math.round(entry.temperature),
            weather: entry.weather,
        };
    });
};

interface WeatherWidgetProps {
    output: WeatherData;
}

const WeatherWidget: FC<WeatherWidgetProps> = memo(({ output }) => {
    const { i18n } = useLingui();
    const { airQuality, current, forecast, location, units } = output;
    const temporaryUnit = units === "metric" ? "°C" : "°F";
    const speedUnit = units === "metric" ? "m/s" : "mph";
    const gradient = getWeatherGradient(current.weather.main);
    const dailyForecast = getDailyForecast(forecast, i18n.locale);
    const feelsLike = Math.round(current.feelsLike);

    return (
        <div className={cn("my-2 w-full max-w-sm overflow-hidden rounded-xl border bg-gradient-to-br", gradient)}>
            {/* Header: Location + current temp */}
            <div className="flex items-start justify-between p-4 pb-2">
                <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold">
                        {location.name}
                        {location.state ? `, ${location.state}` : ""}
                    </h3>
                    <p className="text-muted-foreground text-xs capitalize">{current.weather.description}</p>
                </div>
                <img
                    alt={current.weather.description}
                    className="size-12 shrink-0"
                    onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                    }}
                    src={`https://openweathermap.org/img/wn/${encodeURIComponent(current.weather.icon)}@2x.png`}
                />
            </div>

            {/* Temperature */}
            <div className="px-4 pb-3">
                <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold tabular-nums">
                        {Math.round(current.temperature)}
                        {temporaryUnit}
                    </span>
                    <span className="text-muted-foreground text-sm">
                        <Trans>
                            Feels like {feelsLike}
                            {temporaryUnit}
                        </Trans>
                    </span>
                </div>
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-4 border-t px-4 py-2.5 text-xs">
                <span className="flex items-center gap-1">
                    <Droplets aria-hidden="true" className="size-3.5 text-blue-500" />
                    {current.humidity}%
                </span>
                <span className="flex items-center gap-1">
                    <Wind aria-hidden="true" className="size-3.5 text-gray-500" />
                    {current.windSpeed} {speedUnit}
                </span>
                <span className="flex items-center gap-1">
                    <Eye aria-hidden="true" className="size-3.5 text-gray-500" />
                    {units === "imperial" ? `${(current.visibility / 1609.344).toFixed(1)} mi` : `${(current.visibility / 1000).toFixed(1)} km`}
                </span>
                {airQuality && (
                    <span
                        className={cn(
                            "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                            AQI_COLORS[airQuality.aqi]?.bg ?? "bg-gray-100 dark:bg-gray-800",
                            AQI_COLORS[airQuality.aqi]?.text ?? "text-gray-600 dark:text-gray-300",
                        )}
                    >
                        AQI: {airQuality.aqiDescription}
                    </span>
                )}
            </div>

            {/* 5-day forecast */}
            {dailyForecast.length > 0 && (
                <div className="flex gap-1 overflow-x-auto border-t px-3 py-2.5">
                    {dailyForecast.map((day) => (
                        <div className="flex min-w-14 flex-1 flex-col items-center gap-0.5 rounded-md px-1.5 py-1" key={day.dayKey}>
                            <span className="text-muted-foreground text-[10px] font-medium">{day.day}</span>
                            <span className="text-xs font-semibold tabular-nums">
                                {day.temperature}
                                {temporaryUnit}
                            </span>
                            {day.precipitationProbability > 0 && (
                                <span className="text-[10px] text-blue-500">
                                    {Math.round(day.precipitationProbability > 1 ? day.precipitationProbability : day.precipitationProbability * 100)}%
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
});

WeatherWidget.displayName = "WeatherWidget";

export default WeatherWidget;
