import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import { useCRPC } from "@/lib/lunora/crpc";

/**
 * A thread's guest-link revoke, held by a component that outlives the share menu (`ThreadShareButton`): the confirm it asks
 * when notes are waiting sits beside the menu, not inside its popup, and the revoke still goes through when the menu closes
 * on the confirm's click, as Remove User's does. Render `confirmDialog` outside the menu.
 */
const useGuestLinkRevoke = (threadId: string | undefined): { confirmDialog: ReactNode; revokeLink: (waitingCount: number) => Promise<boolean> } => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const revoke = useMutation(crpc.chat.guest_links.revokeGuestLink.mutationOptions());
    const [asking, setAsking] = useState<{ answer: (confirmed: boolean) => void; waitingCount: number } | null>(null);

    /** Revokes the link, asking first when `waitingCount` notes would be deleted; `false` when the owner declined. */
    const revokeLink = async (waitingCount: number): Promise<boolean> => {
        if (waitingCount > 0) {
            const confirmed = await new Promise<boolean>((resolve) => {
                setAsking({ answer: resolve, waitingCount });
            });

            if (!confirmed) {
                return false;
            }
        }

        await revoke.mutateAsync({ threadId: threadId as Id<"threads"> });

        return true;
    };

    const waitingCount = asking?.waitingCount ?? 0;
    const answer = (confirmed: boolean) => {
        asking?.answer(confirmed);
        setAsking(null);
    };

    const confirmDialog = (
        <DeleteConfirmationDialog
            confirmLabel={t`Revoke`}
            description={t`Revoking the link deletes ${plural(waitingCount, { one: "the # guest message", other: "the # guest messages" })} still waiting. They cannot be sent afterwards.`}
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
