"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { formatDate, formatTime } from "@neore/ui/utils/locale-format";
import { ArrowRight, Clock, Plane } from "lucide-react";
import type { FC } from "react";

export interface FlightData {
    error?: string;
    flight?: {
        date: string;
        flightNumber: string;
        legs: {
            aircraft?: { code: string; name?: string };
            airline: { code: string; name?: string };
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
        }[];
        status: string;
    };
    success: boolean;
}

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
    active: { bg: "bg-green-100 dark:bg-green-900/40", text: "text-green-700 dark:text-green-300" },
    cancelled: { bg: "bg-red-100 dark:bg-red-900/40", text: "text-red-700 dark:text-red-300" },
    delayed: { bg: "bg-yellow-100 dark:bg-yellow-900/40", text: "text-yellow-700 dark:text-yellow-300" },
    diverted: { bg: "bg-orange-100 dark:bg-orange-900/40", text: "text-orange-700 dark:text-orange-300" },
    landed: { bg: "bg-green-100 dark:bg-green-900/40", text: "text-green-700 dark:text-green-300" },
    scheduled: { bg: "bg-blue-100 dark:bg-blue-900/40", text: "text-blue-700 dark:text-blue-300" },
};

/** Display labels for the flight statuses the tool reports; unknown statuses show as sent. */
const STATUS_LABELS: Record<string, MessageDescriptor> = {
    active: msg`Active`,
    cancelled: msg`Cancelled`,
    delayed: msg`Delayed`,
    diverted: msg`Diverted`,
    landed: msg`Landed`,
    scheduled: msg`Scheduled`,
};

const isValidDate = (date: Date): boolean => !Number.isNaN(date.getTime());

const formatLegTime = (iso: string, locale: string): string => {
    const date = new Date(iso);

    return isValidDate(date) ? formatTime(date, locale, { hour: "2-digit", minute: "2-digit" }) : iso;
};

const formatLegDate = (iso: string, locale: string): string => {
    const date = new Date(iso);

    return isValidDate(date) ? formatDate(date, locale, { day: "numeric", month: "short", weekday: "short" }) : iso;
};

interface FlightWidgetProps {
    output: FlightData;
}

const FlightWidget: FC<FlightWidgetProps> = ({ output }) => {
    const { i18n, t } = useLingui();

    if (!output.success || !output.flight) {
        return (
            <div className="my-2 w-full max-w-sm overflow-hidden rounded-xl border bg-red-50 p-4 dark:bg-red-950/20">
                <p className="text-sm text-red-600 dark:text-red-400">{output.error ?? t`Failed to fetch flight data.`}</p>
            </div>
        );
    }

    const { flight } = output;
    const statusLower = flight.status.toLowerCase();
    const statusLabel = STATUS_LABELS[statusLower];
    const statusStyle = STATUS_STYLES[statusLower] ?? { bg: "bg-gray-100 dark:bg-gray-800", text: "text-gray-600 dark:text-gray-300" };

    return (
        <div className="my-2 w-full max-w-sm overflow-hidden rounded-xl border">
            {/* Header */}
            <div className="flex items-center justify-between bg-gradient-to-r from-blue-50 to-indigo-50 p-3 dark:from-blue-950/20 dark:to-indigo-950/20">
                <div className="flex items-center gap-2">
                    <Plane aria-hidden="true" className="size-4 text-blue-600 dark:text-blue-400" />
                    <span className="text-sm font-bold">{flight.flightNumber}</span>
                </div>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize", statusStyle.bg, statusStyle.text)}>
                    {statusLabel ? i18n._(statusLabel) : flight.status}
                </span>
            </div>

            {/* Legs */}
            {flight.legs.map((leg, index) => {
                const dependencyTime = leg.departure.actualTime || leg.departure.estimatedTime || leg.departure.scheduledTime;
                const arrayTime = leg.arrival.actualTime || leg.arrival.estimatedTime || leg.arrival.scheduledTime;

                return (
                    <div className={cn("p-3", index > 0 && "border-t")} key={`${leg.flightNumber}-${leg.departure.scheduledTime}`}>
                        {/* Route */}
                        <div className="flex items-center justify-between">
                            <div className="text-center">
                                <div className="text-lg font-bold">{leg.departure.airport}</div>
                                <div className="text-muted-foreground text-[10px]">{leg.departure.airportName ?? ""}</div>
                            </div>
                            <div className="flex flex-col items-center gap-0.5 px-3">
                                <ArrowRight aria-hidden="true" className="text-muted-foreground size-4" />
                                {leg.duration && (
                                    <span className="text-muted-foreground flex items-center gap-0.5 text-[10px]">
                                        <Clock aria-hidden="true" className="size-2.5" />
                                        {leg.duration}
                                    </span>
                                )}
                            </div>
                            <div className="text-center">
                                <div className="text-lg font-bold">{leg.arrival.airport}</div>
                                <div className="text-muted-foreground text-[10px]">{leg.arrival.airportName ?? ""}</div>
                            </div>
                        </div>

                        {/* Times */}
                        <div className="mt-2 flex justify-between text-xs">
                            <div>
                                <span className="text-muted-foreground">
                                    <Trans>Depart:</Trans>{" "}
                                </span>
                                <span className="font-medium tabular-nums" suppressHydrationWarning>
                                    {formatLegTime(dependencyTime, i18n.locale)}
                                </span>
                                {leg.departure.terminal && <span className="text-muted-foreground ml-1">T{leg.departure.terminal}</span>}
                            </div>
                            <div>
                                <span className="text-muted-foreground">
                                    <Trans>Arrive:</Trans>{" "}
                                </span>
                                <span className="font-medium tabular-nums" suppressHydrationWarning>
                                    {formatLegTime(arrayTime, i18n.locale)}
                                </span>
                                {leg.arrival.terminal && <span className="text-muted-foreground ml-1">T{leg.arrival.terminal}</span>}
                            </div>
                        </div>

                        {/* Airline + Aircraft */}
                        <div className="text-muted-foreground mt-1.5 flex items-center gap-3 text-[11px]">
                            {leg.airline.name && <span>{leg.airline.name}</span>}
                            {leg.aircraft?.name && <span>{leg.aircraft.name}</span>}
                            <span suppressHydrationWarning>{formatLegDate(flight.date, i18n.locale)}</span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export default FlightWidget;
