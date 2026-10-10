/**
 * Per-message cost, as computed by the LLM Gateway.
 *
 * The gateway prices every proxied model call and sends the result as a trailing
 * `gateway-metadata` SSE event. `gateway-language-model.ts` folds it into the
 * step's `finish` part under {@link GATEWAY_COST_METADATA_KEY}, so it lands in
 * the persisted `messages.providerMetadata` with no schema change. This module
 * only reads it back — it is imported by the browser, so it must stay free of
 * backend-only imports.
 */

/** `providerMetadata` key the gateway's cost is stored under on each step's message. */
export const GATEWAY_COST_METADATA_KEY = "neoreGateway";

export type MessageCost = {
    /** At least one step ran on the user's own provider key, so it was not billed as credits. */
    byok: boolean;
    /** Summed across the steps of one assistant turn. 1 credit = 1,000 microdollars. */
    microdollars: number;
    /** False when the gateway had no pricing for at least one step, so the sum is a floor. */
    pricingAvailable: boolean;
};

/** Read one step's cost out of its `providerMetadata`, or undefined when it has none. */
export const readMessageCost = (providerMetadata: unknown): MessageCost | undefined => {
    if (typeof providerMetadata !== "object" || providerMetadata === null) {
        return undefined;
    }

    const entry = (providerMetadata as Record<string, unknown>)[GATEWAY_COST_METADATA_KEY];

    if (typeof entry !== "object" || entry === null) {
        return undefined;
    }

    const { byok, costMicrodollars, pricingAvailable } = entry as Record<string, unknown>;

    if (typeof costMicrodollars !== "number" || !Number.isFinite(costMicrodollars) || costMicrodollars < 0) {
        return undefined;
    }

    return { byok: byok === true, microdollars: costMicrodollars, pricingAvailable: pricingAvailable !== false };
};

/** Sum the costs of every step in a turn that carries one. Undefined when none do. */
export const sumMessageCosts = (providerMetadatas: unknown[]): MessageCost | undefined => {
    let total: MessageCost | undefined;

    for (const providerMetadata of providerMetadatas) {
        const cost = readMessageCost(providerMetadata);

        if (!cost) {
            continue;
        }

        total = total
            ? {
                  byok: total.byok || cost.byok,
                  microdollars: total.microdollars + cost.microdollars,
                  pricingAvailable: total.pricingAvailable && cost.pricingAvailable,
              }
            : cost;
    }

    return total;
};

/** The per-step usage fields a turn's totals are built from (a subset of `vUsage`). */
export type StepUsage = {
    cachedInputTokens?: number;
    completionTokens?: number;
    durationMs?: number;
    promptTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    ttftMs?: number;
};

const TOKEN_FIELDS = ["cachedInputTokens", "completionTokens", "promptTokens", "reasoningTokens", "totalTokens"] as const;

/**
 * Sum token counts across the steps of one turn, so they describe the same
 * calls the summed cost does. `durationMs`/`ttftMs` are per-turn timings patched
 * onto one step, not per-step, so the last defined value is taken rather than a sum.
 */
export const sumStepUsage = (
    usages: (StepUsage | undefined)[],
): (Required<Pick<StepUsage, "completionTokens" | "promptTokens" | "totalTokens">> & StepUsage) | undefined => {
    const present = usages.filter((usage): usage is StepUsage => usage !== undefined);

    if (present.length === 0) {
        return undefined;
    }

    const total: StepUsage = {};

    for (const field of TOKEN_FIELDS) {
        const values = present.map((usage) => usage[field]).filter((value): value is number => typeof value === "number");

        if (values.length > 0) {
            total[field] = values.reduce((sum, value) => sum + value, 0);
        }
    }

    const durationMs = present.findLast((usage) => usage.durationMs !== undefined)?.durationMs;
    const ttftMs = present.findLast((usage) => usage.ttftMs !== undefined)?.ttftMs;

    return {
        ...total,
        completionTokens: total.completionTokens ?? 0,
        promptTokens: total.promptTokens ?? 0,
        totalTokens: total.totalTokens ?? 0,
        ...(durationMs !== undefined && { durationMs }),
        ...(ttftMs !== undefined && { ttftMs }),
    };
};
