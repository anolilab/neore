"use client";

import { Plural, Trans } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { ExternalLink, Play } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

const WWW_PREFIX_RE = /^www\./;

interface VideoResult {
    description?: string;
    embedUrl?: string;
    platform?: "youtube" | "vimeo" | "dailymotion" | "other";
    thumbnailUrl?: string;
    title: string;
    url: string;
}

export interface VideoSearchOutput {
    results: VideoResult[];
    totalResults: number;
}

const extractDomain = (url: string): string => {
    try {
        return new URL(url).hostname.replace(WWW_PREFIX_RE, "");
    } catch {
        return "";
    }
};

const PLATFORM_COLORS: Record<string, string> = {
    dailymotion: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
    vimeo: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    youtube: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

const MAX_VISIBLE = 4;

interface VideoSearchResultsProps {
    output: VideoSearchOutput;
}

const VideoSearchResults: FC<VideoSearchResultsProps> = ({ output }) => {
    const [expanded, setExpanded] = useState(false);

    if (output.results.length === 0) {
        return null;
    }

    const visibleResults = expanded ? output.results : output.results.slice(0, MAX_VISIBLE);
    const hasMore = output.results.length > MAX_VISIBLE;

    return (
        <div className="my-2 w-full max-w-md overflow-hidden rounded-xl border">
            <div className="divide-y">
                {visibleResults.map((result) => {
                    const domain = extractDomain(result.url);
                    const platformStyle = result.platform ? PLATFORM_COLORS[result.platform] : undefined;

                    return (
                        <a
                            className="group flex gap-3 p-2.5 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50"
                            href={result.url}
                            key={result.url}
                            rel="noopener noreferrer"
                            target="_blank"
                        >
                            {/* Thumbnail */}
                            <div className="relative size-20 shrink-0 overflow-hidden rounded-md bg-gray-100 dark:bg-gray-800">
                                {result.thumbnailUrl ? (
                                    <img
                                        alt=""
                                        className="size-full object-cover"
                                        loading="lazy"
                                        onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = "none";
                                        }}
                                        src={result.thumbnailUrl}
                                    />
                                ) : null}
                                <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
                                    <Play aria-hidden="true" className="size-6 fill-white text-white" />
                                </div>
                            </div>

                            {/* Details */}
                            <div className="min-w-0 flex-1">
                                <h4 className="group-hover:text-primary line-clamp-2 text-sm font-medium transition-colors">
                                    {result.title}
                                    <span className="sr-only">
                                        {" "}
                                        <Trans>(opens in new tab)</Trans>
                                    </span>
                                </h4>
                                {result.description && <p className="text-muted-foreground mt-0.5 line-clamp-1 text-xs">{result.description}</p>}
                                <div className="mt-1 flex items-center gap-2">
                                    {result.platform && platformStyle && (
                                        <span className={cn("rounded px-1 py-0.5 text-[10px] font-medium capitalize", platformStyle)}>{result.platform}</span>
                                    )}
                                    <span className="text-muted-foreground text-[10px]">{domain}</span>
                                </div>
                            </div>
                        </a>
                    );
                })}
            </div>
            {hasMore && !expanded && (
                <button
                    className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 border-t px-3 py-2 text-xs transition-colors"
                    onClick={() => setExpanded(true)}
                    type="button"
                >
                    <ExternalLink aria-hidden="true" className="size-3" />
                    <Plural one="Show # more video" other="Show # more videos" value={output.results.length - MAX_VISIBLE} />
                </button>
            )}
        </div>
    );
};

export default VideoSearchResults;
