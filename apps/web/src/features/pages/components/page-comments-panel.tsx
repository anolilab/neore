"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Textarea } from "@neore/ui/components/textarea";
import cn from "@neore/ui/utils/cn";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

export interface DraftComment {
    commentId: string;
    quote: string;
}

interface PageCommentsPanelProps {
    canComment: boolean;
    canModerate: boolean;
    draft: DraftComment | null;
    onCancelDraft: () => void;
    onDeleted: (commentId: string, revision: number | null) => void;
    onFocusAnchor: (commentId: string) => boolean;
    onSubmitDraft: (body: string) => Promise<void>;
    pageId: string;
}

const formatTime = (timestamp: number, locale: string): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);

const CommentComposer: FC<{ label: string; onCancel?: () => void; onSubmit: (body: string) => Promise<void>; submitLabel: string }> = ({
    label,
    onCancel,
    onSubmit,
    submitLabel,
}) => {
    const { t } = useLingui();
    const id = useId();
    const [body, setBody] = useState("");
    const [pending, setPending] = useState(false);

    return (
        <form
            className="space-y-2"
            onSubmit={(event) => {
                event.preventDefault();

                if (!body.trim()) {
                    return;
                }

                setPending(true);
                void (async () => {
                    try {
                        await onSubmit(body);
                        setBody("");
                    } catch (error) {
                        showError(error instanceof Error ? error : t`Could not post the comment`);
                    } finally {
                        setPending(false);
                    }
                })();
            }}
        >
            <label className="sr-only" htmlFor={id}>
                {label}
            </label>
            <Textarea
                className="min-h-16 text-sm"
                id={id}
                maxLength={5000}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.currentTarget.form?.requestSubmit();
                    }
                }}
                placeholder={label}
                value={body}
            />
            <div className="flex justify-end gap-2">
                {onCancel && (
                    <Button onClick={onCancel} size="sm" type="button" variant="ghost">
                        {t`Cancel`}
                    </Button>
                )}
                <Button aria-busy={pending} disabled={pending || !body.trim()} size="sm" type="submit">
                    {submitLabel}
                </Button>
            </div>
        </form>
    );
};

/**
 * Comment threads on a page. A thread quotes the text it is anchored to;
 * clicking the quote selects that text in the editor. An orphaned thread (its
 * text was removed) keeps its discussion and says so.
 */
