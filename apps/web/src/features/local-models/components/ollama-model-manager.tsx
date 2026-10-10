"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack } from "@neore/ui/components/progress";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, ListRestart, Loader2, RefreshCw, Square, Trash2 } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import type { OllamaModelInfo } from "../lib/local-client";
import { deleteOllamaModel, detectOllama, listOllamaModels, pullOllamaModel } from "../lib/local-client";
import type { LocalErrorInfo } from "../lib/local-errors";
import { describeLocalError, diagnoseLocalError } from "../lib/local-errors";
import type { PullProgress } from "../lib/ollama-pull";
import { formatBytes, isValidOllamaModelName } from "../lib/ollama-pull";

interface OllamaModelManagerProps {
    baseUrl: string;
    /** Replace the picker's list with what is installed. */
    onSyncPicker: (modelIds: string[]) => Promise<void>;
    /** The ids the endpoint currently offers in the model picker. */
    pickerModelIds: ReadonlyArray<string>;
}

type PullState = { error?: string; name: string; progress?: PullProgress; status: "failed" | "pulling" } | { status: "idle" };

/**
 * Installed models on the user's own Ollama, managed from the browser:
 * list (`/api/tags`), pull with progress (`/api/pull`), delete
 * (`/api/delete`). Every call goes straight to the user's machine.
 */
