/**
 * Sends a thread has begun whose reply is not streaming yet (`sendMessage`, from the composer, the queue or a guest note's
 * Send): the window before `isStreaming` turns on, where a second send would start a second run beside the first. Kept per
 * thread, outside any component, so every sender sees the others'.
 */
const starting = new Map<string, number>();

const keyOf = (threadId: string | undefined): string => threadId ?? "";

export const markSendStarting = (threadId: string | undefined): void => {
    starting.set(keyOf(threadId), (starting.get(keyOf(threadId)) ?? 0) + 1);
};

export const clearSendStarting = (threadId: string | undefined): void => {
    const left = (starting.get(keyOf(threadId)) ?? 1) - 1;

    if (left > 0) {
        starting.set(keyOf(threadId), left);
    } else {
        starting.delete(keyOf(threadId));
    }
};

export const isSendStarting = (threadId: string | undefined): boolean => starting.has(keyOf(threadId));
