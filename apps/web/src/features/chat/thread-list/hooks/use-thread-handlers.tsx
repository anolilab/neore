import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Doc, Id } from "@neore/backend/dataModel";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useThreadManager } from "@/features/chat/core/hooks/use-thread-manager";
import { useOptimisticActions, useThreadActions } from "@/features/chat/core/stores/thread-store-hooks";
import type { DownloadFormat } from "@/lib/download";
import { handleDownload } from "@/lib/download";
import { ValidationError } from "@/lib/errors";
import { useCRPC, useLunora, useLunoraActionOptions } from "@/lib/lunora/crpc";
import { showError, showSuccess } from "@/lib/toast";

import type { BranchNode, LoadingStates } from "../types";

const updateLoadingState = <K extends keyof LoadingStates>(previous: LoadingStates, key: K, threadId: string, isAdding: boolean): LoadingStates => {
    const currentSet = previous[key] as Set<string>;
    const newSet = new Set(currentSet);

    if (isAdding) {
        newSet.add(threadId);
    } else {
        newSet.delete(threadId);
    }

    return { ...previous, [key]: newSet };
};

const useThreadHandlers = (setLoadingStates: React.Dispatch<React.SetStateAction<LoadingStates>>, currentThreadId?: string) => {
    const { createBranch, deleteBranch } = useThreadManager(true, currentThreadId);
    const { t } = useLingui();
    const navigate = useNavigate();
    const { deleteThreadMetadata } = useThreadActions();
    const { clearOptimisticPin, clearOptimisticStatus, setOptimisticPin, setOptimisticStatus } = useOptimisticActions();
    const crpc = useCRPC();

    const lunora = useLunora();
    const { mutateAsync: pinThreadMutation } = useMutation(crpc.chat.functions.pinThread.mutationOptions());
    const { mutateAsync: unpinThreadMutation } = useMutation(crpc.chat.functions.unpinThread.mutationOptions());
    const { mutateAsync: updateThreadAction } = useMutation(useLunoraActionOptions(api.chat.functions.updateThread));
    const { mutateAsync: undoDeleteThreadMutation } = useMutation(crpc.chat.functions.undoDeleteThread.mutationOptions());
    const { mutateAsync: deleteThreadsMutation } = useMutation(crpc.chat.functions.deleteThreads.mutationOptions());

    const handleUndoDeleteThread = useCallback(
        // Thread ids reach these handlers as plain strings (component props and
        // `BranchNode` fields) but always come from thread documents, so the brand is
        // re-applied at the mutation/query boundary.
        async (threadId: string) => {
            try {
                await undoDeleteThreadMutation({ threadId: threadId as Id<"threads"> });
            } catch {
                // Undo is best-effort: the row may already be gone.
            }
        },
        [undoDeleteThreadMutation],
    );

    const handleDownloadThread = useCallback(
        async (node: BranchNode, format: DownloadFormat) => {
            if (!node.model) {
                throw new ValidationError("Cannot download thread: Model information is missing", "model", ["required"], {
                    context: {
                        threadId: node.threadId,
                        threadTitle: node.title,
                    },
                });
            }

            setLoadingStates((previous) => updateLoadingState(previous, "downloading", node.threadId, true));

            const downloadData = async () => {
                const data = await lunora.query(api.chat.functions.getFullThreadForExport, {
                    model: node.model!,
                    threadId: node.threadId as Id<"threads">,
                });

                if (data?.thread && data.messages) {
                    // `getFullThreadForExport` returns the public thread projection (same
                    // fields, unbranded ids); the exporter only reads `title`.
                    await handleDownload(data.thread as unknown as Doc<"threads">, data.messages as unknown as Doc<"messages">[], format);
                }
            };

            const cleanup = () => {
                setLoadingStates((previous) => updateLoadingState(previous, "downloading", node.threadId, false));
            };

            try {
                await downloadData();
            } catch (error) {
                console.error("Failed to download thread:", error);
            }

            cleanup();
        },
        [lunora, setLoadingStates],
    );

    const handleCreateBranch = useCallback(
        async (threadId: string, branchName?: string) => {
            try {
                // A thread-level branch copies the whole displayed path.
                // Branch creation navigates automatically after the mutation
                await createBranch(threadId, undefined, branchName);
            } catch (error) {
                console.error("Failed to create branch:", error);
                showError(t`Failed to create branch`);
            }
        },
        [createBranch, t],
    );

    const handleDeleteThread = useCallback(
        (threadId: string) => {
            deleteBranch(threadId);

            showSuccess(
                <>
                    {t`Thread deleted.`} <button onClick={() => handleUndoDeleteThread(threadId)} type="button">{t`Undo`}</button>
                </>,
            );
        },
        [deleteBranch, handleUndoDeleteThread, t],
    );

    const handlePinThread = useCallback(
        async (threadId: string) => {
            // Optimistic update - show pinned immediately
            setOptimisticPin(threadId, true);

            pinThreadMutation({ threadId: threadId as Id<"threads"> })
                .then(() => {
                    showSuccess(t`Thread pinned`);
                    // Clear optimistic state - server data is now authoritative
                    clearOptimisticPin(threadId);

                    return undefined;
                })
                .catch((error) => {
                    console.error("Failed to pin thread:", error);
                    showError(t`Failed to pin thread`);
                    // Rollback on error
                    setOptimisticPin(threadId, false);
                    clearOptimisticPin(threadId);
                });
        },
        [pinThreadMutation, setOptimisticPin, clearOptimisticPin, t],
    );

    const handleUnpinThread = useCallback(
        async (threadId: string) => {
            // Optimistic update - show unpinned immediately
            setOptimisticPin(threadId, false);

            unpinThreadMutation({ threadId: threadId as Id<"threads"> })
                .then(() => {
                    showSuccess(t`Thread unpinned`);
                    // Clear optimistic state - server data is now authoritative
                    clearOptimisticPin(threadId);

                    return undefined;
                })
                .catch((error) => {
                    console.error("Failed to unpin thread:", error);
                    showError(t`Failed to unpin thread`);
                    // Rollback on error
                    setOptimisticPin(threadId, true);
                    clearOptimisticPin(threadId);
                });
        },
        [unpinThreadMutation, setOptimisticPin, clearOptimisticPin, t],
    );

    const updateThread = useCallback(
        async (threadId: string, model: string, status: "archived" | "active") => {
            // Optimistic update - show new status immediately
            const previousStatus = status === "archived" ? "active" : "archived";

            setOptimisticStatus(threadId, status);

            // `threadId` originates from thread list nodes/route params, which only name real threads.
            updateThreadAction({ model, status, threadId: threadId as Id<"threads"> })
                .then(() => {
                    showSuccess(status === "archived" ? t`Thread archived` : t`Thread restored`);
                    // Clear optimistic state - server data is now authoritative
                    clearOptimisticStatus(threadId);

                    return undefined;
                })
                .catch((error) => {
                    const action = status === "archived" ? t`archive` : t`unarchive`;

                    console.error(`Failed to ${action} thread:`, error);
                    showError(status === "archived" ? t`Failed to archive thread` : t`Failed to unarchive thread`);
                    // Rollback on error
                    setOptimisticStatus(threadId, previousStatus);
                    clearOptimisticStatus(threadId);
                });
        },
        [updateThreadAction, setOptimisticStatus, clearOptimisticStatus, t],
    );

    const handleBulkDeleteThreads = useCallback(
        async (threadIds: string[]) => {
            if (threadIds.length === 0) {
                return;
            }

            const isDeletingCurrentThread = currentThreadId && threadIds.includes(currentThreadId);

            if (isDeletingCurrentThread) {
                navigate({
                    replace: true,
                    to: "/chat",
                });
            }

            for (const id of threadIds) {
                deleteThreadMetadata(id);
            }

            deleteThreadsMutation({ threadIds })
                .then((result) => {
                    const count = result.deletedCount;

                    showSuccess(t`${plural(count, { one: "# thread deleted.", other: "# threads deleted." })}`);

                    return undefined;
                })
                .catch((error) => {
                    console.error("Failed to delete threads:", error);
                    showError(t`Failed to delete threads`);
                });
        },
        [deleteThreadsMutation, deleteThreadMetadata, t, currentThreadId, navigate],
    );

    return {
        handleBulkDeleteThreads,
        handleCreateBranch,
        handleDeleteThread,
        handleDownloadThread,
        handlePinThread,
        handleUnpinThread,
        updateThread,
    };
};

export default useThreadHandlers;
