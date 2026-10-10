"use client";

import { useLingui } from "@lingui/react/macro";
import type { Doc, Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@neore/ui/components/responsive-popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenIcon, CheckIcon, FileTextIcon, LibraryIcon, Loader2Icon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

type KnowledgeFile = Doc<"knowledgeFiles">;

interface KBAttachmentButtonProps {
    threadId?: string;
}

const KBAttachmentButton: FC<KBAttachmentButtonProps> = ({ threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);

    // Get all user's KB files — only once the picker opens. Every query on first
    // paint queues on the one `__root__` shard (see `e2e/first-paint.e2e.test.ts`).
    const { data: allFiles } = useQuery(crpc.knowledge.functions.listFiles.queryOptions(open ? {} : skipToken));

    // Get files attached to this thread
    const threadKnowledgeQueryOptions = crpc.knowledge.functions.getThreadKnowledge.queryOptions(
        // `threadId` is the `/chat/$threadId` route param, passed down as a plain string.
        threadId ? { threadId: threadId as Id<"threads"> } : skipToken,
    );
    const { data: threadFiles } = useQuery(threadKnowledgeQueryOptions);

    // Collections, attached whole. Read once the picker opens — like the file list —
    // so the header adds nothing to first paint.
    const { data: collections } = useQuery(crpc.knowledge.collections.listCollections.queryOptions(open ? {} : skipToken));
    const { data: threadCollections, refetch: refetchThreadCollections } = useQuery(
        crpc.knowledge.collections.getThreadCollections.queryOptions(open && threadId ? { threadId: threadId as Id<"threads"> } : skipToken),
    );
    const { isPending: isTogglingCollection, mutateAsync: attachCollection } = useMutation(
        crpc.knowledge.collections.attachCollectionToThread.mutationOptions(),
    );
    const { isPending: isDetachingCollection, mutateAsync: detachCollection } = useMutation(
        crpc.knowledge.collections.detachCollectionFromThread.mutationOptions(),
    );
    const attachedCollectionIds = useMemo(() => new Set((threadCollections ?? []).map((collection) => collection.collectionId as string)), [threadCollections]);

    // The crpc shim's query keys are untagged, so `getQueryData` needs the shape spelled out.
    type ThreadKnowledge = NonNullable<typeof threadFiles>;

    // `mutationOptions()` only supplies `mutationFn`; the optimistic-update callbacks
    // are TanStack's and belong on the `useMutation` call.
    const { isPending: isAttaching, mutateAsync: attachToThread } = useMutation({
        ...crpc.knowledge.functions.attachToThread.mutationOptions(),
        onMutate: async ({ knowledgeFileId }) => {
            // Cancel outgoing refetches
            await queryClient.cancelQueries(threadKnowledgeQueryOptions);

            // Snapshot previous value
            const previous = queryClient.getQueryData<ThreadKnowledge>(threadKnowledgeQueryOptions.queryKey);

            // Optimistically add the file
            const fileToAdd = allFiles?.find((f: KnowledgeFile) => (f._id as string) === knowledgeFileId);

            if (fileToAdd) {
                queryClient.setQueryData(threadKnowledgeQueryOptions.queryKey, (old: ThreadKnowledge | undefined) => [
                    ...(old ?? []),
                    { ...fileToAdd, addedAt: Date.now() },
                ]);
            }

            return { previous };
        },
        onError: (_error, _variables, context: { previous?: ThreadKnowledge } | undefined) => {
            // Rollback on error
            if (context?.previous) {
                queryClient.setQueryData(threadKnowledgeQueryOptions.queryKey, context.previous);
            }
        },
    });

    const { isPending: isDetaching, mutateAsync: detachFromThread } = useMutation({
        ...crpc.knowledge.functions.detachFromThread.mutationOptions(),
        onMutate: async ({ knowledgeFileId }) => {
            await queryClient.cancelQueries(threadKnowledgeQueryOptions);

            const previous = queryClient.getQueryData<ThreadKnowledge>(threadKnowledgeQueryOptions.queryKey);

            // Optimistically remove the file
            queryClient.setQueryData(threadKnowledgeQueryOptions.queryKey, (old: ThreadKnowledge | undefined) =>
                (old ?? []).filter((f) => f?._id !== knowledgeFileId),
            );

            return { previous };
        },
        onError: (_error, _variables, context: { previous?: ThreadKnowledge } | undefined) => {
            if (context?.previous) {
                queryClient.setQueryData(threadKnowledgeQueryOptions.queryKey, context.previous);
            }
        },
    });

    // `getThreadKnowledge` returns one slot per attachment, `null` where the file row is gone.
    const attachedFileIds = useMemo(() => new Set((threadFiles ?? []).flatMap((f) => (f ? [f._id as string] : []))), [threadFiles]);

    const indexedFiles = useMemo(() => (allFiles ?? []).filter((f: KnowledgeFile) => f.status === "indexed"), [allFiles]);
    const attachedCount = attachedFileIds.size + attachedCollectionIds.size;

    const handleToggle = useCallback(
        async (fileId: string, isAttached: boolean) => {
            if (!threadId) {
                return;
            }

            try {
                if (isAttached) {
                    await detachFromThread({ knowledgeFileId: fileId as Id<"knowledgeFiles">, threadId: threadId as Id<"threads"> });
                } else {
                    await attachToThread({ knowledgeFileId: fileId as Id<"knowledgeFiles">, threadId: threadId as Id<"threads"> });
                }
            } catch {
                toast.error(isAttached ? t`Failed to detach file` : t`Failed to attach file`);
            }
        },
        [threadId, attachToThread, detachFromThread, t],
    );

    const handleCollectionToggle = useCallback(
        async (collectionId: Id<"knowledgeCollections">, isAttached: boolean) => {
            if (!threadId) {
                return;
            }

            try {
                await (isAttached
                    ? detachCollection({ collectionId, threadId: threadId as Id<"threads"> })
                    : attachCollection({ collectionId, threadId: threadId as Id<"threads"> }));
                await refetchThreadCollections();
            } catch {
                toast.error(isAttached ? t`Failed to detach collection` : t`Failed to attach collection`);
            }
        },
        [attachCollection, detachCollection, refetchThreadCollections, t, threadId],
    );

    if (!threadId) {
        return null;
    }

    const isBusy = isAttaching || isDetaching || isTogglingCollection || isDetachingCollection;

    return (
        <Tooltip>
            <Popover onOpenChange={setOpen} open={open}>
                <TooltipTrigger
                    render={
                        <PopoverTrigger
                            render={
                                <Button
                                    aria-label={t`Knowledge base`}
                                    aria-pressed={attachedCount > 0}
                                    className={cn("relative", attachedCount > 0 && "text-primary")}
                                    size="icon"
                                    variant="ghost"
                                >
                                    <BookOpenIcon className="h-4 w-4" />
                                    {attachedCount > 0 && (
                                        <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-bold">
                                            {attachedCount}
                                        </span>
                                    )}
                                    <span className="sr-only">{t`Knowledge base`}</span>
                                </Button>
                            }
                        />
                    }
                />
                <PopoverContent align="end" className="w-72 p-0" side="bottom" sideOffset={8}>
                    <div className="border-b p-3">
                        <h3 className="text-sm font-medium">{t`Knowledge Base`}</h3>
                        <p className="text-muted-foreground mt-0.5 text-xs">{t`Attach files or whole collections for the AI to reference and cite in this conversation.`}</p>
                    </div>

                    {collections && collections.length > 0 && (
                        <div className="border-b p-2">
                            <p className="text-muted-foreground px-2 pb-1 text-[11px] font-medium tracking-wide uppercase">{t`Collections`}</p>
                            <div className="max-h-40 space-y-1 overflow-y-auto">
                                {collections.map((collection) => {
                                    const isAttached = attachedCollectionIds.has(collection._id as string);

                                    return (
                                        <button
                                            aria-pressed={isAttached}
                                            className={cn(
                                                "hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                                                isAttached && "bg-primary/5",
                                            )}
                                            disabled={isBusy}
                                            key={collection._id as string}
                                            onClick={() => handleCollectionToggle(collection._id, isAttached)}
                                            type="button"
                                        >
                                            <div
                                                className={cn(
                                                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                                                    isAttached ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30",
                                                )}
                                            >
                                                {isAttached && <CheckIcon className="h-3 w-3" />}
                                            </div>
                                            <LibraryIcon aria-hidden="true" className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                                            <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                                            {!collection.isOwner && <span className="text-muted-foreground text-[10px]">{t`shared`}</span>}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    <div className="max-h-64 overflow-y-auto p-2" style={{ contentVisibility: "auto" }}>
                        {indexedFiles.length > 0 ? (
                            <div className="space-y-1">
                                {indexedFiles.map((file: KnowledgeFile) => {
                                    const isAttached = attachedFileIds.has(file._id as string);

                                    return (
                                        <button
                                            aria-pressed={isAttached}
                                            className={cn(
                                                "hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                                                isAttached && "bg-primary/5",
                                            )}
                                            disabled={isBusy}
                                            key={file._id as string}
                                            onClick={() => handleToggle(file._id as string, isAttached)}
                                            type="button"
                                        >
                                            <div
                                                className={cn(
                                                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                                                    isAttached ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30",
                                                )}
                                            >
                                                {isAttached && <CheckIcon className="h-3 w-3" />}
                                            </div>
                                            <FileTextIcon aria-hidden="true" className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                                            <span className="min-w-0 flex-1 truncate">{file.name}</span>
                                            {isBusy && <Loader2Icon aria-hidden="true" className="h-3 w-3 animate-spin" />}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="py-6 text-center">
                                <BookOpenIcon aria-hidden="true" className="text-muted-foreground mx-auto mb-2 h-8 w-8" />
                                <p className="text-muted-foreground text-xs">
                                    {allFiles && allFiles.length > 0
                                        ? t`No indexed files available. Files are still being processed.`
                                        : t`No knowledge base files yet. Upload files in Settings.`}
                                </p>
                            </div>
                        )}
                    </div>

                    {attachedCount > 0 && (
                        <div className="border-t px-3 py-2">
                            <p className="text-muted-foreground text-xs">{t`${attachedCount} source(s) attached to this thread`}</p>
                        </div>
                    )}
                </PopoverContent>
            </Popover>
            <TooltipContent side="bottom">{t`Knowledge base`}</TooltipContent>
        </Tooltip>
    );
};

export default KBAttachmentButton;
