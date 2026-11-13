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
import type { Dispatch, SetStateAction } from "react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { countViewed, viewedStatesOf } from "../lib/review";
import type { PullRequestAddress } from "../lib/use-develop";
import { usePullRequestFiles } from "../lib/use-develop";
import { useReviewActions, useReviewDraft, useReviewThreads, useViewedFiles } from "../lib/use-review";
import type { WriteResult } from "../lib/use-review-messages";
import { useReviewMessages } from "../lib/use-review-messages";
import DiffView from "./diff-view";
import type { ReadFailureStatus } from "./failure-notice";
import FailureNotice from "./failure-notice";
import type { DraftCommentEntry } from "./review-diff";
import ReviewDiff, { DraftComment } from "./review-diff";
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

/** Everything the review adds to one file's row. Each is stable while its own data is, so a row is drawn again only when it changed. */
interface FileReview {
    draftComments: DraftCommentEntry[];
    locked: boolean;
    onToggleViewed: (path: string, viewed: boolean) => void;
    threads: ReviewThread[];
    viewed: ViewedState | undefined;
    viewedPending: boolean;
}

/** A row's identity in the list: a rename is its own row. */
const fileKeyOf = (file: FileEntry): string => `${file.previousPath ?? ""}→${file.path}`;

/** One empty list for every row without review items, so an empty row's props stay the same between renders. Never mutated. */
const NONE: never[] = [];

/**
 * Review items (threads, draft comments) grouped by the row that owns them, in their own order, in one pass. A row owns
 * what is recorded under its path now or under the one it had before a rename; what no row owns is `stray`.
 */
const groupByFile = <Item extends { path: string }>(
    files: ReadonlyArray<FileEntry>,
    items: ReadonlyArray<Item>,
): { byFile: ReadonlyMap<string, Item[]>; stray: Item[] } => {
    const owners = new Map<string, string[]>();

    for (const file of files) {
        const key = fileKeyOf(file);
        const paths = file.previousPath && file.previousPath !== file.path ? [file.path, file.previousPath] : [file.path];

        for (const path of paths) {
            const list = owners.get(path);

            if (list) {
                list.push(key);
            } else {
                owners.set(path, [key]);
            }
        }
    }

    const byFile = new Map<string, Item[]>();
    const stray: Item[] = [];

    for (const item of items) {
        const keys = owners.get(item.path);

        if (!keys) {
            stray.push(item);
            continue;
        }

        for (const key of keys) {
            const list = byFile.get(key);

            if (list) {
                list.push(item);
            } else {
                byFile.set(key, [item]);
            }
        }
    }

    return { byFile, stray };
};

/**
 * Marks a file viewed or not on the host, keeping its checkbox disabled until the call ends. Module-level: a `finally`
 * inside the component would keep the React Compiler from compiling `FilesTab`.
 */
const markViewed = async ({
    messages,
    mutateAsync,
    next,
    path,
    setError,
    setPending,
}: {
    messages: { write: (result: WriteResult) => string };
    mutateAsync: (input: { path: string; viewed: boolean }) => Promise<WriteResult>;
    next: boolean;
    path: string;
    setError: Dispatch<SetStateAction<string | null>>;
    setPending: Dispatch<SetStateAction<ReadonlySet<string>>>;
}): Promise<void> => {
    setError(null);
    setPending((current: ReadonlySet<string>) => new Set(current).add(path));

    try {
        const outcome = await mutateAsync({ path, viewed: next });

        if (outcome.status !== "ok") {
            setError(messages.write(outcome));
        }
    } catch {
        setError(messages.write({ status: "failed" }));
    } finally {
        setPending((current: ReadonlySet<string>) => {
            const rest = new Set(current);

            rest.delete(path);

            return rest;
        });
    }
};

/** The first failure among a query's pages, if any; a thrown page counts as the host failing. */
const failureOf = (pages: ReadonlyArray<{ status: string }>, isError: boolean): ReadFailureStatus | undefined =>
    (pages.find((page) => page.status !== "ok")?.status as ReadFailureStatus | undefined) ?? (isError ? "host_error" : undefined);

/** A file to open and bring into view, e.g. one the guide pointed at. `token` changes with each request. */
export interface FileFocus {
    path: string;
    token: number;
}

interface FileRowProps extends FileReview {
    context: ReviewContext;
    file: FileEntry;
    focus: FileFocus | null;
    showDiff: boolean;
}

/** The same items in the same order: regrouping makes new lists, while the query keeps unchanged items as the same objects. */
const sameItems = (left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>): boolean =>
    left === right || (left.length === right.length && left.every((item: unknown, index: number) => item === right[index]));

const sameRowProps = (previous: FileRowProps, next: FileRowProps): boolean =>
    previous.context === next.context &&
    previous.file === next.file &&
    previous.focus === next.focus &&
    previous.showDiff === next.showDiff &&
    previous.locked === next.locked &&
    previous.onToggleViewed === next.onToggleViewed &&
    previous.viewed === next.viewed &&
    previous.viewedPending === next.viewedPending &&
    sameItems(previous.threads, next.threads) &&
    sameItems(previous.draftComments, next.draftComments);

