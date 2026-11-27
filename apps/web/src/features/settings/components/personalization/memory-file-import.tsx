"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { MEMORY_FILE_MAX_BYTES } from "@neore/backend/memory/import-file-limits";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack } from "@neore/ui/components/progress";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ChangeEvent, FC } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";
import { notifyNative } from "@/lib/native/bridge";

interface ImportCounts {
    duplicates: number;
    imported: number;
    invalid: number;
    tooLong: number;
    updated: number;
}

type JobStatus = "done" | "failed" | "queued" | "running";

interface JobProgress extends ImportCounts {
    done: number;
    error?: string;
    jobId: Id<"memoryImportJobs">;
    status: JobStatus;
    total: number;
}

interface WatchedJob {
    /** The job the progress query held when this start was answered: until the query shows this job, that one is "before". */
    before?: Id<"memoryImportJobs">;
    jobId: Id<"memoryImportJobs">;
    /** The progress query has answered with this job. */
    seen: boolean;
    total: number;
}

type FileFormat = "json" | "text";

interface MemoryFileImportProps {
    memoryEnabled: boolean;
    /** Called when memories were written: an inline import answered, or a background import ended. */
    onImported: () => void;
}

/** How long a started import's job may take to show up in the progress query before the page says it cannot see it. */
const JOB_APPEARS_WITHIN_MS = 10_000;

const NO_COUNTS: ImportCounts = { duplicates: 0, imported: 0, invalid: 0, tooLong: 0, updated: 0 };

const isActive = (status: JobStatus): boolean => status === "queued" || status === "running";

/**
 * The job to watch once the progress query has answered, or `undefined` to keep the current one.
 *
 * A job found running on load, or started in another tab, is shown and can be cancelled: the server refuses a second one.
 * Once the watched job was seen, any other job the query returns is a newer one: it replaces the watched job even when it has
 * already ended, so the page shows how it ended. A watched job not yet seen is this page's own start: only the job the query
 * held when the start was answered (`before`) is still "before it"; any other job is a newer one. Nothing else is adopted
 * while this page's own import is starting (`busy`): if that one fails, its error is the only one shown.
 */
const adoptJob = (live: JobProgress | undefined, watched: WatchedJob | undefined, busy: boolean): WatchedJob | undefined => {
    if (!live) {
        return undefined;
    }

    if (watched?.jobId === live.jobId) {
        return watched.seen ? undefined : { ...watched, seen: true };
    }

    if (busy) {
        return undefined;
    }

    const isNewer = watched === undefined ? isActive(live.status) : watched.seen || live.jobId !== watched.before;

    return isNewer ? { jobId: live.jobId, seen: true, total: live.total } : undefined;
};

/** The format the server parses the file as, from its name; `undefined` for any other kind of file. */
const formatOf = (name: string): FileFormat | undefined => {
    const lower = name.toLowerCase();

    if (lower.endsWith(".json")) {
        return "json";
    }

    return lower.endsWith(".txt") ? "text" : undefined;
};

/** The file's text, or `undefined` when the browser cannot read it. */
const readFileText = async (file: File): Promise<string | undefined> => {
    try {
        return await file.text();
    } catch {
        return undefined;
    }
};

/**
 * Brings in memories from a `.txt` (one per line) or `.json` file. A small file answers with its counts at once; a larger
 * one starts a background import whose progress is read live and which can be cancelled. The server parses and bounds the
 * file again: the size check here only saves sending a file it would refuse.
 */
