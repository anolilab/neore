"use client";

import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";
import { useEffect, useState } from "react";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import useCurrentModel from "@/features/chat/core/hooks/use-current-model";
import { useCurrentThreadId, useThreadMetadata } from "@/features/chat/core/stores/thread-store-hooks";
import useThreadHandlers from "@/features/chat/thread-list/hooks/use-thread-handlers";

/**
 * Archives or restores the open thread on the `archiveThread` shortcut, and deletes it on `deleteThread` after the owner
 * confirms (`use-keyboard-shortcut-handler.ts`). Renders only the confirmation dialog.
 */
const ThreadShortcutsListener: FC = () => {
    const { t } = useLingui();
    const currentThreadId = useCurrentThreadId();
    const threadMetadata = useThreadMetadata();
    const currentModel = useCurrentModel();
    const { handleDeleteThread, updateThread } = useThreadHandlers(() => {});
    const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

    useEffect(() => {
        const archive = () => {
            if (currentThreadId === undefined || currentThreadId === "default") {
                return;
            }

            const isArchived = threadMetadata.get(currentThreadId)?.status === "archived";

            updateThread(currentThreadId, currentModel, isArchived ? "active" : "archived");
        };

        const askToDelete = () => {
            if (currentThreadId === undefined || currentThreadId === "default") {
                return;
            }

            setIsConfirmingDelete(true);
        };

        globalThis.addEventListener("archiveThread", archive);
        globalThis.addEventListener("deleteThread", askToDelete);

        return () => {
            globalThis.removeEventListener("archiveThread", archive);
            globalThis.removeEventListener("deleteThread", askToDelete);
        };
    }, [currentModel, currentThreadId, threadMetadata, updateThread]);

    return (
        <DeleteConfirmationDialog
            description={t`Are you sure you want to delete this thread? This action cannot be undone and will permanently remove all messages in this conversation.`}
            onConfirm={() => {
                if (currentThreadId !== undefined) {
                    handleDeleteThread(currentThreadId);
                }

                setIsConfirmingDelete(false);
            }}
            onOpenChange={setIsConfirmingDelete}
            open={isConfirmingDelete}
            title={t`Delete thread?`}
        />
    );
};

export default ThreadShortcutsListener;
