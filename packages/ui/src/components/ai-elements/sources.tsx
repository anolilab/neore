"use client";

import { plural } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/components/collapsible";
import cn from "@ui/utils/cn";
import { ChevronDownIcon, GlobeIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { memo, useState } from "react";

export type SourcesProps = ComponentProps<"div">;

export const Sources = ({ className, ...props }: SourcesProps) => <Collapsible className={cn("not-prose text-primary mb-4 text-xs", className)} {...props} />;

export type SourcesTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
    count: number;
    /** Source URLs for favicon preview in the trigger */
    sourceUrls?: string[];
};

export const SourcesTrigger = ({ children, className, count, sourceUrls, ...props }: SourcesTriggerProps) => {
    const { t } = useLingui();
    // eslint-disable-next-line no-restricted-syntax -- a Lingui plural must be the whole message of `t`
    const triggerLabel = t`${plural(count, { one: "Used # source, toggle to show", other: "Used # sources, toggle to show" })}`;

    return (
        <CollapsibleTrigger aria-label={triggerLabel} className={cn("flex items-center gap-2", className)} {...props}>
            {children ?? (
                <>
                    {sourceUrls && sourceUrls.length > 0 && (
                        <span className="flex -space-x-1.5">
                            {sourceUrls.slice(0, 3).map((url, index) => (
                                <Favicon className="border-background size-4 rounded-full border" key={`${index}-${url}`} url={url} />
                            ))}
                        </span>
                    )}
                    <p className="font-medium">
                        <Plural one="Used # source" other="Used # sources" value={count} />
                    </p>
                    <ChevronDownIcon aria-hidden="true" className="h-4 w-4" />
                </>
            )}
        </CollapsibleTrigger>
    );
};

export type SourcesContentProps = ComponentProps<typeof CollapsibleContent>;

export const SourcesContent = ({ className, ...props }: SourcesContentProps) => (
    <CollapsibleContent
        className={cn(
            "mt-3 flex w-fit flex-col gap-2",
            "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=open]:animate-in outline-none",
            className,
        )}
        role="list"
        {...props}
    />
);

/**
 * Favicon component - loads favicon from DuckDuckGo's icon service
 */
const Favicon = memo(({ className, url }: { className?: string; url: string }) => {
    const [hasError, setHasError] = useState(false);

    let hostname: string | undefined;

    try {
        hostname = new URL(url).hostname;
    } catch {
        // Invalid URL
    }

    if (!hostname || hasError) {
        return <GlobeIcon aria-hidden="true" className={cn("size-4 shrink-0 text-gray-400", className)} />;
    }

    return (
        <img
            alt=""
            aria-hidden="true"
            className={cn("size-4 shrink-0 rounded-sm", className)}
            loading="lazy"
            onError={() => setHasError(true)}
            src={`https://icons.duckduckgo.com/ip3/${hostname}.ico`}
        />
    );
});

Favicon.displayName = "Favicon";

export type SourceProps = ComponentProps<"a"> & {
    /** Whether this source is highlighted (e.g. from hovering an inline citation marker) */
    highlighted?: boolean;
    /** Optional 1-based index number displayed as a badge */
    index?: number;
};

export const Source = ({ children, className, highlighted, href, index, title, ...props }: SourceProps) => (
    <a
        className={cn(
            "flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800",
            highlighted && "bg-blue-50 ring-1 ring-blue-200 dark:bg-blue-950/40 dark:ring-blue-800",
            className,
        )}
        data-source-index={index}
        href={href}
        rel="noreferrer"
        role="listitem"
        target="_blank"
        {...props}
    >
        {children ?? (
            <>
                {index != null && (
                    <span
                        className={cn(
                            "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold transition-colors",
                            highlighted
                                ? "bg-blue-200 text-blue-700 dark:bg-blue-800 dark:text-blue-200"
                                : "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
                        )}
                    >
                        {index}
                    </span>
                )}
                {href && href !== "#" ? <Favicon url={href} /> : <GlobeIcon aria-hidden="true" className="size-4 shrink-0 text-gray-400" />}
                <span className="block truncate font-medium">{title}</span>
                {href && href !== "#" && <span className="hidden truncate text-gray-400 sm:block">{extractDomain(href)}</span>}
            </>
        )}
    </a>
);

/**
 * Inline citation marker for use within text content.
 * Renders as a small superscript number that can be hovered.
 */
export type CitationMarkerProps = ComponentProps<"a"> & {
    index: number;
};

export const CitationMarker = ({ className, index, ...props }: CitationMarkerProps) => (
    <a
        className={cn(
            "ml-0.5 inline-flex size-4 items-center justify-center rounded-full bg-gray-200 align-super text-[9px] font-bold text-gray-600 no-underline transition-colors hover:bg-blue-100 hover:text-blue-700 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-blue-900 dark:hover:text-blue-300",
            className,
        )}
        rel="noreferrer"
        target="_blank"
        {...props}
    >
        {index}
    </a>
);

const LEADING_WWW_REGEX = /^www\./;

/**
 * Extract domain name from a URL for display.
 */
const extractDomain = (url: string): string => {
    try {
        const { hostname } = new URL(url);

        return hostname.replace(LEADING_WWW_REGEX, "");
    } catch {
        return "";
    }
};
