"use client";

/**
 * "Restore to input" action for a user message: puts its text and attachments
 * back into the composer to edit and send as a new message. Unlike "Edit" it
 * does not rewrite the thread.
 */

import { useLingui } from "@lingui/react/macro";
import { isGuestTextPart } from "@neore/backend/guest-text";
import { mergeNotTypedMarks, notTypedMarksOfPart } from "@neore/backend/not-typed-text";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { Undo2Icon } from "lucide-react";
import type { FC } from "react";

import { extractComposerRestorePayload, requestComposerRestore } from "@/features/chat/core/utils/composer-restore";
import type { UIMessage } from "@/lib/agent";

/** A guest's note the owner sent on: its mark rides on the text part, as the UI part's `providerMetadata`. */
const carriesGuestText = (message: UIMessage): boolean =>
    message.parts.some((part) => part.type === "text" && isGuestTextPart({ providerOptions: part.providerMetadata }));

/** The not-typed marks of a user message's text (`@neore/backend/not-typed-text`), read like the guest mark. */
const notTypedMarksOf = (message: UIMessage) =>
    mergeNotTypedMarks(...message.parts.map((part) => (part.type === "text" ? notTypedMarksOfPart({ providerOptions: part.providerMetadata }) : {})));

/** Back into the composer; a draft from a link or someone else's prompt keeps its mark there, so its next send is marked. */
const restore = (message: UIMessage): void => {
    const { draft } = notTypedMarksOf(message);

    requestComposerRestore({ ...extractComposerRestorePayload(message), ...(draft !== undefined && { draftFrom: draft }) });
};

const RestoreToInputAction: FC<{ message: UIMessage }> = ({ message }) => {
    const { t } = useLingui();

    // In the composer a guest's words, or an admin's written while acting as the owner, would go out again as the owner's own.
    if (carriesGuestText(message) || notTypedMarksOf(message).impersonated === true) {
        return null;
    }

    return (
        <MessageAction label={t`Restore to input`} onClick={() => restore(message)} tooltip={t`Restore to input`}>
            <Undo2Icon aria-hidden="true" className="size-4" />
        </MessageAction>
    );
};

export default RestoreToInputAction;
