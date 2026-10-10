"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import type { EvalComparison, EvalSummary } from "../lib/evals-format";
import { formatCost, formatDelta, formatLatency, formatPercent } from "../lib/evals-format";

type Change = EvalComparison["cases"][number]["change"];

const CHANGE_ORDER: Record<Change, number> = { improved: 1, missing: 3, regressed: 0, unchanged: 2 };

interface RunComparisonProps {
    baselineRunId: Id<"evalRuns">;
    candidateRunId: Id<"evalRuns">;
    rag: boolean;
}

type SummaryRow = { format: (summary: EvalSummary) => string; label: string; value: (summary: EvalSummary) => number | null };

const CHANGE_VARIANT: Record<Change, "default" | "destructive" | "secondary"> = {
    improved: "default",
    missing: "secondary",
    regressed: "destructive",
    unchanged: "secondary",
};

/** The regression view: two runs' aggregates side by side, then every case that changed, regressions first. */
const RunComparison = ({ baselineRunId, candidateRunId, rag }: RunComparisonProps) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const { data, isLoading } = useQuery(crpc.evals.functions.compareRuns.queryOptions({ baselineRunId, candidateRunId }));

    if (isLoading || !data) {
        return (
            <p className="text-muted-foreground text-sm" role="status">
                {t`Loading comparison…`}
            </p>
        );
    }

    const baseSummary = data.baseline.summary;
    const candidateSummary = data.candidate.summary;
    const changeLabels: Record<Change, string> = {
        improved: t`Improved`,
        missing: t`Only in one run`,
        regressed: t`Regressed`,
        unchanged: t`Unchanged`,
    };
    const cases = data.cases.toSorted((a, b) => CHANGE_ORDER[a.change] - CHANGE_ORDER[b.change]);
    const runName = (run: EvalComparison["baseline"]) => run.label ?? formatDateTime(run.createdAt, i18n.locale);
    const summaryRows: SummaryRow[] = [
        { format: (summary) => formatPercent(summary.passRate), label: t`Pass rate`, value: (summary) => summary.passRate },
        { format: (summary) => formatPercent(summary.avgScore), label: t`Average score`, value: (summary) => summary.avgScore },
        { format: (summary) => formatPercent(summary.avgJudgeScore), label: t`Judge score`, value: (summary) => summary.avgJudgeScore },
        { format: (summary) => formatPercent(summary.checkPassRate), label: t`Checks passed`, value: (summary) => summary.checkPassRate },
        ...(rag
            ? [
                  { format: (summary: EvalSummary) => formatPercent(summary.hitRate), label: t`Hit rate`, value: (summary: EvalSummary) => summary.hitRate },
                  {
                      format: (summary: EvalSummary) => (summary.mrr === null ? "—" : summary.mrr.toFixed(2)),
                      label: t`MRR`,
                      value: (summary: EvalSummary) => summary.mrr,
                  },
                  {
                      format: (summary: EvalSummary) => formatPercent(summary.avgContextRecall),
                      label: t`Context recall`,
                      value: (summary: EvalSummary) => summary.avgContextRecall,
                  },
                  {
                      format: (summary: EvalSummary) => formatPercent(summary.avgFaithfulness),
                      label: t`Faithfulness`,
                      value: (summary: EvalSummary) => summary.avgFaithfulness,
                  },
              ]
            : []),
    ];

    return (
        <section aria-labelledby={headingId} className="space-y-4">
            <h3 className="text-sm font-medium" id={headingId}>
                {t`Comparing "${runName(data.baseline)}" (baseline) with "${runName(data.candidate)}"`}
            </h3>
            <p className="text-sm" role="status">
                {t`${String(data.regressed)} regressed · ${String(data.improved)} improved · ${String(data.unchanged)} unchanged`}
            </p>

            {baseSummary && candidateSummary && (
                <div className="overflow-x-auto">
                    <Table>
                        <TableCaption className="sr-only">{t`Aggregate scores of both runs`}</TableCaption>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t`Metric`}</TableHead>
                                <TableHead className="text-right">{t`Baseline`}</TableHead>
                                <TableHead className="text-right">{t`Candidate`}</TableHead>
                                <TableHead className="text-right">{t`Change (points)`}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {summaryRows.map((row) => {
                                const base = row.value(baseSummary);
                                const candidate = row.value(candidateSummary);

                                return (
                                    <TableRow key={row.label}>
                                        <TableHead scope="row">{row.label}</TableHead>
                                        <TableCell className="text-right tabular-nums">{row.format(baseSummary)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{row.format(candidateSummary)}</TableCell>
                                        <TableCell className="text-right tabular-nums">
                                            {base === null || candidate === null ? "—" : formatDelta(candidate - base)}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                            <TableRow>
                                <TableHead scope="row">{t`Average latency`}</TableHead>
                                <TableCell className="text-right tabular-nums">{formatLatency(baseSummary.avgLatencyMs)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatLatency(candidateSummary.avgLatencyMs)}</TableCell>
                                <TableCell className="text-right">—</TableCell>
                            </TableRow>
                            <TableRow>
                                <TableHead scope="row">{t`Cost`}</TableHead>
                                <TableCell className="text-right tabular-nums">{formatCost(baseSummary.totalCostMicrodollars)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatCost(candidateSummary.totalCostMicrodollars)}</TableCell>
                                <TableCell className="text-right">—</TableCell>
                            </TableRow>
                        </TableBody>
                    </Table>
                </div>
            )}

            <div className="overflow-x-auto">
                <Table>
                    <TableCaption className="sr-only">{t`Per-case changes between the two runs`}</TableCaption>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t`Input`}</TableHead>
                            <TableHead>{t`Change`}</TableHead>
                            <TableHead className="text-right">{t`Baseline`}</TableHead>
                            <TableHead className="text-right">{t`Candidate`}</TableHead>
                            <TableHead className="text-right">{t`Δ points`}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {cases.map((entry) => (
                            <TableRow key={entry.caseId}>
                                <TableCell className="max-w-md truncate" title={entry.input}>
                                    {entry.input || t`(deleted case)`}
                                </TableCell>
                                <TableCell>
                                    <Badge variant={CHANGE_VARIANT[entry.change]}>{changeLabels[entry.change]}</Badge>
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{formatPercent(entry.baselineScore)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatPercent(entry.candidateScore)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatDelta(entry.scoreDelta)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </section>
    );
};

export default RunComparison;
