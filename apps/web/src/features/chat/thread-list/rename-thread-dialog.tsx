import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { useMutation } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";

import { beginTitleSave, queueTitleWrite, settleTitleSave } from "@/features/chat/core/lib/thread-title-saves";
import { useThreadActions } from "@/features/chat/core/stores/thread-store-hooks";
import { useLunoraActionOptions } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

interface RenameThreadDialogProps {
    onOpenChange: (open: boolean) => void;
    open: boolean;
    /** Where focus goes when the dialog closes. The parent unmounts the dialog on close, so this runs from the unmount. */
    restoreFocus?: () => HTMLElement | null;
    /** The title as stored: empty for an untitled chat, which the input then leaves empty with a placeholder. */
    storedTitle: string;
    threadId: string;
}

/**
 * Renames a thread from the thread list. It calls the same action as the chat header's title editor and updates the title
 * the header reads.
 */
const RenameThreadDialog = ({ onOpenChange, open, restoreFocus, storedTitle, threadId }: RenameThreadDialogProps) => {
    const { t } = useLingui();
    const inputId = useId();
    const errorId = useId();
    const helpId = useId();
    const { setThreadMetadata } = useThreadActions();
    // The title the dialog opened with. A live update while it is open must not be overwritten by a Save that changed nothing.
    const [initialTitle] = useState(storedTitle);
    const [title, setTitle] = useState(storedTitle);
    const [saveError, setSaveError] = useState<string | null>(null);
    // The input takes focus when the dialog opens: the dialog's own default would give it to the close button.
    const titleInput = useRef<HTMLInputElement>(null);
    // Fixed for the dialog's lifetime: the parent mounts it for one thread and unmounts it on close.
    const [returnFocusTo] = useState(() => restoreFocus);

    // Focus returns from the unmount, after the dialog's own focus trap is gone; a plain close would leave it on a removed row.
    // The restore is scheduled by the cleanup and cancelled when the effect runs again: StrictMode replays the mount, and the
    // replayed cleanup must not move focus out of the open dialog.
    const pendingRestore = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (pendingRestore.current !== null) {
            clearTimeout(pendingRestore.current);
            pendingRestore.current = null;
        }

        return () => {
            pendingRestore.current = setTimeout(() => {
                pendingRestore.current = null;
                returnFocusTo?.()?.focus();
            }, 0);
        };
    }, [returnFocusTo]);

    // The header reads a metadata entry before the list's title. Only an entry that already exists is kept in step:
    // creating one would hide later title changes from the server.
    const showTitle = (shown: string | undefined) => {
        if (shown === undefined) {
            return;
        }

        setThreadMetadata((previous) => {
            const current = previous.get(threadId);

            if (!current) {
                return previous;
            }

            return new Map(previous).set(threadId, { ...current, lastActivity: new Date(), title: shown });
        });
    };

    const titleOptions = useLunoraActionOptions(api.chat.functions.updateThread);
    const { isPending, mutate } = useMutation({
        ...titleOptions,
        // Sent after the thread's earlier title writes, so the server applies the saves in the order they were made.
        mutationFn: (variables, context) =>
            queueTitleWrite(threadId, () => titleOptions.mutationFn?.(variables, context) ?? Promise.reject(new Error("The title write has no action."))),
        // Fails at once when offline, instead of waiting in TanStack's queue until the connection returns; never retried.
        networkMode: "always",
        retry: 0,
        // The order is taken when the save is sent (shared with the header's editor), and comes back with the outcome.
        onMutate: (variables) => {
            // The dialog always sends a title; the fallback only types the optional field.
            return { order: beginTitleSave(threadId, variables.title ?? "", storedTitle, false) };
        },
        // Mutation-level, so both outcomes still run when Cancel closes the dialog while the save is pending (per-call callbacks do not).
        // A failure is reported here too: after Cancel the dialog is gone, so the toast is the only notice the person gets.
        onError: (error, _variables, context) => {
            console.error("Failed to rename the thread:", error);
            setSaveError(t`The title could not be saved. Try again.`);
            showError(error);

            if (context) {
                showTitle(settleTitleSave(threadId, context.order, "failed"));
            }
        },
        onSuccess: (_result, _variables, context) => {
            showTitle(settleTitleSave(threadId, context.order, "saved"));
        },
    });

    const trimmed = title.trim();
    const isBlank = trimmed === "";

    const onSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (isBlank) {
            return;
        }

        if (trimmed === initialTitle) {
            onOpenChange(false);

            return;
        }

        const variables = { threadId: threadId as Id<"threads">, title: trimmed };

        mutate(variables, {
            onSuccess: () => {
                onOpenChange(false);
            },
        });
    };

    const describedBy = [saveError ? errorId : null, isBlank ? helpId : null].filter(Boolean).join(" ") || undefined;

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent className="sm:max-w-sm" finalFocus={returnFocusTo} initialFocus={titleInput}>
                <DialogHeader>
                    <DialogTitle>{t`Rename thread`}</DialogTitle>
                </DialogHeader>
                <form className="flex flex-col gap-3" onSubmit={onSubmit}>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor={inputId}>{t`Title`}</Label>
                        <Input
                            aria-describedby={describedBy}
                            aria-invalid={saveError ? true : undefined}
                            aria-required="true"
                            autoFocus
                            id={inputId}
                            onChange={(event) => {
                                setTitle(event.target.value);
                                setSaveError(null);
                            }}
                            placeholder={t`New Chat`}
                            ref={titleInput}
                            value={title}
                        />
                        {isBlank && (
                            <p className="text-muted-foreground text-sm" id={helpId}>
                                {t`Enter a title to save.`}
                            </p>
                        )}
                        {saveError && (
                            <p className="text-destructive text-sm" id={errorId} role="alert">
                                {saveError}
                            </p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
                            {t`Cancel`}
                        </Button>
                        <Button disabled={isPending || isBlank} type="submit">
                            {t`Save`}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default RenameThreadDialog;
