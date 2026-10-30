"use client";

import { useLingui } from "@lingui/react/macro";
import type { HostCapabilityReportInput } from "@neore/backend/source-control/capabilities";
import { hostCapabilityOf, isHostCapabilityAvailable } from "@neore/backend/source-control/capabilities";
import type { ReviewThread as Thread } from "@neore/backend/source-control/types";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { useState } from "react";

import type { PullRequestAddress } from "../lib/use-develop";
import { useReviewActions } from "../lib/use-review";
import { useReviewMessages } from "../lib/use-review-messages";
import CommentComposer from "./comment-composer";

/** One conversation on a line: its comments as text, a reply, and resolve or reopen. */
const ReviewThread = ({
    address,
    capabilities,
    hostLabel,
    thread,
}: {
    address: PullRequestAddress;
    capabilities: HostCapabilityReportInput;
    hostLabel: string;
    thread: Thread;
}) => {
    const { t } = useLingui();
    const messages = useReviewMessages(hostLabel);
    const actions = useReviewActions(address);
    const [replying, setReplying] = useState(false);
    const [resolveError, setResolveError] = useState<string | null>(null);
    const topComment = thread.comments[0];
    const canReply = topComment !== undefined && isHostCapabilityAvailable(capabilities, "review.replies");
    const replyCapability = hostCapabilityOf(capabilities, "review.replies");
    const repliesApart = replyCapability.supported && replyCapability.degradation !== "none";
    const canToggle = isHostCapabilityAvailable(capabilities, "review.resolveThreads") && (thread.isResolved ? thread.canUnresolve : thread.canResolve);

    return (
        <div className="bg-background text-foreground sticky left-0 my-1 max-w-3xl space-y-2 rounded-md border p-3 font-sans text-sm whitespace-normal">
            {(thread.isResolved || thread.isOutdated) && (
                <div className="flex gap-2">
                    {thread.isResolved && <Badge variant="secondary">{t`Resolved`}</Badge>}
                    {thread.isOutdated && <Badge variant="outline">{t`Outdated`}</Badge>}
                </div>
            )}
            <ul className="space-y-2">
                {thread.comments.map((comment) => (
                    <li key={comment.id}>
                        <p className="text-muted-foreground text-xs">
                            {comment.authorLogin} · {new Date(comment.createdAt).toLocaleString()}
                        </p>
                        {/* The comment is text from the host: shown as text, never parsed as markup. */}
                        <p className="break-words whitespace-pre-wrap">{comment.body}</p>
                    </li>
                ))}
            </ul>
            {replying && topComment !== undefined ? (
                <div className="space-y-1">
                    <CommentComposer
                        label={t`Reply`}
                        onCancel={() => setReplying(false)}
                        onSubmit={async (body) => {
                            const outcome = await actions.reply.mutateAsync({ body, commentId: topComment.id });

                            if (outcome.status === "ok") {
                                setReplying(false);

                                return null;
                            }

                            return messages.write(outcome);
                        }}
                        submitLabel={repliesApart ? t`Send reply now` : t`Reply`}
                    />
                    {repliesApart && <p className="text-muted-foreground text-xs">{t`A reply is posted straight away, not with the rest of your review.`}</p>}
                </div>
            ) : (
                <div className="flex gap-2">
                    {canReply && (
                        <Button onClick={() => setReplying(true)} size="sm" variant="outline">
                            {t`Reply`}
                        </Button>
                    )}
                    {canToggle && (
                        <Button
                            disabled={actions.resolve.isPending}
                            onClick={async () => {
                                setResolveError(null);

                                const outcome = await actions.resolve.mutateAsync({ resolved: !thread.isResolved, threadId: thread.id });

                                if (outcome.status !== "ok") {
                                    setResolveError(messages.write(outcome));
                                }
                            }}
                            size="sm"
                            variant="ghost"
                        >
                            {thread.isResolved ? t`Reopen` : t`Resolve`}
                        </Button>
                    )}
                </div>
            )}
            {resolveError !== null && (
                <p className="text-destructive text-xs" role="alert">
                    {resolveError}
                </p>
            )}
        </div>
    );
};

export default ReviewThread;