const PageCommentsPanel: FC<PageCommentsPanelProps> = ({ canComment, canModerate, draft, onCancelDraft, onDeleted, onFocusAnchor, onSubmitDraft, pageId }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const [showResolved, setShowResolved] = useState(false);
    const { data: threads } = useQuery(crpc.pages.comments.listPageComments.queryOptions({ pageId: pageId as never }));
    const reply = useMutation(crpc.pages.comments.replyToPageComment.mutationOptions());
    const setStatus = useMutation(crpc.pages.comments.setPageCommentStatus.mutationOptions());
    const remove = useMutation(crpc.pages.comments.deletePageComment.mutationOptions());

    const visible = (threads ?? []).filter((thread) => (showResolved ? thread.status === "resolved" : thread.status === "open"));
    const openCount = (threads ?? []).filter((thread) => thread.status === "open").length;
    let emptyMessage = canComment ? t`Select text in the page and choose “Comment”.` : t`No comments yet.`;

    if (showResolved) {
        emptyMessage = t`No resolved comments.`;
    }

    const handleDelete = (rowId: string, commentId: string | null) => {
        remove.mutate(
            { commentRowId: rowId as never },
            {
                onError: (error) => showError(error instanceof Error ? error : t`Could not delete the comment`),
                onSuccess: ({ revision }) => {
                    if (commentId) {
                        onDeleted(commentId, revision);
                    }
                },
            },
        );
    };

    return (
        <section aria-label={t`Comments`} className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b px-3 py-2">
                <h2 className="text-sm font-semibold">{t`Comments`}</h2>
                <Button aria-pressed={showResolved} onClick={() => setShowResolved((value) => !value)} size="sm" variant="ghost">
                    {showResolved ? t`Show open` : t`Show resolved`}
                </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                {draft && (
                    <div className="bg-muted/50 space-y-2 rounded-md border p-2">
                        <blockquote className="border-l-2 border-amber-500 pl-2 text-xs italic">{draft.quote}</blockquote>
                        <CommentComposer label={t`Add a comment`} onCancel={onCancelDraft} onSubmit={onSubmitDraft} submitLabel={t`Comment`} />
                    </div>
                )}
                {threads !== undefined && visible.length === 0 && !draft && (
                    <p className="text-muted-foreground flex flex-col items-center gap-2 py-8 text-center text-xs">
                        <MessageSquare aria-hidden="true" className="size-5" />
                        {emptyMessage}
                    </p>
                )}
                <ul className="space-y-3">
                    {visible.map((thread) => (
                        <li className={cn("space-y-2 rounded-md border p-2", thread.status === "resolved" && "opacity-75")} key={thread._id}>
                            {thread.orphaned ? (
                                <p className="text-muted-foreground text-xs">
                                    <span className="font-medium">{t`Text removed.`}</span>{" "}
                                    {thread.anchorText && <q className="line-through">{thread.anchorText}</q>}
                                </p>
                            ) : (
                                <button
                                    className="hover:bg-muted block w-full rounded-sm border-l-2 border-amber-500 pl-2 text-left text-xs italic"
                                    onClick={() => onFocusAnchor(thread.commentId)}
                                    type="button"
                                >
                                    <span className="sr-only">{t`Go to commented text: `}</span>
                                    {thread.anchorText}
                                </button>
                            )}
                            {[
                                { ...thread, isRoot: true },
                                ...thread.replies.map((entry) => {
                                    return { ...entry, isRoot: false };
                                }),
                            ].map((entry) => (
                                <article className="text-sm" key={entry._id}>
                                    <header className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                                        <span>
                                            <span className="text-foreground font-medium">{entry.authorName}</span> ·{" "}
                                            <time dateTime={new Date(entry.createdAt).toISOString()}>{formatTime(entry.createdAt, i18n.locale)}</time>
                                            {entry.editedAt !== null && <span> · {t`edited`}</span>}
                                        </span>
                                        {(entry.isOwn || canModerate) && (
                                            <Button
                                                aria-label={entry.isRoot ? t`Delete thread` : t`Delete reply`}
                                                onClick={() => handleDelete(entry._id, entry.isRoot ? thread.commentId : null)}
                                                size="icon-xs"
                                                variant="ghost"
                                            >
                                                <Trash2 aria-hidden="true" />
                                            </Button>
                                        )}
                                    </header>
                                    <p className="break-words whitespace-pre-wrap">{entry.body}</p>
                                </article>
                            ))}
                            {canComment && (
                                <div className="flex flex-col gap-2">
                                    {thread.status === "open" && (
                                        <CommentComposer
                                            label={t`Reply`}
                                            onSubmit={async (body) => {
                                                await reply.mutateAsync({ body, commentRowId: thread._id as never });
                                            }}
                                            submitLabel={t`Reply`}
                                        />
                                    )}
                                    <Button
                                        className="self-start"
                                        onClick={() =>
                                            setStatus.mutate(
                                                { commentRowId: thread._id as never, status: thread.status === "open" ? "resolved" : "open" },
                                                { onError: (error) => showError(error instanceof Error ? error : t`Could not update the comment`) },
                                            )
                                        }
                                        size="sm"
                                        variant="outline"
                                    >
                                        {thread.status === "open" ? <Check aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
                                        {thread.status === "open" ? t`Resolve` : t`Reopen`}
                                    </Button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            </div>
            <p aria-live="polite" className="sr-only" role="status">
                {t`${openCount} open comments`}
            </p>
        </section>
    );
};

export default PageCommentsPanel;
