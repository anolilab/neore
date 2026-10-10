"use client";

import { useLingui } from "@lingui/react/macro";

import type { EvalSummary } from "../lib/evals-format";
import { formatCost, formatLatency, formatPercent } from "../lib/evals-format";

interface EvalSummaryStatsProps {
    rag: boolean;
    summary: EvalSummary;
}

/** Aggregate scores for a run, as a definition list so each value is read with its name. */
const EvalSummaryStats = ({ rag, summary }: EvalSummaryStatsProps) => {
    const { t } = useLingui();
    const stats: { label: string; value: string }[] = [
        { label: t`Pass rate`, value: formatPercent(summary.passRate) },
        { label: t`Average score`, value: formatPercent(summary.avgScore) },
        { label: t`Judge score`, value: formatPercent(summary.avgJudgeScore) },
        { label: t`Checks passed`, value: formatPercent(summary.checkPassRate) },
        ...(rag
            ? [
                  { label: t`Hit rate`, value: formatPercent(summary.hitRate) },
                  { label: t`MRR`, value: summary.mrr === null ? "—" : summary.mrr.toFixed(2) },
                  { label: t`Context precision`, value: formatPercent(summary.avgContextPrecision) },
                  { label: t`Context recall`, value: formatPercent(summary.avgContextRecall) },
                  { label: t`Faithfulness`, value: formatPercent(summary.avgFaithfulness) },
              ]
            : []),
        { label: t`Average latency`, value: formatLatency(summary.avgLatencyMs) },
        { label: t`Cost`, value: formatCost(summary.totalCostMicrodollars) },
        {
            label: t`Cases`,
            value: t`${String(summary.scored)} scored · ${String(summary.errored)} errors · ${String(summary.skipped)} skipped of ${String(summary.total)}`,
        },
    ];

    return (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {stats.map((stat) => (
                <div className="bg-muted/40 rounded-lg p-3" key={stat.label}>
                    <dt className="text-muted-foreground text-xs">{stat.label}</dt>
                    <dd className="text-sm font-semibold tabular-nums">{stat.value}</dd>
                </div>
            ))}
        </dl>
    );
};

export default EvalSummaryStats;
