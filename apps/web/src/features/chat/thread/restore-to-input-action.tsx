"use client";

/**
 * "Restore to input" action for a user message: puts its text and attachments
 * back into the composer to edit and send as a new message. Unlike "Edit" it
 * does not rewrite the thread.
 */

import { useLingui } from "@lingui/react/macro";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { Undo2Icon } from "lucide-react";
import type { FC } from "react";

import { extractComposerRestorePayload, requestComposerRestore } from "@/features/chat/core/utils/composer-restore";
import type { UIMessage } from "@/lib/agent";

const RestoreToInputAction: FC<{ message: UIMessage }> = ({ message }) => {
    const { t } = useLingui();

    return (
        <MessageAction label={t`Restore to input`} onClick={() => requestComposerRestore(extractComposerRestorePayload(message))} tooltip={t`Restore to input`}>
            <Undo2Icon aria-hidden="true" className="size-4" />
        </MessageAction>
    );
};

export default RestoreToInputAction;
