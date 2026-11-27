import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { formatNumber, formatTime } from "@neore/ui/utils/locale-format";
import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, CheckCircle2, Clock, DollarSign, TrendingUp, XCircle, Zap } from "lucide-react";
import { useState } from "react";

import { AdminBlock, AdminSection, AdminStatGrid } from "@/features/admin/components/admin-section";
import { useGatewayAnalytics } from "@/features/admin/hooks/use-admin";

const formatCost = (microdollars: number): string => {
    if (microdollars === 0) return "$0.00";

    const dollars = microdollars / 1_000_000;

    if (dollars < 0.01) return `$${(microdollars / 1000).toFixed(3)}m`;

    return `$${dollars.toFixed(4)}`;
};

const formatLatency = (ms: number): string => {
    if (ms < 1000) return `${Math.round(ms)}ms`;

    return `${(ms / 1000).toFixed(1)}s`;
};

const formatPercent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

const statusConfig: Record<string, { icon: React.ReactNode; label: MessageDescriptor; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    degraded: { icon: <AlertCircle className="size-3" />, label: msg`Degraded`, variant: "secondary" },
    healthy: { icon: <CheckCircle2 className="size-3" />, label: msg`Healthy`, variant: "default" },
    offline: { icon: <XCircle className="size-3" />, label: msg`Offline`, variant: "destructive" },
};

const tierColors: Record<string, string> = {
    complex: "bg-attention/20 text-foreground",
    reasoning: "bg-destructive/20 text-foreground",
    simple: "bg-success/20 text-foreground",
    standard: "bg-info/20 text-foreground",
};

