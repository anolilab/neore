import { FileTextIcon, GlobeIcon, TextQuoteIcon, XIcon } from "lucide-react";

import type { PageContext } from "@/page-context/build";
import { estimateTokens } from "@/page-context/build";

interface PageContextChipProps {
    context: PageContext;
    onRemove: () => void;
}

const hostOf = (url: string): string => {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
};

/** The page that will go with the next message, with a way to drop it. */
export function PageContextChip({ context, onRemove }: PageContextChipProps) {
    const Icon = context.text ? FileTextIcon : TextQuoteIcon;
    const kind = context.text ? "Page" : "Selection";
    const tokens = estimateTokens(context);

    return (
        <div className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2 text-xs dark:border-gray-700 dark:bg-gray-900">
            <Icon aria-hidden="true" className="size-4 shrink-0 text-gray-500 dark:text-gray-400" />
            <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-gray-800 dark:text-gray-100" title={context.title}>
                    <span className="sr-only">{`${kind} attached: `}</span>
                    {context.title}
                </p>
                <p className="flex items-center gap-1 truncate text-gray-500 dark:text-gray-400">
                    <GlobeIcon aria-hidden="true" className="size-3 shrink-0" />
                    <span className="truncate">{hostOf(context.url)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{`${kind}, ~${tokens.toLocaleString()} tokens`}</span>
                </p>
            </div>
            <button
                aria-label={`Remove attached ${kind.toLowerCase()}`}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-800 focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                onClick={onRemove}
                type="button"
            >
                <XIcon aria-hidden="true" className="size-3.5" />
            </button>
        </div>
    );
}
