"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Skeleton } from "@neore/ui/components/skeleton";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { ChevronLeft, ChevronRight, ImageOff, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { AdminFeedbackItem, FeedbackKind } from "../hooks/use-admin";
import { useAdminFeedback } from "../hooks/use-admin";
import { AdminSection } from "./admin-section";

/** One page of the list; the route loader preloads the first with the same size. */
export const FEEDBACK_PAGE_SIZE = 20;

const KIND_LABELS: Record<FeedbackKind, MessageDescriptor> = {
    idea: msg`Idea`,
    other: msg`Other`,
    problem: msg`Problem`,
};

const KIND_VARIANTS: Record<FeedbackKind, "default" | "destructive" | "secondary"> = {
    idea: "default",
    other: "secondary",
    problem: "destructive",
};

const FeedbackRow = ({ item }: { item: AdminFeedbackItem }) => {
    const { i18n, t } = useLingui();
    const { sender } = item;
    const senderName = sender.name || sender.email || sender.userId;
    const sentAt = formatDateTime(item.createdAt, i18n.locale);

    return (
        <li className="flex flex-col gap-3 py-4">
            <div className="flex flex-wrap items-center gap-3">
                <Avatar className="size-8">
                    <AvatarImage alt="" src={sender.image || undefined} />
                    <AvatarFallback name={senderName}>{senderName.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col">
                    {/* No email means no user row: the account is gone, and only its id is left to show. */}
                    <span className="truncate text-sm font-medium">{sender.email === null ? t`Deleted user` : sender.name || t`No name`}</span>
                    <span className="text-muted-foreground truncate text-xs">{sender.email ?? sender.userId}</span>
                </div>
                <Badge variant={KIND_VARIANTS[item.kind]}>{i18n._(KIND_LABELS[item.kind])}</Badge>
                <time className="text-muted-foreground font-mono text-xs" dateTime={new Date(item.createdAt).toISOString()}>
                    {sentAt}
                </time>
            </div>

            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{item.message}</p>

            {item.pagePath && (
                <p className="text-muted-foreground text-xs">
                    <Trans>
                        Sent from <code className="break-all">{item.pagePath}</code>
                    </Trans>
                </p>
            )}

            {item.images.length > 0 && (
                <ul aria-label={t`Attached images`} className="flex flex-wrap gap-2">
                    {item.images.map((image, index) => {
                        const position = index + 1;
                        const label = t`Image ${position} from ${senderName}`;

                        return (
                            // The images are the same order every time and carry no id of their own.
                            // eslint-disable-next-line react-x/no-array-index-key
                            <li key={index}>
                                {image.url ? (
                                    <a className="block" href={image.url} rel="noreferrer" target="_blank">
                                        <img alt={label} className="border-border/50 size-24 rounded-lg border object-cover" loading="lazy" src={image.url} />
                                    </a>
                                ) : (
                                    <div
                                        aria-label={t`Image ${position} could not be loaded`}
                                        className="text-muted-foreground border-border/50 flex size-24 items-center justify-center rounded-lg border"
                                        role="img"
                                    >
                                        <ImageOff aria-hidden="true" className="size-5" />
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </li>
    );
};

/** `/admin/feedback`: what users sent from "Send feedback", newest first, a page at a time. */
const FeedbackAdminPage = () => {
    const { t } = useLingui();
    const [kind, setKind] = useState<FeedbackKind | "all">("all");
    // The cursors of the pages before the current one; the last entry is the current page's own cursor.
    const [cursors, setCursors] = useState<(string | null)[]>([null]);
    const cursor = cursors.at(-1) ?? null;

    const { data, isFetching, isPending, refetch } = useAdminFeedback({ cursor, kind: kind === "all" ? undefined : kind, limit: FEEDBACK_PAGE_SIZE });

    const changeKind = (value: FeedbackKind | "all") => {
        setKind(value);
        setCursors([null]);
    };

    let body: React.ReactNode;

    if (isPending) {
        body = (
            <div aria-label={t`Loading feedback`} className="divide-border/50 divide-y px-4 py-1" role="status">
                {[1, 2, 3].map((index) => (
                    <div className="space-y-2 py-4" key={index}>
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="h-12 w-full" />
                    </div>
                ))}
            </div>
        );
    } else if (data === undefined) {
        // Only when there is nothing to show: a failed background read keeps the list it already has.
        body = (
            <p className="text-destructive py-8 text-center text-sm" role="alert">
                {t`Feedback could not be loaded.`}
            </p>
        );
    } else if (data.page.length === 0) {
        body = <p className="text-muted-foreground py-8 text-center text-sm">{kind === "all" ? t`No feedback yet` : t`No feedback of this kind`}</p>;
    } else {
        body = (
            <ul aria-label={t`Feedback`} className="divide-border/50 divide-y px-4 py-1">
                {data.page.map((item) => (
                    <FeedbackRow item={item} key={item._id} />
                ))}
            </ul>
        );
    }

    const nextCursor = data && !data.isDone ? data.continueCursor : null;

    return (
        <div className="flex flex-col gap-3">
            <AdminSection
                action={
                    <div className="flex flex-wrap items-center gap-2">
                        <Button onClick={() => refetch()} size="sm" variant="outline">
                            <RefreshCw aria-hidden="true" className={isFetching ? "size-4 animate-spin" : "size-4"} />
                            {t`Refresh`}
                        </Button>
                        <Select onValueChange={(value) => value && changeKind(value)} value={kind}>
                            <SelectTrigger aria-label={t`Filter by kind`} className="w-[180px]">
                                <SelectValue placeholder={t`Filter by kind`} />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">{t`All kinds`}</SelectItem>
                                <SelectItem value="idea">{t`Ideas`}</SelectItem>
                                <SelectItem value="problem">{t`Problems`}</SelectItem>
                                <SelectItem value="other">{t`Other`}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                }
                description={t`What users sent from the app, newest first`}
                title={t`Feedback`}
            >
                {body}
            </AdminSection>

            <nav aria-label={t`Feedback pages`} className="flex justify-end gap-2">
                <Button disabled={cursors.length <= 1} onClick={() => setCursors((previous) => previous.slice(0, -1))} size="sm" variant="outline">
                    <ChevronLeft aria-hidden="true" className="size-4" />
                    {t`Newer`}
                </Button>
                <Button
                    disabled={nextCursor === null}
                    onClick={() => {
                        if (nextCursor !== null) {
                            setCursors((previous) => [...previous, nextCursor]);
                        }
                    }}
                    size="sm"
                    variant="outline"
                >
                    {t`Older`}
                    <ChevronRight aria-hidden="true" className="size-4" />
                </Button>
            </nav>
        </div>
    );
};

export default FeedbackAdminPage;
