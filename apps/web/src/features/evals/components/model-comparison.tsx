"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import { useCRPC } from "@/lib/lunora/crpc";

import { formatCost, formatPercent } from "../lib/evals-format";

interface ModelComparisonProps {
    datasetId: Id<"evalDatasets">;
}

/** The newest finished run of each model on a dataset, side by side: totals per model, then every case's outcome. */
const ModelComparison = ({ datasetId }: ModelComparisonProps) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data, isLoading } = useQuery(crpc.evals.functions.compareModels.queryOptions({ datasetId }));

    if (isLoading || !data) {
        return (
            <p className="text-muted-foreground text-sm" role="status">
                {t`Loading comparison…`}
            </p>
        );
    }

    if (data.runs.length < 2) {
        return <p className="text-muted-foreground text-sm">{t`Run this dataset against at least two models to compare them.`}</p>;
    }

    const names = data.runs.map((run) => run.target.model ?? run.target.kind);
    const outcome = (passed: boolean | null) => {
        if (passed === null) {
            return "—";
        }

        return passed ? t`Pass` : t`Fail`;
    };

    return (
        <div className="space-y-4">
            <div className="overflow-x-auto">
                <Table>
                    <TableCaption className="sr-only">{t`Totals per model`}</TableCaption>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t`Model`}</TableHead>
                            <TableHead className="text-right">{t`Passed`}</TableHead>
                            <TableHead className="text-right">{t`Failed`}</TableHead>
                            <TableHead className="text-right">{t`Pass rate`}</TableHead>
                            <TableHead className="text-right">{t`Cost`}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {data.runs.map((run, index) => (
                            <TableRow key={run._id}>
                                <TableHead scope="row">{names[index]}</TableHead>
                                <TableCell className="text-right tabular-nums">{run.summary?.passed ?? 0}</TableCell>
                                <TableCell className="text-right tabular-nums">{(run.summary?.scored ?? 0) - (run.summary?.passed ?? 0)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatPercent(run.summary?.passRate)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatCost(run.costMicrodollars)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>

            <div className="overflow-x-auto">
                <Table>
                    <TableCaption className="sr-only">{t`Outcome of every case per model`}</TableCaption>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t`Input`}</TableHead>
                            {data.runs.map((run, index) => (
                                <TableHead className="text-right" key={run._id}>
                                    {names[index]}
                                </TableHead>
                            ))}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {data.cases.map((entry) => (
                            <TableRow key={entry.caseId}>
                                <TableCell className="max-w-md truncate" title={entry.input}>
                                    {entry.frozen && <Lock aria-label={t`Frozen`} className="mr-1 inline size-3" />}
                                    {entry.input}
                                </TableCell>
                                {entry.results.map((result) => (
                                    <TableCell className="text-right" key={result.runId}>
                                        <Badge variant={result.passed === false ? "destructive" : "secondary"}>
                                            {outcome(result.passed)} {result.score === null ? "" : formatPercent(result.score)}
                                        </Badge>
                                    </TableCell>
                                ))}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
};

export default ModelComparison;
