/**
 * The input of `runStreamingAgent` (`chat/execute.ts`).
 *
 * A run that pauses on a provider rate limit stores these arguments on its stream
 * (`persistentStreams.pause.run`), so the resume — delayed to the retry time, or
 * early on "Retry now" — re-enters the same job with the same arguments plus the
 * pause's id. One definition keeps the stored copy and the job's input from drifting.
 *
 * Imported by `schema.ts`, so this module must stay free of runtime imports
 * beyond `lunorash/server` and the validator caps (`lib/validators.ts`, which imports nothing of ours).
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { MAX_LENGTH } from "../../lib/validators";

export const runStreamingAgentFields = {
    /** Anonymous callers are pinned to the free model; a skill must not lift that. */
    isAnonymous: v.optional(v.boolean()),
    messageId: v.string(),
    /** The caller's active organization, verified by `/chat/start` — scopes organization-shared skills. */
    organizationId: v.optional(v.string()),
    /** What started the turn: the user's own chat, or the public API's key (an outside agent). Unset reads as the user's. */
    origin: v.optional(v.union(v.literal("lead"), v.literal("outside_agent"))),
    /**
     * Set on the job that resumes a run paused on a provider rate limit: the id of the pause it answers
     * (`persistentStreams.pause.id`). It claims that pause instead of the stream's first-run claim.
     */
    resume: v.optional(v.string().max(MAX_LENGTH.short)),
    /** The skill a goal's first round invoked, so every later round runs it too (the round's own text no longer starts with `/<slug>`). */
    skill: v.optional(v.object({ rawArgs: v.string().max(MAX_LENGTH.text), slug: v.string().max(MAX_LENGTH.short) })),
    streamId: v.string(),
    streamingConfig: v.object({
        contentType: v.string(),
        customSystemPrompt: v.optional(v.string()),
        enabledFeatures: v.optional(v.array(v.string())),
        imageSize: v.optional(v.string()),
        mcpServerNames: v.optional(v.array(v.string())),
        model: v.string(),
        reasoningEffort: v.optional(v.number()),
        researchDepth: v.optional(v.string()),
        searchMode: v.optional(v.string()),
        shouldAutoContinue: v.optional(v.boolean()),
        statelessMode: v.optional(v.boolean()),
    }),
    threadId: v.string(),
    userId: v.string(),
    /** The raw composer text, when the start payload had it — where a `/<slug>` command is detected. */
    userPrompt: v.optional(v.string()),
};

export type RunStreamingArgs = Infer<ReturnType<typeof v.object<typeof runStreamingAgentFields>>>;
