"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Heading, HeadingSection } from "@neore/ui/components/heading";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Separator } from "@neore/ui/components/separator";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { formatDateTime, formatNumber } from "@neore/ui/utils/locale-format";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertCircle, Bell, BellOff, ChevronDown, ChevronRight, DollarSign, Loader2, Plus, Trash2, TrendingUp, Zap } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { useAction } from "@/lib/lunora/crpc";

import { useUsageBackfill } from "../../hooks/use-usage-backfill";
import UsageActivityHeatmap from "./usage-activity-heatmap";
import UsageSkillBreakdown from "./usage-skill-breakdown";

// ── Types ─────────────────────────────────────────────────────────────────────

type Metric = "daily_cost" | "monthly_cost" | "request_count" | "token_count";
type Period = "hour" | "day" | "month";
type RuleAction = "notify" | "block" | "notify_and_block";

interface NotificationRule {
    action: RuleAction;
    createdAt: string;
    id: string;
    isActive: boolean;
    lastTriggeredAt: string | null;
    metric: Metric;
    modelFilter: string | null;
    name: string;
    period: Period;
    threshold: number;
}

interface UsageSummary {
    byModel: Record<string, { cost: number; requests: number; tokens: number }>;
    dailyBreakdown: {
        completionTokens: number;
        costMicrodollars: number;
        date: string;
        promptTokens: number;
        requestCount: number;
    }[];
    period: string;
    totalCompletionTokens: number;
    totalCostMicrodollars: number;
    totalPromptTokens: number;
    totalRequests: number;
}

type UsageDailyEntry = UsageSummary["dailyBreakdown"][number];

// ── Helpers ───────────────────────────────────────────────────────────────────

const formatCost = (microdollars: number): string => {
    if (microdollars === 0) return "$0.00";

    const dollars = microdollars / 1_000_000;

    // Two significant digits ("$0.0015"), as the activity heatmap words it — a
    // millidollar "m" suffix read as millions.
    if (dollars < 0.01) return `$${dollars.toPrecision(2)}`;

    return `$${dollars.toFixed(4)}`;
};

const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;

    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;

    return String(n);
};

const METRIC_LABELS: Record<Metric, MessageDescriptor> = {
    daily_cost: msg`Daily cost (microdollars)`,
    monthly_cost: msg`Monthly cost (microdollars)`,
    request_count: msg`Request count`,
    token_count: msg`Token count`,
};

const PERIOD_LABELS: Record<Period, MessageDescriptor> = {
    day: msg`Day`,
    hour: msg`Hour`,
    month: msg`Month`,
};

const ACTION_LABELS: Record<RuleAction, MessageDescriptor> = {
    block: msg`Block requests`,
    notify: msg`Notify only`,
    notify_and_block: msg`Notify + block`,
};

const ACTION_VARIANTS: Record<RuleAction, "default" | "secondary" | "destructive"> = {
    block: "destructive",
    notify: "secondary",
    notify_and_block: "destructive",
};

const EMPTY_FORM = {
    action: "notify" as RuleAction,
    metric: "monthly_cost" as Metric,
    modelFilter: "",
    name: "",
    period: "month" as Period,
    threshold: 10_000_000, // $10 in microdollars
};

// ── Overview Card ─────────────────────────────────────────────────────────────

interface OverviewCardProps {
    icon: React.ReactNode;
    label: string;
    value: string | null;
}

const OverviewCard: FC<OverviewCardProps> = ({ icon, label, value }) => (
    <Card>
        <CardContent className="pt-4">
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                {icon}
                {label}
            </div>
            <div className="mt-1 text-2xl font-semibold">{value === null ? <Skeleton className="h-7 w-24" /> : value}</div>
        </CardContent>
    </Card>
);

// ── Main Component ────────────────────────────────────────────────────────────