const FileRowView = ({ context, file, focus, showDiff, ...review }: FileRowProps) => {
    const { t } = useLingui();
    const wanted = focus !== null && (focus.path === file.path || focus.path === file.previousPath);
    const [open, setOpen] = useState(wanted);
    const panelId = useId();
    const row = useRef<HTMLLIElement>(null);
    const toggle = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!wanted) {
            return;
        }

        setOpen(true);
        row.current?.scrollIntoView({ block: "start" });
        // The button that asked (a guide stop) is gone with its tab: keyboard focus follows the file.
        toggle.current?.focus({ preventScroll: true });
    }, [wanted, focus?.token]);

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
        <li className="border-b last:border-b-0" ref={row}>
            <div className="flex items-center">
                <button
                    aria-controls={panelId}
                    aria-expanded={open}
                    className="hover:bg-muted focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm outline-none focus-visible:ring-2"
                    onClick={() => setOpen((current) => !current)}
                    ref={toggle}
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
                            onCheckedChange={(checked) => review.onToggleViewed(file.path, checked)}
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
                {open &&
                    !(showDiff && file.patch !== null && reviewable) &&
                    review.draftComments.map((comment) => (
                        <DraftComment
                            address={context.address}
                            comment={comment}
                            headSha={context.headSha}
                            hostLabel={context.hostLabel}
                            key={comment.id}
                            locked={review.locked}
                        />
                    ))}
                {open && notes[file.patchState] && <p className="text-muted-foreground px-3 py-2 text-xs">{notes[file.patchState]}</p>}
                {open && !showDiff && <p className="text-muted-foreground px-3 py-2 text-xs">{t`Diffs are not available from this host.`}</p>}
            </div>
        </li>
    );
};

/** Memoized: a review change on one file (a comment, a viewed mark) draws that row again, not every open diff in the list. */
const FileRow = memo(FileRowView, sameRowProps);

/** Every file the host will list, page by page, and how many it will not. */
const FilesTab = ({
    address,
    capabilities,
    fileCount,
    fileLimit,
    focus,
    headSha,
    hostLabel,
    leftOut,
    showDiff,
}: {
    address: PullRequestAddress;
    capabilities: HostCapabilityReportInput;
    fileCount: number;
    fileLimit: number;
    focus?: FileFocus | null;
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
    // Several files can be toggled at once: each keeps its checkbox disabled until its own call ends.
    const [viewedPending, setViewedPending] = useState<ReadonlySet<string>>(new Set());
    const viewedStates = useMemo(() => viewedStatesOf(viewed.data?.pages ?? []), [viewed.data]);
    const loadedThreads = useMemo(() => (threads.data?.pages ?? []).flatMap((page) => (page.status === "ok" ? page.threads : [])), [threads.data]);
    const draftComments = draft.data?.comments ?? NONE;

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
    const pages = files.data?.pages ?? NONE;
    // Pages are read one after another, so a push in between can move a file onto a second page: keep its first place.
    const listed = useMemo(
        () => [
            ...new Map((files.data?.pages ?? NONE).flatMap((page) => (page.status === "ok" ? page.files : [])).map((file) => [fileKeyOf(file), file])).values(),
        ],
        [files.data],
    );
    const threadGroups = useMemo(() => groupByFile(listed, loadedThreads), [listed, loadedThreads]);
    const draftGroups = useMemo(() => groupByFile(listed, draftComments), [listed, draftComments]);
    const context = useMemo(() => {
        return { address, capabilities, headSha, hostLabel };
    }, [address, capabilities, headSha, hostLabel]);
    const { mutateAsync: setViewedMark } = actions.setViewed;
    const onToggleViewed = useCallback(
        (path: string, next: boolean) => {
            void markViewed({ messages, mutateAsync: setViewedMark, next, path, setError: setViewedError, setPending: setViewedPending });
        },
        [messages, setViewedMark],
    );
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

    const retryButton = (
        <Button disabled={files.isFetching} onClick={() => files.retry()} variant="outline">
            {t`Try again`}
        </Button>
    );

    // A later page that fails leaves the earlier ones on screen, with the failure below them.
    if (failure && listed.length === 0) {
        return (
            <div className="space-y-3">
                <FailureNotice label={hostLabel} status={failure} />
                {retryButton}
            </div>
        );
    }

    const loading = !failure && (hasNextPage || isFetchingNextPage);
    const strayThreads = threadGroups.stray;
    const strayDrafts = draftGroups.stray;
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
                {listed.map((file) => {
                    const key = fileKeyOf(file);

                    return (
                        <FileRow
                            context={context}
                            draftComments={draftGroups.byFile.get(key) ?? NONE}
                            file={file}
                            focus={focus ?? null}
                            key={key}
                            locked={draft.data?.submitting === true}
                            onToggleViewed={onToggleViewed}
                            showDiff={showDiff}
                            threads={threadGroups.byFile.get(key) ?? NONE}
                            viewed={viewedStates.get(file.path)}
                            viewedPending={viewedPending.has(file.path)}
                        />
                    );
                })}
            </ul>
            {!loading && (strayThreads.length > 0 || strayDrafts.length > 0) && (
                <section aria-label={t`Other conversations`} className="space-y-2">
                    <p className="text-muted-foreground text-xs">{t`Conversations and pending comments on files this list does not show`}</p>
                    {strayThreads.map((thread) => (
                        <ReviewThreadCard address={address} capabilities={capabilities} hostLabel={hostLabel} key={thread.id} thread={thread} />
                    ))}
                    {strayDrafts.map((comment) => (
                        <DraftComment
                            address={address}
                            comment={comment}
                            headSha={headSha}
                            hostLabel={hostLabel}
                            key={comment.id}
                            locked={draft.data?.submitting === true}
                        />
                    ))}
                </section>
            )}
            {failure && (
                <>
                    <FailureNotice label={hostLabel} status={failure} />
                    {retryButton}
                </>
            )}
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
