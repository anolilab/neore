"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import { isDailyLimitRefusal } from "@/features/chat/compaction/compaction-logic";
import { getValidThreadId } from "@/features/chat/core/utils/thread-id";
import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";

/**
 * Compacts the model context of a thread: its older turns are replaced, in what the model is sent, by a summary.
 * The stored messages stay as they are. One implementation for `/compact`, the thread menu and the cache chip.
 */
const useCompactThread = (threadId: string | undefined): { compact: () => Promise<void>; isCompacting: boolean } => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    // Offline, the default network mode would pause the call and run it on reconnect, long after the toast; `always` fails it now.
    const { isPending, mutateAsync, variables } = useMutation({
        ...useLunoraActionOptions(api.chat.compaction.compactThread),
        networkMode: "always",
        retry: 0,
    });

    const compact = useCallback(async () => {
        const validThreadId = getValidThreadId(threadId);

        if (!validThreadId) {
            toast.info(t`Send a message first. There is nothing to compact yet.`);

            return;
        }

        const toastId = toast.loading(t`Compacting the conversation...`);

        try {
            const result = await mutateAsync({ threadId: validThreadId as Id<"threads"> });

            if (result.compacted) {
                toast.success(t`Older messages are condensed for the model. Your chat is unchanged.`, { id: toastId });
            } else {
                const reasons: Record<string, string> = {
                    busy: t`Wait for the reply to finish, then try again.`,
                    failed: t`Compacting did not finish. Try again.`,
                    not_owner: t`Only the owner of a chat can compact it.`,
                    nothing: t`There is nothing to compact yet.`,
                    too_long: t`This chat is too long to compact.`,
                    unavailable: t`This chat cannot be compacted.`,
                };

                toast.info(reasons[result.reason ?? "nothing"] ?? reasons.nothing, { id: toastId });
            }

            await queryClient.invalidateQueries({ queryKey: crpc.chat.compaction.getCompactionStatus.queryKey({ threadId: validThreadId as Id<"threads"> }) });
        } catch (error) {
            // A retry is refused again until the quota resets, so do not ask for one.
            toast.error(isDailyLimitRefusal(error) ? t`You have used today's messages. Try again later.` : t`Could not compact the conversation. Try again.`, {
                id: toastId,
            });
        }
    }, [crpc, mutateAsync, queryClient, t, threadId]);

    // A compaction running in another chat does not disable this chat's action: only the chat it was started in is busy.
    return { compact, isCompacting: isPending && variables?.threadId === threadId };
};

export default useCompactThread;
