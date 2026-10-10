"use client";

/**
 * "Select" message action: enters multi-select mode on this thread with this
 * message already picked (see `forward-selection-bar.tsx`). Hidden while select
 * mode is on — the row's checkbox takes over.
 */
import { useLingui } from "@lingui/react/macro";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { ListChecksIcon } from "lucide-react";
import type { FC } from "react";

import { useChatThread } from "@/features/chat/core/context/chat-context";
import { isValidThreadId } from "@/features/chat/core/hooks/use-validated-thread";

import { selectIsSelectMode, useForwardSelectionStore } from "./forward-selection-store";

const SelectMessagesAction: FC<{ messageId: string }> = ({ messageId }) => {
    const { t } = useLingui();
    const { threadId } = useChatThread();
    const isSelectMode = useForwardSelectionStore(selectIsSelectMode(threadId));
    const start = useForwardSelectionStore((state) => state.start);

    if (isSelectMode || !isValidThreadId(threadId)) {
        return null;
    }

    return (
        <MessageAction label={t`Select messages to forward`} onClick={() => start(threadId, messageId)} tooltip={t`Select`}>
            <ListChecksIcon aria-hidden="true" className="size-4" />
        </MessageAction>
    );
};

export default SelectMessagesAction;