const MemoryFileImport: FC<MemoryFileImportProps> = ({ memoryEnabled, onImported }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const fileId = useId();
    const helpId = useId();
    const offId = useId();
    const fileErrorId = useId();
    const importButton = useRef<HTMLButtonElement>(null);
    const outcome = useRef<HTMLDivElement>(null);
    const [file, setFile] = useState<File | null>(null);
    // Remounts the file control after an import: picking the same file again then fires a change.
    const [inputKey, setInputKey] = useState(0);
    const [fileError, setFileError] = useState<string | undefined>(undefined);
    const [isReading, setIsReading] = useState(false);
    const [result, setResult] = useState<ImportCounts | undefined>(undefined);
    const [importError, setImportError] = useState<string | undefined>(undefined);
    // The background import this page started, or found running. Only its end is shown: the progress query answers with the
    // latest job, which may be one that ended days ago.
    const [watched, setWatched] = useState<WatchedJob | undefined>(undefined);
    // The progress query answered after a start without showing the job it returned.
    const [startUnconfirmed, setStartUnconfirmed] = useState(false);
    const [retries, setRetries] = useState(0);

    const maxSize = `${i18n.number(MEMORY_FILE_MAX_BYTES / 1000)} KB`;

    const {
        data: progress,
        error: progressError,
        isError: isProgressError,
        refetch: refetchProgress,
    } = useQuery({
        ...crpc.memory.import_job.getMemoryImportProgress.queryOptions({}),
        enabled: memoryEnabled,
    });

    // `null` is an answer ("no job yet"); only `undefined` means the query has not answered. An import starts only from an
    // answered query: the job it finds then is the one "before" this start.
    const baselineReady = progress !== undefined;

    const { isPending: isImporting, mutate: runImport } = useMutation({ ...useLunoraActionOptions(api.memory.import.importMemoryFile) });
    const { isPending: isCancelling, mutate: runCancel } = useMutation({ ...crpc.memory.import_job.cancelMemoryImport.mutationOptions() });

    // With memory off the query is disabled: its cached answer is out of date, so it is not read until memory is on again.
    const live = memoryEnabled ? (progress ?? undefined) : undefined;

    const latestJobId = useRef<Id<"memoryImportJobs"> | undefined>(undefined);
    const liveJobId = live?.jobId;

    useEffect(() => {
        latestJobId.current = liveJobId;
    }, [liveJobId]);

    const adopted = adoptJob(live, watched, isImporting || isReading);

    if (adopted) {
        setWatched(adopted);
    }

    const job: JobProgress | undefined = live && watched?.jobId === live.jobId ? live : undefined;
    // Answered by the action, not yet seen by the progress query.
    const isStarting = memoryEnabled && watched !== undefined && job === undefined;
    const jobRunning = job === undefined ? isStarting : isActive(job.status);
    const running = isImporting || isReading || jobRunning;
    const jobEnded = job !== undefined && !isActive(job.status);
    const endedKey = jobEnded ? `${job.jobId}:${job.status}` : undefined;
    // Also changes when the final counts are written, so `onImported` runs after them and not only at the status change.
    const refreshKey = jobEnded ? `${endedKey}:${job.done}:${job.imported}:${job.updated}:${job.duplicates}:${job.tooLong}:${job.invalid}` : undefined;
    const errorKey = importError ? `error:${importError}` : undefined;
    const outcomeKey = result ? "result" : (endedKey ?? errorKey);
    const processed = job?.done ?? 0;
    const entries = job?.total ?? watched?.total ?? 0;
    const disabled = !memoryEnabled || running;
    // The query failed and gave this page nothing to show: no answer at all, or none for the job this page is waiting on.
    const progressFailed =
        memoryEnabled &&
        job === undefined &&
        ((isProgressError && (watched !== undefined || progress === undefined)) || (startUnconfirmed && watched !== undefined));

    useEffect(() => {
        if (refreshKey) {
            onImported();
        }
    }, [refreshKey, onImported]);

    // The query shows a start's job through its live push, which can trail the start's answer: wait a while for it, then stop
    // waiting and say so. `retries` re-arms the wait after "Try again".
    const waitingForJob = memoryEnabled && watched !== undefined && job === undefined;

    useEffect(() => {
        if (!waitingForJob) {
            setStartUnconfirmed(false);

            return undefined;
        }

        const timer = setTimeout(() => {
            setStartUnconfirmed(true);
        }, JOB_APPEARS_WITHIN_MS);

        return () => {
            clearTimeout(timer);
        };
    }, [waitingForJob, retries]);

    // The job this page started or saw running: only its end is announced to the shell, never one that was already over.
    const announceable = useRef<Id<"memoryImportJobs"> | undefined>(undefined);
    const jobId = job?.jobId;
    const jobStatus = job?.status;

    useEffect(() => {
        if (!jobId || !jobStatus) {
            return;
        }

        if (isActive(jobStatus)) {
            announceable.current = jobId;

            return;
        }

        if (announceable.current === jobId) {
            announceable.current = undefined;
            void notifyNative({ title: jobStatus === "done" ? t`Memory import finished` : t`Memory import stopped` });
        }
    }, [jobId, jobStatus, t]);

    // The control the person used is disabled or gone once an import ends: the result takes focus then, never from elsewhere.
    useEffect(() => {
        if (!outcomeKey) {
            return;
        }

        const active = document.activeElement;

        if (!active || active === document.body || active === importButton.current) {
            outcome.current?.focus();
        }
    }, [outcomeKey]);

    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const picked = event.target.files?.[0] ?? null;

        setResult(undefined);
        setImportError(undefined);

        if (!picked) {
            setFile(null);
            setFileError(undefined);

            return;
        }

        if (picked.size > MEMORY_FILE_MAX_BYTES) {
            setFile(null);
            setFileError(t`The file is larger than ${maxSize}. Choose a smaller file.`);

            return;
        }

        if (!formatOf(picked.name)) {
            setFile(null);
            setFileError(t`Choose a .txt or .json file.`);

            return;
        }

        setFileError(undefined);
        setFile(picked);
    };

    const retryProgress = () => {
        setStartUnconfirmed(false);
        setRetries((count) => count + 1);
        void refetchProgress();
    };

    const startImport = async () => {
        const format = file ? formatOf(file.name) : undefined;

        if (!file || !format || !baselineReady) {
            return;
        }

        setResult(undefined);
        setImportError(undefined);
        setWatched(undefined);
        setStartUnconfirmed(false);
        setIsReading(true);

        const content = await readFileText(file);

        setIsReading(false);

        if (content === undefined) {
            setImportError(t`Could not read the file.`);

            return;
        }

        // Read before the request is sent: a job that shows up while it runs is then newer than this start, not "before" it.
        const before = latestJobId.current;

        runImport(
            { content, format },
            {
                onError: (error: Error) => {
                    setImportError(error.message || t`Could not import the file.`);
                },
                onSuccess: (response) => {
                    setFile(null);
                    setInputKey((key) => key + 1);

                    if ("jobId" in response) {
                        announceable.current = response.jobId;
                        setWatched({ before, jobId: response.jobId, seen: false, total: response.total });
                        void refetchProgress();

                        return;
                    }

                    setResult(response);
                    onImported();
                },
            },
        );
    };

    const cancelImport = () => {
        const targetId = job?.jobId ?? watched?.jobId;

        if (!targetId) {
            return;
        }

        setImportError(undefined);
        runCancel(
            { jobId: targetId },
            {
                onError: (error: Error) => {
                    setImportError(error.message || t`Could not cancel the import.`);
                },
            },
        );
    };

    const finished = result !== undefined || job?.status === "done";
    const done = i18n.number(processed);
    const total = i18n.number(entries);
    const progressText = t`${done} of ${total} entries processed`;
    const shownCounts = job ?? result ?? NO_COUNTS;
    const imported = i18n.number(shownCounts.imported);
    const updated = i18n.number(shownCounts.updated);
    const duplicates = i18n.number(shownCounts.duplicates);
    const tooLong = i18n.number(shownCounts.tooLong);
    const invalid = i18n.number(shownCounts.invalid);
    const countsText = t`Imported ${imported} · Updated ${updated} · Duplicates ${duplicates} · Too long ${tooLong} · Invalid ${invalid}`;
    const jobError = job?.status === "failed" ? (job.error ?? t`The import stopped before it finished.`) : undefined;
    const progressErrorText = progressFailed ? (isProgressError && progressError?.message) || t`Could not read the import's progress.` : undefined;
    const alertText = importError ?? jobError ?? progressErrorText;

    return (
        <div aria-labelledby={`${fileId}-title`} className="space-y-2" role="group">
            <p className="text-sm font-medium" id={`${fileId}-title`}>
                {t`Import memories from a file`}
            </p>
            <p className="text-muted-foreground text-xs" id={helpId}>
                {t`Choose a .txt file with one memory per line, or a .json file with a list of memories. The file can be up to ${maxSize}.`}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1 space-y-1">
                    <Label htmlFor={fileId}>{t`File to import`}</Label>
                    <Input
                        accept=".txt,.json,text/plain,application/json"
                        aria-describedby={`${helpId}${fileError ? ` ${fileErrorId}` : ""}${memoryEnabled ? "" : ` ${offId}`}`}
                        aria-invalid={fileError !== undefined}
                        disabled={disabled}
                        id={fileId}
                        key={inputKey}
                        onChange={handleFileChange}
                        type="file"
                    />
                </div>
                <Button disabled={disabled || !file || !baselineReady} onClick={startImport} ref={importButton} type="button" variant="outline">
                    {t`Import file`}
                </Button>
            </div>
            {!memoryEnabled && (
                <p className="text-muted-foreground text-xs" id={offId}>
                    {t`Turn on memory to import a file.`}
                </p>
            )}
            {fileError && (
                <p className="text-destructive text-xs" id={fileErrorId} role="alert">
                    {fileError}
                </p>
            )}

            {/* Always mounted: a live region announces only what changes inside it. Its text changes when an import starts and
                when it ends, not on every batch (the progress bar carries those). */}
            <div
                aria-label={t`Import result`}
                className="focus:border-ring focus:ring-ring/30 -m-1 space-y-2 rounded-md border border-transparent p-[3px] outline-none focus:ring-[2px]"
                ref={outcome}
                role="group"
                tabIndex={-1}
            >
                <div className="space-y-1 text-xs" role="status">
                    {running && !progressFailed && <p>{t`Importing memories…`}</p>}
                    {finished && <p className="font-medium">{t`Import finished.`}</p>}
                    {(result || jobEnded) && <p>{countsText}</p>}
                </div>
                {jobRunning && (
                    <div className="space-y-1">
                        <Progress getAriaValueText={() => progressText} max={Math.max(entries, 1)} value={processed}>
                            <ProgressLabel className="sr-only">{t`Import progress`}</ProgressLabel>
                            <ProgressTrack>
                                <ProgressIndicator />
                            </ProgressTrack>
                        </Progress>
                        <p className="text-muted-foreground text-xs">{progressText}</p>
                        <p className="text-muted-foreground text-xs">{countsText}</p>
                        <Button disabled={isCancelling} onClick={cancelImport} size="sm" type="button" variant="outline">
                            {t`Cancel import`}
                        </Button>
                    </div>
                )}
                {alertText && (
                    <p className="text-destructive text-xs" role="alert">
                        {alertText}
                    </p>
                )}
                {progressErrorText && alertText === progressErrorText && (
                    <Button onClick={retryProgress} size="sm" type="button" variant="outline">
                        {t`Try again`}
                    </Button>
                )}
            </div>
        </div>
    );
};

export default MemoryFileImport;