const GatewayAnalyticsPage = () => {
    const { i18n, t } = useLingui();
    const [period, setPeriod] = useState<"24h" | "7d">("24h");
    const { data, isPending, error } = useGatewayAnalytics(period);
    const totalRequests = data ? formatNumber(data.overview.totalRequests, i18n.locale) : "—";

    const costTrendBody = data?.costTrend.length ? (
        <div className="space-y-2">
            {data.costTrend.map((day: { costMicrodollars: number; date: string; requestCount: number }) => {
                const maxCost = Math.max(...data.costTrend.map((d: { costMicrodollars: number }) => d.costMicrodollars), 1);
                const pct = (day.costMicrodollars / maxCost) * 100;
                const requestCount = formatNumber(day.requestCount, i18n.locale);

                return (
                    <div className="flex items-center gap-3 text-sm" key={day.date}>
                        <span className="text-muted-foreground w-20 shrink-0 text-xs">{day.date}</span>
                        <div className="bg-surface-well relative flex-1 overflow-hidden rounded">
                            <div className="bg-primary/60 h-6 transition-[width]" style={{ width: `${pct}%` }} />
                            <span className="absolute inset-0 flex items-center px-2 text-xs font-medium">{formatCost(day.costMicrodollars)}</span>
                        </div>
                        <span className="text-muted-foreground w-20 shrink-0 text-right text-xs">{t`${requestCount} req`}</span>
                    </div>
                );
            })}
        </div>
    ) : (
        <p className="text-muted-foreground py-4 text-center text-sm">
            <Trans>No cost data for this period.</Trans>
        </p>
    );

    const modelBreakdownBody = data?.modelBreakdown.length ? (
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead>
                        <Trans>Model</Trans>
                    </TableHead>
                    <TableHead>
                        <Trans>Provider</Trans>
                    </TableHead>
                    <TableHead className="text-right">
                        <Trans>Requests</Trans>
                    </TableHead>
                    <TableHead className="text-right">
                        <Trans>Cost</Trans>
                    </TableHead>
                    <TableHead className="text-right">
                        <Trans>Avg Latency</Trans>
                    </TableHead>
                    <TableHead className="text-right">
                        <Trans>Errors</Trans>
                    </TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {data.modelBreakdown.map(
                    (model: { avgLatencyMs: number; costMicrodollars: number; count: number; errorCount: number; modelId: string; provider: string }) => (
                        <TableRow key={`${model.provider}-${model.modelId}`}>
                            <TableCell className="font-medium">{model.modelId}</TableCell>
                            <TableCell className="text-muted-foreground capitalize">{model.provider}</TableCell>
                            <TableCell className="text-right">{formatNumber(model.count, i18n.locale)}</TableCell>
                            <TableCell className="text-right">{formatCost(model.costMicrodollars)}</TableCell>
                            <TableCell className="text-right">{formatLatency(model.avgLatencyMs)}</TableCell>
                            <TableCell className="text-right">
                                {model.errorCount > 0 ? (
                                    <span className="text-destructive font-medium">{model.errorCount}</span>
                                ) : (
                                    <span className="text-muted-foreground">0</span>
                                )}
                            </TableCell>
                        </TableRow>
                    ),
                )}
            </TableBody>
        </Table>
    ) : (
        <p className="text-muted-foreground py-4 text-center text-sm">
            <Trans>No usage data for this period.</Trans>
        </p>
    );

    const providerHealthBody = data?.providerHealth.length ? (
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead>
                        <Trans>Provider / Model</Trans>
                    </TableHead>
                    <TableHead>
                        <Trans>Status</Trans>
                    </TableHead>
                    <TableHead className="text-right">
                        <Trans>Err%</Trans>
                    </TableHead>
                    <TableHead className="text-right">P50</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {data.providerHealth.map(
                    (ph: {
                        avgLatency5mMs: number;
                        circuitBreakerUntil: string | null;
                        errorRate5m: number;
                        lastFailureAt: string | null;
                        lastSuccessAt: string | null;
                        modelApiId: string;
                        provider: string;
                        status: string;
                    }) => {
                        const config = statusConfig[ph.status] ?? statusConfig["healthy"]!;
                        const circuitBreakerUntil = ph.circuitBreakerUntil ? formatTime(ph.circuitBreakerUntil, i18n.locale) : undefined;

                        return (
                            <TableRow key={`${ph.provider}-${ph.modelApiId}`}>
                                <TableCell>
                                    <div className="font-medium capitalize">{ph.provider}</div>
                                    <div className="text-muted-foreground text-xs">{ph.modelApiId}</div>
                                </TableCell>
                                <TableCell>
                                    <Badge className="gap-1" variant={config.variant}>
                                        {config.icon}
                                        {i18n._(config.label)}
                                    </Badge>
                                    {circuitBreakerUntil && (
                                        <div className="text-destructive mt-0.5 text-xs" suppressHydrationWarning>
                                            <Trans>CB until {circuitBreakerUntil}</Trans>
                                        </div>
                                    )}
                                </TableCell>
                                <TableCell className="text-right text-sm">{formatPercent(ph.errorRate5m)}</TableCell>
                                <TableCell className="text-right text-sm">{formatLatency(ph.avgLatency5mMs)}</TableCell>
                            </TableRow>
                        );
                    },
                )}
            </TableBody>
        </Table>
    ) : (
        <p className="text-muted-foreground py-4 text-center text-sm">
            <Trans>No provider health data recorded yet.</Trans>
        </p>
    );

    const tierDistributionBody = data?.tierDistribution.length ? (
        <div className="space-y-3">
            {data.tierDistribution.map((tier: { count: number; tier: string }) => {
                const total = data.tierDistribution.reduce((sum: number, entry: { count: number }) => sum + entry.count, 0);
                const pct = total > 0 ? (tier.count / total) * 100 : 0;

                return (
                    <div className="space-y-1" key={tier.tier}>
                        <div className="flex items-center justify-between text-sm">
                            <span className={`rounded px-1.5 py-0.5 text-xs font-medium capitalize ${tierColors[tier.tier] ?? ""}`}>{tier.tier}</span>
                            <span className="text-muted-foreground">
                                {formatNumber(tier.count, i18n.locale)} ({pct.toFixed(0)}%)
                            </span>
                        </div>
                        <div className="bg-surface-well h-2 w-full overflow-hidden rounded-full">
                            <div className="h-full rounded-full bg-current opacity-60 transition-[width]" style={{ width: `${pct}%` }} />
                        </div>
                    </div>
                );
            })}
        </div>
    ) : (
        <p className="text-muted-foreground py-4 text-center text-sm">
            <Trans>No tier data yet. Tier info is recorded for new requests after the gateway upgrade.</Trans>
        </p>
    );

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-muted-foreground text-sm">
                    <Trans>Smart routing decisions, model usage, and provider health</Trans>
                </p>

                <Select onValueChange={(v) => v && setPeriod(v as "24h" | "7d")} value={period}>
                    <SelectTrigger aria-label={t`Period`} className="w-[120px]">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="24h">
                            <Trans>Last 24h</Trans>
                        </SelectItem>
                        <SelectItem value="7d">
                            <Trans>Last 7 days</Trans>
                        </SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {error && (
                <div className="surface-raised ring-destructive/40 rounded-xl px-4 py-3.5 ring-1">
                    <p className="text-destructive text-sm">
                        <Trans>Failed to load analytics. Ensure the LLM Gateway is running and reachable.</Trans>
                    </p>
                </div>
            )}

            {/* Overview Stats */}
            <AdminSection>
                <AdminStatGrid
                    columns="@3xl:grid-cols-5"
                    stats={[
                        {
                            icon: <TrendingUp aria-hidden="true" className="size-3.5" />,
                            id: "requests",
                            label: t`Requests`,
                            value: isPending ? <Skeleton className="h-7 w-20" /> : totalRequests,
                        },
                        {
                            icon: <DollarSign aria-hidden="true" className="size-3.5" />,
                            id: "total-cost",
                            label: t`Total Cost`,
                            value: isPending ? <Skeleton className="h-7 w-20" /> : formatCost(data?.overview.totalCostMicrodollars ?? 0),
                        },
                        {
                            icon: <Clock aria-hidden="true" className="size-3.5" />,
                            id: "avg-latency",
                            label: t`Avg Latency`,
                            value: isPending ? <Skeleton className="h-7 w-20" /> : formatLatency(data?.overview.avgLatencyMs ?? 0),
                        },
                        {
                            icon: <AlertCircle aria-hidden="true" className="size-3.5" />,
                            id: "error-rate",
                            label: t`Error Rate`,
                            value: isPending ? <Skeleton className="h-7 w-20" /> : formatPercent(data?.overview.errorRate ?? 0),
                        },
                        {
                            icon: <Zap aria-hidden="true" className="size-3.5" />,
                            id: "cache-hit-rate",
                            label: t`Cache Hit Rate`,
                            value: isPending ? <Skeleton className="h-7 w-20" /> : formatPercent(data?.overview.cacheHitRate ?? 0),
                        },
                    ]}
                />
            </AdminSection>

            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
                {/* Routing Tier Distribution */}
                <AdminSection
                    description={<Trans>Query complexity tiers assigned by the routing engine</Trans>}
                    title={<Trans>Routing Tier Distribution</Trans>}
                >
                    <AdminBlock>
                        {isPending ? (
                            <div className="space-y-2">
                                {[1, 2, 3, 4].map((i) => (
                                    <Skeleton className="h-8 w-full" key={i} />
                                ))}
                            </div>
                        ) : (
                            tierDistributionBody
                        )}
                    </AdminBlock>
                </AdminSection>

                {/* Provider Health */}
                <AdminSection description={<Trans>Circuit breaker status from the last 5 minutes</Trans>} title={<Trans>Provider Health</Trans>}>
                    <AdminBlock className="px-2">
                        {isPending ? (
                            <div className="space-y-2 px-2">
                                {[1, 2, 3].map((i) => (
                                    <Skeleton className="h-8 w-full" key={i} />
                                ))}
                            </div>
                        ) : (
                            providerHealthBody
                        )}
                    </AdminBlock>
                </AdminSection>
            </div>

            {/* Model Breakdown */}
            <AdminSection description={<Trans>Request volume, cost, and error count per model</Trans>} title={<Trans>Model Breakdown</Trans>}>
                <AdminBlock className="px-2">
                    {isPending ? (
                        <div className="space-y-2 px-2">
                            {[1, 2, 3, 4, 5].map((i) => (
                                <Skeleton className="h-10 w-full" key={i} />
                            ))}
                        </div>
                    ) : (
                        modelBreakdownBody
                    )}
                </AdminBlock>
            </AdminSection>

            {/* 7-day Cost Trend */}
            <AdminSection description={<Trans>Daily LLM spend and request volume</Trans>} title={<Trans>7-Day Cost Trend</Trans>}>
                <AdminBlock>
                    {isPending ? (
                        <div className="flex gap-1">
                            {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                                <Skeleton className="flex-1" key={i} style={{ height: `${40 + i * 10}px` }} />
                            ))}
                        </div>
                    ) : (
                        costTrendBody
                    )}
                </AdminBlock>
            </AdminSection>
        </div>
    );
};

export const Route = createFileRoute("/admin/gateway/")({
    component: GatewayAnalyticsPage,
});
