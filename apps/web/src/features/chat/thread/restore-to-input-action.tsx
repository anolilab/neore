"use client";

/**
 * "Restore to input" action for a user message: puts its text and attachments
 * back into the composer to edit and send as a new message. Unlike "Edit" it
 * does not rewrite the thread.
 */

import { useLingui } from "@lingui/react/macro";
import { isGuestTextPart } from "@neore/backend/guest-text";
import { draftFromOfMarks, mergeNotTypedMarks, notTypedMarksOfPart } from "@neore/backend/not-typed-text";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { Undo2Icon } from "lucide-react";
import type { FC } from "react";

import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import { extractComposerRestorePayload, requestComposerRestore } from "@/features/chat/core/utils/composer-restore";
import { isViewersOwnMessage } from "@/features/chat/core/utils/message-author";
import type { UIMessage } from "@/lib/agent";

/** A guest's note the owner sent on: its mark rides on the text part, as the UI part's `providerMetadata`. */
const carriesGuestText = (message: UIMessage): boolean =>
    message.parts.some((part) => part.type === "text" && isGuestTextPart({ providerOptions: part.providerMetadata }));

/** The not-typed marks of a user message's text (`@neore/backend/not-typed-text`), read like the guest mark. */
const notTypedMarksOf = (message: UIMessage) =>
    mergeNotTypedMarks(...message.parts.map((part) => (part.type === "text" ? notTypedMarksOfPart({ providerOptions: part.providerMetadata }) : {})));

/**
 * Back into the composer; text the viewer did not type keeps its mark there (an admin's as `impersonated`), so its next
 * send is marked. Another person's message in a shared chat (any the viewer cannot be shown to have sent,
 * `isViewersOwnMessage`) is `collaborator`: sent from here it would read as the viewer's own words.
 */
const restore = (message: UIMessage, viewerId: string | undefined): void => {
    const draftFrom = draftFromOfMarks(notTypedMarksOf(message)) ?? (isViewersOwnMessage(message, viewerId) ? undefined : "collaborator");

    requestComposerRestore({ ...extractComposerRestorePayload(message), ...(draftFrom !== undefined && { draftFrom }) });
};

const RestoreToInputAction: FC<{ message: UIMessage }> = ({ message }) => {
    const { t } = useLingui();
    const { data: sessionData } = useAuthSession();

    // In the composer a guest's words would go out again as the owner's own.
    if (carriesGuestText(message)) {
        return null;
    }

    return (
        <MessageAction label={t`Restore to input`} onClick={() => restore(message, sessionData?.user?.id)} tooltip={t`Restore to input`}>
            <Undo2Icon aria-hidden="true" className="size-4" />
        </MessageAction>
    );
};

export default RestoreToInputAction;
