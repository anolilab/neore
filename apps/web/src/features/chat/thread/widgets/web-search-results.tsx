"use client";

import { Plural, Trans } from "@lingui/react/macro";
import { ExternalLink } from "lucide-react";
import type { FC } from "react";
import { memo, useState } from "react";

const WWW_PREFIX_RE = /^www\./;

interface SearchResult {
    author?: string;
    content: string;
    image?: string;
    publishedDate?: string;
    title: string;
    url: string;
}

export interface WebSearchOutput {
    results: {
        query: string;
        results: SearchResult[];
    }[];
    totalResults: number;
}

const extractDomain = (url: string): string => {
    try {
        return new URL(url).hostname.replace(WWW_PREFIX_RE, "");
    } catch {
        return url;
    }
};

// Fixed locale + timezone: this widget is server-rendered with the thread, so a
// viewer-dependent format would hydrate differently than it was sent.
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" });

const formatDate = (dateString: string): string => {
    try {
        return DATE_FORMATTER.format(new Date(dateString));
    } catch {
        return dateString;
    }
};

const MAX_VISIBLE = 4;

const ResultCard: FC<{ result: SearchResult }> = memo(({ result }) => {
    const domain = extractDomain(result.url);
    const faviconUrl = `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;

    return (
        <a
            className="group flex gap-3 rounded-lg p-2.5 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50"
            href={result.url}
            rel="noopener noreferrer"
            target="_blank"
        >
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                    <img
                        alt=""
                        className="size-3.5 shrink-0 rounded-sm"
                        onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                        }}
                        src={faviconUrl}
                    />
                    <span className="text-muted-foreground truncate text-[11px]">{domain}</span>
                    {result.publishedDate && <span className="text-muted-foreground shrink-0 text-[10px]">· {formatDate(result.publishedDate)}</span>}
                </div>
                <h4 className="group-hover:text-primary mt-0.5 line-clamp-1 text-sm font-medium transition-colors">
                    {result.title}
                    <span className="sr-only">
                        {" "}
                        <Trans>(opens in new tab)</Trans>
                    </span>
                </h4>
                <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-relaxed">{result.content}</p>
            </div>
            {result.image && (
                <img
                    alt=""
                    className="size-16 shrink-0 rounded-md object-cover"
                    loading="lazy"
                    onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                    }}
                    src={result.image}
                />
            )}
        </a>
    );
});

ResultCard.displayName = "ResultCard";

interface WebSearchResultsWidgetProps {
    output: WebSearchOutput;
}

const WebSearchResultsWidget: FC<WebSearchResultsWidgetProps> = memo(({ output }) => {
    const [expanded, setExpanded] = useState(false);

    // Flatten all results from all queries
    const allResults = output.results.flatMap((q) => q.results);

    if (allResults.length === 0) {
        return null;
    }

    const visibleResults = expanded ? allResults : allResults.slice(0, MAX_VISIBLE);
    const hasMore = allResults.length > MAX_VISIBLE;

    return (
        <div className="my-2 w-full max-w-md overflow-hidden rounded-xl border">
            <div className="divide-y">
                {visibleResults.map((result) => (
                    <ResultCard key={result.url} result={result} />
                ))}
            </div>
            {hasMore && !expanded && (
                <button
                    className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 border-t px-3 py-2 text-xs transition-colors"
                    onClick={() => setExpanded(true)}
                    type="button"
                >
                    <ExternalLink aria-hidden="true" className="size-3" />
                    <Plural one="Show # more result" other="Show # more results" value={allResults.length - MAX_VISIBLE} />
                </button>
            )}
        </div>
    );
});

WebSearchResultsWidget.displayName = "WebSearchResultsWidget";

export default WebSearchResultsWidget;
