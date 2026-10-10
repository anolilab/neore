/**
 * Validators for multi-agent group chat — the `threads.groupChat` column and
 * the group part of a tool-approval snapshot (`toolApprovalRuns.config.group`).
 *
 * Imported by `schema.ts` and `chat/lib/tool-run-config.ts`, so this module
 * must stay free of runtime imports beyond `lunorash/server`.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

/**
 * - `supervisor`: a small routing call picks who speaks, 1–N in sequence.
 * - `round-robin`: participants take turns, one per user message.
 * - `mention-only`: only `@mentioned` participants answer.
 * - `parallel`: every participant answers on its own, without seeing the
 *   others' replies; an optional synthesizer then merges them.
 * - `debate`: two participants argue for and against over N rounds, then a
 *   synthesizer weighs both sides.
 *
 * `@mentions` force the speaker in every mode.
 */
export const vGroupChatMode = v.union(v.literal("supervisor"), v.literal("round-robin"), v.literal("mention-only"), v.literal("parallel"), v.literal("debate"));

export type GroupChatMode = Infer<typeof vGroupChatMode>;

/** One participant: a skill, referenced by id. Its instructions stay on the skill row. */
export const vGroupParticipant = v.object({
    addedAt: v.number(),
    skillId: v.string(),
});

export const vGroupChat = v.object({
    /** `debate` only: rounds of for/against before the synthesis (1–3, default 2). */
    debateRounds: v.optional(v.number()),
    mode: vGroupChatMode,
    participants: v.array(vGroupParticipant),
    /** Set by `stopGroupTurn`; a turn that started before it runs no further speakers. */
    stopRequestedAt: v.optional(v.number()),
    /**
     * `parallel`: the participant that merges the answers (none = no merge).
     * `debate`: the one that weighs both sides (none = a third participant, or
     * the first debater). Ignored by the other modes.
     */
    synthesizerSkillId: v.optional(v.string()),
});

export type GroupChat = Infer<typeof vGroupChat>;

/** The part one speaker plays in a `parallel` or `debate` turn. */
export const vGroupRole = v.union(v.literal("independent"), v.literal("pro"), v.literal("contra"), v.literal("synthesizer"));

export type GroupRole = Infer<typeof vGroupRole>;

/** One planned reply of a `parallel` or `debate` turn. The other modes plan bare skill ids. */
export const vGroupStep = v.object({
    role: vGroupRole,
    /** `debate`: which round this for/against reply belongs to (1-based). */
    round: v.optional(v.number()),
    /** `debate`: how many rounds the turn has — set on every debate step, the synthesis included. */
    rounds: v.optional(v.number()),
    skillId: v.string(),
});

export type GroupStep = Infer<typeof vGroupStep>;

/**
 * Recorded in the approval snapshot of a speaker that paused on a tool, so the
 * continuation resumes THAT participant and then the rest of the turn.
 */
export const vGroupRunSnapshot = v.object({
    /** The model the user picked for the turn — a participant without a preferred model runs on it. */
    baseModel: v.string(),
    /** Anonymous callers stay pinned to the free model; no participant lifts that. */
    isAnonymous: v.boolean(),
    /** The caller's active organization when the turn started — scopes organization-shared skills. */
    organizationId: v.optional(v.string()),
    /** Participants still planned to speak after the paused one, in order. */
    queue: v.array(v.string()),
    /** The paused participant. */
    skillId: v.string(),
    /** Everyone who already spoke this turn, the paused participant included — once per reply. */
    spokenSkillIds: v.array(v.string()),
    /** `parallel`/`debate`: the paused reply's role. */
    step: v.optional(vGroupStep),
    /** `parallel`/`debate`: the replies still planned after the paused one. Takes precedence over `queue`. */
    steps: v.optional(v.array(vGroupStep)),
    /** When the turn began — a stop requested after it halts the rest. */
    turnStartedAt: v.number(),
});

export type GroupRunSnapshot = Infer<typeof vGroupRunSnapshot>;
