"use client";

/**
 * The rows of the MCP tool calls that are running while a reply streams: the tool, its server, and the
 * progress the server reports — a bar filled to `progress / total`, or a pulsing one when it gave no total —
 * with its latest status message under it. The numbers arrive on the reply's stream (`toolProgress`
 * chunks) and a row leaves with the call's `ended` marker, so a server that reports nothing shows nothing.
 */

import { useLingui } from "@lingui/react/macro";
import type { ToolProgressEntry, ToolProgressState } from "@neore/chat-ui/utils/tool-progress";
import { progressFraction } from "@neore/chat-ui/utils/tool-progress";
import { Progress, ProgressIndicator, ProgressTrack } from "@neore/ui/components/progress";
import { Loader2 } from "lucide-react";
import type { FC } from "react";
import { memo, useEffect, useRef, useState } from "react";

/** A screen reader hears a changed message at most this often; a bar that ticks twice a second would drown it out. */
const ANNOUNCE_EVERY_MS = 3000;

/** `message`, but changing at most every {@link ANNOUNCE_EVERY_MS}: the newest one waits for the window to pass. */
const useAnnouncedMessage = (message: string | undefined): string | undefined => {
    const [announced, setAnnounced] = useState(message);
    const announcedAt = useRef(0);

    // The first message is announced as the row mounts: the window starts there.
    useEffect(() => {
        announcedAt.current = Date.now();
    }, []);

    useEffect(() => {
        if (message === announced) {
            return undefined;
        }

        const timer = setTimeout(
            () => {
                announcedAt.current = Date.now();
                setAnnounced(message);
            },
            Math.max(0, announcedAt.current + ANNOUNCE_EVERY_MS - Date.now()),
        );

        return () => clearTimeout(timer);
    }, [message, announced]);

    return announced;
};

const ToolProgressRow: FC<{ entry: ToolProgressEntry }> = memo(({ entry }) => {
    const { t } = useLingui();
    const fraction = progressFraction(entry);
    const announced = useAnnouncedMessage(entry.message);
    const { serverName, toolName } = entry;

    return (
        <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/50" data-testid="tool-progress-row">
            <div className="flex items-center gap-2 p-3 pb-2 text-sm font-medium text-gray-800 dark:text-gray-200">
                <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
                <span className="font-mono">{toolName}</span>
                <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-900/50 dark:text-purple-300">
                    {serverName}
                </span>
            </div>
            <div className="flex flex-col gap-1.5 px-3 pb-3">
                <Progress aria-label={t`Progress of ${toolName}`} value={fraction === undefined ? null : Math.round(fraction * 100)}>
                    <ProgressTrack>
                        <ProgressIndicator className="data-indeterminate:w-full data-indeterminate:animate-pulse motion-reduce:animate-none" />
                    </ProgressTrack>
                </Progress>
                <p className="text-muted-foreground min-h-4 text-xs wrap-break-word">{entry.message}</p>
                <span aria-live="polite" className="sr-only" role="status">
                    {announced}
                </span>
            </div>
        </div>
    );
});

ToolProgressRow.displayName = "ToolProgressRow";

export const ToolProgressRows: FC<{ state: ToolProgressState }> = ({ state }) => {
    if (state.length === 0) {
        return null;
    }

    return (
        <div className="mt-2">
            {state.map((entry) => (
                <ToolProgressRow entry={entry} key={entry.toolCallId} />
            ))}
        </div>
    );
};
