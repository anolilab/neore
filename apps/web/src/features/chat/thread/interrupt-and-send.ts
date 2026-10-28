import { usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";

/**
 * A follow-up to a runner that can only be interrupted: the text goes to the head of the queue
 * and lifts any pause, so it is the next message sent, then the reply is stopped. Stopping from
 * the composer pauses the queue, which is why the pause is lifted here and not left to chance.
 */
const interruptAndSend = (threadId: string, text: string, cancelStream: () => Promise<void>): void => {
    usePromptQueueStore.getState().enqueueNext(threadId, { attachments: [], text });
    void cancelStream();
};

export default interruptAndSend;
