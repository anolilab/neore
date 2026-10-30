"use client";

import { useLingui } from "@lingui/react/macro";
import type { HostCapabilityReportInput } from "@neore/backend/source-control/capabilities";
import { isHostCapabilityAvailable } from "@neore/backend/source-control/capabilities";
import type { DiffSide, ReviewThread as Thread } from "@neore/backend/source-control/types";
import cn from "@neore/ui/utils/cn";
import { MessageSquarePlus } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import type { DiffLineKind, NumberedDiffLine } from "../lib/diff";
import { numberDiffLines } from "../lib/diff";
import { groupByLine, lineKey, threadLineKey, unplacedThreads } from "../lib/review";
import type { PullRequestAddress } from "../lib/use-develop";
import { useDraftMutations } from "../lib/use-review";
import { useReviewMessages } from "../lib/use-review-messages";
import CommentComposer from "./comment-composer";
import DraftCommentCard from "./draft-comment-card";
import ReviewThread from "./review-thread";

const LINE_STYLE: Record<DiffLineKind, string> = {
    add: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    context: "",
    hunk: "bg-muted text-muted-foreground",
    meta: "text-muted-foreground italic",
    remove: "bg-red-500/10 text-red-700 dark:text-red-300",
};

export interface DraftCommentEntry {
    body: string;
    id: string;
    line: number;
    path: string;
    side: DiffSide;
}

/** Where a new comment on this line would go: a removed line is on the old side, everything else on the new. */
const targetOf = (line: NumberedDiffLine): { line: number; side: DiffSide } | null => {
    if (line.kind === "remove" && line.oldLine !== null) {
        return { line: line.oldLine, side: "old" };
    }

    return line.newLine === null ? null : { line: line.newLine, side: "new" };
};

/**
 * A unified patch, line by line, with the review on it: the conversations already there, the
 * comments in the draft, and a button on each line to add one. The patch and every comment are text
 * from the host or the user and go in as text. What can be done is decided by the capability report.
 */
const ReviewDiff = ({
    address,
    capabilities,
    draftComments,
    headSha,
    hostLabel,
    locked,
    path,
    patch,
    threads,
}: {
    address: PullRequestAddress;
    capabilities: HostCapabilityReportInput;
    draftComments: DraftCommentEntry[];
    headSha: string;
    hostLabel: string;
    /** A submit holds the draft, so it cannot be edited now. */
    locked: boolean;
    patch: string;
    path: string;
    threads: Thread[];
}) => {
    const { t } = useLingui();
    const messages = useReviewMessages(hostLabel);
    const mutations = useDraftMutations();
    const [composing, setComposing] = useState<string | null>(null);
    const lines = useMemo(() => numberDiffLines(patch), [patch]);
    const canComment = isHostCapabilityAvailable(capabilities, "review.lineComments") && !locked;
    const threadsByLine = useMemo(() => groupByLine(threads, threadLineKey), [threads]);
    const draftsByLine = useMemo(() => groupByLine(draftComments, (comment) => lineKey(comment.side, comment.line)), [draftComments]);
    const placed = useMemo(
        () =>
            new Set(
                lines.flatMap((line) => {
                    const target = targetOf(line);

                    return target === null ? [] : [lineKey(target.side, target.line)];
                }),
            ),
        [lines],
    );
    const loose = useMemo(() => unplacedThreads(threads, placed), [placed, threads]);
    // A draft comment on a line this patch does not show (it was cut short) must not vanish from sight.
    const looseDrafts = useMemo(() => draftComments.filter((comment) => !placed.has(lineKey(comment.side, comment.line))), [draftComments, placed]);

    const save = async (input: { body: string; commentId?: string; line: number; side: DiffSide }): Promise<string | null> => {
        const outcome = await mutations.saveComment.mutateAsync({ ...address, ...input, commitId: headSha, path, startLine: null });

        return outcome.status === "ok" ? null : messages.edit(outcome.status);
    };

    const draftCard = (comment: DraftCommentEntry) => (
        <DraftCommentCard
            body={comment.body}
            key={comment.id}
            locked={locked}
            onDelete={async () => {
                try {
                    const outcome = await mutations.deleteComment.mutateAsync({ ...address, commentId: comment.id });

                    return outcome.status === "ok" ? null : messages.edit(outcome.status);
                } catch {
                    return messages.edit("failed");
                }
            }}
            onEdit={async (body) => await save({ body, commentId: comment.id, line: comment.line, side: comment.side })}
        />
    );

    return (
        <div className="overflow-x-auto font-mono text-xs leading-5">
            {lines.map((line, index) => {
                const target = targetOf(line);
                const key = target === null ? null : lineKey(target.side, target.line);

                return (
                    // The patch is static text, so the line's position is its stable key.

                    // eslint-disable-next-line react-x/no-array-index-key
                    <Fragment key={index}>
                        <div className={cn("group flex min-w-full", LINE_STYLE[line.kind])}>
                            {canComment && target !== null && key !== null ? (
                                <button
                                    aria-label={t`Comment on line ${target.line}`}
                                    className="focus-visible:ring-ring flex w-6 shrink-0 items-center justify-center opacity-0 outline-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
                                    onClick={() => setComposing(key)}
                                    type="button"
                                >
                                    <MessageSquarePlus aria-hidden className="size-3.5" />
                                </button>
                            ) : (
                                <span aria-hidden className="w-6 shrink-0" />
                            )}
                            <span className="block flex-1 px-1 whitespace-pre">{line.text === "" ? " " : line.text}</span>
                        </div>
                        {key !== null && target !== null && (
                            <>
                                {threadsByLine.get(key)?.map((thread) => (
                                    <ReviewThread address={address} capabilities={capabilities} hostLabel={hostLabel} key={thread.id} thread={thread} />
                                ))}
                                {draftsByLine.get(key)?.map((comment) => draftCard(comment))}
                                {composing === key && (
                                    <div className="bg-background text-foreground sticky left-0 my-1 max-w-3xl rounded-md border p-3 font-sans text-sm whitespace-normal">
                                        <CommentComposer
                                            label={t`Comment on line ${target.line}`}
                                            onCancel={() => setComposing(null)}
                                            onSubmit={async (body) => {
                                                const failure = await save({ body, line: target.line, side: target.side });

                                                if (failure === null) {
                                                    setComposing(null);
                                                }

                                                return failure;
                                            }}
                                            submitLabel={t`Add to review`}
                                        />
                                    </div>
                                )}
                            </>
                        )}
                    </Fragment>
                );
            })}
            {looseDrafts.length > 0 && (
                <div className="font-sans text-sm">
                    <p className="text-muted-foreground px-3 pt-2 text-xs">{t`Your comments on lines this diff does not show`}</p>
                    {looseDrafts.map((comment) => draftCard(comment))}
                </div>
            )}
            {loose.length > 0 && (
                <div className="font-sans text-sm">
                    <p className="text-muted-foreground px-3 pt-2 text-xs">{t`Conversations on lines this diff no longer shows`}</p>
                    {loose.map((thread) => (
                        <ReviewThread address={address} capabilities={capabilities} hostLabel={hostLabel} key={thread.id} thread={thread} />
                    ))}
                </div>
            )}
        </div>
    );
};

export default ReviewDiff;
