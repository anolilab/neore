import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Doc, Id } from "@neore/backend/dataModel";
import { shardOptionsFor } from "@neore/client-runtime";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useThreadManager } from "@/features/chat/core/hooks/use-thread-manager";
import { useOptimisticActions, useThreadActions } from "@/features/chat/core/stores/thread-store-hooks";
import { routeIsOn, survivingPaneAfterDelete } from "@/features/chat/split/split-layout-store";
import { focusThreadSearchToggle } from "@/features/keyboard/lib/thread-search-target";
import type { DownloadFormat } from "@/lib/download";
import { handleDownload } from "@/lib/download";
import { ValidationError } from "@/lib/errors";
import { useCRPC, useLunora, useLunoraActionOptions } from "@/lib/lunora/crpc";
import { showError, showSuccess } from "@/lib/toast";

import { chatActionConfirmations, CONFIRM_EVERYTHING } from "../lib/chat-action-confirmations";
import type { BranchNode, LoadingStates } from "../types";

/** What a confirmation asks, and the action it runs only on confirm. */
interface ConfirmationRequest {
    /** Runs after the confirm, once the dialog has returned focus: for focus that must land on a control still on the page. */
    afterConfirm?: () => void;
    confirmLabel: string;
    description: string;
    run: () => void;
    title: string;
}

/**
 * Where focus goes after a confirmed archive or unpin, when the control that asked was in the sidebar: that row leaves its
 * group and unmounts, so focus lands on the search toggle, which stays. Read when the action is asked, before the dialog takes
 * focus. From the shortcut, the palette or the chat, focus is left where it was.
 */
