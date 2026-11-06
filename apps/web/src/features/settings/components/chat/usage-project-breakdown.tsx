import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import { useQuery } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import { useActiveOrganization, useHasPermission } from "@/features/auth/hooks/organization-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useAction, useCRPC } from "@/lib/lunora/crpc";

import { BACKFILL_REFETCH_MS, useRefetchAfterBackfill } from "../../hooks/use-usage-backfill";
import { formatUsd, localDayKey, periodStart } from "../../lib/usage-activity";
import { sumOrganizationUsage } from "../../lib/usage-organization";

/** The row key of what no project accounts for; never a project id. */
const NO_PROJECT_KEY = "__no_project__";

type Scope = "mine" | "organization";

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
 * Replies, tokens and spend per project over the page's selected window: the
 * caller's own, with what no project accounts for, and — for an organization's
 * admins — the active organization's projects summed over its members.
 */
const UsageProjectBreakdown: FC<UsageProjectBreakdownProps> = ({ backfilling, days }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const { authClient } = useAuth();
    const [today] = useState(() => localDayKey(new Date()));
    const [scope, setScope] = useState<Scope>("mine");
    const locale = i18n.locale || "en";
    const fromDate = periodStart(today, days);

    // Organization admins and owners can update it; members cannot.
    const { data: permission } = useHasPermission(authClient, { permissions: { organization: ["update"] } });
    const { data: activeOrganization } = useActiveOrganization(authClient);
    const organizationId: string | undefined = activeOrganization?.id;
    const isOrganizationAdmin = permission?.success === true && organizationId !== undefined;
    const showing: Scope = isOrganizationAdmin ? scope : "mine";

    const mine = useQuery({
        ...crpc.usage.activity.getProjectBreakdown.queryOptions({ fromDate }, { live: false }),
        enabled: showing === "mine",
        refetchInterval: backfilling ? BACKFILL_REFETCH_MS : false,
    });

    useRefetchAfterBackfill(backfilling, mine.refetch);

    const fetchOrganization = useAction(api.usage.organization.getOrganizationProjectUsage);
    const organization = useQuery({
        enabled: showing === "organization" && organizationId !== undefined,
        queryFn: async () => await sumOrganizationUsage(async (afterUserId) => await fetchOrganization({ afterUserId, fromDate })),
        // Keyed by the organization too: switching organizations must not show the last one's totals.
        queryKey: ["usage", "organization-projects", organizationId, fromDate],
        retry: 1,
        staleTime: 2 * 60_000,
    });

    const active = showing === "mine" ? mine : organization;
    let rows: ProjectRow[] = [];

    if (showing === "mine" && mine.data) {
        rows = mine.data.projects.map((project) => {
            return { ...project, key: project.projectKey, label: project.title ?? t`Project no longer available` };
        });

        if (mine.data.noProject.replies > 0 || mine.data.noProject.costMicrodollars > 0) {
            rows.push({ ...mine.data.noProject, key: NO_PROJECT_KEY, label: t`No project` });
        }
    }

    if (showing === "organization" && organization.data) {
        rows = organization.data.projects.map((project) => {
            return { ...project, key: project.projectKey, label: project.title };
        });
    }

    const totalCost = rows.reduce((sum, row) => sum + row.costMicrodollars, 0);
    const truncated = showing === "mine" ? mine.data?.truncated : organization.data?.truncated;

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <FolderKanban aria-hidden="true" className="size-4" />
                            {t`Usage by project`}
                        </CardTitle>
                        <CardDescription>
                            {showing === "mine"
                                ? t`Replies, tokens and spend per project for the selected period`
                                : t`Your organization's projects, summed over every member, for the selected period`}
                        </CardDescription>
                    </div>
                    {isOrganizationAdmin && (
                        <ToggleGroup
                            aria-label={t`Whose usage`}
                            className="gap-1"
                            onValueChange={(value) => {
                                const next = value?.[0];

                                if (next === "mine" || next === "organization") {
                                    setScope(next);
                                }
                            }}
                            size="sm"
                            value={[showing]}
                            variant="outline"
                        >
                            <ToggleGroupItem value="mine">{t`Mine`}</ToggleGroupItem>
                            <ToggleGroupItem value="organization">{t`Organization`}</ToggleGroupItem>
                        </ToggleGroup>
                    )}
                </div>
            </CardHeader>
            <CardContent>
                {active.isPending && (
                    <div className="space-y-2">
                        {[1, 2, 3].map((index) => (
                            <Skeleton className="h-10 w-full" key={index} />
                        ))}
                    </div>
                )}
                {active.isError && <p className="text-destructive text-sm">{t`Could not load the project breakdown.`}</p>}
                {!active.isPending && !active.isError && rows.length === 0 && (
                    <p className="text-muted-foreground py-4 text-center text-sm">{t`No replies recorded for this period.`}</p>
                )}
                {!active.isPending && !active.isError && rows.length > 0 && (
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
