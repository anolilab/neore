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
import { api } from "@neore/backend/api";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { GitFork } from "lucide-react";
import type { FC } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { getLocalizedError } from "@/features/auth/lib/utilities";
import { useLunoraActionOptions } from "@/lib/lunora/crpc";

const HostFork: FC<{ capabilities: CapabilityReportInput | undefined; disabled?: boolean; threadId: string }> = ({ capabilities, disabled, threadId }) => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    // One id per click, kept while it is retried: a double tap forks once (`clientId`).
    const clientId = useRef<string | undefined>(undefined);
    // Still on this chat? A fork that finishes after the person moved on is not taken from them silently, nor do they get pulled away.
    const mounted = useRef(true);
    const openFork = (forkedThreadId: string) => {
        void navigate({ params: { threadId: forkedThreadId }, to: "/chat/$threadId" });
    };
    // The callbacks are the mutation's own, not `mutate`'s: those do not run once this component has unmounted.
    const fork = useMutation({
        // An action: it starts the session and then copies the chat's settled history into the new one.
        ...useLunoraActionOptions(api.acp.remote.forkHostThread),
        networkMode: "always",
        retry: 0,
        onError: (error) => {
            // A refused fork was taken back, so the next click is a new fork under a new id, not a retry of this one.
            clientId.current = undefined;
            toast.error(getLocalizedError({ error, t }));
        },
        onSuccess: (result) => {
            clientId.current = undefined;
            setOpen(false);

            if (result.threadId === undefined) {
                return;
            }

            const { threadId: forkedThreadId } = result;

            if (mounted.current) {
                openFork(forkedThreadId);
            } else {
                toast.success(t`The chat was forked.`, { action: { label: t`Open`, onClick: () => openFork(forkedThreadId) } });
            }
        },
    });

    useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;
        };
    }, []);

    if (!isAvailable(capabilityOf(capabilities, "sessions.fork"))) {
        return null;
    }

    const confirm = () => {
        clientId.current ??= crypto.randomUUID();
        // The route's own id type is a branded string; the thread id the composer holds is that thread's.
        fork.mutate({ clientId: clientId.current, threadId: threadId as never });
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
