import { PROMPT_CACHE_COLD_START_TOKENS, PROMPT_CACHE_LIFETIME_MS } from "@neore/ai/models";

/** What `chat.compaction.getCompactionStatus` answers. */
export interface CompactionStatus {
    canCompact: boolean;
    compactedAt?: number;
    contextTokens: number;
    lastActivityAt?: number;
}

/** Whether a failed `compactThread` was refused because the day's message quota is used up (`chat/compaction.ts`). */
export const isDailyLimitRefusal = (error: unknown): boolean => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return (data?.code ?? code) === "DAILY_MESSAGE_LIMIT_REACHED";
};

/** Whether a sent text is the `/compact` command rather than a message for the model. */
export const isCompactCommand = (text: string): boolean => text.trim().toLowerCase() === "/compact";

/**
 * Whether to offer compacting a thread the person comes back to: it has been idle longer than a provider keeps its
 * prompt cached (so the next reply re-reads the whole context as fresh input), that context is big enough for the
 * re-read to matter, and it was not compacted since the last reply.
 */
export const shouldOfferCompaction = (status: CompactionStatus | undefined, now: number): boolean => {
    if (!status?.canCompact || status.lastActivityAt === undefined) {
        return false;
    }

    if (status.compactedAt !== undefined && status.compactedAt >= status.lastActivityAt) {
        return false;
    }

    return now - status.lastActivityAt > PROMPT_CACHE_LIFETIME_MS && status.contextTokens >= PROMPT_CACHE_COLD_START_TOKENS;
};
