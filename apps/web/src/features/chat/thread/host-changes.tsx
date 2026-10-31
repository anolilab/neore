"use client";

import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/dialog";
import { FileDiffIcon, MessageSquarePlusIcon } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import DiffCommentForm from "@/features/chat/host/diff-comment-form";
import DiffCommentsDraft from "@/features/chat/host/diff-comments-draft";
import { useDiffCommentStore } from "@/features/chat/host/diff-comments-store";
import type { UIMessage } from "@/lib/agent";

import HostDiffViewer from "./host-diff-viewer";

type HostChangesData = NonNullable<UIMessage["hostChanges"]>;

interface HostChangesProps {
    changes: HostChangesData;
    /** The reply these changes belong to; with `threadId`, it makes the diff and the files commentable. */
    messageId?: string;
    threadId?: string;
}

/**
 * What a host-run turn wrote: the files with their line counts, and the patch as it was at the end of that turn.
 * The patch is the agent's text, so it is shown as plain text, never as Markdown. Given a thread, a person can comment
 * on lines of the diff, or on a whole file (the only choice when the diff was too large to keep), and send the
 * comments to the agent (`features/chat/host/diff-comments-draft.tsx`).
 */
const HostChanges: FC<HostChangesProps> = ({ changes, messageId, threadId }) => {
    const { t } = useLingui();
    const [open, setOpen] = useState(false);
    const [commenting, setCommenting] = useState<string | undefined>();
    const { files, patch } = changes;
    const added = files.reduce((sum, file) => sum + file.added, 0);
    const removed = files.reduce((sum, file) => sum + file.removed, 0);
    const commentable = threadId !== undefined && messageId !== undefined;

    return (
        <section aria-label={t`Files changed by this turn`} className="border-border my-2 rounded-md border text-sm" data-testid="host-changes">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
                <p className="font-medium">
                    <Plural one="# file changed" other="# files changed" value={files.length} />{" "}
                    <span className="text-green-700 dark:text-green-400">+{added}</span> <span className="text-red-700 dark:text-red-400">−{removed}</span>
                </p>
                {typeof patch === "string" && (
                    <Button onClick={() => setOpen(true)} size="sm" type="button" variant="outline">
                        <FileDiffIcon aria-hidden="true" className="size-4" />
                        <Trans>Open diff</Trans>
                    </Button>
                )}
            </div>
            <ul className="border-border divide-border divide-y border-t">
                {files.map((file) => (
                    <li key={file.path}>
                        <div className="flex items-center justify-between gap-2 px-3 py-1">
                            <span className="min-w-0 truncate font-mono text-xs">{file.path}</span>
                            <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
                                <span>
                                    <span className="text-green-700 dark:text-green-400">+{file.added}</span>{" "}
                                    <span className="text-red-700 dark:text-red-400">−{file.removed}</span>
                                </span>
                                {commentable && (
                                    <Button
                                        aria-expanded={commenting === file.path}
                                        aria-label={t`Comment on ${file.path}`}
                                        onClick={() => setCommenting(commenting === file.path ? undefined : file.path)}
                                        size="icon-sm"
                                        type="button"
                                        variant="ghost"
                                    >
                                        <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
                                    </Button>
                                )}
                            </span>
                        </div>
                        {commentable && commenting === file.path && (
                            <DiffCommentForm
                                label={t`Comment on the whole file ${file.path}`}
                                onCancel={() => setCommenting(undefined)}
                                onSubmit={(text) => {
                                    useDiffCommentStore.getState().add(threadId, { messageId, path: file.path, text });
                                    setCommenting(undefined);
                                }}
                            />
                        )}
                    </li>
                ))}
            </ul>
            {typeof patch === "object" && (
                <p className="text-muted-foreground border-border border-t px-3 py-2 text-xs" role="status">
                    <Trans>The diff is too large to keep. The files and their line counts are shown.</Trans>
                </p>
            )}
            {typeof patch === "string" && (
                <Dialog onOpenChange={setOpen} open={open}>
                    <DialogContent className="max-w-3xl">
                        <DialogHeader>
                            <DialogTitle>
                                <Trans>Changes in this turn</Trans>
                            </DialogTitle>
                            <DialogDescription>
                                <Trans>The diff as it was when the turn ended. Later edits to these files are not part of it.</Trans>
                            </DialogDescription>
                        </DialogHeader>
                        <DialogPanel>
                            <HostDiffViewer comment={commentable ? { messageId, threadId } : undefined} patch={patch} />
                            {commentable && <DiffCommentsDraft threadId={threadId} />}
                        </DialogPanel>
                    </DialogContent>
                </Dialog>
            )}
        </section>
    );
};

export default HostChanges;
