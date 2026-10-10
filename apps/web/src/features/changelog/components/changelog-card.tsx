"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { formatDate } from "@neore/ui/utils/locale-format";
import { X } from "lucide-react";
import type { FC } from "react";
import { useCallback } from "react";

import useChangelog from "@/features/changelog/hooks/use-changelog";
import useChangelogStore from "@/features/changelog/stores/changelog-store";

/**
 * Floating card in the bottom-left corner that surfaces the latest unread
 * changelog entry. Appears only when there is at least one unread update.
 */
const ChangelogCard: FC = () => {
    const { i18n, t } = useLingui();
    const { latestUnread, markAsViewed } = useChangelog();
    const openPanel = useChangelogStore((s) => s.open);

    const handleOpen = useCallback(() => {
        openPanel();
    }, [openPanel]);

    const handleDismiss = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();

            if (latestUnread) {
                markAsViewed(latestUnread.id);
            }
        },
        [latestUnread, markAsViewed],
    );

    if (!latestUnread) {
        return null;
    }

    return (
        <div
            className={cn(
                "ring-border bg-popover text-popover-foreground group fixed bottom-4 z-40 flex w-72 flex-col gap-2 rounded-xl p-3 text-left shadow-lg ring-1 transition-shadow hover:shadow-xl",
                // Offset from the left to sit beside the sidebar shortcut (w-16 = 64px)
                "left-[72px]",
            )}
        >
            {/* Stretched overlay carrying the card's own action */}
            <button
                aria-label={t`View latest update: ${latestUnread.title}`}
                className="absolute inset-0 z-10 cursor-pointer rounded-xl"
                onClick={handleOpen}
                type="button"
            />

            {/* Dismiss button */}
            <button
                aria-label={t`Dismiss`}
                className="text-muted-foreground hover:text-foreground absolute top-2.5 right-2.5 z-20 rounded-sm opacity-0 transition-opacity group-hover:opacity-100"
                onClick={handleDismiss}
                type="button"
            >
                <X className="size-3.5" />
            </button>

            {/* Featured image */}
            {latestUnread.featuredImage && <img alt={latestUnread.title} className="h-28 w-full rounded-lg object-cover" src={latestUnread.featuredImage} />}

            <div className="flex flex-col gap-1 pr-5">
                {/* Category chips */}
                {latestUnread.categories.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                        {latestUnread.categories.map((cat) => (
                            <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium" key={cat.name}>
                                {cat.name}
                            </span>
                        ))}
                    </div>
                )}

                <p className="text-foreground line-clamp-2 text-xs leading-snug font-medium">{latestUnread.title}</p>

                <p className="text-muted-foreground text-[11px]">
                    {formatDate(latestUnread.date, i18n.locale, { day: "numeric", month: "short", year: "numeric" })}
                </p>
            </div>

            <p className="text-primary text-[11px] font-medium">{t`See what's new →`}</p>
        </div>
    );
};

export default ChangelogCard;
