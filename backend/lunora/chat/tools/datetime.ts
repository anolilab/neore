/**
 * DateTime Tool
 * Provides current date and time information
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";

/**
 * Whether the runtime's ICU data knows this IANA time zone.
 *
 * `Intl.DateTimeFormat` throws `RangeError` for an unknown zone. The formatter
 * is fed to `Boolean` so that constructing it is a value, not a discarded
 * statement.
 */
const isSupportedTimeZone = (timeZone: string): boolean => {
    try {
        return Boolean(new Intl.DateTimeFormat("en-US", { timeZone }));
    } catch {
        return false;
    }
};

/**
 * DateTime Tool
 */
const datetimeTool = createTool<
    {
        timezone?: string;
    },
    {
        components: {
            day: number;
            dayOfWeek: number;
            hour: number;
            minute: number;
            month: number;
            second: number;
            weekOfYear: number;
            year: number;
        };
        formatted: {
            date: string;
            dateShort: string;
            full: string;
            isoLocal: string;
            time: string;
            timeShort: string;
        };
        iso: string;
        timestamp: number;
        timezone: string;
    },
    ToolContext
>({
    description: "Get the current date and time in various formats. Optionally specify a timezone.",
    execute: async (_context, input) => {
        const { timezone = "UTC" } = input;

        const now = new Date();

        // Validate timezone
        const validTimezone = isSupportedTimeZone(timezone) ? timezone : "UTC";

        if (validTimezone !== timezone) {
            toolsLogger.warn(`Invalid timezone "${timezone}", falling back to UTC`);
        }

        // Create formatters for different formats
        const dateFormatter = new Intl.DateTimeFormat("en-US", {
            day: "numeric",
            month: "long",
            timeZone: validTimezone,
            weekday: "long",
            year: "numeric",
        });

        const timeFormatter = new Intl.DateTimeFormat("en-US", {
            hour: "2-digit",
            hour12: true,
            minute: "2-digit",
            second: "2-digit",
            timeZone: validTimezone,
        });

        const dateShortFormatter = new Intl.DateTimeFormat("en-US", {
            day: "numeric",
            month: "short",
            timeZone: validTimezone,
            year: "numeric",
        });

        const timeShortFormatter = new Intl.DateTimeFormat("en-US", {
            hour: "2-digit",
            hour12: true,
            minute: "2-digit",
            timeZone: validTimezone,
        });

        const fullFormatter = new Intl.DateTimeFormat("en-US", {
            day: "numeric",
            hour: "2-digit",
            hour12: true,
            minute: "2-digit",
            month: "long",
            second: "2-digit",
            timeZone: validTimezone,
            weekday: "long",
            year: "numeric",
        });

        // ISO local format (sv-SE gives ISO-like format)
        const isoLocalFormatter = new Intl.DateTimeFormat("sv-SE", {
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            month: "2-digit",
            second: "2-digit",
            timeZone: validTimezone,
            year: "numeric",
        });

        // Get date components in the specified timezone
        const parts = new Intl.DateTimeFormat("en-US", {
            day: "numeric",
            hour: "numeric",
            hour12: false,
            minute: "numeric",
            month: "numeric",
            second: "numeric",
            timeZone: validTimezone,
            weekday: "short",
            year: "numeric",
        }).formatToParts(now);

        const getPartValue = (type: string): number => {
            const part = parts.find((p) => p.type === type);

            return part ? parseInt(part.value, 10) : 0;
        };

        const year = getPartValue("year");
        const month = getPartValue("month");
        const day = getPartValue("day");

        // Calculate week of year
        const startOfYear = new Date(year, 0, 1);
        const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / 86_400_000) + 1;
        const weekOfYear = Math.ceil(dayOfYear / 7);

        // Day of week (0 = Sunday, 6 = Saturday)
        const dayOfWeekMap: Record<string, number> = {
            Fri: 5,
            Mon: 1,
            Sat: 6,
            Sun: 0,
            Thu: 4,
            Tue: 2,
            Wed: 3,
        };
        const weekdayPart = parts.find((p) => p.type === "weekday");
        const dayOfWeek = weekdayPart ? (dayOfWeekMap[weekdayPart.value] ?? 0) : now.getDay();

        return {
            components: {
                day,
                dayOfWeek,
                hour: getPartValue("hour"),
                minute: getPartValue("minute"),
                month,
                second: getPartValue("second"),
                weekOfYear,
                year,
            },
            formatted: {
                date: dateFormatter.format(now),
                dateShort: dateShortFormatter.format(now),
                full: fullFormatter.format(now),
                isoLocal: isoLocalFormatter.format(now).replace(" ", "T"),
                time: timeFormatter.format(now),
                timeShort: timeShortFormatter.format(now),
            },
            iso: now.toISOString(),
            timestamp: now.getTime(),
            timezone: validTimezone,
        };
    },
    inputSchema: z
        .object({
            timezone: z
                .string()
                .optional()
                .default("UTC")
                .meta({ description: "Timezone (e.g., 'America/New_York', 'Europe/London', 'Asia/Tokyo'). Default: UTC" }),
        })
        .strict(),
    title: "Date & Time",
});

export default datetimeTool;
