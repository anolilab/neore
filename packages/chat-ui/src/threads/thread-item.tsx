import { useLingui } from "@lingui/react/macro";
import formatTimeAgo from "@neore/ui/utils/relative-time";
import { Hash, Pin, Trash2 } from "lucide-react";
import { useState } from "react";

import type { Thread } from "../types/thread";
import cn from "../utils/cn";

interface ThreadItemProps {
    isSelected?: boolean;
    onArchive?: () => void;
    onDelete?: () => void;
    onPin?: () => void;
    onSelect: () => void;
    thread: Thread;
}

const SOURCE_LABELS: Record<string, string> = {
    discord: "Discord",
    slack: "Slack",
    telegram: "Telegram",
};

const SOURCE_COLORS: Record<string, string> = {
    discord: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
    slack: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
    telegram: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
};

const SourceBadge = ({ source }: { source: string }) => {
    const label = SOURCE_LABELS[source] ?? source;
    const colorClass = SOURCE_COLORS[source] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";

    return (
        <span className={cn("inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] leading-none font-medium", colorClass)}>
            <Hash aria-hidden="true" className="size-2.5" />
            {label}
        </span>
    );
};

const ThreadItem = ({ isSelected = false, onArchive, onDelete, onPin, onSelect, thread }: ThreadItemProps) => {
    const { i18n, t } = useLingui();
    const [isHovered, setIsHovered] = useState(false);

    const title = thread.title || t`New Chat`;
    const relativeTime = formatTimeAgo(thread._creationTime, i18n.locale);
    const isPinned = thread.pinnedAt !== undefined;
    const source = thread.source && thread.source !== null ? thread.source : undefined;

    const hasActions = !!(onDelete || onArchive || onPin);

    return (
        <div
            className={cn(
                "group relative flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors",
                isSelected
                    ? "bg-blue-50 text-blue-900 dark:bg-blue-950/40 dark:text-blue-100"
                    : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800/60",
            )}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            {/* Clickable main area */}
            <button aria-current={isSelected ? "page" : undefined} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left" onClick={onSelect} type="button">
                <div className="flex min-w-0 items-center gap-1.5">
                    {isPinned && <Pin aria-hidden="true" className="size-3 shrink-0 text-amber-500 dark:text-amber-400" />}
                    <span className="truncate text-sm leading-snug font-medium">{title}</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-400 dark:text-gray-500">{relativeTime}</span>
                    {source && <SourceBadge source={source} />}
                </div>
            </button>

            {/* Action buttons — visible on hover when not selected or always when selected+hovered */}
            {hasActions && isHovered && (
                <div className="flex shrink-0 items-center gap-0.5">
                    {onPin && (
                        <button
                            aria-label={isPinned ? t`Unpin thread` : t`Pin thread`}
                            className={cn(
                                "flex size-6 items-center justify-center rounded text-gray-400 transition-colors",
                                "hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200",
                                isPinned && "text-amber-500 dark:text-amber-400",
                            )}
                            onClick={(event) => {
                                event.stopPropagation();
                                onPin();
                            }}
                            type="button"
                        >
                            <Pin aria-hidden="true" className="size-3.5" />
                        </button>
                    )}
                    {onArchive && (
                        <button
                            aria-label={t`Archive thread`}
                            className="flex size-6 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                            onClick={(event) => {
                                event.stopPropagation();
                                onArchive();
                            }}
                            type="button"
                        >
                            {/* Archive icon (inbox-arrow-down style) */}
                            <svg aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                                <path
                                    d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 14.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-6.586L3.293 6.707A1 1 0 013 6V4z"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                            </svg>
                        </button>
                    )}
                    {onDelete && (
                        <button
                            aria-label={t`Delete thread`}
                            className="flex size-6 items-center justify-center rounded text-gray-400 transition-colors hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/40 dark:hover:text-red-400"
                            onClick={(event) => {
                                event.stopPropagation();
                                onDelete();
                            }}
                            type="button"
                        >
                            <Trash2 aria-hidden="true" className="size-3.5" />
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export default ThreadItem;
