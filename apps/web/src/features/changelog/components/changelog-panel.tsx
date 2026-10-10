"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@neore/ui/components/sheet";
import cn from "@neore/ui/utils/cn";
import { formatDate } from "@neore/ui/utils/locale-format";
import { ExternalLink, Sparkles } from "lucide-react";
import type { FC } from "react";

import useChangelog from "@/features/changelog/hooks/use-changelog";
import useChangelogStore from "@/features/changelog/stores/changelog-store";
import type { ChangelogEntry } from "@/features/changelog/types";

const DATE_OPTIONS: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };

interface ChangelogEntryViewProps {
    entry: ChangelogEntry;
    isUnread: boolean;
    onView: (id: string) => void;
}

const ChangelogEntryView: FC<ChangelogEntryViewProps> = ({ entry, isUnread, onView }) => {
    const { i18n, t } = useLingui();
    const handleClick = () => onView(entry.id);

    return (
        <article
            className={cn("group flex flex-col gap-3 border-b p-4 transition-colors last:border-b-0", isUnread ? "bg-primary/[0.03]" : "hover:bg-muted/40")}
            onClick={handleClick}
        >
            {entry.featuredImage && <img alt={entry.title} className="h-36 w-full rounded-md object-cover" loading="lazy" src={entry.featuredImage} />}

            <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                        {isUnread && <span className="bg-primary size-1.5 rounded-full" />}
                        {entry.categories.map((cat) => (
                            <Badge className="h-4 px-1.5 text-[10px]" key={cat.name} variant="secondary">
                                {cat.name}
                            </Badge>
                        ))}
                    </div>
                    <h3 className="text-foreground text-sm leading-snug font-medium">{entry.title}</h3>
                    <time className="text-muted-foreground text-[11px]" dateTime={entry.date}>
                        {formatDate(entry.date, i18n.locale, DATE_OPTIONS)}
                    </time>
                </div>

                <a
                    aria-label={t`Open full changelog`}
                    className="text-muted-foreground hover:text-foreground mt-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                    href={entry.url}
                    onClick={(e) => e.stopPropagation()}
                    rel="noopener noreferrer"
                    target="_blank"
                >
                    <ExternalLink className="size-3.5" />
                </a>
            </div>

            {/*
             * HTML content is authored and served by Featurebase (our own account).
             * It is not user-generated input and is not rendered during SSR
             * (component is lazy-loaded in __root.tsx behind a Suspense boundary).
             */}
            <div
                className="prose prose-xs dark:prose-invert prose-p:my-1 prose-headings:font-medium prose-headings:text-foreground max-w-none text-xs leading-relaxed [&_img]:my-2 [&_img]:rounded-md"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: entry.content }}
            />
        </article>
    );
};

const ChangelogPanel: FC = () => {
    const { t } = useLingui();
    const { close, isOpen } = useChangelogStore();
    const { changelogs, isLoading, markAllAsViewed, markAsViewed, viewedIds } = useChangelog();

    const handleOpenChange = (open: boolean) => {
        if (open) {
            return;
        }

        markAllAsViewed();
        close();
    };

    return (
        <Sheet onOpenChange={handleOpenChange} open={isOpen}>
            <SheetContent className="flex flex-col gap-0 p-0 sm:max-w-md" showCloseButton side="right">
                <SheetHeader className="border-b px-4 py-3">
                    <div className="flex items-center gap-2">
                        <Sparkles className="text-primary size-4" strokeWidth={1.5} />
                        <SheetTitle className="text-sm font-semibold">{t`What's New`}</SheetTitle>
                    </div>
                </SheetHeader>

                <div className="flex-1 overflow-y-auto">
                    {isLoading && changelogs.length === 0 && (
                        <div className="text-muted-foreground flex h-40 items-center justify-center text-xs">{t`Loading...`}</div>
                    )}

                    {!isLoading && changelogs.length === 0 && (
                        <div className="text-muted-foreground flex h-40 items-center justify-center text-xs">{t`No updates yet.`}</div>
                    )}

                    {changelogs.map((entry) => (
                        <ChangelogEntryView entry={entry} isUnread={!viewedIds.has(entry.id)} key={entry.id} onView={markAsViewed} />
                    ))}
                </div>
            </SheetContent>
        </Sheet>
    );
};

export default ChangelogPanel;
