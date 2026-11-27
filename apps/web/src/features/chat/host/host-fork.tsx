"use client";

/**
 * "Fork here" on a coding agent's chat: a new chat on the same computer and folder whose agent session continues this one
 * (`acp.remote.forkHostThread`, which asks the computer to fork the agent's own session). Offered only when the agent said it forks
 * sessions. The fork works in the same folder as this chat, so the two can change the same files, and a git worktree there is
 * shared with it (a per-chat worktree is not built yet): the person is told so before the fork is made, not refused.
 */

import { useLingui } from "@lingui/react/macro";
import type { CapabilityReportInput } from "@neore/ai/capabilities";
import { capabilityOf, isAvailable } from "@neore/ai/capabilities";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { GitFork } from "lucide-react";
import type { FC } from "react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { getLocalizedError } from "@/features/auth/lib/utilities";
import { useCRPC } from "@/lib/lunora/crpc";

const HostFork: FC<{ capabilities: CapabilityReportInput | undefined; disabled?: boolean; threadId: string }> = ({ capabilities, disabled, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    // One id per click, kept while it is retried: a double tap forks once (`clientId`).
    const clientId = useRef<string | undefined>(undefined);
    const fork = useMutation(crpc.acp.remote.forkHostThread.mutationOptions());

    if (!isAvailable(capabilityOf(capabilities, "sessions.fork"))) {
        return null;
    }

    const confirm = () => {
        clientId.current ??= crypto.randomUUID();
        fork.mutate(
            // The route's own id type is a branded string; the thread id the composer holds is that thread's.
            { clientId: clientId.current, threadId: threadId as never },
            {
                onError: (error) => {
                    toast.error(getLocalizedError({ error, t }));
                },
                onSuccess: (result) => {
                    clientId.current = undefined;
                    setOpen(false);

                    if (result.threadId !== undefined) {
                        void navigate({ params: { threadId: result.threadId }, to: "/chat/$threadId" });
                    }
                },
            },
        );
    };

    return (
        <div className="flex justify-end">
            <Button disabled={disabled === true || fork.isPending} onClick={() => setOpen(true)} size="sm" type="button" variant="ghost">
                <GitFork aria-hidden="true" className="size-4" />
                {t`Fork here`}
            </Button>
            <ConfirmDialog
                confirmLabel={t`Fork here`}
                description={t`The fork continues from this conversation in a new chat on the same computer and folder. Both chats work in that folder, so they can change the same files, and a git worktree there is shared too.`}
                loading={fork.isPending}
                onConfirm={confirm}
                onOpenChange={setOpen}
                open={open}
                title={t`Fork this chat?`}
            />
        </div>
    );
};

export default HostFork;
