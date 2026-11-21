"use client";

/**
 * Files dropped on the sidebar's thread list start a new chat with them attached. The new-chat composer takes them
 * through its normal upload path (`requestComposerAttach`, as a drop on the desktop dock icon does), so the chat's own
 * size and type limits apply there, and nothing is sent.
 *
 * Only a drag that carries files activates the zone: a thread moved within the list is a pointer drag (dnd-kit) and
 * fires no drag events at all. With the keyboard, the same is New chat, then the composer's attach button.
 */

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { FilePlusIcon } from "lucide-react";
import type { DragEvent, FC, ReactNode } from "react";
import { useCallback } from "react";
import { useDropzone } from "react-dropzone";

import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import { requestComposerAttach, withdrawComposerAttach } from "@/features/chat/core/utils/composer-submit";
import { SIGNED_OUT } from "@/features/chat/core/utils/signed-out";
import { showError } from "@/lib/toast";

/** Whether `pathname` is the new-chat page, whose composer takes the files without a navigation. */
export const isNewChatPath = (pathname: string): boolean => pathname === "/chat" || pathname === "/chat/";

/**
 * The files of a drag, as the composer's own drop reads them: a dropped folder stays one entry rather than every file
 * inside it, which react-dropzone's default would upload all at once. While dragging, the items say a drag carries files.
 */
export const droppedFiles = async (event: unknown): Promise<(DataTransferItem | File)[]> => {
    const transfer = (event as { dataTransfer?: DataTransfer | null }).dataTransfer;

    if (!transfer) {
        return [];
    }

    return (event as { type?: string }).type === "drop" ? [...transfer.files] : [...transfer.items];
};

/** The drops still waiting for the new chat to open, and the latest move there, which decides for all of them. */
const waiting = { attempt: 0, files: [] as File[] };

/**
 * Opens the new chat for a drop. When the navigation does not land there (the update dialog stopped it, say), the files
 * of every drop still waiting are taken back, so they never turn up in some later new chat. A move a later drop
 * superseded decides nothing: the later one does. The result is `false` only when this move failed and took files back.
 */
export const openNewChatFor = async (files: ReadonlyArray<File>, go: () => Promise<unknown>, currentPath: () => string): Promise<boolean> => {
    waiting.attempt += 1;
    waiting.files.push(...files);

    const { attempt } = waiting;

    await go().catch(() => undefined);

    if (waiting.attempt !== attempt) {
        return true;
    }

    const all = [...waiting.files];

    waiting.files.length = 0;

    if (isNewChatPath(currentPath())) {
        return true;
    }

    withdrawComposerAttach(all);

    return false;
};

const ThreadListDropZone: FC<{ children: ReactNode }> = ({ children }) => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const router = useRouter();
    // The files are for this account: a composer of another one (after an account switch) never uploads them.
    // Undefined only while the session loads; a loaded session with no user is signed out, never "any account".
    const { data: session, isPending: sessionPending } = useAuthSession();
    const accountId = session?.user?.id ?? (sessionPending ? undefined : SIGNED_OUT);

    const onDrop = useCallback(
        (files: File[]) => {
            if (files.length === 0) {
                return;
            }

            // Held until the new-chat composer takes them, so the drop survives the navigation below.
            if (requestComposerAttach({ accountId, files }) > 0) {
                showError(t`Files dropped earlier for another account were not attached. Drop them again.`);
            }

            if (isNewChatPath(router.state.location.pathname)) {
                return;
            }

            void openNewChatFor(
                files,
                () => navigate({ search: {}, to: "/chat" }),
                () => router.state.location.pathname,
            ).then((landed: boolean) => {
                if (!landed) {
                    showError(t`The new chat could not open, so the files were not attached. Drop them again.`);
                }

                return landed;
            });
        },
        [accountId, navigate, router, t],
    );

    const { getRootProps, isDragActive } = useDropzone({ getFilesFromEvent: droppedFiles, multiple: true, noClick: true, noKeyboard: true, onDrop });

    // React drag events bubble through portals: a file dropped on a dialog the list opens (a project form, which imports
    // its own files) must not reach the zone. `currentTarget` is the zone's own element; stopped here, react-dropzone's
    // own handlers skip the event.
    const onlyOverTheList = (event: DragEvent<HTMLElement>) => {
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) {
            event.stopPropagation();
        }
    };

    return (
        <div
            {...getRootProps({
                className: "relative flex min-h-0 flex-1 flex-col",
                onDragEnter: onlyOverTheList,
                onDragLeave: onlyOverTheList,
                onDragOver: onlyOverTheList,
                onDrop: onlyOverTheList,
            })}
            data-testid="thread-list-drop-zone"
        >
            {children}
            <div
                aria-hidden={!isDragActive}
                className={cn(
                    "border-primary bg-background/90 pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-center backdrop-blur-sm",
                    isDragActive ? "visible" : "invisible",
                )}
            >
                <FilePlusIcon aria-hidden="true" className="text-primary size-6" />
                <p className="text-sm font-medium">{t`Drop files to start a new chat`}</p>
                <p className="text-muted-foreground text-xs">{t`They are attached; nothing is sent until you send it.`}</p>
            </div>
            {isDragActive && (
                <span className="sr-only" role="status">
                    {t`Drop files to start a new chat`}
                </span>
            )}
        </div>
    );
};

export default ThreadListDropZone;