const UsageSettings: FC = () => {
    const { i18n, t } = useLingui();
    const [days, setDays] = useState<7 | 30 | 90>(30);
    const { backfilling } = useUsageBackfill();
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [formData, setFormData] = useState(EMPTY_FORM);
    const [showDailyBreakdown, setShowDailyBreakdown] = useState(false);

    // ── Data fetching ──────────────────────────────────────────────────────────

    const fetchUsage = useAction(api.saas.usage_functions.getMyUsage);
    const fetchRules = useAction(api.saas.usage_functions.listMyNotificationRules);
    const createRuleAction = useAction(api.saas.usage_functions.createMyNotificationRule);
    const deleteRuleAction = useAction(api.saas.usage_functions.deleteMyNotificationRule);

    const {
        data: usage,
        error: usageError,
        isPending: usagePending,
    } = useQuery({
        queryFn: () => fetchUsage({ days }),
        queryKey: ["usage", "my", days],
        refetchInterval: 5 * 60_000, // 5 min
        retry: 1,
        staleTime: 2 * 60_000,
    });
    const totalRequests = usage ? formatNumber(usage.totalRequests, i18n.locale) : "—";

    const {
        data: rules,
        isPending: rulesPending,
        refetch: refetchRules,
    } = useQuery({
        queryFn: () => fetchRules({}),
        queryKey: ["usage", "notification-rules"],
        retry: 1,
        staleTime: 30_000,
    });

    // ── Rule actions ───────────────────────────────────────────────────────────

    const [creatingRule, setCreatingRule] = useState(false);
    const [deletingRuleId, setDeletingRuleId] = useState<null | string>(null);

    const handleCreateRule = async () => {
        if (!formData.name.trim()) {
            toast.error(t`Rule name is required`);

            return;
        }

        setCreatingRule(true);

        const modelFilter = formData.modelFilter.trim() || undefined;

        try {
            await createRuleAction({
                action: formData.action,
                metric: formData.metric,
                modelFilter,
                name: formData.name.trim(),
                period: formData.period,
                threshold: formData.threshold,
            });
            toast.success(t`Budget alert created`);
            setShowCreateForm(false);
            setFormData(EMPTY_FORM);
            void refetchRules();
        } catch {
            toast.error(t`Failed to create budget alert`);
        }

        setCreatingRule(false);
    };

    const handleDeleteRule = async (ruleId: string) => {
        setDeletingRuleId(ruleId);

        try {
            await deleteRuleAction({ ruleId });
            toast.success(t`Budget alert deleted`);
            void refetchRules();
        } catch {
            toast.error(t`Failed to delete budget alert`);
        }

        setDeletingRuleId(null);
    };

    // ── Render ─────────────────────────────────────────────────────────────────

    const modelEntries = Object.entries(usage?.byModel ?? {}).toSorted((a, b) => b[1].cost - a[1].cost);
    const maxDailyCost = Math.max(...(usage?.dailyBreakdown ?? []).map((d: UsageDailyEntry) => d.costMicrodollars), 1);

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <Heading className="text-xl font-semibold">{t`Usage & Cost`}</Heading>
                    <p className="text-muted-foreground text-sm">{t`Track your LLM token usage, cost, and set budget alerts`}</p>
                </div>

                <Select onValueChange={(v) => v && setDays(Number(v) as 7 | 30 | 90)} value={String(days)}>
                    <SelectTrigger className="w-[130px]">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="7">{t`Last 7 days`}</SelectItem>
                        <SelectItem value="30">{t`Last 30 days`}</SelectItem>
                        <SelectItem value="90">{t`Last 90 days`}</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            <HeadingSection>
                {usageError && (
                    <Card className="border-destructive">
                        <CardContent className="pt-4">
                            <p className="text-destructive text-sm">{t`Failed to load usage data. Ensure the LLM Gateway is running and reachable.`}</p>
                        </CardContent>
                    </Card>
                )}

                {/* Overview stats */}
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                    <OverviewCard icon={<TrendingUp aria-hidden="true" className="size-4" />} label={t`Requests`} value={usagePending ? null : totalRequests} />
                    <OverviewCard
                        icon={<DollarSign aria-hidden="true" className="size-4" />}
                        label={t`Total Cost`}
                        value={usagePending ? null : formatCost(usage?.totalCostMicrodollars ?? 0)}
                    />
                    <OverviewCard
                        icon={<Activity aria-hidden="true" className="size-4" />}
                        label={t`Prompt Tokens`}
                        value={usagePending ? null : formatTokens(usage?.totalPromptTokens ?? 0)}
                    />
                    <OverviewCard
                        icon={<Zap aria-hidden="true" className="size-4" />}
                        label={t`Completion Tokens`}
                        value={usagePending ? null : formatTokens(usage?.totalCompletionTokens ?? 0)}
                    />
                </div>

                {/* Activity heatmap (last 53 weeks, independent of the period selector) */}
                <UsageActivityHeatmap backfilling={backfilling} />

                {/* Model breakdown */}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <TrendingUp aria-hidden="true" className="size-4" />
                            {t`Cost by Model`}
                        </CardTitle>
                        <CardDescription>{t`Token usage and cost breakdown per model for the selected period`}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {usagePending && (
                            <div className="space-y-2">
                                {[1, 2, 3].map((i) => (
                                    <Skeleton className="h-10 w-full" key={i} />
                                ))}
                            </div>
                        )}
                        {!usagePending && modelEntries.length === 0 && (
                            <p className="text-muted-foreground py-4 text-center text-sm">{t`No usage data for this period.`}</p>
                        )}
                        {!usagePending && modelEntries.length > 0 && (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t`Model`}</TableHead>
                                        <TableHead className="text-right">{t`Requests`}</TableHead>
                                        <TableHead className="text-right">{t`Tokens`}</TableHead>
                                        <TableHead className="text-right">{t`Cost`}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {modelEntries.map(([modelId, stats]) => (
                                        <TableRow key={modelId}>
                                            <TableCell className="font-medium">{modelId}</TableCell>
                                            <TableCell className="text-right">{formatNumber(stats.requests, i18n.locale)}</TableCell>
                                            <TableCell className="text-right">{formatTokens(stats.tokens)}</TableCell>
                                            <TableCell className="text-right">{formatCost(stats.cost)}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>

                {/* Skill / agent breakdown */}
                <UsageSkillBreakdown backfilling={backfilling} days={days} />

                {/* Daily cost trend */}
                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between">
                            <div>
                                <CardTitle className="flex items-center gap-2 text-base">
                                    <DollarSign aria-hidden="true" className="size-4" />
                                    {t`Daily Cost Trend`}
                                </CardTitle>
                                <CardDescription>{t`Daily spend and request volume`}</CardDescription>
                            </div>
                            <Button
                                aria-expanded={showDailyBreakdown}
                                aria-label={showDailyBreakdown ? t`Collapse daily trend` : t`Expand daily trend`}
                                onClick={() => setShowDailyBreakdown((v) => !v)}
                                size="sm"
                                variant="ghost"
                            >
                                {showDailyBreakdown ? (
                                    <ChevronDown aria-hidden="true" className="size-4" />
                                ) : (
                                    <ChevronRight aria-hidden="true" className="size-4" />
                                )}
                            </Button>
                        </div>
                    </CardHeader>

                    {showDailyBreakdown && (
                        <CardContent>
                            {usagePending && (
                                <div className="flex gap-1">
                                    {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                                        <Skeleton className="flex-1" key={i} style={{ height: `${30 + i * 8}px` }} />
                                    ))}
                                </div>
                            )}
                            {!usagePending && usage !== undefined && usage.dailyBreakdown.length > 0 && (
                                <div className="space-y-2">
                                    {usage.dailyBreakdown.map((day: UsageDailyEntry) => {
                                        const pct = (day.costMicrodollars / maxDailyCost) * 100;
                                        const requestCount = formatNumber(day.requestCount, i18n.locale);

                                        return (
                                            <div className="flex items-center gap-3 text-sm" key={day.date}>
                                                <span className="text-muted-foreground w-24 shrink-0 text-xs">{day.date}</span>
                                                <div className="bg-muted relative flex-1 overflow-hidden rounded">
                                                    <div className="bg-primary/60 h-6 transition-[width]" style={{ width: `${pct}%` }} />
                                                    <span className="absolute inset-0 flex items-center px-2 text-xs font-medium">
                                                        {formatCost(day.costMicrodollars)}
                                                    </span>
                                                </div>
                                                <span className="text-muted-foreground w-20 shrink-0 text-right text-xs">{t`${requestCount} req`}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {!usagePending && !usage?.dailyBreakdown.length && (
                                <p className="text-muted-foreground py-4 text-center text-sm">{t`No daily data for this period.`}</p>
                            )}
                        </CardContent>
                    )}
                </Card>

                <Separator />

                {/* Budget Alerts */}
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <Heading className="font-medium" fallbackLevel={3}>{t`Budget Alerts`}</Heading>
                            <p className="text-muted-foreground text-sm">{t`Get notified or block requests when usage thresholds are reached`}</p>
                        </div>
                        <Button aria-label={t`Add budget alert`} onClick={() => setShowCreateForm((v) => !v)} size="sm" variant="outline">
                            <Plus aria-hidden="true" className="mr-1.5 size-3.5" />
                            {t`Add Alert`}
                        </Button>
                    </div>

                    <HeadingSection>
                        {/* Create form */}
                        {showCreateForm && (
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-base">{t`New Budget Alert`}</CardTitle>
                                    <CardDescription>{t`Trigger a notification or block when a usage metric exceeds a threshold`}</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="space-y-1.5">
                                        <Label htmlFor="alert-name">{t`Name`}</Label>
                                        <Input
                                            id="alert-name"
                                            maxLength={80}
                                            onChange={(e) =>
                                                setFormData((f) => {
                                                    return { ...f, name: e.target.value };
                                                })
                                            }
                                            placeholder={t`e.g. Monthly $10 limit`}
                                            value={formData.name}
                                        />
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-1.5">
                                            <Label htmlFor="alert-metric">{t`Metric`}</Label>
                                            <Select
                                                onValueChange={(v) =>
                                                    v &&
                                                    setFormData((f) => {
                                                        return { ...f, metric: v as Metric };
                                                    })
                                                }
                                                value={formData.metric}
                                            >
                                                <SelectTrigger id="alert-metric">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {(Object.entries(METRIC_LABELS) as [Metric, MessageDescriptor][]).map(([value, label]) => (
                                                        <SelectItem key={value} value={value}>
                                                            {i18n._(label)}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-1.5">
                                            <Label htmlFor="alert-period">{t`Period`}</Label>
                                            <Select
                                                onValueChange={(v) =>
                                                    v &&
                                                    setFormData((f) => {
                                                        return { ...f, period: v as Period };
                                                    })
                                                }
                                                value={formData.period}
                                            >
                                                <SelectTrigger id="alert-period">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {(Object.entries(PERIOD_LABELS) as [Period, MessageDescriptor][]).map(([value, label]) => (
                                                        <SelectItem key={value} value={value}>
                                                            {i18n._(label)}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-1.5">
                                            <Label htmlFor="alert-threshold">
                                                {t`Threshold`}
                                                {(formData.metric === "daily_cost" || formData.metric === "monthly_cost") && (
                                                    <span className="text-muted-foreground ml-1 text-xs">{t`(microdollars; 1,000,000 = $1)`}</span>
                                                )}
                                            </Label>
                                            <Input
                                                id="alert-threshold"
                                                min={1}
                                                onChange={(e) =>
                                                    setFormData((f) => {
                                                        return { ...f, threshold: Number(e.target.value) || 0 };
                                                    })
                                                }
                                                type="number"
                                                value={formData.threshold}
                                            />
                                        </div>

                                        <div className="space-y-1.5">
                                            <Label htmlFor="alert-action">{t`Action`}</Label>
                                            <Select
                                                onValueChange={(v) =>
                                                    v &&
                                                    setFormData((f) => {
                                                        return { ...f, action: v as RuleAction };
                                                    })
                                                }
                                                value={formData.action}
                                            >
                                                <SelectTrigger id="alert-action">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {(Object.entries(ACTION_LABELS) as [RuleAction, MessageDescriptor][]).map(([value, label]) => (
                                                        <SelectItem key={value} value={value}>
                                                            {i18n._(label)}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    <div className="space-y-1.5">
                                        <Label htmlFor="alert-model-filter">
                                            {t`Model filter`}
                                            <span className="text-muted-foreground ml-1 text-xs">{t`(optional)`}</span>
                                        </Label>
                                        <Input
                                            id="alert-model-filter"
                                            onChange={(e) =>
                                                setFormData((f) => {
                                                    return { ...f, modelFilter: e.target.value };
                                                })
                                            }
                                            placeholder={t`e.g. claude-opus-4 (leave blank for all models)`}
                                            value={formData.modelFilter}
                                        />
                                    </div>

                                    <div className="flex gap-2">
                                        <Button
                                            aria-label={t`Save budget alert`}
                                            disabled={creatingRule || !formData.name.trim()}
                                            onClick={() => {
                                                void handleCreateRule();
                                            }}
                                            size="sm"
                                        >
                                            {creatingRule && <Loader2 aria-hidden="true" className="mr-1.5 size-3.5 animate-spin" />}
                                            {t`Save Alert`}
                                        </Button>
                                        <Button
                                            aria-label={t`Cancel`}
                                            onClick={() => {
                                                setShowCreateForm(false);
                                                setFormData(EMPTY_FORM);
                                            }}
                                            size="sm"
                                            variant="outline"
                                        >
                                            {t`Cancel`}
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        )}

                        {/* Rules list */}
                        {rulesPending && (
                            <div className="space-y-2">
                                {[1, 2].map((i) => (
                                    <Skeleton className="h-16 w-full" key={i} />
                                ))}
                            </div>
                        )}
                        {!rulesPending && rules !== undefined && rules.length > 0 && (
                            <div className="space-y-2">
                                {rules.map((rule: NotificationRule) => {
                                    const metricLabel = i18n._(METRIC_LABELS[rule.metric]);
                                    const threshold =
                                        rule.metric === "daily_cost" || rule.metric === "monthly_cost"
                                            ? formatCost(rule.threshold)
                                            : formatNumber(rule.threshold, i18n.locale);
                                    const { modelFilter, name: ruleName } = rule;
                                    const lastTriggeredAt = rule.lastTriggeredAt ? formatDateTime(rule.lastTriggeredAt, i18n.locale) : null;
                                    let ruleSummary: string;

                                    switch (rule.period) {
                                        case "day": {
                                            ruleSummary = t`${metricLabel} > ${threshold} per day`;
                                            break;
                                        }
                                        case "hour": {
                                            ruleSummary = t`${metricLabel} > ${threshold} per hour`;
                                            break;
                                        }
                                        default: {
                                            ruleSummary = t`${metricLabel} > ${threshold} per month`;
                                        }
                                    }

                                    return (
                                        <Card key={rule.id}>
                                            <CardContent className="flex items-start justify-between gap-4 pt-4">
                                                <div className="flex items-start gap-3">
                                                    <Bell aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                                                    <div>
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <span className="text-sm font-medium">{rule.name}</span>
                                                            <Badge variant={ACTION_VARIANTS[rule.action]}>{i18n._(ACTION_LABELS[rule.action])}</Badge>
                                                        </div>
                                                        <p className="text-muted-foreground mt-0.5 text-xs">
                                                            {ruleSummary}
                                                            {modelFilter && t` · model: ${modelFilter}`}
                                                        </p>
                                                        {lastTriggeredAt && (
                                                            <p className="text-muted-foreground mt-0.5 text-xs">
                                                                <AlertCircle aria-hidden="true" className="mr-1 inline size-3" />
                                                                <Trans>Last triggered: {lastTriggeredAt}</Trans>
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>
                                                <Button
                                                    aria-label={t`Delete alert "${ruleName}"`}
                                                    className="shrink-0"
                                                    disabled={deletingRuleId === rule.id}
                                                    onClick={() => {
                                                        void handleDeleteRule(rule.id);
                                                    }}
                                                    size="icon"
                                                    variant="ghost"
                                                >
                                                    {deletingRuleId === rule.id ? (
                                                        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                                                    ) : (
                                                        <Trash2 aria-hidden="true" className="size-4" />
                                                    )}
                                                </Button>
                                            </CardContent>
                                        </Card>
                                    );
                                })}
                            </div>
                        )}
                        {!rulesPending && !rules?.length && (
                            <Card>
                                <CardContent className="py-8 text-center">
                                    <BellOff aria-hidden="true" className="text-muted-foreground mx-auto mb-3 size-8" />
                                    <p className="text-muted-foreground text-sm">{t`No budget alerts configured.`}</p>
                                    <p className="text-muted-foreground mt-1 text-xs">{t`Add an alert above to be notified when your usage crosses a threshold.`}</p>
                                </CardContent>
                            </Card>
                        )}
                    </HeadingSection>
                </div>
            </HeadingSection>
        </div>
    );
};

export default UsageSettings;
