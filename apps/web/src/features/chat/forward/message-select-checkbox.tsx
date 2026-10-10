"use client";

/**
 * The per-row checkbox of "Select" mode. Renders nothing outside it.
 *
 * Its own component, subscribed to its own boolean, so toggling one message
 * re-renders this checkbox and nothing else — the row around it stays memoized.
 */
import { useLingui } from "@lingui/react/macro";
import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";
import { Checkbox } from "@neore/ui/components/checkbox";
import type { FC } from "react";

import { useChatThread } from "@/features/chat/core/context/chat-context";

import { selectIsSelectMode, useForwardSelectionStore } from "./forward-selection-store";
import { messageExcerpt } from "./message-excerpt";

interface MessageSelectCheckboxProps {
    /** Streaming or pending rows cannot be picked yet. */
    disabled?: boolean;
    /** Its text's start (`messageExcerpt`) tells the checkboxes apart for a screen reader. */
    message: Parameters<typeof getVisibleUserText>[0] & { id: string; role: string };
}

const MessageSelectCheckbox: FC<MessageSelectCheckboxProps> = ({ disabled, message }) => {
    const { id: messageId, role } = message;
    const { t } = useLingui();
    const { threadId } = useChatThread();
    const isSelectMode = useForwardSelectionStore(selectIsSelectMode(threadId));
    const isSelected = useForwardSelectionStore((state) => Object.hasOwn(state.selected, messageId));
    const toggle = useForwardSelectionStore((state) => state.toggle);

    if (!isSelectMode) {
        return null;
    }

    // Only in select mode: the rest of the time this renders nothing.
    const excerpt = messageExcerpt(getVisibleUserText(message));

    return (
        // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the label wraps the Base UI control, which renders the input
        <label className="not-prose mb-1 flex w-fit cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={isSelected} disabled={disabled === true} onCheckedChange={(checked) => toggle(messageId, checked)} />
            <span className="text-muted-foreground select-none">
                {role === "user" ? t`Select your message` : t`Select this reply`}
                {/* Every row reads the same visibly; the excerpt gives each checkbox its own name. */}
                {excerpt && <span className="sr-only">{`: ${excerpt}`}</span>}
            </span>
        </label>
    );
};

export default MessageSelectCheckbox;
