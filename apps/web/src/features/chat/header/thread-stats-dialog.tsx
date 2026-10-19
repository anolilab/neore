"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@neore/ui/components/dialog";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { skipToken, useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { useMemo } from "react";

import { toUIMessages } from "@/lib/agent";
import { useCRPC } from "@/lib/lunora/crpc";

import { formatCostUsd } from "../thread/format-cost";
import { countReplies, distinctModels, summarizeThreadStats } from "./thread-stats";

interface ThreadStatsDialogProps {
    model: string;
    onOpenChange: (open: boolean) => void;
    open: boolean;
    threadId: string;
}

/**
 * Thread-wide totals ("stats for nerds"). Reads the whole thread through the same
 * export query the download menu uses, so it covers every reply on every branch
 * rather than the messages currently paged in. Loads only while open.
 */
const ThreadStatsDialog: FC<ThreadStatsDialogProps> = ({ model, onOpenChange, open, threadId }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();

    const { data, isError, isPending } = useQuery(
        crpc.chat.functions.getFullThreadForExport.queryOptions(open ? { model, threadId: threadId as Id<"threads"> } : skipToken, { live: false }),
    );

    const stats = useMemo(() => {
        if (!data) {
            return undefined;
        }

        // A child thread's rows include its parent's prefix; those belong to the parent.
        const rows = data.messages as unknown as Parameters<typeof toUIMessages>[0];
        const own = rows.filter((row) => String(row.threadId) === threadId);

        return { ...summarizeThreadStats(toUIMessages(own)), models: distinctModels(own), replies: countReplies(own) };
    }, [data, threadId]);

    const { locale } = i18n;
    const none = "—";

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t`Thread statistics`}</DialogTitle>
                    <DialogDescription>{t`Totals across every reply in this thread, including regenerated alternatives.`}</DialogDescription>
                </DialogHeader>
                {isPending && !isError && (
                    <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
                        {t`Loading statistics…`}
                    </p>
                )}
                {isError && (
                    <p className="text-destructive text-sm" role="alert">
                        {t`Could not load statistics for this thread.`}
                    </p>
                )}
                {stats && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm tabular-nums">
                        <dt className="text-muted-foreground">{t`Replies`}</dt>
                        <dd>{formatNumber(stats.replies, locale)}</dd>
                        <dt className="text-muted-foreground">{t`Input tokens`}</dt>
                        <dd>{formatNumber(stats.inputTokens, locale)}</dd>
                        <dt className="text-muted-foreground">{t`Output tokens`}</dt>
                        <dd>{formatNumber(stats.outputTokens, locale)}</dd>
                        <dt className="text-muted-foreground">{t`Average speed`}</dt>
                        <dd>
                            {stats.averageTokensPerSecond === undefined
                                ? none
                                : t`${formatNumber(Math.round(stats.averageTokensPerSecond * 10) / 10, locale)} tok/s`}
                        </dd>
                        <dt className="text-muted-foreground">{t`Estimated cost`}</dt>
                        <dd>
                            {stats.cost === undefined ? (
                                none
                            ) : (
                                <>
                                    {stats.costIsPartial ? "≥ " : ""}
                                    {formatCostUsd(stats.cost.microdollars)}
                                    {stats.unpricedReplies > 0 && (
                                        <span className="text-muted-foreground block text-xs">{t`+ unpriced replies, not counted in this total`}</span>
                                    )}
                                    {stats.cost.byok && (
                                        <span className="text-muted-foreground block text-xs">{t`Includes replies billed to your own API key.`}</span>
                                    )}
                                </>
                            )}
                        </dd>
                        <dt className="text-muted-foreground">{t`Models`}</dt>
                        <dd>{stats.models.length > 0 ? stats.models.join(", ") : none}</dd>
                    </dl>
                )}
            </DialogContent>
        </Dialog>
    );
};

export default ThreadStatsDialog;
