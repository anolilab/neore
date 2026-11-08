import { createRequestChannel } from "@/features/chat/core/stores/request-channel-store";
import type { MessagePosition } from "@/features/chat/thread/message-windowing";

export interface ScrollToMessageDetail {
    /** Move focus to the message after scrolling. Defaults to true; the find bar keeps focus in its field. */
    focus?: boolean;
    messageId: string;
    /** Where the message sits, for a stored step that renders merged into an earlier message. */
    position?: MessagePosition;
    threadId?: string;
}

/** Consumed by the message list, which owns the virtualizer; here so a caller outside the list need not import it. */
export const scrollToMessageChannel = createRequestChannel<ScrollToMessageDetail>();

/**
 * Scrolls the open thread to a message and focuses it, mounting it first if it
 * is virtualized and loading older pages if it is not loaded yet; the list says
 * so when the message is not in the conversation. Pass `threadId` when the
 * request races a navigation to that thread: the jump then waits until that
 * thread's messages are showing.
 */
export const scrollToMessage = (messageId: string, options: { focus?: boolean; position?: MessagePosition; threadId?: string } = {}): void => {
    scrollToMessageChannel.request({ messageId, ...options });
};
