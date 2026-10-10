"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Progress } from "@neore/ui/components/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { formatDateTime, formatNumber } from "@neore/ui/utils/locale-format";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useId, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

import type { EvalResult } from "../lib/evals-format";
import { formatCost, formatLatency, formatPercent, runProgress } from "../lib/evals-format";
import { useCheckLabels } from "./case-fields";
import EvalSummaryStats from "./eval-summary-stats";
import { RunStatusBadge } from "./run-status";

const ResultStatus = ({ result }: { result: EvalResult }) => {
    const { t } = useLingui();

    if (result.status === "running") {
        return <Badge variant="outline">{t`Running`}</Badge>;
    }

    if (result.status === "error") {
        return <Badge variant="destructive">{t`Error`}</Badge>;
    }

    if (result.status === "skipped") {
        return <Badge variant="secondary">{t`Skipped`}</Badge>;
    }

    return result.passed ? <Badge>{t`Pass`}</Badge> : <Badge variant="destructive">{t`Fail`}</Badge>;
};

const ResultDetail = ({ result }: { result: EvalResult }) => {
    const { t } = useLingui();
    const checkLabels = useCheckLabels();

    return (
        <div className="space-y-3 py-2 text-sm">
            {result.error && <p className="text-destructive">{result.error}</p>}
            {result.answer && (
                <div>
                    <h4 className="text-xs font-medium">{t`Answer`}</h4>
                    <p className="bg-muted/40 mt-1 max-h-64 overflow-y-auto rounded p-2 whitespace-pre-wrap">{result.answer}</p>
                </div>
            )}
            {result.judge && (
                <div>
                    <h4 className="text-xs font-medium">{t`Judge: ${formatPercent(result.judge.score)}`}</h4>
                    <ul className="text-muted-foreground mt-1 list-disc pl-5 text-xs">
                        {result.judge.reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                        ))}
                    </ul>
                </div>
            )}
            {result.faithfulness && (
                <div>
                    <h4 className="text-xs font-medium">{t`Faithfulness: ${formatPercent(result.faithfulness.score)}`}</h4>
                    <ul className="text-muted-foreground mt-1 list-disc pl-5 text-xs">
                        {result.faithfulness.reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                        ))}
                    </ul>
                </div>
            )}
            {result.checks.length > 0 && (
                <div>
                    <h4 className="text-xs font-medium">{t`Checks`}</h4>
                    <ul className="mt-1 space-y-1 text-xs">
                        {result.checks.map((check, index) => {
                            let verdict = t`not measured`;

                            if (check.pass === true) {
                                verdict = t`passed`;
                            } else if (check.pass === false) {
                                verdict = t`failed`;
                            }

                            return (
                                // eslint-disable-next-line react-x/no-array-index-key -- checks repeat kinds and have no id
                                <li key={index}>
                                    <span className="font-medium">{checkLabels[check.kind].label}</span>{" "}
                                    <code className="bg-muted rounded px-1">{check.value.slice(0, 80)}</code> —{" "}
                                    <span className={check.pass === false ? "text-destructive" : undefined}>{verdict}</span>
                                    {check.detail && <span className="text-muted-foreground"> ({check.detail})</span>}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
            {result.retrieval && (
                <div>
                    <h4 className="text-xs font-medium">
                        {t`Retrieval: hit ${formatPercent(result.retrieval.hitAtK)} · MRR ${result.retrieval.mrr.toFixed(2)} · precision ${formatPercent(result.retrieval.contextPrecision)} · recall ${formatPercent(result.retrieval.contextRecall)}`}
                    </h4>
                    <ol className="mt-1 list-decimal pl-5 text-xs">
                        {result.retrieval.retrieved.map((chunk, index) => (
                            // eslint-disable-next-line react-x/no-array-index-key -- the same file can be retrieved at several ranks
                            <li key={index}>
                                {chunk.fileName} {chunk.relevant ? <span className="font-medium">{t`(expected)`}</span> : null}
                            </li>
                        ))}
                    </ol>
                </div>
            )}
            {result.threadId && (
                <Link className="text-primary text-xs underline-offset-4 hover:underline" params={{ threadId: result.threadId }} to="/chat/$threadId">
                    {t`Open the run's conversation`}
                </Link>
            )}
        </div>
    );
};

interface RunDetailProps {
    onDeleted: () => void;
    rag: boolean;
    runId: Id<"evalRuns">;
}

/** One run: progress, aggregate scores and the per-case results table. Live while the run is going. */
const RunDetail = ({ onDeleted, rag, runId }: RunDetailProps) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const { data, isLoading } = useQuery(crpc.evals.functions.getRun.queryOptions({ runId }));
    const cancelRun = useMutation(crpc.evals.functions.cancelRun.mutationOptions());
    const deleteRun = useMutation(crpc.evals.functions.deleteRun.mutationOptions());
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

    if (isLoading || !data) {
        return (
            <p className="text-muted-foreground text-sm" role="status">
                {t`Loading run…`}
            </p>
        );
    }

    const { results, run, summary } = data;
    const progress = runProgress(run);
    const isRunning = run.status === "running";

    const toggle = (id: string) =>
        setExpanded((previous) => {
            const next = new Set(previous);

            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }

            return next;
        });

    return (
        <section aria-labelledby={headingId} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-medium" id={headingId}>
                    {run.label ?? t`Run from ${formatDateTime(run.createdAt, i18n.locale)}`}
                    <RunStatusBadge status={run.status} />
                </h3>
                <div className="flex gap-2">
                    {isRunning ? (
                        <Button
                            disabled={cancelRun.isPending}
                            onClick={() => cancelRun.mutate({ runId }, { onError: (error) => toast.error(error.message) })}
                            size="sm"
                            variant="outline"
                        >
                            {t`Cancel run`}
                        </Button>
                    ) : (
                        <Button
                            disabled={deleteRun.isPending}
                            onClick={() => deleteRun.mutate({ runId }, { onError: (error) => toast.error(error.message), onSuccess: onDeleted })}
                            size="sm"
                            variant="ghost"
                        >
                            {t`Delete run`}
                        </Button>
                    )}
                </div>
            </div>

            {run.error && (
                <p className="text-destructive text-sm" role="alert">
                    {run.error}
                </p>
            )}

            {isRunning && <Progress aria-label={t`Run progress`} value={Math.round(progress * 100)} />}
            <p className="sr-only" role="status">
                {isRunning ? t`${String(run.nextIndex)} of ${String(run.caseCount)} cases finished` : ""}
            </p>
            <p className="text-muted-foreground text-xs">
                {t`Spent ${formatCost(run.costMicrodollars)} of a ${formatCost(run.costCapMicrodollars)} cap.`}{" "}
                {run.unpricedTokens > 0 &&
                    t`Cases with no reported cost used ${formatNumber(run.unpricedTokens, i18n.locale)} of ${formatNumber(run.tokenBudget, i18n.locale)} budgeted tokens.`}
            </p>

            <EvalSummaryStats rag={rag} summary={summary} />

            <div className="overflow-x-auto">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-10">
                                <span className="sr-only">{t`Details`}</span>
                            </TableHead>
                            <TableHead className="w-12">#</TableHead>
                            <TableHead>{t`Input`}</TableHead>
                            <TableHead>{t`Result`}</TableHead>
                            <TableHead className="text-right">{t`Score`}</TableHead>
                            <TableHead className="text-right">{t`Latency`}</TableHead>
                            <TableHead className="text-right">{t`Cost`}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {results.map((result) => {
                            const isOpen = expanded.has(result._id);
                            const detailId = `${headingId}-${result._id}`;

                            return (
                                <Fragment key={result._id}>
                                    <TableRow>
                                        <TableCell>
                                            <Button
                                                aria-controls={isOpen ? detailId : undefined}
                                                aria-expanded={isOpen}
                                                aria-label={t`Details for case ${String(result.index + 1)}`}
                                                onClick={() => toggle(result._id)}
                                                size="icon"
                                                variant="ghost"
                                            >
                                                {isOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
                                            </Button>
                                        </TableCell>
                                        <TableCell className="tabular-nums">{result.index + 1}</TableCell>
                                        <TableCell className="max-w-md truncate" title={result.input}>
                                            {result.input || t`(deleted case)`}
                                        </TableCell>
                                        <TableCell>
                                            <ResultStatus result={result} />
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">{formatPercent(result.score)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{formatLatency(result.latencyMs)}</TableCell>
                                        <TableCell className="text-right tabular-nums">{formatCost(result.costMicrodollars)}</TableCell>
                                    </TableRow>
                                    {isOpen && (
                                        <TableRow>
                                            <TableCell colSpan={7} id={detailId}>
                                                <ResultDetail result={result} />
                                            </TableCell>
                                        </TableRow>
                                    )}
                                </Fragment>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
        </section>
    );
};

export default RunDetail;
