"use client";

/**
 * "Restore to input" action for a user message: puts its text and attachments
 * back into the composer to edit and send as a new message. Unlike "Edit" it
 * does not rewrite the thread.
 */

import { useLingui } from "@lingui/react/macro";
import { isGuestTextPart } from "@neore/backend/guest-text";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { Undo2Icon } from "lucide-react";
import type { FC } from "react";

import { extractComposerRestorePayload, requestComposerRestore } from "@/features/chat/core/utils/composer-restore";
import type { UIMessage } from "@/lib/agent";

/** A guest's note the owner sent on: its mark rides on the text part, as the UI part's `providerMetadata`. */
const carriesGuestText = (message: UIMessage): boolean =>
    message.parts.some((part) => part.type === "text" && isGuestTextPart({ providerOptions: part.providerMetadata }));

const RestoreToInputAction: FC<{ message: UIMessage }> = ({ message }) => {
    const { t } = useLingui();

    // In the composer a guest's words would go out again as the owner's own, without the guest mark.
    if (carriesGuestText(message)) {
        return null;
    }

    return (
        <MessageAction label={t`Restore to input`} onClick={() => requestComposerRestore(extractComposerRestorePayload(message))} tooltip={t`Restore to input`}>
            <Undo2Icon aria-hidden="true" className="size-4" />
        </MessageAction>
    );
};

export default RestoreToInputAction;
