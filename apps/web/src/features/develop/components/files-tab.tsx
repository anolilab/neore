"use client";

import { plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { HostCapabilityReportInput } from "@neore/backend/source-control/capabilities";
import { isHostCapabilityAvailable } from "@neore/backend/source-control/capabilities";
import type { ReviewThread, ViewedState } from "@neore/backend/source-control/types";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import { ChevronRight } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { countViewed, viewedStatesOf } from "../lib/review";
import type { PullRequestAddress } from "../lib/use-develop";
import { usePullRequestFiles } from "../lib/use-develop";
import { useReviewActions, useReviewDraft, useReviewThreads, useViewedFiles } from "../lib/use-review";
import { useReviewMessages } from "../lib/use-review-messages";
import DiffView from "./diff-view";
import type { ReadFailureStatus } from "./failure-notice";
import FailureNotice from "./failure-notice";
import type { DraftCommentEntry } from "./review-diff";
import ReviewDiff from "./review-diff";
import ReviewThreadCard from "./review-thread";

interface FileEntry {
    additions: number;
    deletions: number;
    patch: string | null;
    patchState: "full" | "host_omitted" | "over_budget" | "truncated";
    path: string;
    previousPath: string | null;
    status: string;
}

interface ReviewContext {
    address: PullRequestAddress;
    capabilities: HostCapabilityReportInput;
    headSha: string;
    hostLabel: string;
}

/** Everything the review adds to one file's row. */
interface FileReview {
    draftComments: DraftCommentEntry[];
    locked: boolean;
    onToggleViewed: (viewed: boolean) => void;
    threads: ReviewThread[];
    viewed: ViewedState | undefined;
    viewedPending: boolean;
}

/** The first failure among a query's pages, if any; a thrown page counts as the host failing. */
const failureOf = (pages: ReadonlyArray<{ status: string }>, isError: boolean): ReadFailureStatus | undefined =>
    (pages.find((page) => page.status !== "ok")?.status as ReadFailureStatus | undefined) ?? (isError ? "host_error" : undefined);

const FileRow = ({ context, file, review, showDiff }: { context: ReviewContext; file: FileEntry; review: FileReview; showDiff: boolean }) => {
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

    const viewedEnabled = isHostCapabilityAvailable(context.capabilities, "review.viewedMarks");
    const checkboxId = useId();
    const reviewable = isHostCapabilityAvailable(context.capabilities, "review.lineComments");

    return (
        <li className="border-b last:border-b-0">
            <div className="flex items-center">
                <button
                    aria-controls={panelId}
                    aria-expanded={open}
                    className="hover:bg-muted focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm outline-none focus-visible:ring-2"
                    onClick={() => setOpen((current) => !current)}
                    type="button"
                >
                    <ChevronRight aria-hidden className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</span>
                    {review.threads.length > 0 && (
                        <span className="text-muted-foreground shrink-0 text-xs">
                            <Plural one="# thread" other="# threads" value={review.threads.length} />
                        </span>
                    )}
                    {review.draftComments.length > 0 && (
                        <span className="text-muted-foreground shrink-0 text-xs">
                            <Plural one="# pending comment" other="# pending comments" value={review.draftComments.length} />
                        </span>
                    )}
                    <span className="text-muted-foreground shrink-0 text-xs">{statuses[file.status] ?? t`Changed`}</span>
                    <span className="shrink-0 font-mono text-xs text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                    <span className="shrink-0 font-mono text-xs text-red-600 dark:text-red-400">−{file.deletions}</span>
                </button>
                {viewedEnabled && (
                    <div className="flex shrink-0 items-center gap-2 px-3">
                        <Checkbox
                            checked={review.viewed === "viewed"}
                            disabled={review.viewedPending}
                            id={checkboxId}
                            onCheckedChange={(checked) => review.onToggleViewed(checked)}
                        />
                        <label className="text-xs" htmlFor={checkboxId}>
                            {review.viewed === "changed" ? t`Viewed (changed since)` : t`Viewed`}
                        </label>
                    </div>
                )}
            </div>
            <div hidden={!open} id={panelId}>
                {open && showDiff && file.patch !== null && reviewable && (
                    <ReviewDiff
                        address={context.address}
                        capabilities={context.capabilities}
                        draftComments={review.draftComments}
                        headSha={context.headSha}
                        hostLabel={context.hostLabel}
                        locked={review.locked}
                        patch={file.patch}
                        path={file.path}
                        threads={review.threads}
                    />
                )}
                {open && showDiff && file.patch !== null && !reviewable && <DiffView patch={file.patch} />}
                {open &&
                    !(showDiff && file.patch !== null && reviewable) &&
                    review.threads.map((thread) => (
                        <ReviewThreadCard
                            address={context.address}
                            capabilities={context.capabilities}
                            hostLabel={context.hostLabel}
                            key={thread.id}
                            thread={thread}
                        />
                    ))}
                {open && notes[file.patchState] && <p className="text-muted-foreground px-3 py-2 text-xs">{notes[file.patchState]}</p>}
                {open && !showDiff && <p className="text-muted-foreground px-3 py-2 text-xs">{t`Diffs are not available from this host.`}</p>}
            </div>
        </li>
    );
};

/** Every file the host will list, page by page, and how many it will not. */
const FilesTab = ({
    address,
    capabilities,
    fileCount,
    fileLimit,
    headSha,
    hostLabel,
    leftOut,
    showDiff,
}: {
    address: PullRequestAddress;
    capabilities: HostCapabilityReportInput;
    fileCount: number;
    fileLimit: number;
    headSha: string;
    hostLabel: string;
    leftOut: number;
    showDiff: boolean;
}) => {
    const { t } = useLingui();
    const messages = useReviewMessages(hostLabel);
    const files = usePullRequestFiles(address, true);
    const reviewable = isHostCapabilityAvailable(capabilities, "review.lineComments");
    const viewedEnabled = isHostCapabilityAvailable(capabilities, "review.viewedMarks");
    const draft = useReviewDraft(reviewable ? address : undefined);
    const threads = useReviewThreads(address, reviewable);
    const viewed = useViewedFiles(address, viewedEnabled);
    const actions = useReviewActions(address);
    const [viewedError, setViewedError] = useState<string | null>(null);
    const viewedStates = useMemo(() => viewedStatesOf(viewed.data?.pages ?? []), [viewed.data]);
    const threadsByPath = useMemo(() => {
        const byPath = new Map<string, ReviewThread[]>();

        const pages = threads.data?.pages ?? [];
        const loaded = pages.flatMap((page) => (page.status === "ok" ? page.threads : []));

        for (const thread of loaded) {
            byPath.set(thread.path, [...(byPath.get(thread.path) ?? []), thread]);
        }

        return byPath;
    }, [threads.data]);

    // The host's pages are bounded by its own ceilings, so reading them to the end is bounded too.
    // A page that failed stays failed: asking again at once would only spend the read budget.
    useEffect(() => {
        if (threads.hasNextPage && !threads.isFetchingNextPage && !threads.isError) {
            threads.fetchNextPage();
        }

        if (viewed.hasNextPage && !viewed.isFetchingNextPage && !viewed.isError) {
            viewed.fetchNextPage();
        }
    }, [threads, viewed]);
    const { fetchNextPage, hasNextPage, isFetchingNextPage } = files;
    const pages = files.data?.pages ?? [];
    // Pages are read one after another, so a push in between can move a file onto a second page: keep its first place.
    const listed = [
        ...new Map(pages.flatMap((page) => (page.status === "ok" ? page.files : [])).map((file) => [`${file.previousPath ?? ""}→${file.path}`, file])).values(),
    ];
    const failure = failureOf(pages, files.isError);
    const reviewFailure = failureOf(threads.data?.pages ?? [], threads.isError) ?? failureOf(viewed.data?.pages ?? [], viewed.isError);

    // Keep loading until the host has nothing more to list: the pages are bounded by the host's own ceiling.
    useEffect(() => {
        if (hasNextPage && !isFetchingNextPage && !failure) {
            fetchNextPage();
        }
    }, [failure, fetchNextPage, hasNextPage, isFetchingNextPage]);

    if (files.isPending) {
        return <Skeleton aria-label={t`Loading files`} className="h-24 w-full" role="status" />;
    }

    // A later page that fails leaves the earlier ones on screen, with the failure below them.
    if (failure && listed.length === 0) {
        return <FailureNotice label={hostLabel} status={failure} />;
    }

    const loading = !failure && (hasNextPage || isFetchingNextPage);
    const viewedCount = countViewed(
        listed.map((file) => file.path),
        viewedStates,
    );

    return (
        <div className="space-y-3">
            {/* Screen readers hear the start and the final count only; the running count below is for the eye. */}
            <p className="sr-only" role="status">
                {loading ? t`Loading files…` : <Plural one="# file" other="# files" value={listed.length} />}
            </p>
            <p aria-hidden className="text-muted-foreground text-sm">
                {loading || failure ? (
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
            {viewedEnabled && !loading && <p className="text-muted-foreground text-sm">{t`Viewed ${viewedCount} of ${listed.length} files`}</p>}
            {viewedError !== null && (
                <p className="text-destructive text-sm" role="alert">
                    {viewedError}
                </p>
            )}
            <ul className="rounded-md border">
                {listed.map((file) => (
                    <FileRow
                        context={{ address, capabilities, headSha, hostLabel }}
                        file={file}
                        key={`${file.previousPath ?? ""}→${file.path}`}
                        review={{
                            draftComments: draft.data?.comments.filter((comment) => comment.path === file.path) ?? [],
                            locked: draft.data?.submitting === true,
                            onToggleViewed: async (next) => {
                                setViewedError(null);

                                try {
                                    const outcome = await actions.setViewed.mutateAsync({ path: file.path, viewed: next });

                                    if (outcome.status !== "ok") {
                                        setViewedError(messages.write(outcome));
                                    }
                                } catch {
                                    setViewedError(messages.write({ status: "failed" }));
                                }
                            },
                            threads: threadsByPath.get(file.path) ?? [],
                            viewed: viewedStates.get(file.path),
                            viewedPending: actions.setViewed.isPending && actions.setViewed.variables?.path === file.path,
                        }}
                        showDiff={showDiff}
                    />
                ))}
            </ul>
            {failure && <FailureNotice label={hostLabel} status={failure} />}
            {reviewFailure && reviewFailure !== failure && <FailureNotice label={hostLabel} status={reviewFailure} />}
            {hasNextPage && !isFetchingNextPage && !failure && (
                <Button onClick={() => fetchNextPage()} variant="outline">
                    {t`Load more files`}
                </Button>
            )}
        </div>
    );
};

export default FilesTab;
