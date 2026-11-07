import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Label } from "@neore/ui/components/label";
import { Skeleton } from "@neore/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { BACKFILL_REFETCH_MS, useRefetchAfterBackfill, useUsageBackfill } from "@/features/settings/hooks/use-usage-backfill";
import { formatUsd, localDayKey, periodStart } from "@/features/settings/lib/usage-activity";
import { useCRPC } from "@/lib/lunora/crpc";

/** The window the project's totals cover, in days. */
const WINDOW_DAYS = 30;

interface ProjectUsageSummaryProps {
    projectId: string;
}

/** The caller's replies, tokens and spend in one project over the last 30 days. */
const ProjectUsageSummary = ({ projectId }: ProjectUsageSummaryProps) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const [today] = useState(() => localDayKey(new Date()));
    const locale = i18n.locale || "en";
    // Earlier replies are filed under their projects by the usage backfill: start it if it has not run, and read again as it goes.
    const { projectsBackfilling: backfilling } = useUsageBackfill();
    const { data, isError, isPending, refetch } = useQuery({
        ...crpc.usage.activity.getProjectUsage.queryOptions(
            // The dialog receives `_id` as a plain `string`; it is always an id the backend returned for a `projects` row.
            { fromDate: periodStart(today, WINDOW_DAYS), projectId: projectId as Id<"projects"> },
            { live: false },
        ),
        refetchInterval: backfilling ? BACKFILL_REFETCH_MS : false,
    });

    useRefetchAfterBackfill(backfilling, refetch);

    const stats = [
        { label: t`Replies`, value: data ? data.replies.toLocaleString(locale) : undefined },
        {
            label: t`Tokens`,
            value: data ? new Intl.NumberFormat(locale, { maximumFractionDigits: 1, notation: "compact" }).format(data.tokens) : undefined,
        },
        { label: t`Spend`, value: data ? formatUsd(data.costMicrodollars, locale) : undefined },
    ];

    return (
        <section aria-labelledby="project-usage-label" className="bg-muted/30 space-y-3 rounded-lg border p-4">
            <div className="space-y-1">
                <Label className="text-sm font-medium" id="project-usage-label">{t`Usage`}</Label>
                <p className="text-muted-foreground text-xs">{t`Your replies, tokens and spend in this project over the last 30 days.`}</p>
            </div>
            {isError && <p className="text-destructive text-sm">{t`Could not load this project's usage.`}</p>}
            {!isError && (
                <dl className="grid grid-cols-3 gap-4">
                    {stats.map((stat) => (
                        <div key={stat.label}>
                            <dt className="text-muted-foreground text-xs">{stat.label}</dt>
                            <dd className="mt-1 text-lg font-semibold tabular-nums">{isPending ? <Skeleton className="h-6 w-16" /> : stat.value}</dd>
                        </div>
                    ))}
                </dl>
            )}
        </section>
    );
};

export default ProjectUsageSummary;
