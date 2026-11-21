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
import type { FC, ReactNode } from "react";
import { useCallback } from "react";
import { useDropzone } from "react-dropzone";

import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import { requestComposerAttach, withdrawComposerAttach } from "@/features/chat/core/utils/composer-submit";
import { showError } from "@/lib/toast";

/** Whether `pathname` is the new-chat page, whose composer takes the files without a navigation. */
export const isNewChatPath = (pathname: string): boolean => pathname === "/chat" || pathname === "/chat/";

/**
 * Opens the new chat for a drop. When the navigation does not land there (the update dialog stopped it, say), the files
 * are taken back, so they never turn up in some later new chat; the result says whether it landed.
 */
export const openNewChatFor = async (files: ReadonlyArray<File>, go: () => Promise<unknown>, currentPath: () => string): Promise<boolean> => {
    await go().catch(() => undefined);

    if (isNewChatPath(currentPath())) {
        return true;
    }

    withdrawComposerAttach(files);

    return false;
};

const ThreadListDropZone: FC<{ children: ReactNode }> = ({ children }) => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const router = useRouter();
    // The files are for this account: a composer of another one (after an account switch) never uploads them.
    const { data: session } = useAuthSession();
    const accountId = session?.user?.id;

    const onDrop = useCallback(
        (files: File[]) => {
            if (files.length === 0) {
                return;
            }

            // Held until the new-chat composer takes them, so the drop survives the navigation below.
            requestComposerAttach({ accountId, files });

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

    const { getRootProps, isDragActive } = useDropzone({ multiple: true, noClick: true, noKeyboard: true, onDrop });

    return (
        <div {...getRootProps({ className: "relative flex min-h-0 flex-1 flex-col" })} data-testid="thread-list-drop-zone">
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
