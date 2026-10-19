import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";

import { DEFAULT_MESSAGE_OPTS } from "@/features/chat/core/constants/query-options";
import { useCRPC } from "@/lib/lunora/crpc";
import { forgetUnlockProof, isThreadLockedError, onUnlockExpired, useUnlockProof } from "@neore/client-runtime";

import { ThreadLockDialog } from "./thread-lock-dialog";

/**
 * Keeps a locked chat's view from mounting. Its composite read is refused with
 * THREAD_LOCKED until the proof is in memory; then this shows the unlock prompt
 * instead of the chat. The gate re-renders on every proof change, so the read is
 * rebuilt WITH the proof (`withUnlockProof` runs at build time) and a fresh one
 * is fetched: the chat appears on unlock and the prompt returns on relock.
 */
export const LockedChatGate = ({ children, threadId }: { children: ReactNode; threadId: string }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const [unlocking, setUnlocking] = useState(false);
    // Set by a relock, cleared once a read without a proof answers. Until then the
    // chat's children stay unmounted, so nothing it read with the proof stays on screen.
    const [relocked, setRelocked] = useState(false);
    const proof = useUnlockProof(threadId);

    useEffect(
        () =>
            onUnlockExpired((relockedId) => {
                if (relockedId === threadId) {
                    setRelocked(true);
                }
            }),
        [threadId],
    );
    // The same args as the chat's own read, so the two share one subscription (`DEFAULT_MESSAGE_OPTS`).
    const { error, isSuccess } = useQuery(
        crpc.chat.composite.getThreadWithData.queryOptions({ messageOpts: DEFAULT_MESSAGE_OPTS, threadId: threadId as Id<"threads"> }),
    );

    // Adjusted during render rather than in an effect: the flag clears on the render that sees the answer.
    if (relocked && isSuccess) {
        setRelocked(false);
    }

    // A refused read with a proof in hand means that proof is stale (the passcode epoch
    // rotated on another tab or device). Forget it: that relocks the chat and drops what it
    // read. The next read carries no proof, is refused once more, and does not forget again.
    const staleProof = proof !== undefined && isThreadLockedError(error);

    useEffect(() => {
        if (staleProof) {
            forgetUnlockProof(threadId);
        }
    }, [staleProof, threadId]);

    // A refusal hides the chat whether or not a proof is held. A relocked chat stays hidden
    // while its read is pending. A relocked chat whose passcode was removed answers the read
    // with no proof, so it shows again.
    const refused = isThreadLockedError(error);
    const relockedAndPending = proof === undefined && relocked && !isSuccess && !error;

    if (!refused && !relockedAndPending) {
        // A relocked chat whose read fails for another reason shows that error, not the prompt,
        // and its content stays unmounted.
        if (proof === undefined && relocked && error) {
            return (
                <section className="flex h-full flex-col items-center justify-center p-6 text-center" role="alert">
                    <p className="text-destructive text-sm">{error.message}</p>
                </section>
            );
        }

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
