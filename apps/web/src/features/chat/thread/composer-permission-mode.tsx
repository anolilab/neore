"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@neore/ui/components/dropdown-menu";
import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import type { FC } from "react";
import { useRef, useState } from "react";

import { useChatIsRunning, useChatThread } from "@/features/chat/core/context/chat-context";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

export type ThreadPermissionMode = "auto" | "auto-edit" | "full" | "supervised";

const MODE_ORDER: ReadonlyArray<ThreadPermissionMode> = ["supervised", "auto-edit", "auto", "full"];

const isMode = (value: unknown): value is ThreadPermissionMode => MODE_ORDER.includes(value as ThreadPermissionMode);

interface ComposerPermissionModeProps {
    disabled?: boolean;
    mode: ThreadPermissionMode;
    onModeChange: (mode: ThreadPermissionMode) => void;
}

/** The control itself: a menu of the four modes, each with a one-line description. */
export const ComposerPermissionMode: FC<ComposerPermissionModeProps> = ({ disabled, mode, onModeChange }) => {
    const { t } = useLingui();

    const labels: Record<ThreadPermissionMode, string> = {
        auto: t`Auto`,
        "auto-edit": t`Auto-edit`,
        full: t`Full access`,
        supervised: t`Supervised`,
    };

    const descriptions: Record<ThreadPermissionMode, string> = {
        auto: t`Tools run on their own settings; a quick check can clear low-risk calls`,
        "auto-edit": t`For now, every change asks`,
        full: t`Every tool runs without asking, except those that need your answer`,
        supervised: t`Anything that is not a plain lookup asks first`,
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        aria-label={t`Permission mode: ${labels[mode]}`}
                        className="bg-sidebar border-border dark:border-sidebar-border/15 hover:bg-accent/50 dark:hover:bg-sidebar-accent/30 text-foreground h-11 gap-1 px-2 sm:h-7 dark:text-white"
                        disabled={disabled}
                        variant="outline"
                    >
                        <ShieldCheck aria-hidden="true" className="size-3 shrink-0" />
                        <span className="hidden sm:inline">{labels[mode]}</span>
                    </Button>
                }
            />
            <DropdownMenuContent align="start" className="w-72" side="top">
                <DropdownMenuRadioGroup
                    aria-label={t`Permission mode`}
                    onValueChange={(value) => {
                        if (isMode(value)) {
                            onModeChange(value);
                        }
                    }}
                    value={mode}
                >
                    {MODE_ORDER.map((option) => (
                        <DropdownMenuRadioItem className="flex-col items-start gap-0" key={option} value={option}>
                            <span className="font-medium">{labels[option]}</span>
                            <span className="text-muted-foreground text-xs">{descriptions[option]}</span>
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

/** The mutation key of a thread's mode save. The composer waits on it: a turn sent before the save lands would run under the old mode. */
export const permissionModeSaveKey = (threadId: string) => ["thread-permission-mode-save", threadId] as const;

/** Whether a mode save for this thread is in flight. */
export const usePermissionModeSaving = (threadId: string | undefined): boolean =>
    useIsMutating({ exact: true, mutationKey: permissionModeSaveKey(threadId ?? "") }) > 0;

/**
 * The control for the open cloud thread: shows the stored mode and writes it. Nothing for a thread that does not exist yet,
 * one the viewer does not own, or a host thread (its approvals keep their own rules).
 */
const ComposerThreadPermissionMode: FC = () => {
    const { t } = useLingui();
    const { thread, threadId } = useChatThread();
    const crpc = useCRPC();
    const isRunning = useChatIsRunning();
    const { data: access } = useQuery(crpc.chat.sharing.getThreadAccess.queryOptions(threadId ? { threadId: threadId as never } : skipToken));
    // The mode the owner's runs use here: a comparison column with no mode of its own runs under its parent's.
    const { data: effective } = useQuery(
        crpc.chat.thread_state.getEffectivePermissionMode.queryOptions(threadId ? { threadId: threadId as never } : skipToken),
    );
    const queryClient = useQueryClient();
    const { mutateAsync } = useMutation({
        ...crpc.chat.thread_state.setThreadPermissionMode.mutationOptions(),
        mutationKey: permissionModeSaveKey(threadId ?? ""),
    });
    const [pending, setPending] = useState<ThreadPermissionMode>();
    const latestSave = useRef(0);

    // Until the thread has loaded, the menu is hidden: a host thread must never show an enabled control while its runner is unknown.
    // A locked thread read without its proof is a stub: metadata only, so it has no `userId` (`LOCKED_STUB_KEYS`). The owner's full row
    // always carries it. The model is no sign: an imported chat has none, and its owner still gets the menu.
    const lockedStub = Boolean(thread?.lockedAt) && thread?.userId === undefined;

    if (!threadId || !thread || lockedStub || thread.runner === "host" || access?.isOwner !== true) {
        return null;
    }

    const ownMode: ThreadPermissionMode = isMode(thread?.permissionMode) ? thread.permissionMode : "auto";
    const stored: ThreadPermissionMode = isMode(effective) ? effective : ownMode;

    return (
        <ComposerPermissionMode
            disabled={isRunning}
            mode={pending ?? stored}
            onModeChange={(mode) => {
                latestSave.current += 1;
                const save = latestSave.current;

                setPending(mode);
                mutateAsync({ mode, threadId: threadId as never })
                    // The menu reads the mode from the cached thread: a saved mode must show without waiting for a refresh.
                    .then(() => queryClient.invalidateQueries({ queryKey: crpc.chat.functions.getThread.queryKey({ threadId: threadId as never }) }))
                    .then(() =>
                        queryClient.invalidateQueries({
                            queryKey: crpc.chat.thread_state.getEffectivePermissionMode.queryKey({ threadId: threadId as never }),
                        }),
                    )
                    .catch((error: unknown) => {
                        showError(error instanceof Error ? error : t`Could not change the permission mode. Please try again.`);
                    })
                    .finally(() => {
                        // Only the newest save clears the selection: an older save finishing must not show the stored mode over a newer pending one.
                        if (latestSave.current === save) {
                            setPending(undefined);
                        }
                    })
                    .catch(() => {});
            }}
        />
    );
};

export default ComposerThreadPermissionMode;
