import { useLingui } from "@lingui/react/macro";
import type { PageContextMarker } from "@neore/ai/gateway";
import { ChevronDown, ChevronRight, Globe, TextQuote } from "lucide-react";
import { useId, useState } from "react";

import cn from "../utils/cn";
import { getPageContextExcerpt } from "../utils/page-context";

interface PageContextChipProps {
    className?: string;
    info: PageContextMarker;
    /** The stored part's text; the marker's ranges point into it. */
    text: string;
}

const hostOf = (url: string): string => {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
};

/** Only http(s) links are rendered as links; anything else is shown as text. */
const safeHref = (url: string): string | undefined => {
    try {
        const { protocol } = new URL(url);

        return protocol === "https:" || protocol === "http:" ? url : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Compact, collapsible stand-in for a page attached to a user message.
 *
 * Deliberately no favicon: fetching the page origin's `/favicon.ico` would hit the
 * attached site from every viewer's browser — shared-thread readers included —
 * leaking their IPs to it and probing intranet hosts named in the URL.
 */
const PageContextChip = ({ className, info, text }: PageContextChipProps) => {
    const { t } = useLingui();
    const [isOpen, setIsOpen] = useState(false);
    const panelId = useId();
    const href = safeHref(info.url);
    const label = info.kind === "selection" ? t`Selection context` : t`Page context`;
    const excerpt = isOpen ? getPageContextExcerpt(info, text) : "";

    return (
        <div className={cn("w-full max-w-sm rounded-lg border border-gray-200 bg-white text-left text-xs dark:border-gray-700 dark:bg-gray-900", className)}>
            <div className="flex items-center gap-2 px-2.5 py-2">
                <Globe aria-hidden="true" className="size-4 shrink-0 text-gray-500 dark:text-gray-400" />
                <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-gray-500 uppercase dark:text-gray-400">
                        {info.kind === "selection" && <TextQuote aria-hidden="true" className="size-3" />}
                        {label}
                    </p>
                    <p className="truncate font-medium text-gray-800 dark:text-gray-100" title={info.title}>
                        {info.title}
                    </p>
                    {href ? (
                        <a className="block truncate text-gray-500 hover:underline dark:text-gray-400" href={href} rel="noopener noreferrer" target="_blank">
                            {hostOf(info.url)}
                        </a>
                    ) : (
                        <p className="truncate text-gray-500 dark:text-gray-400">{info.url}</p>
                    )}
                </div>
                <button
                    aria-controls={panelId}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? t`Hide attached content` : t`Show attached content`}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none dark:text-gray-400 dark:hover:bg-gray-800"
                    onClick={() => setIsOpen((open) => !open)}
                    type="button"
                >
                    {isOpen ? <ChevronDown aria-hidden="true" className="size-3.5" /> : <ChevronRight aria-hidden="true" className="size-3.5" />}
                </button>
            </div>
            <div aria-hidden={!isOpen} className={isOpen ? "block" : "hidden"} id={panelId}>
                {isOpen && (
                    <p className="max-h-60 overflow-y-auto border-t border-gray-200 px-2.5 py-2 whitespace-pre-wrap text-gray-700 dark:border-gray-700 dark:text-gray-300">
                        {excerpt || t`No text to show.`}
                    </p>
                )}
            </div>
        </div>
    );
};

export default PageContextChip;
