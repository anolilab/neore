"use client";

import { Plural } from "@lingui/react/macro";
import { ExternalLink } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

const WWW_PREFIX_RE = /^www\./;

interface ImageResult {
    description?: string;
    sourceUrl?: string;
    title: string;
    url: string;
}

export interface ImageSearchOutput {
    results: ImageResult[];
    totalResults: number;
}

const extractDomain = (url: string): string => {
    try {
        return new URL(url).hostname.replace(WWW_PREFIX_RE, "");
    } catch {
        return "";
    }
};

const MAX_VISIBLE = 8;

interface ImageSearchGalleryProps {
    output: ImageSearchOutput;
}

const ImageSearchGallery: FC<ImageSearchGalleryProps> = ({ output }) => {
    const [expanded, setExpanded] = useState(false);
    const [failedImages, setFailedImages] = useState<Set<string>>(new Set());

    const results = output.results.filter((r) => !failedImages.has(r.url));

    if (results.length === 0) {
        return null;
    }

    const visibleResults = expanded ? results : results.slice(0, MAX_VISIBLE);
    const hasMore = results.length > MAX_VISIBLE;

    return (
        <div className="my-2 w-full max-w-lg overflow-hidden rounded-xl border">
            <div className="grid grid-cols-4 gap-0.5 p-0.5">
                {visibleResults.map((result) => {
                    const linkUrl = result.sourceUrl || result.url;
                    const domain = extractDomain(linkUrl);

                    return (
                        <a
                            className="group relative aspect-square overflow-hidden rounded-md bg-gray-100 dark:bg-gray-800"
                            href={linkUrl}
                            key={result.url}
                            rel="noopener noreferrer"
                            target="_blank"
                            title={result.title}
                        >
                            <img
                                alt={result.title}
                                className="size-full object-cover transition-transform group-hover:scale-105"
                                loading="lazy"
                                onError={() => {
                                    setFailedImages((previous) => new Set(previous).add(result.url));
                                }}
                                src={result.url}
                            />
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                                <p className="line-clamp-1 text-[10px] font-medium text-white">{result.title}</p>
                                {domain && <p className="text-[9px] text-white/70">{domain}</p>}
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
                    <Plural one="Show # more image" other="Show # more images" value={results.length - MAX_VISIBLE} />
                </button>
            )}
        </div>
    );
};

ImageSearchGallery.displayName = "ImageSearchGallery";

export default ImageSearchGallery;