const OllamaModelManager: FC<OllamaModelManagerProps> = ({ baseUrl, onSyncPicker, pickerModelIds }) => {
    const { i18n, t } = useLingui();
    const queryClient = useQueryClient();
    const fieldId = useId();
    const [pullName, setPullName] = useState("");
    const [pull, setPull] = useState<PullState>({ status: "idle" });
    const [deleting, setDeleting] = useState<OllamaModelInfo | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [diagnosis, setDiagnosis] = useState<LocalErrorInfo | null>(null);
    const pullAbortRef = useRef<AbortController | null>(null);
    const queryKey = ["local-models", "ollama-tags", baseUrl] as const;

    const version = useQuery({
        queryFn: async () => (await detectOllama(baseUrl)) ?? null,
        queryKey: ["local-models", "ollama-version", baseUrl],
        retry: false,
    });
    const isOllama = Boolean(version.data);
    const models = useQuery({ enabled: isOllama, queryFn: async () => await listOllamaModels(baseUrl), queryKey, retry: false });

    // A pull left running when the panel closes would keep downloading unseen.
    useEffect(() => () => pullAbortRef.current?.abort(), []);

    useEffect(() => {
        const error = version.error ?? models.error;

        if (!error) {
            setDiagnosis(null);

            return undefined;
        }

        let isCurrent = true;

        const diagnose = async () => {
            const info = await diagnoseLocalError(error, baseUrl);

            if (isCurrent) {
                setDiagnosis(info);
            }
        };

        void diagnose();

        return () => {
            isCurrent = false;
        };
    }, [baseUrl, models.error, version.error]);

    const refresh = useCallback(async () => {
        await queryClient.invalidateQueries({ queryKey: ["local-models"] });
    }, [queryClient]);

    const startPull = useCallback(async () => {
        const name = pullName.trim();

        if (!isValidOllamaModelName(name)) {
            toast.error(t`Enter a model name such as llama3.2 or qwen3:8b`);

            return;
        }

        const controller = new AbortController();

        pullAbortRef.current = controller;
        setPull({ name, status: "pulling" });

        try {
            await pullOllamaModel(baseUrl, name, (progress) => setPull({ name, progress, status: "pulling" }), controller.signal);
            setPull({ status: "idle" });
            setPullName("");
            toast.success(t`${name} is installed`);
            await refresh();
        } catch (error) {
            if (controller.signal.aborted) {
                setPull({ status: "idle" });

                return;
            }

            const info = await diagnoseLocalError(error, baseUrl);

            setPull({
                error: i18n._(describeLocalError(info.kind === "unknown" && error instanceof Error ? { ...info, detail: error.message } : info)),
                name,
                status: "failed",
            });
        } finally {
            pullAbortRef.current = null;
        }
    }, [baseUrl, i18n, pullName, refresh, t]);

    const confirmDelete = useCallback(async () => {
        if (!deleting) {
            return;
        }

        setIsDeleting(true);

        try {
            await deleteOllamaModel(baseUrl, deleting.name);
            toast.success(t`${deleting.name} deleted`);
            await refresh();
        } catch (error) {
            const info = await diagnoseLocalError(error, baseUrl);

            toast.error(i18n._(describeLocalError(info)));
        } finally {
            setIsDeleting(false);
            setDeleting(null);
        }
    }, [baseUrl, deleting, i18n, refresh, t]);

    if (version.isPending) {
        return (
            <p className="text-muted-foreground flex items-center gap-2 text-xs" role="status">
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                {t`Looking for Ollama at ${baseUrl}…`}
            </p>
        );
    }

    if (!isOllama) {
        return (
            <div className="space-y-2 text-xs" role="status">
                <p className={diagnosis ? "text-destructive" : "text-muted-foreground"}>
                    {diagnosis
                        ? i18n._(describeLocalError(diagnosis))
                        : t`This endpoint is not Ollama. Model management is available for Ollama only — in LM Studio, download models in the app.`}
                </p>
                <Button
                    onClick={() => {
                        void refresh();
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                >
                    <RefreshCw aria-hidden="true" className="mr-1 size-4" />
                    {t`Retry`}
                </Button>
            </div>
        );
    }

    const installedIds = (models.data ?? []).map((model) => model.name);
    const isPickerInSync = installedIds.length === pickerModelIds.length && installedIds.every((id) => pickerModelIds.includes(id));
    const pullPercent = pull.status === "pulling" ? pull.progress?.percent : undefined;

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground text-xs">{t`Ollama ${version.data ?? ""} · ${installedIds.length} installed`}</p>
                <div className="flex gap-1">
                    <Button
                        aria-label={t`Refresh installed models`}
                        onClick={() => {
                            void refresh();
                        }}
                        size="sm"
                        type="button"
                        variant="ghost"
                    >
                        <RefreshCw aria-hidden="true" className="size-4" />
                    </Button>
                    <Button
                        aria-busy={isSyncing}
                        disabled={isSyncing || isPickerInSync || installedIds.length === 0}
                        onClick={async () => {
                            setIsSyncing(true);

                            try {
                                await onSyncPicker(installedIds);
                            } finally {
                                setIsSyncing(false);
                            }
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                    >
                        <ListRestart aria-hidden="true" className="mr-1 size-4" />
                        {isPickerInSync ? t`Picker up to date` : t`Show installed models in picker`}
                    </Button>
                </div>
            </div>

            {diagnosis && (
                <p className="text-destructive flex items-start gap-2 text-xs" role="alert">
                    <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    {i18n._(describeLocalError(diagnosis))}
                </p>
            )}

            {models.data && models.data.length > 0 && (
                <ul aria-label={t`Installed models`} className="divide-y rounded-md border">
                    {models.data.map((model) => (
                        <li className="flex items-center justify-between gap-3 px-3 py-2" key={model.name}>
                            <div className="min-w-0">
                                <p className="truncate font-mono text-sm">{model.name}</p>
                                <div className="mt-1 flex flex-wrap gap-1">
                                    <Badge className="text-xs" variant="secondary">
                                        {formatBytes(model.size)}
                                    </Badge>
                                    {model.parameterSize && (
                                        <Badge className="text-xs" variant="outline">
                                            {model.parameterSize}
                                        </Badge>
                                    )}
                                    {model.quantization && (
                                        <Badge className="text-xs" variant="outline">
                                            {model.quantization}
                                        </Badge>
                                    )}
                                </div>
                            </div>
                            <Button aria-label={t`Delete ${model.name}`} onClick={() => setDeleting(model)} size="sm" type="button" variant="ghost">
                                <Trash2 aria-hidden="true" className="text-destructive size-4" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            {models.data?.length === 0 && <p className="text-muted-foreground text-xs">{t`No models installed yet.`}</p>}

            <form
                className="space-y-2"
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    void startPull();
                }}
            >
                <Label className="text-xs" htmlFor={`${fieldId}-pull`}>
                    {t`Download a model`}
                </Label>
                <div className="flex gap-2">
                    <Input
                        aria-describedby={`${fieldId}-pull-hint`}
                        autoComplete="off"
                        className="font-mono text-sm"
                        disabled={pull.status === "pulling"}
                        id={`${fieldId}-pull`}
                        onChange={(event) => setPullName(event.target.value)}
                        placeholder="llama3.2:3b"
                        value={pullName}
                    />
                    {pull.status === "pulling" ? (
                        <Button onClick={() => pullAbortRef.current?.abort()} size="sm" type="button" variant="outline">
                            <Square aria-hidden="true" className="mr-1 size-4" />
                            {t`Cancel`}
                        </Button>
                    ) : (
                        <Button disabled={!pullName.trim()} size="sm" type="submit">
                            <Download aria-hidden="true" className="mr-1 size-4" />
                            {t`Pull`}
                        </Button>
                    )}
                </div>
                <p className="text-muted-foreground text-xs" id={`${fieldId}-pull-hint`}>
                    {t`Any name from ollama.com/library, e.g. llama3.2, qwen3:8b or gemma3:4b. Downloads run on your computer and can take a while.`}
                </p>

                <div aria-live="polite" role="status">
                    {pull.status === "pulling" && (
                        <Progress value={pullPercent ?? null}>
                            <ProgressLabel className="text-muted-foreground text-xs font-normal">
                                {pull.progress?.total
                                    ? t`${pull.progress.status} — ${formatBytes(pull.progress.completed ?? 0)} of ${formatBytes(pull.progress.total)}`
                                    : (pull.progress?.status ?? t`Starting ${pull.name}…`)}
                            </ProgressLabel>
                            <ProgressTrack>
                                <ProgressIndicator />
                            </ProgressTrack>
                        </Progress>
                    )}
                    {pull.status === "failed" && (
                        <p className="text-destructive flex items-start gap-2 text-xs">
                            <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                            {t`Could not pull ${pull.name}: ${pull.error ?? ""}`}
                        </p>
                    )}
                </div>
            </form>

            <ConfirmDialog
                confirmLabel={t`Delete`}
                description={t`This removes the model files from your computer. You can pull it again later.`}
                loading={isDeleting}
                onConfirm={confirmDelete}
                onOpenChange={(open) => !open && !isDeleting && setDeleting(null)}
                open={deleting !== null}
                title={deleting ? t`Delete ${deleting.name}?` : t`Delete model?`}
            />
        </div>
    );
};

export default OllamaModelManager;
