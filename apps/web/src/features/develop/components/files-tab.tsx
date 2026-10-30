"use client";

import { plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import { ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { PullRequestAddress } from "../lib/use-develop";
import { usePullRequestFiles } from "../lib/use-develop";
import DiffView from "./diff-view";
import FailureNotice from "./failure-notice";

interface FileEntry {
    additions: number;
    deletions: number;
    patch: string | null;
    patchState: "full" | "host_omitted" | "over_budget" | "truncated";
    path: string;
    previousPath: string | null;
    status: string;
}

const FileRow = ({ file, showDiff }: { file: FileEntry; showDiff: boolean }) => {
    const { t } = useLingui();
    const [open, setOpen] = useState(false);
    const panelId = useId();
    const statuses: Record<string, string> = {
        added: t`Added`,
        changed: t`Changed`,
        copied: t`Copied`,
        modified: t`Modified`,
        removed: t`Removed`,
        renamed: t`Renamed`,
        unchanged: t`Unchanged`,
    };
    const notes: Record<FileEntry["patchState"], string | undefined> = {
        full: undefined,
        host_omitted: t`The host sent no diff for this file (binary, or too large for it).`,
        over_budget: t`Not loaded: the diffs on this page were already large.`,
        truncated: t`This diff is cut short.`,
    };

    return (
        <li className="border-b last:border-b-0">
            <button
                aria-controls={panelId}
                aria-expanded={open}
                className="hover:bg-muted focus-visible:ring-ring flex w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none focus-visible:ring-2"
                onClick={() => setOpen((current) => !current)}
                type="button"
            >
                <ChevronRight aria-hidden className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{statuses[file.status] ?? t`Changed`}</span>
                <span className="shrink-0 font-mono text-xs text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                <span className="shrink-0 font-mono text-xs text-red-600 dark:text-red-400">−{file.deletions}</span>
            </button>
            <div hidden={!open} id={panelId}>
                {open && showDiff && file.patch !== null && <DiffView patch={file.patch} />}
                {open && notes[file.patchState] && <p className="text-muted-foreground px-3 py-2 text-xs">{notes[file.patchState]}</p>}
                {open && !showDiff && <p className="text-muted-foreground px-3 py-2 text-xs">{t`Diffs are not available from this host.`}</p>}
            </div>
        </li>
    );
};

/** Every file the host will list, page by page, and how many it will not. */
const FilesTab = ({
    address,
    fileCount,
    fileLimit,
    hostLabel,
    leftOut,
    showDiff,
}: {
    address: PullRequestAddress;
    fileCount: number;
    fileLimit: number;
    hostLabel: string;
    leftOut: number;
    showDiff: boolean;
}) => {
    const { t } = useLingui();
    const files = usePullRequestFiles(address, true);
    const { fetchNextPage, hasNextPage, isFetchingNextPage } = files;
    const pages = files.data?.pages ?? [];
    const failure = pages.find((page) => page.status !== "ok");
    const listed = pages.flatMap((page) => (page.status === "ok" ? page.files : []));

    // Keep loading until the host has nothing more to list: the pages are bounded by the host's own ceiling.
    useEffect(() => {
        if (hasNextPage && !isFetchingNextPage && !failure) {
            fetchNextPage();
        }
    }, [failure, fetchNextPage, hasNextPage, isFetchingNextPage]);

    if (files.isPending) {
        return <Skeleton aria-label={t`Loading files`} className="h-24 w-full" role="status" />;
    }

    if (files.isError) {
        return <FailureNotice label={hostLabel} status="host_error" />;
    }

    if (failure) {
        return <FailureNotice label={hostLabel} status={failure.status} />;
    }

    const loading = hasNextPage || isFetchingNextPage;

    return (
        <div className="space-y-3">
            {/* Screen readers hear the start and the final count only; the running count below is for the eye. */}
            <p className="sr-only" role="status">
                {loading ? t`Loading files…` : <Plural one="# file" other="# files" value={listed.length} />}
            </p>
            <p aria-hidden className="text-muted-foreground text-sm">
                {loading ? (
                    <Trans>
                        Loaded {listed.length} of <Plural one="# file" other="# files" value={Math.min(fileCount, fileLimit)} />…
                    </Trans>
                ) : (
                    <Plural one="# file" other="# files" value={listed.length} />
                )}
            </p>
            {leftOut > 0 && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="note">
                    {t`The host lists at most ${plural(fileLimit, { one: "# file", other: "# files" })} for one change. ${plural(leftOut, { one: "# more is not shown here.", other: "# more are not shown here." })}`}
                </p>
            )}
            <ul className="rounded-md border">
                {listed.map((file) => (
                    <FileRow file={file} key={`${file.previousPath ?? ""}→${file.path}`} showDiff={showDiff} />
                ))}
            </ul>
            {hasNextPage && !isFetchingNextPage && (
                <Button onClick={() => fetchNextPage()} variant="outline">
                    {t`Load more files`}
                </Button>
            )}
        </div>
    );
};

export default FilesTab;
