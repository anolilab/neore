import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import { skipToken, useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { useState } from "react";

import SettingsCard from "@/components/settings/settings-card";
import { useActiveOrganization, useHasPermission } from "@/features/auth/hooks/organization-management";
import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useAction, useCRPC } from "@/lib/lunora/crpc";

import { BACKFILL_REFETCH_MS, useRefetchAfterBackfill, useStaleAfterBackfill } from "../../hooks/use-usage-backfill";
import { keepAcrossDayTurn, useUsageToday } from "../../hooks/use-usage-today";
import { formatUsd, periodStart } from "../../lib/usage-activity";
import { organizationSinceOf, sumOrganizationUsage } from "../../lib/usage-organization";

/** The row key of what no project accounts for; never a project id. */
const NO_PROJECT_KEY = "__no_project__";

/** The row key of the projects past the ones listed by name; never a project id. */
const OTHER_PROJECTS_KEY = "__other_projects__";

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

const REMOVED_PROJECTS_KEY = "removed-projects";

const formatTokens = (count: number, locale: string): string => new Intl.NumberFormat(locale, { maximumFractionDigits: 1, notation: "compact" }).format(count);

/**
 * Replies, tokens and spend per project over the page's selected window: the caller's own, with what no project accounts for (the
 * parts add up to the total), and — for an organization's admins — the active organization's projects summed over its members.
 */
const UsageProjectBreakdown: FC<UsageProjectBreakdownProps> = ({ backfilling, days }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const { authClient } = useAuth();
    const { data: session } = useAuthSession();
    const { failed: zoneFailed, today, zone } = useUsageToday();
    const [scope, setScope] = useState<Scope>("mine");
    const locale = i18n.locale || "en";
    const fromDate = today === undefined ? undefined : periodStart(today, days);

    // Organization admins and owners can see the organization's projects; members see only their own. The permission is asked for the
    // active organization by id and keyed by it, so a result cached for another organization never grants the view here.
    const { data: activeOrganization } = useActiveOrganization(authClient);
    const organizationId: string | undefined = activeOrganization?.id;
    const { data: permission } = useHasPermission(
        authClient,
        { organizationId: organizationId ?? "", permissions: { organization: ["update"] } },
        { enabled: organizationId !== undefined },
    );
    const isOrganizationAdmin = permission?.success === true && organizationId !== undefined;
    const showing: Scope = isOrganizationAdmin ? scope : "mine";

    const breakdownQuery = crpc.usage.activity.getProjectBreakdown.queryOptions(today === undefined ? skipToken : { fromDate: periodStart(today, days) }, {
        live: false,
    });
    const mine = useQuery({
        ...keepAcrossDayTurn(breakdownQuery, `projects:${zone}:${String(days)}`),
        enabled: showing === "mine",
        refetchInterval: backfilling ? BACKFILL_REFETCH_MS : false,
    });

    useRefetchAfterBackfill(backfilling, mine.refetch, today !== undefined);

    const fetchOrganization = useAction(api.usage.organization.getOrganizationProjectUsage);
    // Keyed by the viewer and the organization: a total cached for another account or organization is never shown, whatever clears
    // the cache on a switch.
    const organizationKey = ["usage", "organization-projects", session?.user.id, organizationId, fromDate, zone];
    const organization = useQuery({
        enabled: showing === "organization" && organizationId !== undefined && fromDate !== undefined,
        queryFn: async () => {
            if (fromDate === undefined || organizationId === undefined) {
                throw new Error("The usage day or organization is not known yet");
            }

            // The chosen date's UTC midnight, not the viewer's: the view counts whole UTC weeks, and viewers in different zones who pick the
            // same date must read the same weeks.
            const since = organizationSinceOf(fromDate);

            return await sumOrganizationUsage(async (cursor) => await fetchOrganization({ cursor, organizationId, since }));
        },
        queryKey: organizationKey,
        retry: 1,
        staleTime: 2 * 60_000,
    });

    // Not polled while the walk runs (each read asks every member's shard). Once it is done the organization's totals are stale, so they
    // read again when the organization scope is next shown: a refetch now would run the walk while the page shows the personal scope.
    useStaleAfterBackfill(backfilling, organizationKey, today !== undefined);

    const active = showing === "mine" ? mine : organization;
    const rows: ProjectRow[] = [];

    if (showing === "mine") {
        const ownProjects = mine.data?.projects ?? [];

        for (const project of ownProjects) {
            rows.push({ ...project, key: project.projectKey, label: project.title ?? t`Project no longer available` });
        }

        if (mine.data?.otherProjects) {
            rows.push({ ...mine.data.otherProjects, key: OTHER_PROJECTS_KEY, label: t`Other projects` });
        }

        if (mine.data && (mine.data.noProject.replies > 0 || mine.data.noProject.costMicrodollars > 0)) {
            rows.push({ ...mine.data.noProject, key: NO_PROJECT_KEY, label: t`No project` });
        }
    } else {
        const organizationProjects = organization.data?.projects ?? [];

        for (const project of organizationProjects) {
            rows.push({ ...project, key: project.projectKey, label: project.title });
        }

        // Projects too few members of the view use to be named: folded into one total, under no project's name.
        if (organization.data?.small) {
            rows.push({ ...organization.data.small, key: OTHER_PROJECTS_KEY, label: t`Other projects` });
        }

        // Replies to projects the organization no longer has: their usage keeps counting, under no project's name.
        if (organization.data?.removed) {
            rows.push({ ...organization.data.removed, key: REMOVED_PROJECTS_KEY, label: t`Projects no longer in the organization` });
        }
    }

    const isError = active.isError || zoneFailed;
    const isPending = active.isPending && !zoneFailed;
    const totalCost = rows.reduce((sum, row) => sum + row.costMicrodollars, 0);
    const truncated = active.data?.truncated === true;

    return (
        <SettingsCard
            description={
                showing === "mine"
                    ? t`Replies, tokens and spend per project for the selected period`
                    : t`Your organization's projects, summed over every member, for the selected period`
            }
            title={t`Usage by project`}
        >
            {isOrganizationAdmin && (
                <div className="flex justify-end pt-3">
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
                </div>
            )}
            {showing === "organization" && (
                <p className="text-muted-foreground pt-3 text-xs">{t`Counted in whole weeks (Monday to Sunday, UTC) once each week has ended, so this week's usage shows next week.`}</p>
            )}
            <div aria-busy={isPending} className="py-3">
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
                                // The spoken share follows the locale's own percent format (its sign, spacing and digits).
                                const spendShare = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, style: "percent" }).format(share);
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
                                                aria-label={t`${project}: ${spendShare} of spend`}
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
                {truncated && (
                    <p className="text-muted-foreground mt-2 text-xs" role="status">
                        {t`Only part of this period is included.`}
                    </p>
                )}
            </div>
        </SettingsCard>
    );
};

export default UsageProjectBreakdown;
