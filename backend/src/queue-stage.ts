import type { MessageBatchLike } from "@lunora/queue";

/**
 * A deploy suffixes every queue with its stage (`neore-backend-jobs-pr-12`), but the
 * generated consumer routes by the name `lunora/queues.ts` declares. `stage` is empty
 * in production, whose queues keep the bare name.
 *
 * The batch is wrapped, not spread: `ackAll` and `retryAll` are runtime methods that
 * only work on the original.
 */
export const withoutStage = (batch: MessageBatchLike, stage: string | undefined): MessageBatchLike => {
    const suffix = stage ? `-${stage}` : "";

    if (!suffix || !batch.queue.endsWith(suffix)) {
        return batch;
    }

    return {
        ackAll: () => batch.ackAll(),
        messages: batch.messages,
        queue: batch.queue.slice(0, -suffix.length),
        retryAll: (options) => batch.retryAll(options),
    };
};
