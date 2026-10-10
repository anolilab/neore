"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileUp, GitCompare, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

import type { EvalCase, EvalDataset, EvalRun } from "../lib/evals-format";
import { formatCost, formatPercent, formToCasePayload, orderForComparison } from "../lib/evals-format";
import CaseFormDialog from "./case-form-dialog";
import ImportCasesDialog from "./import-cases-dialog";
import RunComparison from "./run-comparison";
import RunDetail from "./run-detail";
import RunDialog from "./run-dialog";
import { RunStatusBadge } from "./run-status";

interface DatasetPanelProps {
    dataset: EvalDataset;
    onDelete: () => void;
    onEdit: () => void;
}

type RunView = { kind: "compare" } | { kind: "none" } | { kind: "run"; runId: Id<"evalRuns"> };

/** One dataset: its cases, its runs, a run's results and the comparison between two runs. */
const DatasetPanel = ({ dataset, onDelete, onEdit }: DatasetPanelProps) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const rag = dataset.kind === "rag";

    const { data: detail } = useQuery(crpc.evals.functions.getDataset.queryOptions({ datasetId: dataset._id }));
    const { data: runs = [] } = useQuery(crpc.evals.functions.listRuns.queryOptions({ datasetId: dataset._id }));
    const { data: files = [] } = useQuery({ ...crpc.knowledge.functions.listFiles.queryOptions({}), enabled: rag });
    const fileNames = new Map<string, string>(files.map((file) => [file._id as string, file.name]));
    const createCase = useMutation(crpc.evals.functions.createCase.mutationOptions());
    const updateCase = useMutation(crpc.evals.functions.updateCase.mutationOptions());
    const deleteCase = useMutation(crpc.evals.functions.deleteCase.mutationOptions());

    const [tab, setTab] = useState<"cases" | "runs">("cases");
    const [caseDialog, setCaseDialog] = useState<{ editing: EvalCase | null; open: boolean }>({ editing: null, open: false });
    const [pendingCaseDelete, setPendingCaseDelete] = useState<EvalCase | null>(null);
    const [importOpen, setImportOpen] = useState(false);
    const [runOpen, setRunOpen] = useState(false);
    const [runView, setRunView] = useState<RunView>({ kind: "none" });
    const [compareIds, setCompareIds] = useState<Id<"evalRuns">[]>([]);

    const cases = detail?.cases ?? [];
    const comparePair = orderForComparison(runs.filter((run) => compareIds.includes(run._id)));

    const confirmCaseDelete = async () => {
        if (!pendingCaseDelete) {
            return;
        }

        try {
            await deleteCase.mutateAsync({ caseId: pendingCaseDelete._id });
            setPendingCaseDelete(null);
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Failed to delete the case`);
        }
    };

    const toggleCompare = (run: EvalRun, checked: boolean) =>
        setCompareIds((previous) => {
            if (!checked) {
                return previous.filter((id) => id !== run._id);
            }

            // Keep the two most recent picks.
            return [...previous.filter((id) => id !== run._id), run._id].slice(-2);
        });

    return (
        <section aria-labelledby={headingId} className="min-w-0 flex-1 space-y-4">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                    <h2 className="flex items-center gap-2 text-lg font-semibold" id={headingId}>
                        {dataset.name}
                        <Badge variant="secondary">{rag ? t`Retrieval` : t`Agent`}</Badge>
                    </h2>
                    {dataset.description && <p className="text-muted-foreground text-sm">{dataset.description}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button aria-label={t`Edit dataset`} onClick={onEdit} size="icon" variant="ghost">
                        <Pencil aria-hidden />
                    </Button>
                    <Button aria-label={t`Delete dataset`} onClick={onDelete} size="icon" variant="ghost">
                        <Trash2 aria-hidden />
                    </Button>
                    <Button onClick={() => setImportOpen(true)} variant="outline">
                        <FileUp aria-hidden />
                        {t`Import`}
                    </Button>
                    <Button onClick={() => setCaseDialog({ editing: null, open: true })} variant="outline">
                        <Plus aria-hidden />
                        {t`Add case`}
                    </Button>
                    <Button disabled={cases.length === 0} onClick={() => setRunOpen(true)}>
                        <Play aria-hidden />
                        {t`Run`}
                    </Button>
                </div>
            </header>

            <Tabs onValueChange={(value) => setTab(value === "runs" ? "runs" : "cases")} value={tab}>
                <TabsList aria-label={t`Dataset views`}>
                    <TabsTrigger value="cases">{t`Cases (${String(cases.length)})`}</TabsTrigger>
                    <TabsTrigger value="runs">{t`Runs (${String(runs.length)})`}</TabsTrigger>
                </TabsList>

                <TabsContent className="pt-4" value="cases">
                    {cases.length === 0 ? (
                        <p className="text-muted-foreground text-sm">{t`No cases yet. Add one by hand, import a CSV or JSONL file, or save a chat turn with "Save as eval case".`}</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <Table>
                                <TableCaption className="sr-only">{t`Cases in ${dataset.name}`}</TableCaption>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t`Input`}</TableHead>
                                        <TableHead>{t`Expected answer`}</TableHead>
                                        {rag && <TableHead>{t`Expected sources`}</TableHead>}
                                        <TableHead className="text-right">{t`Checks`}</TableHead>
                                        <TableHead className="w-24">
                                            <span className="sr-only">{t`Actions`}</span>
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {cases.map((evalCase, index) => (
                                        <TableRow key={evalCase._id}>
                                            <TableCell className="max-w-xs truncate" title={evalCase.input}>
                                                {evalCase.input}
                                            </TableCell>
                                            <TableCell className="text-muted-foreground max-w-xs truncate" title={evalCase.expectedAnswer ?? undefined}>
                                                {evalCase.expectedAnswer ?? "—"}
                                            </TableCell>
                                            {rag && (
                                                <TableCell className="max-w-xs truncate">
                                                    {evalCase.expectedSources.map((source) => fileNames.get(source) ?? source).join(", ") || "—"}
                                                </TableCell>
                                            )}
                                            <TableCell className="text-right tabular-nums">{evalCase.checks.length}</TableCell>
                                            <TableCell>
                                                <div className="flex justify-end gap-1">
                                                    <Button
                                                        aria-label={t`Edit case ${String(index + 1)}`}
                                                        onClick={() => setCaseDialog({ editing: evalCase, open: true })}
                                                        size="icon"
                                                        variant="ghost"
                                                    >
                                                        <Pencil aria-hidden />
                                                    </Button>
                                                    <Button
                                                        aria-label={t`Delete case ${String(index + 1)}`}
                                                        onClick={() => setPendingCaseDelete(evalCase)}
                                                        size="icon"
                                                        variant="ghost"
                                                    >
                                                        <Trash2 aria-hidden />
                                                    </Button>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </TabsContent>

                <TabsContent className="space-y-6 pt-4" value="runs">
                    {runs.length === 0 ? (
                        <p className="text-muted-foreground text-sm">{t`No runs yet. Start one to score every case.`}</p>
                    ) : (
                        <>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-muted-foreground text-xs">{t`Tick two runs to compare them.`}</p>
                                <Button disabled={!comparePair} onClick={() => setRunView({ kind: "compare" })} size="sm" variant="outline">
                                    <GitCompare aria-hidden />
                                    {t`Compare`}
                                </Button>
                            </div>
                            <div className="overflow-x-auto">
                                <Table>
                                    <TableCaption className="sr-only">{t`Runs of ${dataset.name}`}</TableCaption>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-10">
                                                <span className="sr-only">{t`Compare`}</span>
                                            </TableHead>
                                            <TableHead>{t`Run`}</TableHead>
                                            <TableHead>{t`Status`}</TableHead>
                                            <TableHead className="text-right">{t`Progress`}</TableHead>
                                            <TableHead className="text-right">{t`Pass rate`}</TableHead>
                                            <TableHead className="text-right">{t`Score`}</TableHead>
                                            <TableHead className="text-right">{t`Cost`}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {runs.map((run) => {
                                            const name = run.label ?? formatDateTime(run.createdAt, i18n.locale);
                                            const isSelected = runView.kind === "run" && runView.runId === run._id;

                                            return (
                                                <TableRow data-state={isSelected ? "selected" : undefined} key={run._id}>
                                                    <TableCell>
                                                        <Checkbox
                                                            aria-label={t`Compare ${name}`}
                                                            checked={compareIds.includes(run._id)}
                                                            onCheckedChange={(checked) => toggleCompare(run, checked)}
                                                        />
                                                    </TableCell>
                                                    <TableCell>
                                                        <Button
                                                            aria-current={isSelected ? "true" : undefined}
                                                            className="h-auto p-0"
                                                            onClick={() => setRunView({ kind: "run", runId: run._id })}
                                                            variant="link"
                                                        >
                                                            {name}
                                                        </Button>
                                                    </TableCell>
                                                    <TableCell>
                                                        <RunStatusBadge status={run.status} />
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums">
                                                        {String(run.nextIndex)}/{String(run.caseCount)}
                                                    </TableCell>
                                                    <TableCell className="text-right tabular-nums">{formatPercent(run.summary?.passRate)}</TableCell>
                                                    <TableCell className="text-right tabular-nums">{formatPercent(run.summary?.avgScore)}</TableCell>
                                                    <TableCell className="text-right tabular-nums">{formatCost(run.costMicrodollars)}</TableCell>
                                                </TableRow>
                                            );
                                        })}
                                    </TableBody>
                                </Table>
                            </div>
                        </>
                    )}

                    {runView.kind === "run" && <RunDetail key={runView.runId} onDeleted={() => setRunView({ kind: "none" })} rag={rag} runId={runView.runId} />}
                    {runView.kind === "compare" && comparePair && <RunComparison {...comparePair} rag={rag} />}
                </TabsContent>
            </Tabs>

            <CaseFormDialog
                editing={caseDialog.editing}
                knownFileIds={new Set(fileNames.keys())}
                onClose={() => setCaseDialog({ editing: null, open: false })}
                onSubmit={async (values) => {
                    const payload = formToCasePayload(values);

                    if (caseDialog.editing) {
                        await updateCase.mutateAsync({ ...payload, caseId: caseDialog.editing._id });
                    } else {
                        await createCase.mutateAsync({ ...payload, datasetId: dataset._id });
                    }
                }}
                open={caseDialog.open}
                rag={rag}
            />

            <ImportCasesDialog datasetId={dataset._id} onClose={() => setImportOpen(false)} open={importOpen} />

            <RunDialog
                dataset={dataset}
                onClose={() => setRunOpen(false)}
                onStarted={(runId) => {
                    setTab("runs");
                    setRunView({ kind: "run", runId });
                }}
                open={runOpen}
            />

            <ConfirmDialog
                confirmLabel={t`Delete`}
                description={t`Past runs keep their results for this case.`}
                loading={deleteCase.isPending}
                onConfirm={() => confirmCaseDelete()}
                onOpenChange={(open) => !open && setPendingCaseDelete(null)}
                open={pendingCaseDelete !== null}
                title={t`Delete this case?`}
            />
        </section>
    );
};

export default DatasetPanel;
