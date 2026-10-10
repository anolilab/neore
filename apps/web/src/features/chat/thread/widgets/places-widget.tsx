"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { ExternalLink, MapPin, Star } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

// --- Find Place Widget ---

interface FindPlaceResult {
    addressComponents?: {
        longName: string;
        shortName: string;
        types: string[];
    }[];
    coordinates: { lat: number; lng: number };
    formattedAddress: string;
    placeId: string;
    types: string[];
}

export interface FindPlaceOutput {
    error?: string;
    results?: FindPlaceResult[];
    success: boolean;
}

interface FindPlaceWidgetProps {
    output: FindPlaceOutput;
}

export const FindPlaceWidget: FC<FindPlaceWidgetProps> = ({ output }) => {
    if (!output.success || !output.results || output.results.length === 0) {
        return null;
    }

    const place = output.results[0]!;
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${place.coordinates.lat},${place.coordinates.lng}`;

    return (
        <div className="my-2 w-full max-w-sm overflow-hidden rounded-xl border">
            <div className="flex items-start gap-3 p-3">
                <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
                    <MapPin aria-hidden="true" className="text-muted-foreground size-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-sm leading-tight font-medium">{place.formattedAddress}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                        {place.coordinates.lat.toFixed(4)}, {place.coordinates.lng.toFixed(4)}
                    </p>
                    {place.types.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                            {place.types.slice(0, 3).map((type) => (
                                <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]" key={type}>
                                    {type.replaceAll("_", " ")}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            <div className="border-t px-3 py-2">
                <a
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs transition-colors"
                    href={mapsUrl}
                    rel="noreferrer"
                    target="_blank"
                >
                    <ExternalLink aria-hidden="true" className="size-3" />
                    <Trans>View on Google Maps</Trans>
                </a>
            </div>
        </div>
    );
};

// --- Nearby Places Widget ---

interface NearbyPlace {
    address: string;
    coordinates: { lat: number; lng: number };
    distance?: number;
    name: string;
    openNow?: boolean;
    phoneNumber?: string;
    photos?: string[];
    placeId: string;
    priceLevel?: number;
    rating?: number;
    types: string[];
    userRatingsTotal?: number;
    website?: string;
}

export interface NearbyPlacesOutput {
    error?: string;
    places?: NearbyPlace[];
    searchCenter?: { lat: number; lng: number };
    success: boolean;
}

interface NearbyPlacesWidgetProps {
    output: NearbyPlacesOutput;
}

const MAX_VISIBLE = 5;

export const NearbyPlacesWidget: FC<NearbyPlacesWidgetProps> = ({ output }) => {
    const [expanded, setExpanded] = useState(false);
    const { t } = useLingui();

    if (!output.success || !output.places || output.places.length === 0) {
        return null;
    }

    const visiblePlaces = expanded ? output.places : output.places.slice(0, MAX_VISIBLE);
    const hasMore = output.places.length > MAX_VISIBLE;
    const remainingCount = output.places.length - MAX_VISIBLE;

    return (
        <div className="my-2 w-full max-w-sm overflow-hidden rounded-xl border">
            <div className="divide-y">
                {visiblePlaces.map((place) => {
                    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name)}&query_place_id=${place.placeId}`;

                    return (
                        <div className="flex items-start gap-3 p-3" key={place.placeId}>
                            {place.photos && place.photos.length > 0 ? (
                                <img
                                    alt=""
                                    className="size-10 shrink-0 rounded-md object-cover"
                                    loading="lazy"
                                    referrerPolicy="no-referrer"
                                    src={place.photos[0]}
                                />
                            ) : (
                                <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md">
                                    <MapPin aria-hidden="true" className="text-muted-foreground size-4" />
                                </div>
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <a
                                        className="hover:text-primary truncate text-sm font-medium transition-colors"
                                        href={mapsUrl}
                                        rel="noreferrer"
                                        target="_blank"
                                    >
                                        {place.name}
                                        <span className="sr-only">
                                            {" "}
                                            <Trans>(opens in new tab)</Trans>
                                        </span>
                                    </a>
                                    {place.openNow != null && (
                                        <span
                                            className={cn(
                                                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                                                place.openNow
                                                    ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                                                    : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
                                            )}
                                        >
                                            {place.openNow ? t({ context: "place opening hours", message: "Open" }) : t`Closed`}
                                        </span>
                                    )}
                                </div>
                                <p className="text-muted-foreground mt-0.5 truncate text-xs">{place.address}</p>
                                <div className="mt-1 flex items-center gap-2 text-xs">
                                    {place.rating != null && (
                                        <span className="flex items-center gap-0.5">
                                            <Star aria-hidden="true" className="size-3 fill-amber-400 text-amber-400" />
                                            <span className="font-medium">{place.rating.toFixed(1)}</span>
                                            {place.userRatingsTotal != null && <span className="text-muted-foreground">({place.userRatingsTotal})</span>}
                                        </span>
                                    )}
                                    {place.distance != null && (
                                        <span className="text-muted-foreground">
                                            {place.distance < 1 ? `${Math.round(place.distance * 1000)}m` : `${place.distance.toFixed(1)}km`}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
            {hasMore && !expanded && (
                <button
                    className="text-muted-foreground hover:text-foreground w-full border-t px-3 py-2 text-center text-xs transition-colors"
                    onClick={() => setExpanded(true)}
                    type="button"
                >
                    <Trans>Show {remainingCount} more</Trans>
                </button>
            )}
        </div>
    );
};
