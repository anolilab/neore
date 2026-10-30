/**
 * The goal columns, declared once: `schema.ts` builds `threadGoals` from them
 * and the procedures reuse them for their outputs. Inline `v.union` literals —
 * codegen resolves an inline validator, not one built by a call.
 *
 * Imported by `schema.ts`, so this module stays free of runtime imports beyond
 * `lunorash/server`.
 */
import { v } from "lunorash/server";

export const vGoalStatus = v.union(v.literal("active"), v.literal("met"), v.literal("stopped"));

export const vGoalStopReason = v.union(
    v.literal("cost_limit"),
    v.literal("daily_limit"),
    v.literal("error"),
    v.literal("review_failed"),
    v.literal("round_limit"),
    v.literal("superseded"),
    v.literal("unsupported"),
    v.literal("user"),
);

/** One review: round `round`'s verdict, shown under the reply of turn `order` (the last one the round wrote). */
export const vGoalVerdict = v.object({
    at: v.number(),
    met: v.boolean(),
    order: v.optional(v.number()),
    reason: v.string(),
    round: v.number(),
});

/** What the next round needs of the run that started the goal. */
export const vGoalRunConfig = v.object({
    customSystemPrompt: v.optional(v.string()),
    enabledFeatures: v.optional(v.array(v.string())),
    mcpServerNames: v.optional(v.array(v.string())),
    model: v.string(),
    reasoningEffort: v.optional(v.number()),
    researchDepth: v.optional(v.union(v.literal("speed"), v.literal("balanced"), v.literal("thorough"))),
    searchMode: v.optional(v.string()),
    statelessMode: v.optional(v.boolean()),
});
