"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@neore/ui/components/empty";
import cn from "@neore/ui/utils/cn";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FlaskConical, Plus } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

import type { EvalDataset } from "../lib/evals-format";
import type { DatasetFormValues } from "./dataset-form-dialog";
import DatasetFormDialog from "./dataset-form-dialog";
import DatasetPanel from "./dataset-panel";

/**
 * The /evals page: datasets of test cases on the left, the selected dataset's
 * cases, runs, per-case results and run comparison on the right.
 */
const EvalsPage = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const navId = useId();

    const { data: datasets, isLoading } = useQuery(crpc.evals.functions.listDatasets.queryOptions({}));
    const createDataset = useMutation(crpc.evals.functions.createDataset.mutationOptions());
    const updateDataset = useMutation(crpc.evals.functions.updateDataset.mutationOptions());
    const deleteDataset = useMutation(crpc.evals.functions.deleteDataset.mutationOptions());

    const [selectedId, setSelectedId] = useState<Id<"evalDatasets"> | null>(null);
    const [datasetDialog, setDatasetDialog] = useState<{ editing: EvalDataset | null; open: boolean }>({ editing: null, open: false });
    const [pendingDelete, setPendingDelete] = useState<EvalDataset | null>(null);

    const list = datasets ?? [];
    const selected = list.find((dataset) => dataset._id === selectedId) ?? list[0] ?? null;

    const submitDataset = async (values: DatasetFormValues) => {
        const description = values.description.trim() || undefined;

        if (datasetDialog.editing) {
            await updateDataset.mutateAsync({ datasetId: datasetDialog.editing._id, description, judgeEnabled: values.judgeEnabled, name: values.name.trim() });
        } else {
            const { datasetId } = await createDataset.mutateAsync({
                description,
                judgeEnabled: values.judgeEnabled,
                kind: values.kind,
                name: values.name.trim(),
            });

            setSelectedId(datasetId);
        }
    };

    const confirmDelete = async () => {
        if (!pendingDelete) {
            return;
        }

        try {
            await deleteDataset.mutateAsync({ datasetId: pendingDelete._id });

            if (selectedId === pendingDelete._id) {
                setSelectedId(null);
            }

            setPendingDelete(null);
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Failed to delete the dataset`);
        }
    };

    return (
        <div className="mx-auto max-w-7xl space-y-6">
            <header className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1">
                    <h1 className="text-xl font-semibold">{t`Evals`}</h1>
                    <p className="text-muted-foreground text-sm">
                        {t`Test your agents, models and knowledge base against a fixed set of cases, score every answer, and catch regressions between runs.`}
                    </p>
                </div>
                <Button onClick={() => setDatasetDialog({ editing: null, open: true })}>
                    <Plus aria-hidden />
                    {t`New dataset`}
                </Button>
            </header>

            {isLoading && (
                <p className="text-muted-foreground text-sm" role="status">
                    {t`Loading datasets…`}
                </p>
            )}

            {datasets && list.length === 0 && (
                <Empty>
                    <EmptyHeader>
                        <EmptyMedia variant="icon">
                            <FlaskConical aria-hidden />
                        </EmptyMedia>
                        <EmptyTitle>{t`No datasets yet`}</EmptyTitle>
                        <EmptyDescription>
                            {t`Create a dataset of test cases — each an input, and optionally an expected answer, a rubric, checks, or the documents it should be answered from.`}
                        </EmptyDescription>
                    </EmptyHeader>
                </Empty>
            )}

            {list.length > 0 && selected && (
                <div className="flex flex-col gap-6 md:flex-row">
                    <nav aria-labelledby={navId} className="md:w-64 md:shrink-0">
                        <h2 className="text-muted-foreground mb-2 text-xs font-medium" id={navId}>
                            {t`Datasets`}
                        </h2>
                        <ul className="space-y-1">
                            {list.map((dataset) => {
                                const isCurrent = dataset._id === selected._id;

                                return (
                                    <li key={dataset._id}>
                                        <button
                                            aria-current={isCurrent ? "true" : undefined}
                                            className={cn(
                                                "hover:bg-muted focus-visible:ring-ring w-full rounded-md px-3 py-2 text-left text-sm outline-none focus-visible:ring-2",
                                                isCurrent && "bg-muted font-medium",
                                            )}
                                            onClick={() => setSelectedId(dataset._id)}
                                            type="button"
                                        >
                                            <span className="block truncate">{dataset.name}</span>
                                            <span className="text-muted-foreground block text-xs">
                                                {dataset.kind === "rag"
                                                    ? t`Retrieval · ${String(dataset.caseCount)} cases`
                                                    : t`Agent · ${String(dataset.caseCount)} cases`}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </nav>

                    <DatasetPanel
                        dataset={selected}
                        key={selected._id}
                        onDelete={() => setPendingDelete(selected)}
                        onEdit={() => setDatasetDialog({ editing: selected, open: true })}
                    />
                </div>
            )}

            <DatasetFormDialog
                editing={datasetDialog.editing}
                onClose={() => setDatasetDialog({ editing: null, open: false })}
                onSubmit={submitDataset}
                open={datasetDialog.open}
            />

            <ConfirmDialog
                confirmLabel={t`Delete`}
                description={t`The dataset, its cases and every run of it are removed.`}
                loading={deleteDataset.isPending}
                onConfirm={() => confirmDelete()}
                onOpenChange={(open) => !open && setPendingDelete(null)}
                open={pendingDelete !== null}
                title={t`Delete dataset "${pendingDelete?.name ?? ""}"?`}
            />
        </div>
    );
};

export default EvalsPage;
