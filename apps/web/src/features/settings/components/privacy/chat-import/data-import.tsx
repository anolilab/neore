"use client";

import type { I18n } from "@lingui/core";
import { Plural, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import { Progress, ProgressValue } from "@neore/ui/components/progress";
import { formatDate } from "@neore/ui/utils/locale-format";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import { trackEvent } from "@/lib/analytics";
import { useCRPC } from "@/lib/lunora/crpc";
import { uploadFile } from "@/lib/upload/upload-file";

import { ChatImportError, extractJsonFromFile, parseExportFile } from "./parsers";
import type { ImportProvider, NormalizedConversation } from "./parsers/types";

/** An export with nothing in it: an empty array or object. */
/** An export with nothing in it. An object file arrives wrapped once more, so `[{}]` counts too. */
const isEmptyExport = (value: unknown): boolean => {
    const unwrapped = Array.isArray(value) && value.length === 1 ? (value[0] as unknown) : value;

    return (
        (Array.isArray(unwrapped) && unwrapped.length === 0) ||
        (typeof unwrapped === "object" && unwrapped !== null && !Array.isArray(unwrapped) && Object.keys(unwrapped).length === 0)
    );
};

const PROVIDER_LABELS: Record<ImportProvider, string> = {
    chatgpt: "ChatGPT",
    claude: "Claude",
    "claude-code": "Claude Code",
    codex: "Codex CLI",
    gemini: "Google Gemini",
};

type ImportState =
    | { step: "idle" }
    | { step: "parsing" }
    | { conversations: NormalizedConversation[]; provider: ImportProvider; skipped: string[]; step: "preview" }
    | { provider: ImportProvider; step: "uploading" }
    | { jobId: string; provider: ImportProvider; step: "importing" }
    | { failed: number; imported: number; provider: ImportProvider; step: "done" }
    | { message: string; step: "error" };

/** The user-facing text of an import failure: translated for our own errors, the raw message otherwise. */
const importErrorMessage = (error: unknown, i18n: I18n, fallback: string): string => {
    if (error instanceof ChatImportError) {
        return i18n._(error.descriptor);
    }

    return error instanceof Error && error.message ? error.message : fallback;
};

const describeError = (error: unknown, i18n: I18n): string => {
    if (error instanceof ChatImportError) {
        return i18n._(error.descriptor);
    }

    return error instanceof Error ? error.message : String(error);
};

const DataImport: FC = () => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [state, setState] = useState<ImportState>({ step: "idle" });

    const { data: importStatus } = useQuery(crpc.chat_import.functions.getImportStatus.queryOptions({}));

    // Read the job fields as scalars: the query object is a fresh reference on every
    // poll, so depending on it directly would re-run the effects below on each tick.
    const activeJobId = importStatus?._id;
    const jobProvider = importStatus?.provider;
    const jobStatus = importStatus?.status;
    const jobImported = importStatus?.importedConversations;
    const jobFailed = importStatus?.failedConversations;
    const jobErrorMessage = importStatus?.errorMessage;

    const { mutateAsync: startImportJob } = useMutation(crpc.chat_import.functions.startImportJob.mutationOptions());
    const { mutateAsync: cancelImportJob } = useMutation(crpc.chat_import.functions.cancelImportJob.mutationOptions());

    // Resume active import on mount — if the server shows a "processing" job
    // and the local state is idle, the user likely refreshed the page mid-import.
    useEffect(() => {
        if (state.step !== "idle" || jobStatus !== "processing" || activeJobId === undefined) {
            return;
        }

        setState({
            jobId: activeJobId,
            provider: (jobProvider as ImportProvider) || "chatgpt",
            step: "importing",
        });
    }, [state.step, jobStatus, activeJobId, jobProvider]);

    // Watch import status and transition to done/error when workflow completes
    useEffect(() => {
        if (state.step !== "importing" || jobStatus === undefined) {
            return;
        }

        if (jobStatus === "completed") {
            const imported = jobImported ?? 0;
            const failed = jobFailed ?? 0;
            const { provider } = state as { provider: ImportProvider };

            setState({ failed, imported, provider, step: "done" });

            if (failed > 0) {
                trackEvent("chat_import_failed", { error_type: "partial_failure", provider });
            } else {
                trackEvent("chat_import_completed", { conversation_count: imported, provider });
            }

            if (imported > 0) {
                toast.success(t`Successfully imported ${imported} conversations from ${PROVIDER_LABELS[provider]}`);
            }
        } else if (jobStatus === "failed") {
            setState({
                message: jobErrorMessage ?? t`Import failed`,
                step: "error",
            });
        }
    }, [state, jobStatus, jobImported, jobFailed, jobErrorMessage, t]);

    const handleFileSelect = useCallback(
        async (event: React.ChangeEvent<HTMLInputElement>) => {
            const input = event.target;
            const files = [...(input.files ?? [])];

            if (files.length === 0) {
                return;
            }

            // Reset input so same file can be re-selected
            input.value = "";

            setState({ step: "parsing" });

            try {
                const extracted = await Promise.all(
                    files.map(async (file) => {
                        try {
                            return { name: file.name, records: await extractJsonFromFile(file) };
                        } catch (error) {
                            // A damaged file is named, so the message says which upload to fix.
                            throw new Error(`${file.name}: ${describeError(error, i18n)}`, { cause: error });
                        }
                    }),
                );
                const jsonDataArray = extracted.flatMap(({ name, records }) =>
                    records.map((jsonData) => {
                        return { jsonData, name };
                    }),
                );

                // Each file is detected on its own: a shared hint would parse a second
                // format with the first one's parser and drop its sessions silently.
                // An empty file in an archive (`[]`, `{}`) carries nothing to import and must not block the rest.
                // A file that is not a recognised export is skipped and named in the preview. Only when nothing
                // in the selection parses does the import fail, with the first file's reason.
                const results: ReturnType<typeof parseExportFile>[] = [];
                const skipped: string[] = [];
                let firstFailure: Error | undefined;

                const candidates = jsonDataArray.filter(({ jsonData: value }) => !isEmptyExport(value));

                for (const { jsonData, name } of candidates) {
                    try {
                        results.push(parseExportFile(jsonData));
                    } catch (error) {
                        skipped.push(name);
                        firstFailure ??= new Error(`${name}: ${describeError(error, i18n)}`, { cause: error });
                    }
                }

                if (results.length === 0 && firstFailure) {
                    throw firstFailure;
                }

                const providers = new Set(results.map((result) => result.provider));

                // One import job carries one provider, so a mixed selection cannot run.
                if (providers.size > 1) {
                    setState({ message: t`Import one kind of export at a time.`, step: "error" });

                    return;
                }

                const [detectedProvider] = providers;
                const allConversations = results.flatMap((result) => result.conversations);

                if (!detectedProvider || allConversations.length === 0) {
                    setState({ message: t`No conversations found in the file.`, step: "error" });

                    return;
                }

                setState({
                    conversations: allConversations,
                    provider: detectedProvider,
                    skipped: [...new Set(skipped)],
                    step: "preview",
                });
            } catch (error: unknown) {
                setState({ message: importErrorMessage(error, i18n, t`Failed to parse file`), step: "error" });
            }
        },
        [i18n, t],
    );

    const handleStartImport = useCallback(async () => {
        if (state.step !== "preview") {
            return;
        }

        const { conversations, provider } = state;

        setState({ provider, step: "uploading" });

        try {
            // 1. Send the normalized conversations JSON to the upload route. An
            // upload nobody starts a job for is reaped by the backend.
            const uploadId = await uploadFile(new File([JSON.stringify(conversations)], "import.json", { type: "application/json" }), {
                contentType: "application/json",
            });

            // 2. Start the server-side import workflow
            const { jobId } = await startImportJob({
                provider,
                totalConversations: conversations.length,
                uploadId,
            });

            trackEvent("chat_import_started", { conversation_count: conversations.length, provider });

            // 3. Switch to importing state — progress tracked via reactive query
            setState({ jobId, provider, step: "importing" });
        } catch (error: any) {
            setState({ message: error?.message || t`Failed to start import`, step: "error" });
        }
    }, [state, startImportJob, t]);

    const handleCancel = useCallback(async () => {
        if (state.step !== "importing") {
            return;
        }

        try {
            await cancelImportJob({ jobId: (state as { jobId: string }).jobId });
            toast.success(t`Import cancelled`);
        } catch {
            // Cancellation is best-effort; the status poll will pick up the final state
        }
    }, [state, cancelImportJob, t]);

    const handleReset = useCallback(() => {
        setState({ step: "idle" });
    }, []);

    // Progress from the server-side workflow
    const serverProgress = state.step === "importing" ? (importStatus?.progress ?? 0) : 0;

    return (
        <SettingsCard
            description={t`Import conversations from ChatGPT, Google Gemini, Claude, or local Claude Code and Codex CLI sessions. Upload your exported JSON or ZIP file, or session .jsonl files.`}
            title={t`Import Conversations`}
        >
            <CardContent className="space-y-4">
                {/* Hidden file input */}
                <input accept=".json,.jsonl,.zip" className="hidden" multiple onChange={handleFileSelect} ref={fileInputRef} type="file" />

                {/* Idle state */}
                {state.step === "idle" && (
                    <div className="space-y-3">
                        <p className="text-muted-foreground text-sm">
                            {t`Supported formats: ChatGPT export (conversations.json), Google Gemini (Takeout ZIP), Claude.ai export.`}
                        </p>
                        <Button onClick={() => fileInputRef.current?.click()} variant="default">
                            {t`Select File`}
                        </Button>
                    </div>
                )}

                {/* Parsing state */}
                {state.step === "parsing" && <div className="text-muted-foreground text-sm">{t`Parsing file...`}</div>}

                {/* Preview state */}
                {state.step === "preview" && (
                    <div className="space-y-3">
                        <div className="bg-muted rounded-lg p-4 text-sm">
                            <p className="font-medium">{t`Detected: ${PROVIDER_LABELS[state.provider]}`}</p>
                            <p className="text-muted-foreground mt-1">{t`${state.conversations.length} conversations found`}</p>
                            {state.skipped.length > 0 && (
                                <p className="text-muted-foreground mt-1" role="status">
                                    {t`Skipped files that are not chat exports: ${state.skipped.join(", ")}`}
                                </p>
                            )}
                            {state.conversations.length > 0 && (
                                <div className="text-muted-foreground mt-2 max-h-32 space-y-1 overflow-y-auto">
                                    {state.conversations.slice(0, 10).map((c, i) => (
                                        <div className="truncate text-xs" key={i}>
                                            {c.title} (<Plural one="# message" other="# messages" value={c.messages.length} />)
                                        </div>
                                    ))}
                                    {state.conversations.length > 10 && (
                                        <div className="text-xs italic">{t`...and ${state.conversations.length - 10} more`}</div>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <Button onClick={handleStartImport}>{t`Import All`}</Button>
                            <Button onClick={handleReset} variant="outline">
                                {t`Cancel`}
                            </Button>
                        </div>
                    </div>
                )}

                {/* Uploading state */}
                {state.step === "uploading" && (
                    <div className="text-muted-foreground text-sm">{t`Uploading data for import from ${PROVIDER_LABELS[state.provider]}...`}</div>
                )}

                {/* Importing state — progress from server */}
                {state.step === "importing" && (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span>{t`Importing from ${PROVIDER_LABELS[state.provider]}...`}</span>
                            <span>{serverProgress}%</span>
                        </div>
                        <Progress value={serverProgress}>
                            <ProgressValue />
                        </Progress>
                        <p className="text-muted-foreground text-xs">
                            {importStatus
                                ? t`${importStatus.importedConversations} of ${importStatus.totalConversations} conversations imported`
                                : t`Starting import...`}
                            {importStatus && (importStatus.failedConversations ?? 0) > 0 && <> {t`(${jobFailed} failed)`}</>}
                        </p>
                        <Button onClick={handleCancel} size="sm" variant="outline">
                            {t`Cancel Import`}
                        </Button>
                    </div>
                )}

                {/* Done state */}
                {state.step === "done" && (
                    <div className="space-y-3">
                        <div className="bg-muted rounded-lg p-4 text-sm">
                            <p className="font-medium">{t`Import complete!`}</p>
                            <p className="text-muted-foreground mt-1">{t`${state.imported} conversations imported from ${PROVIDER_LABELS[state.provider]}`}</p>
                            {state.failed > 0 && <p className="text-destructive mt-1">{t`${state.failed} conversations failed to import`}</p>}
                        </div>
                        <Button onClick={handleReset} variant="outline">
                            {t`Import More`}
                        </Button>
                    </div>
                )}

                {/* Error state */}
                {state.step === "error" && (
                    <div className="space-y-3">
                        <div className="bg-destructive/10 text-destructive rounded-lg p-4 text-sm">
                            <p className="font-medium">{t`Import failed`}</p>
                            <p className="mt-1">{state.message}</p>
                        </div>
                        <Button onClick={handleReset} variant="outline">
                            {t`Try Again`}
                        </Button>
                    </div>
                )}

                {/* Show last import status if available and we're idle */}
                {state.step === "idle" && importStatus && importStatus.status === "completed" && (
                    <div className="text-muted-foreground text-xs">
                        {t`Last import: ${importStatus.importedConversations} conversations from ${PROVIDER_LABELS[importStatus.provider as ImportProvider] ?? importStatus.provider} on ${formatDate(importStatus.createdAt, i18n.locale)}`}
                    </div>
                )}
            </CardContent>
        </SettingsCard>
    );
};

export default DataImport;
