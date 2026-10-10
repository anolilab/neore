"use client";

/**
 * LoadMoreTrigger - Visual loading indicator for infinite scroll
 *
 * The actual load trigger lives in ThreadViewport's scroll handler,
 * which captures scrollHeight synchronously before calling loadMore().
 * This component only renders the loading spinner while older messages are being fetched.
 */

import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";

interface LoadMoreTriggerProps {
    status: "LoadingFirstPage" | "LoadingMore" | "Exhausted" | "CanLoadMore";
}

const LoadMoreTrigger: React.FC<LoadMoreTriggerProps> = ({ status }) => {
    if (status !== "LoadingMore") {
        return null;
    }

    return (
        // overflow-anchor: none keeps this element out of the browser's CSS scroll-anchor
        // candidate list so it doesn't interfere with position restoration.
        <div className="text-muted-foreground flex items-center justify-center gap-2 py-4 text-sm" style={{ overflowAnchor: "none" }}>
            <Loader2 className="size-4 animate-spin" />
            <span>
                <Trans>Loading older messages...</Trans>
            </span>
        </div>
    );
};

export default LoadMoreTrigger;
