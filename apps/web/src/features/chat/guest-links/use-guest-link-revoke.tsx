import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useUnlockProof } from "@neore/client-runtime";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import { useCRPC } from "@/lib/lunora/crpc";

import { errorCode } from "./error-code";

/**
 * A thread's guest-link revoke, held by a component that outlives the share menu (`ThreadShareButton`): the confirm it asks
 * when notes are waiting sits beside the menu, not inside its popup, and the revoke still goes through when the menu closes
 * on the confirm's click, as Remove User's does. Render `confirmDialog` outside the menu.
 */
const useGuestLinkRevoke = (
    threadId: string | undefined,
): { confirmDialog: ReactNode; revokeLink: (linkId: string, waitingNotes: string[]) => Promise<boolean> } => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const unlockProof = useUnlockProof(threadId);
    const revoke = useMutation(crpc.chat.guest_links.revokeGuestLink.mutationOptions());
    const [asking, setAsking] = useState<{ answer: (confirmed: boolean) => void; threadId: string | undefined; waitingCount: number } | null>(null);

    // A question asked for one chat is never answered in another: moving to another chat declines it.
    if (asking && asking.threadId !== threadId) {
        asking.answer(false);
        setAsking(null);
    }

    /** The notes waiting now, read afresh: the panel's live read may not have caught up with a note just left. */
    const waitingNow = async (forThread: string | undefined): Promise<string[]> => {
        const read = await queryClient.fetchQuery({
            ...crpc.chat.guest_links.getGuestLink.queryOptions({ threadId: forThread as Id<"threads">, unlockProof }, { live: false }),
            staleTime: 0,
        });

        return read.messages.filter((note) => note.status === "held").map((note) => note.id);
    };

    /**
     * Revokes the link, deleting only the waiting notes the owner confirmed, by id. The server refuses when one waits that
     * they did not see (left since, even in place of one sent meanwhile): they are asked again about the notes waiting now.
     */
    const revokeConfirmed = async (forThread: string | undefined, linkId: string, waitingNotes: string[]): Promise<boolean> => {
        if (waitingNotes.length > 0) {
            const yes = await new Promise<boolean>((resolve) => {
                setAsking({ answer: resolve, threadId: forThread, waitingCount: waitingNotes.length });
            });

            if (!yes) {
                return false;
            }
        }

        try {
            await revoke.mutateAsync({
                confirmedNotes: waitingNotes as Id<"threadGuestMessages">[],
                linkId: linkId as Id<"threadGuestLinks">,
                threadId: forThread as Id<"threads">,
            });
        } catch (error) {
            if (errorCode(error) !== "GUEST_NOTES_WAITING") {
                throw error;
            }

            const waiting = await waitingNow(forThread);

            // Asked again only about a note the owner has not confirmed yet, and only through the confirm. When the read shows
            // none (the server counts a note this read does not list), stop: never a retry without a click, never a loop.
            if (waiting.every((noteId) => waitingNotes.includes(noteId))) {
                throw new Error("The revoke was refused, and no unconfirmed note is shown.", { cause: error });
            }

            return await revokeConfirmed(forThread, linkId, waiting);
        }

        return true;
    };

    /**
     * Revokes the link the owner saw (`linkId`: a link replaced since is refused, `GUEST_LINK_ENDED`), asking first when the
     * waiting notes shown (`waitingNotes`, their ids) would be deleted; `false` when declined.
     */
    const revokeLink = async (linkId: string, waitingNotes: string[]): Promise<boolean> => await revokeConfirmed(threadId, linkId, waitingNotes);

    const waitingCount = asking?.waitingCount ?? 0;
    const answer = (confirmed: boolean) => {
        asking?.answer(confirmed);
        setAsking(null);
    };

    const confirmDialog = (
        <DeleteConfirmationDialog
            confirmLabel={t`Revoke`}
            description={t`Revoking the link deletes ${plural(waitingCount, {
                one: "the # guest message still waiting. It cannot be sent afterwards.",
                other: "the # guest messages still waiting. They cannot be sent afterwards.",
            })}`}
            onConfirm={() => answer(true)}
            onOpenChange={(open) => {
                if (open) {
                    return;
                }

                answer(false);
            }}
            open={asking !== null}
            title={t`Revoke the guest link?`}
        />
    );

    return { confirmDialog, revokeLink };
};

export default useGuestLinkRevoke;
