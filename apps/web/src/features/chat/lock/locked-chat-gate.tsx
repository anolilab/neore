import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";

import { DEFAULT_MESSAGE_OPTS } from "@/features/chat/core/constants/query-options";
import { useCRPC } from "@/lib/lunora/crpc";
import { isThreadLockedError, onUnlockExpired } from "@/lib/lunora/unlock-proofs";

import { ThreadLockDialog } from "./thread-lock-dialog";

/**
 * Keeps a locked chat's view from mounting. Its composite read is refused with
 * THREAD_LOCKED until the proof is in memory; then this shows the unlock prompt
 * instead of the chat. After an unlock the read refetches and the chat appears.
 */
export const LockedChatGate = ({ children, threadId }: { children: ReactNode; threadId: string }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const queryClient = useQueryClient();
    const [unlocking, setUnlocking] = useState(false);

    // When the proof lapses (expiry or idle), refetch: the server refuses the read and the prompt appears.
    useEffect(
        () =>
            onUnlockExpired(() => {
                void queryClient.invalidateQueries();
            }),
        [queryClient],
    );
    // The same args as the chat's own read, so the two share one subscription (`DEFAULT_MESSAGE_OPTS`).
    const { error } = useQuery(crpc.chat.composite.getThreadWithData.queryOptions({ messageOpts: DEFAULT_MESSAGE_OPTS, threadId: threadId as Id<"threads"> }));

    if (!isThreadLockedError(error)) {
        return children;
    }

    return (
        <section aria-labelledby={headingId} className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <h2 className="text-lg font-medium" id={headingId}>
                {t`This chat is locked`}
            </h2>
            <p className="text-muted-foreground max-w-md text-sm">{t`Enter its passcode to read it in this browser. Closing the tab or staying idle locks it again.`}</p>
            <Button onClick={() => setUnlocking(true)} type="button">
                {t`Unlock chat`}
            </Button>
            {unlocking && (
                <ThreadLockDialog
                    mode="unlock"
                    onOpenChange={(open) => {
                        if (!open) {
                            setUnlocking(false);
                        }
                    }}
                    open
                    threadId={threadId}
                />
            )}
        </section>
    );
};
