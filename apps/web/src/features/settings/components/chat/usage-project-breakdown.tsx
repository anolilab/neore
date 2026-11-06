import { useLingui } from "@lingui/react/macro";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import { BACKFILL_REFETCH_MS, useRefetchAfterBackfill } from "../../hooks/use-usage-backfill";
import { formatUsd, localDayKey, periodStart } from "../../lib/usage-activity";

/** The row key of what no project accounts for; never a project id. */
const NO_PROJECT_KEY = "__no_project__";

interface UsageProjectBreakdownProps {
    /** Earlier replies are still being added to the rollup (`useUsageBackfill`). */
    backfilling: boolean;
    /** The usage page's selected window, in days. */
    days: number;
}

interface ProjectRow {
    costMicrodollars: number;
    key: string;
    label: string;
    replies: number;
    tokens: number;
}

const formatTokens = (count: number, locale: string): string => new Intl.NumberFormat(locale, { maximumFractionDigits: 1, notation: "compact" }).format(count);

/**
 * The caller's replies, tokens and spend per project over the page's selected
 * window, with what no project accounts for: the rows add up to the total.
 */
const UsageProjectBreakdown: FC<UsageProjectBreakdownProps> = ({ backfilling, days }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const [today] = useState(() => localDayKey(new Date()));
    const locale = i18n.locale || "en";
    const fromDate = periodStart(today, days);

    const mine = useQuery({
        ...crpc.usage.activity.getProjectBreakdown.queryOptions({ fromDate }, { live: false }),
        refetchInterval: backfilling ? BACKFILL_REFETCH_MS : false,
    });

    useRefetchAfterBackfill(backfilling, mine.refetch);

    let rows: ProjectRow[] = [];

    if (mine.data) {
        rows = mine.data.projects.map((project) => {
            return { ...project, key: project.projectKey, label: project.title ?? t`Project no longer available` };
        });

        if (mine.data.noProject.replies > 0 || mine.data.noProject.costMicrodollars > 0) {
            rows.push({ ...mine.data.noProject, key: NO_PROJECT_KEY, label: t`No project` });
        }
    }

    const totalCost = rows.reduce((sum, row) => sum + row.costMicrodollars, 0);
    const truncated = mine.data?.truncated;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <FolderKanban aria-hidden="true" className="size-4" />
                    {t`Usage by project`}
                </CardTitle>
                <CardDescription>{t`Replies, tokens and spend per project for the selected period`}</CardDescription>
            </CardHeader>
            <CardContent>
                {mine.isPending && (
                    <div className="space-y-2">
                        {[1, 2, 3].map((index) => (
                            <Skeleton className="h-10 w-full" key={index} />
                        ))}
                    </div>
                )}
                {mine.isError && <p className="text-destructive text-sm">{t`Could not load the project breakdown.`}</p>}
                {!mine.isPending && !mine.isError && rows.length === 0 && (
                    <p className="text-muted-foreground py-4 text-center text-sm">{t`No replies recorded for this period.`}</p>
                )}
                {!mine.isPending && !mine.isError && rows.length > 0 && (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t`Project`}</TableHead>
                                <TableHead className="text-right">{t`Replies`}</TableHead>
                                <TableHead className="text-right">{t`Tokens`}</TableHead>
                                <TableHead className="text-right">{t`Spend`}</TableHead>
                                <TableHead className="w-1/4">
                                    <span className="sr-only">{t`Share of spend`}</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row) => {
                                const share = totalCost > 0 ? row.costMicrodollars / totalCost : 0;
                                const percent = Math.round(share * 100);

                                return (
                                    <TableRow key={row.key}>
                                        <TableCell className={row.key === NO_PROJECT_KEY ? "text-muted-foreground font-medium" : "font-medium"}>
                                            {row.label}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">{row.replies.toLocaleString(locale)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{formatTokens(row.tokens, locale)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{formatUsd(row.costMicrodollars, locale)}</TableCell>
                                        <TableCell>
                                            <div
                                                aria-label={t`${String(percent)}% of spend`}
                                                aria-valuemax={100}
                                                aria-valuemin={0}
                                                aria-valuenow={percent}
                                                className="bg-muted h-2 overflow-hidden rounded-full"
                                                role="meter"
                                            >
                                                <div className="bg-chart-4 dark:bg-chart-3 h-full" style={{ width: `${String(share * 100)}%` }} />
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                )}
                {truncated && <p className="text-muted-foreground mt-2 text-xs">{t`Only part of this period is included.`}</p>}
            </CardContent>
        </Card>
    );
};

export default UsageProjectBreakdown;
