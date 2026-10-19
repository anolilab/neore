/**
 * Thread-level totals for "Thread statistics", summed over the assistant
 * messages of one thread. `toUIMessages` has already summed each turn's steps'
 * tokens and cost, so this only adds turns together.
 *
 * Reply count and models are NOT taken from those turns: sibling replies
 * (regenerated alternatives) share a prompt's `order`, so `toUIMessages` merges
 * them into one turn and keeps one model. `countReplies` and `distinctModels`
 * read the raw rows instead.
 */

/** The fields of a UI message the totals read. Structural, so tests need no full message. */
export type StatsMessage = {
    cost?: { byok: boolean; microdollars: number; pricingAvailable: boolean };
    role: string;
    usage?: { completionTokens?: number; durationMs?: number; promptTokens?: number };
};

/** The fields of a stored message row the reply count reads. */
export type ReplyRow = {
    _id: string;
    message?: { role?: string };
    model?: string;
    order: number;
    parentMessageId?: string;
    stepOrder: number;
};

export type ThreadStats = {
    /** Output tokens per second over the replies that timed it. Undefined when none did. */
    averageTokensPerSecond?: number;
    /** Undefined when no reply carried a cost. */
    cost?: { byok: boolean; microdollars: number; pricingAvailable: boolean };
    inputTokens: number;
    outputTokens: number;
};

const assistantRowsInOrder = (rows: ReadonlyArray<ReplyRow>): ReplyRow[] =>
    rows.filter((row) => row.message?.role === "assistant").toSorted((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);

/** Distinct model ids of the assistant rows, in the order the thread first used them. */
export const distinctModels = (rows: ReadonlyArray<ReplyRow>): string[] => {
    const models = new Set<string>();

    for (const row of assistantRowsInOrder(rows)) {
        if (row.model) {
            models.add(row.model);
        }
    }

    return [...models];
};

/**
 * Number of replies in the rows: one per assistant row group. Steps of one reply
 * are consecutive rows with no explicit parent. A row whose explicit parent is
 * not in the current group (`branchThread` / regenerate parent it to the prompt)
 * starts a new reply, so a regenerated alternative counts on its own.
 */
export const countReplies = (rows: ReadonlyArray<ReplyRow>): number => {
    const assistant = assistantRowsInOrder(rows);
    let replies = 0;
    let order: number | undefined;
    let groupIds = new Set<string>();

    for (const row of assistant) {
        const startsNewReply = row.order !== order || (row.parentMessageId !== undefined && !groupIds.has(row.parentMessageId));

        if (startsNewReply) {
            replies += 1;
            groupIds = new Set<string>();
            order = row.order;
        }

        groupIds.add(row._id);
    }

    return replies;
};

export const summarizeThreadStats = (messages: ReadonlyArray<StatsMessage>): ThreadStats => {
    const replies = messages.filter((message) => message.role === "assistant");
    let inputTokens = 0;
    let outputTokens = 0;
    let timedTokens = 0;
    let timedMs = 0;
    let cost: ThreadStats["cost"];

    for (const reply of replies) {
        const { usage } = reply;
        const completionTokens = usage?.completionTokens ?? 0;

        inputTokens += usage?.promptTokens ?? 0;
        outputTokens += completionTokens;

        if (completionTokens > 0 && usage?.durationMs !== undefined && usage.durationMs > 0) {
            timedTokens += completionTokens;
            timedMs += usage.durationMs;
        }

        if (reply.cost) {
            cost = cost
                ? {
                      byok: cost.byok || reply.cost.byok,
                      microdollars: cost.microdollars + reply.cost.microdollars,
                      // One unpriced reply makes the sum a floor, not an exact figure.
                      pricingAvailable: cost.pricingAvailable && reply.cost.pricingAvailable,
                  }
                : { ...reply.cost };
        }
    }

    return {
        averageTokensPerSecond: timedMs > 0 ? (timedTokens / timedMs) * 1000 : undefined,
        cost,
        inputTokens,
        outputTokens,
    };
};
