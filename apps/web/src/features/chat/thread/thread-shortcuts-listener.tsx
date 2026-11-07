"use client";

import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";
import { useEffect, useState } from "react";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import useCurrentModel from "@/features/chat/core/hooks/use-current-model";
import { useCurrentThreadId, useOptimisticStatuses } from "@/features/chat/core/stores/thread-store-hooks";
import useThreadHandlers from "@/features/chat/thread-list/hooks/use-thread-handlers";

interface ThreadShortcutsListenerProperties {
    /** Whether the signed-in person owns the open thread. A shared thread's viewer cannot archive or delete it, so the shortcuts do nothing for them. */
    isOwner?: boolean;
    /** The open thread's own model: archiving goes through the thread's model path, not the globally selected one. */
    model?: string;
    /** The open thread's stored status. A pending archive change in the optimistic map takes precedence. */
    status?: string;
}

/**
 * Archives or restores the open thread on the `archiveThread` shortcut, and deletes it on `deleteThread` after the owner
 * confirms (`use-keyboard-shortcut-handler.ts`). Renders only the confirmation dialog. Mounted by the thread view, which
 * owns the open thread's document, in both its normal and its comparison layout.
 */
const ThreadShortcutsListener: FC<ThreadShortcutsListenerProperties> = ({ isOwner = false, model, status }) => {
    const { t } = useLingui();
    const currentThreadId = useCurrentThreadId();
    const optimisticStatuses = useOptimisticStatuses();
    const currentModel = useCurrentModel();
    const { handleDeleteThread, updateThread } = useThreadHandlers(() => {}, currentThreadId);
    // The thread the delete was asked for. The route can change while the dialog is open, so confirming uses this, not the live thread.
    const [deleteTargetId, setDeleteTargetId] = useState<string | undefined>(undefined);

    useEffect(() => {
        const archive = () => {
            if (!isOwner || currentThreadId === undefined || currentThreadId === "default") {
                return;
            }

            // A second press before the first update settles reads the pending status, so it toggles back rather than repeating.
            const effectiveStatus = optimisticStatuses.get(currentThreadId) ?? status;

            updateThread(currentThreadId, model ?? currentModel, effectiveStatus === "archived" ? "active" : "archived");
        };

        const askToDelete = () => {
            if (!isOwner || currentThreadId === undefined || currentThreadId === "default") {
                return;
            }

            setDeleteTargetId(currentThreadId);
        };

        globalThis.addEventListener("archiveThread", archive);
        globalThis.addEventListener("deleteThread", askToDelete);

        return () => {
            globalThis.removeEventListener("archiveThread", archive);
            globalThis.removeEventListener("deleteThread", askToDelete);
        };
    }, [currentModel, currentThreadId, isOwner, model, optimisticStatuses, status, updateThread]);

    return (
        <DeleteConfirmationDialog
            description={t`Are you sure you want to delete this thread? This action cannot be undone and will permanently remove all messages in this conversation.`}
            onConfirm={() => {
                if (deleteTargetId !== undefined) {
                    handleDeleteThread(deleteTargetId);
                }

                setDeleteTargetId(undefined);
            }}
            onOpenChange={(open) => {
                if (!open) {
                    setDeleteTargetId(undefined);
                }
            }}
            open={deleteTargetId !== undefined}
            title={t`Delete thread?`}
        />
    );
};

export default ThreadShortcutsListener;
