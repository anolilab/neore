"use client";

/**
 * Jump to my last message: scrolls the open thread to the newest prompt the person sent, so the reply
 * after it is in view again. The control beside scroll-to-bottom (`thread.tsx`) and the `jumpToLastMessage`
 * shortcut (`use-keyboard-shortcut-handler.ts`) both resolve their target with `jumpTargetId`.
 *
 * Reads the loaded messages only, no query of its own. When no prompt of the person's is loaded the control
 * hides and the shortcut says so. The scroll itself, including loading an older page or mounting a windowed
 * row, is `scrollToMessage` (`message-list.tsx`).
 */

import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";
import { useEffect, useRef } from "react";

import { useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";
import { scrollToMessage } from "@/features/chat/core/utils/scroll-to-message";
import { withoutGoalInstructions } from "@/features/chat/goal/goal-view";
import type { UIMessage } from "@/lib/agent";
import { showInfo } from "@/lib/toast";

import { lastPromptId } from "./minimap-items";

/**
 * The message the jump lands on: the newest prompt the person sent among the rendered messages. A goal's own
 * instructions carry the user role but are never rendered, so they are not targets.
 */
export const jumpTargetId = (messages: UIMessage[]): string | undefined => lastPromptId(withoutGoalInstructions(messages));

/** Renders nothing. Mounted by the thread while its messages are a list (text mode), where there is something to scroll. */
const JumpToLastMessageListener: FC = () => {
    const { t } = useLingui();
    const { messages } = useChatMessages();
    const { threadId } = useChatThread();
    const messagesRef = useRef(messages);

    useEffect(() => {
        messagesRef.current = messages;
    });

    useEffect(() => {
        const handle = () => {
            const targetId = jumpTargetId(messagesRef.current);

            if (!targetId) {
                showInfo(t`No message of yours is loaded in this conversation`);

                return;
            }

            scrollToMessage(targetId, { threadId });
        };

        globalThis.addEventListener("jumpToLastMessage", handle);

        return () => {
            globalThis.removeEventListener("jumpToLastMessage", handle);
        };
    }, [t, threadId]);

    return null;
};

export default JumpToLastMessageListener;
