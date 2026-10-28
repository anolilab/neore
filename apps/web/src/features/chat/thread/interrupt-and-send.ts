import { usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";

/**
 * A follow-up to a runner that can only be interrupted: the text goes to the head of the queue
 * and lifts any pause (stopping from the composer pauses it), then the reply is stopped.
 */
const interruptAndSend = (threadId: string, text: string, cancelStream: () => Promise<void>): void => {
    usePromptQueueStore.getState().enqueueNext(threadId, { attachments: [], text });
    void cancelStream();
};

export default interruptAndSend;