const focusListAfterSidebarAction = (): (() => void) | undefined => {
    const origin = document.activeElement;

    if (!(origin instanceof HTMLElement) || origin.closest('[data-slot="sidebar"]') === null) {
        return undefined;
    }

    return () => {
        focusThreadSearchToggle();
    };
};

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
    const { clearOptimisticPin, clearOptimisticStatus, removeOptimisticDeletion, setOptimisticPin, setOptimisticStatus } = useOptimisticActions();
    const crpc = useCRPC();
    const { data: userSettings } = useUserSettings();
    // Until the settings are known, every action asks: a missing answer must not skip a prompt someone opted into.
    const confirmations = userSettings === undefined ? CONFIRM_EVERYTHING : chatActionConfirmations(userSettings);
    // One confirmation at a time: the request the dialog shows, and whether it is open.
    const [pendingRequest, setPendingRequest] = useState<ConfirmationRequest | undefined>(undefined);
    const [dialogOpen, setDialogOpen] = useState(false);

    const askFirst = useCallback((request: ConfirmationRequest) => {
        setPendingRequest(request);
        setDialogOpen(true);
    }, []);

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
        async (deletedIds: string[]) => {
            // Each deleted row is restored on its own, including branches deleted with their parent.
            // Undo is best-effort: a row that is already gone stays hidden.
            const results = await Promise.allSettled(deletedIds.map((id) => undoDeleteThreadMutation({ threadId: id as Id<"threads"> })));

            deletedIds.forEach((id, index) => {
                if (results[index]?.status === "fulfilled") {
                    removeOptimisticDeletion(id);
                }
            });
        },
        [removeOptimisticDeletion, undoDeleteThreadMutation],
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
            deleteBranch(threadId)
                .then(({ deletedIds, threadDeleted }) => {
                    const undo = <button onClick={() => handleUndoDeleteThread(deletedIds)} type="button">{t`Undo`}</button>;

                    if (threadDeleted) {
                        showSuccess(
                            <>
                                {t`Thread deleted.`} {undo}
                            </>,
                        );
                    } else if (deletedIds.length > 0) {
                        // The thread was refused but some of its branches were deleted: those can still be brought back.
                        showError(
                            <>
                                {t`Failed to delete the thread. ${plural(deletedIds.length, { one: "# branch was deleted.", other: "# branches were deleted." })}`}{" "}
                                {undo}
                            </>,
                        );
                    } else {
                        showError(t`Failed to delete threads`);
                    }

                    return undefined;
                })
                .catch(() => {
                    showError(t`Failed to delete threads`);
                });
        },
        [deleteBranch, handleUndoDeleteThread, t],
    );

    const handleUndoUnpinThread = useCallback(
        (threadId: string) => {
            setOptimisticPin(threadId, true);

            pinThreadMutation({ threadId: threadId as Id<"threads"> })
                .then(() => {
                    clearOptimisticPin(threadId);

                    return undefined;
                })
                .catch((error) => {
                    console.error("Failed to re-pin thread:", error);
                    showError(t`Failed to pin thread`);
                    setOptimisticPin(threadId, false);
                    clearOptimisticPin(threadId);
                });
        },
        [pinThreadMutation, setOptimisticPin, clearOptimisticPin, t],
    );

    const handleUndoArchiveThread = useCallback(
        (threadId: string, model: string) => {
            setOptimisticStatus(threadId, "active");

            updateThreadAction({ model, status: "active", threadId: threadId as Id<"threads"> })
                .then(() => {
                    clearOptimisticStatus(threadId);

                    return undefined;
                })
                .catch((error) => {
                    console.error("Failed to unarchive thread:", error);
                    showError(t`Failed to unarchive thread`);
                    setOptimisticStatus(threadId, "archived");
                    clearOptimisticStatus(threadId);
                });
        },
        [updateThreadAction, setOptimisticStatus, clearOptimisticStatus, t],
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

    const unpinNow = useCallback(
        async (threadId: string) => {
            // Optimistic update - show unpinned immediately
            setOptimisticPin(threadId, false);

            unpinThreadMutation({ threadId: threadId as Id<"threads"> })
                .then(() => {
                    showSuccess(
                        <>
                            {t`Thread unpinned`} <button onClick={() => handleUndoUnpinThread(threadId)} type="button">{t`Undo`}</button>
                        </>,
                    );
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
        [unpinThreadMutation, handleUndoUnpinThread, setOptimisticPin, clearOptimisticPin, t],
    );

    const handleUnpinThread = useCallback(
        (threadId: string) => {
            if (!confirmations.unpin) {
                void unpinNow(threadId);

                return;
            }

            askFirst({
                afterConfirm: focusListAfterSidebarAction(),
                confirmLabel: t`Unpin`,
                description: t`The chat will no longer be pinned. You can pin it again from the list.`,
                run: () => {
                    void unpinNow(threadId);
                },
                title: t`Unpin this chat?`,
            });
        },
        [askFirst, confirmations.unpin, t, unpinNow],
    );

    const applyThreadStatus = useCallback(
        async (threadId: string, model: string, status: "archived" | "active") => {
            // Optimistic update - show new status immediately
            const previousStatus = status === "archived" ? "active" : "archived";

            setOptimisticStatus(threadId, status);

            // `threadId` originates from thread list nodes/route params, which only name real threads.
            updateThreadAction({ model, status, threadId: threadId as Id<"threads"> })
                .then(() => {
                    showSuccess(
                        status === "archived" ? (
                            <>
                                {t`Thread archived`} <button onClick={() => handleUndoArchiveThread(threadId, model)} type="button">{t`Undo`}</button>
                            </>
                        ) : (
                            t`Thread restored`
                        ),
                    );
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
        [updateThreadAction, handleUndoArchiveThread, setOptimisticStatus, clearOptimisticStatus, t],
    );

    // Restoring runs at once; only archiving asks, when the setting is on.
    const updateThread = useCallback(
        (threadId: string, model: string, status: "archived" | "active") => {
            if (status !== "archived" || !confirmations.archive) {
                void applyThreadStatus(threadId, model, status);

                return;
            }

            askFirst({
                afterConfirm: focusListAfterSidebarAction(),
                confirmLabel: t`Archive`,
                description: t`Archived chats stay searchable, and you can restore them from the archive.`,
                run: () => {
                    void applyThreadStatus(threadId, model, status);
                },
                title: t`Archive this chat?`,
            });
        },
        [applyThreadStatus, askFirst, confirmations.archive, t],
    );

    const handleBulkDeleteThreads = useCallback(
        async (threadIds: string[]) => {
            if (threadIds.length === 0) {
                return;
            }

            deleteThreadsMutation({ threadIds })
                .then((result) => {
                    const count = result.deletedCount;

                    // Local metadata goes only once the server has deleted the rows.
                    for (const id of threadIds) {
                        deleteThreadMetadata(id);
                    }

                    const isDeletingCurrentThread = currentThreadId && threadIds.includes(currentThreadId);

                    if (isDeletingCurrentThread) {
                        // Once the server has deleted them: the survivor is read, then the route moves only if it still shows a deleted chat.
                        // With the split view on, the other open panes stay: the route moves to one of them instead of `/chat`.
                        void (async () => {
                            const survivor = await survivingPaneAfterDelete(threadIds, (id) => {
                                const args = { threadId: id as Id<"threads"> };

                                return lunora.query(api.chat.functions.getThread, args, shardOptionsFor(args));
                            });

                            if (!routeIsOn(threadIds)) {
                                return;
                            }

                            navigate(
                                survivor === undefined
                                    ? { replace: true, to: "/chat" }
                                    : { params: { threadId: survivor }, replace: true, to: "/chat/$threadId" },
                            );
                        })();
                    }

                    showSuccess(t`${plural(count, { one: "# thread deleted.", other: "# threads deleted." })}`);

                    return undefined;
                })
                .catch((error) => {
                    console.error("Failed to delete threads:", error);
                    showError(t`Failed to delete threads`);
                });
        },
        [deleteThreadsMutation, deleteThreadMetadata, t, currentThreadId, navigate, lunora],
    );

    // Rendered by the caller, once, so the dialog survives the menu that opened it.
    const confirmDialog = (
        <ConfirmDialog
            confirmLabel={pendingRequest?.confirmLabel}
            description={pendingRequest?.description}
            onConfirm={() => {
                const request = pendingRequest;

                setDialogOpen(false);
                request?.run();

                // The dialog returns focus to the button that opened it on close, so a follow-up runs after that return.
                if (request?.afterConfirm) {
                    globalThis.setTimeout(request.afterConfirm, 0);
                }
            }}
            onOpenChange={setDialogOpen}
            open={dialogOpen}
            title={pendingRequest?.title ?? ""}
        />
    );

    return {
        // Delete is not gated here: each caller asks in its own dialog, so a gate here would ask twice.
        confirmBeforeDelete: confirmations.delete,
        confirmDialog,
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
