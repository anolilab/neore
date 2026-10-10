import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { isThisWeek, isToday, isYesterday } from "date-fns";
import { Loader2, PlusIcon } from "lucide-react";

import type { Thread } from "../types/thread";
import cn from "../utils/cn";
import ThreadItem from "./thread-item";

interface ThreadListProps {
    hasMore?: boolean;
    isLoading?: boolean;
    onArchiveThread?: (threadId: string) => void;
    onCreateThread: () => void;
    onDeleteThread?: (threadId: string) => void;
    onLoadMore?: () => void;
    onPinThread?: (threadId: string) => void;
    onSelect: (threadId: string) => void;
    selectedId?: string;
    threads: Thread[];
}

type DateGroup = "older" | "this-week" | "today" | "yesterday";

const getDateGroup = (creationTime: number): DateGroup => {
    const date = new Date(creationTime);

    if (isToday(date)) {
        return "today";
    }

    if (isYesterday(date)) {
        return "yesterday";
    }

    if (isThisWeek(date)) {
        return "this-week";
    }

    return "older";
};

const GROUP_LABELS: Record<DateGroup, MessageDescriptor> = {
    older: msg`Older`,
    "this-week": msg`This Week`,
    today: msg`Today`,
    yesterday: msg`Yesterday`,
};

const GROUP_ORDER: DateGroup[] = ["today", "yesterday", "this-week", "older"];

const SKELETON_ROWS = ["row-1", "row-2", "row-3", "row-4", "row-5", "row-6"];

const LoadingSkeleton = () => {
    const { t } = useLingui();

    return (
        <div aria-busy="true" aria-label={t`Loading threads`} className="flex flex-col gap-1 px-1">
            {SKELETON_ROWS.map((rowKey) => (
                <div className="flex animate-pulse flex-col gap-1.5 rounded-lg px-2 py-2" key={rowKey}>
                    <div className="h-3.5 w-3/4 rounded bg-gray-200 dark:bg-gray-700" />
                    <div className="h-2.5 w-1/3 rounded bg-gray-100 dark:bg-gray-800" />
                </div>
            ))}
        </div>
    );
};

const ThreadList = ({
    hasMore = false,
    isLoading = false,
    onArchiveThread,
    onCreateThread,
    onDeleteThread,
    onLoadMore,
    onPinThread,
    onSelect,
    selectedId,
    threads,
}: ThreadListProps) => {
    const { i18n, t } = useLingui();
    // Group threads by date
    const grouped = new Map<DateGroup, Thread[]>();

    for (const group of GROUP_ORDER) {
        grouped.set(group, []);
    }

    for (const thread of threads) {
        const group = getDateGroup(thread._creationTime);

        grouped.get(group)!.push(thread);
    }

    const isEmpty = isLoading && threads.length === 0;

    return (
        <div className="flex h-full flex-col">
            {/* New Chat button */}
            <div className="shrink-0 p-2">
                <button
                    className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium",
                        "bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800",
                        "focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:outline-none",
                        "transition-colors",
                    )}
                    onClick={onCreateThread}
                    type="button"
                >
                    <PlusIcon aria-hidden="true" className="size-4" />
                    {t`New Chat`}
                </button>
            </div>

            {/* Thread groups */}
            <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
                {isEmpty && <LoadingSkeleton />}

                {!isEmpty && threads.length === 0 && (
                    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                        <p className="text-sm text-gray-500 dark:text-gray-400">{t`No conversations yet`}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{t`Start a new chat to get started`}</p>
                    </div>
                )}

                {!isEmpty && threads.length > 0 && (
                    <>
                        {GROUP_ORDER.map((group) => {
                            const groupThreads = grouped.get(group)!;

                            if (groupThreads.length === 0) {
                                return null;
                            }

                            return (
                                <div className="mb-3" key={group}>
                                    <div className="mb-1 px-2 py-1">
                                        <span className="text-[11px] font-semibold tracking-wider text-gray-400 uppercase dark:text-gray-500">
                                            {i18n._(GROUP_LABELS[group])}
                                        </span>
                                    </div>
                                    <div className="flex flex-col gap-0.5">
                                        {groupThreads.map((thread) => (
                                            <ThreadItem
                                                isSelected={thread._id === selectedId}
                                                key={thread._id}
                                                onArchive={onArchiveThread ? () => onArchiveThread(thread._id) : undefined}
                                                onDelete={onDeleteThread ? () => onDeleteThread(thread._id) : undefined}
                                                onPin={onPinThread ? () => onPinThread(thread._id) : undefined}
                                                onSelect={() => onSelect(thread._id)}
                                                thread={thread}
                                            />
                                        ))}
                                    </div>
                                </div>
                            );
                        })}

                        {/* Load more */}
                        {hasMore && (
                            <div className="px-2 pt-1">
                                <button
                                    className={cn(
                                        "flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium",
                                        "text-gray-500 hover:bg-gray-100 hover:text-gray-700",
                                        "dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200",
                                        "focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none",
                                        "transition-colors",
                                    )}
                                    onClick={onLoadMore}
                                    type="button"
                                >
                                    {isLoading ? (
                                        <>
                                            <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                                            {t`Loading...`}
                                        </>
                                    ) : (
                                        t`Load more`
                                    )}
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default ThreadList;
