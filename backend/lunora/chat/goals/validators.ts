/**
 * The goal columns, declared once: `schema.ts` builds `threadGoals` from them
 * and the procedures reuse them for their outputs. Inline `v.union` literals —
 * codegen resolves an inline validator, not one built by a call.
 *
 * Imported by `schema.ts`, so this module stays free of runtime imports beyond
 * `lunorash/server`.
 */
import { v } from "lunorash/server";

import { MAX_LENGTH } from "../../lib/validators";

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

/** The most feature or server names a run can name; the composer offers a few dozen. */
const MAX_NAMES = 100;

/**
 * What the next round needs of the run that started the goal: the model and settings, what started the run
 * (`origin`: a public API key's run keeps its tool limits in every round) and the skill it invoked (so the
 * skill's instructions, model and tools apply in every round, not only the first). Bounded, because
 * `startGoal` is the boundary and this is stored.
 */
export const vGoalRunConfig = v.object({
    customSystemPrompt: v.optional(v.string().max(MAX_LENGTH.text)),
    enabledFeatures: v.optional(v.array(v.string().max(MAX_LENGTH.short)).check((names) => names.length <= MAX_NAMES, { message: "Too many features" })),
    mcpServerNames: v.optional(v.array(v.string().max(MAX_LENGTH.short)).check((names) => names.length <= MAX_NAMES, { message: "Too many servers" })),
    model: v.string().max(MAX_LENGTH.short),
    origin: v.optional(v.literal("outside_agent")),
    reasoningEffort: v.optional(v.number().check((effort) => Number.isFinite(effort) && effort >= 0 && effort <= 100, { message: "Invalid reasoning effort" })),
    researchDepth: v.optional(v.union(v.literal("speed"), v.literal("balanced"), v.literal("thorough"))),
    searchMode: v.optional(v.string().max(MAX_LENGTH.short)),
    skill: v.optional(v.object({ rawArgs: v.string().max(MAX_LENGTH.text), slug: v.string().max(MAX_LENGTH.short) })),
    statelessMode: v.optional(v.boolean()),
});
