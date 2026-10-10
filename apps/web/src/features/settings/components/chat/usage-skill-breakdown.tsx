import { useLingui } from "@lingui/react/macro";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import { BACKFILL_REFETCH_MS, useRefetchAfterBackfill } from "../../hooks/use-usage-backfill";
import { formatUsd, localDayKey, periodStart } from "../../lib/usage-activity";

/** The `skillKey` the backend files plain-assistant replies under; mirrors DEFAULT_SKILL_KEY in the backend's activity logic. */
const DEFAULT_SKILL_KEY = "__assistant__";

/** The `skillKey` of the Daily Brief; mirrors DAILY_BRIEF_SKILL_KEY in the backend's activity logic. */
const DAILY_BRIEF_SKILL_KEY = "__daily_brief__";

interface UsageSkillBreakdownProps {
    /** Earlier replies are still being added to the rollup (`useUsageBackfill`). */
    backfilling: boolean;
    /** The usage page's selected window, in days. */
    days: number;
}

const formatTokens = (count: number, locale: string): string => new Intl.NumberFormat(locale, { maximumFractionDigits: 1, notation: "compact" }).format(count);

/** Replies, tokens and spend per skill (or group-chat agent) over the page's selected window. */
const UsageSkillBreakdown: FC<UsageSkillBreakdownProps> = ({ backfilling, days }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const [today] = useState(() => localDayKey(new Date()));
    const locale = i18n.locale || "en";

    const { data, isError, isPending, refetch } = useQuery({
        ...crpc.usage.activity.getSkillBreakdown.queryOptions({ fromDate: periodStart(today, days) }, { live: false }),
        refetchInterval: backfilling ? BACKFILL_REFETCH_MS : false,
    });

    useRefetchAfterBackfill(backfilling, refetch);

    const skillLabel = (skill: { skillKey: string; skillName?: string }): string => {
        if (skill.skillKey === DEFAULT_SKILL_KEY) {
            return t`Assistant (no skill)`;
        }

        if (skill.skillKey === DAILY_BRIEF_SKILL_KEY) {
            return t`Daily Brief`;
        }

        return skill.skillName ?? t`Unnamed skill`;
    };

    const skills = data?.skills ?? [];
    const totalCost = skills.reduce((sum, skill) => sum + skill.costMicrodollars, 0);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <Sparkles aria-hidden="true" className="size-4" />
                    {t`Usage by skill`}
                </CardTitle>
                <CardDescription>{t`Replies, tokens and spend per skill or agent for the selected period`}</CardDescription>
            </CardHeader>
            <CardContent>
                {isPending && (
                    <div className="space-y-2">
                        {[1, 2, 3].map((index) => (
                            <Skeleton className="h-10 w-full" key={index} />
                        ))}
                    </div>
                )}
                {isError && <p className="text-destructive text-sm">{t`Could not load the skill breakdown.`}</p>}
                {!isPending && !isError && skills.length === 0 && (
                    <p className="text-muted-foreground py-4 text-center text-sm">{t`No replies recorded for this period.`}</p>
                )}
                {!isPending && !isError && skills.length > 0 && (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t`Skill or agent`}</TableHead>
                                <TableHead className="text-right">{t`Replies`}</TableHead>
                                <TableHead className="text-right">{t`Tokens`}</TableHead>
                                <TableHead className="text-right">{t`Spend`}</TableHead>
                                <TableHead className="w-1/4">
                                    <span className="sr-only">{t`Share of spend`}</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {skills.map((skill) => {
                                const share = totalCost > 0 ? skill.costMicrodollars / totalCost : 0;
                                const percent = Math.round(share * 100);

                                return (
                                    <TableRow key={skill.skillKey}>
                                        <TableCell className="font-medium">{skillLabel(skill)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{skill.replies.toLocaleString(locale)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{formatTokens(skill.tokens, locale)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{formatUsd(skill.costMicrodollars, locale)}</TableCell>
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
                {data?.truncated && <p className="text-muted-foreground mt-2 text-xs">{t`Only the most recent days of this period are included.`}</p>}
            </CardContent>
        </Card>
    );
};

export default UsageSkillBreakdown;
