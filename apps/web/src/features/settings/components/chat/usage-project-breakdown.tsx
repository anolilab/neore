import { useLingui } from "@lingui/react/macro";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { skipToken, useQuery } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import type { FC } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import { BACKFILL_REFETCH_MS, useRefetchAfterBackfill } from "../../hooks/use-usage-backfill";
import { keepAcrossDayTurn, useUsageToday } from "../../hooks/use-usage-today";
import { formatUsd, periodStart } from "../../lib/usage-activity";

/** The row key of what no project accounts for; never a project id. */
const NO_PROJECT_KEY = "__no_project__";

/** The row key of the projects past the ones listed by name; never a project id. */
const OTHER_PROJECTS_KEY = "__other_projects__";

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
 * window, with what no project accounts for: the parts add up to the total.
 */
const UsageProjectBreakdown: FC<UsageProjectBreakdownProps> = ({ backfilling, days }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const { failed: zoneFailed, today, zone } = useUsageToday();
    const locale = i18n.locale || "en";
    const breakdownQuery = crpc.usage.activity.getProjectBreakdown.queryOptions(today === undefined ? skipToken : { fromDate: periodStart(today, days) }, {
        live: false,
    });
    const mine = useQuery({
        ...keepAcrossDayTurn(breakdownQuery, `projects:${zone}:${String(days)}`),
        refetchInterval: backfilling ? BACKFILL_REFETCH_MS : false,
    });

    useRefetchAfterBackfill(backfilling, mine.refetch, today !== undefined);

    const rows: ProjectRow[] = (mine.data?.projects ?? []).map((project) => {
        return { ...project, key: project.projectKey, label: project.title ?? t`Project no longer available` };
    });

    if (mine.data?.otherProjects) {
        rows.push({ ...mine.data.otherProjects, key: OTHER_PROJECTS_KEY, label: t`Other projects` });
    }

    if (mine.data && (mine.data.noProject.replies > 0 || mine.data.noProject.costMicrodollars > 0)) {
        rows.push({ ...mine.data.noProject, key: NO_PROJECT_KEY, label: t`No project` });
    }

    const isError = mine.isError || zoneFailed;
    const isPending = mine.isPending && !zoneFailed;
    const totalCost = rows.reduce((sum, row) => sum + row.costMicrodollars, 0);
    const truncated = mine.data?.truncated === true;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <FolderKanban aria-hidden="true" className="size-4" />
                    {t`Usage by project`}
                </CardTitle>
                <CardDescription>{t`Replies, tokens and spend per project for the selected period`}</CardDescription>
            </CardHeader>
            <CardContent aria-busy={isPending}>
                {isPending && (
                    <div className="space-y-2" role="status">
                        <span className="sr-only">{t`Loading usage…`}</span>
                        {[1, 2, 3].map((index) => (
                            <Skeleton className="h-10 w-full" key={index} />
                        ))}
                    </div>
                )}
                {isError && (
                    <p className="text-destructive text-sm" role="alert">
                        {t`Could not load the project breakdown.`}
                    </p>
                )}
                {!isPending && !isError && rows.length === 0 && (
                    <p className="text-muted-foreground py-4 text-center text-sm">{t`No replies recorded for this period.`}</p>
                )}
                {!isPending && !isError && rows.length > 0 && (
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
                                const project = row.label;

                                return (
                                    <TableRow key={row.key}>
                                        <TableHead
                                            className={row.key === NO_PROJECT_KEY || row.key === OTHER_PROJECTS_KEY ? "text-muted-foreground" : undefined}
                                            scope="row"
                                        >
                                            {row.label}
                                        </TableHead>
                                        <TableCell className="text-right tabular-nums">{row.replies.toLocaleString(locale)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{formatTokens(row.tokens, locale)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{formatUsd(row.costMicrodollars, locale)}</TableCell>
                                        <TableCell>
                                            <div
                                                aria-label={t`${project}: ${String(percent)}% of spend`}
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
