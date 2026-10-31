/**
 * The snapshot a run records when it pauses on tool-approval requests —
 * `toolApprovalRuns.config` in the schema, and the `config` argument of
 * `recordPendingToolApprovals` / `continueAfterToolApproval`. One validator for
 * all three, so the stored row and the procedure inputs cannot drift apart.
 *
 * Imported by `schema.ts`, so this module must stay free of runtime imports
 * beyond `lunorash/server`.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { vGroupRunSnapshot } from "../group/validators";

export const vToolRunConfig = v.object({
    autoMediaEnrichment: v.boolean(),
    /**
     * What started the run that paused, when it was not the user's own chat: the continuation
     * dispatches to workers as that origin did, not as the lead. Absent means the lead.
     */
    dispatchOrigin: v.optional(v.literal("outside_agent")),
    /**
     * Set when a group-chat participant paused: the continuation resumes that
     * participant, then the rest of the turn (`chat/group/run.ts`).
     */
    group: v.optional(vGroupRunSnapshot),
    instructions: v.optional(v.string()),
    mcpServerNames: v.array(v.string()),
    /**
     * Set when the run that paused fed memory extraction (it extracted its own prompt
     * and steers at the pause). The continuation then extracts only what it adds: the
     * messages steered into it after the pause.
     */
    memory: v.optional(v.object({ botId: v.optional(v.string()) })),
    model: v.string(),
    /**
     * The prompt row the paused run answered. The continuation's stream is keyed on the approval id, so this is
     * how a goal recognises the resumed run as its own round (`chat/goals/internal.ts#runPromptId`).
     */
    promptMessageId: v.optional(v.string()),
    reasoningEffort: v.optional(v.number()),
    researchDepth: v.union(v.literal("speed"), v.literal("balanced"), v.literal("thorough")),
    searchMode: v.string(),
    shouldAutoContinue: v.boolean(),
    toolNames: v.array(v.string()),
    /**
     * Runtime tool name -> stable permission key, taken from the tools as they
     * were built. "Always allow" writes the key found here; a row without it
     * (or without the tool) approves once and writes no preference.
     */
    toolPermissionKeys: v.optional(v.record(v.string(), v.string())),
    /**
     * The final system prompt carries retrieved knowledge, memories or project context. A continuation never reloads
     * that context, so the quick check for low-risk calls reads it from here; a row without it counts as `true`.
     */
    untrustedContext: v.optional(v.boolean()),
});

export type ToolRunConfig = Infer<typeof vToolRunConfig>;

/**
 * Who started a run, when that is not the person at the app (`outside_agent`: the public API's key). Such a run never gets more than
 * `ask` for its tools and no device tools, whatever the user's own overrides say (`resolveToolPermission`).
 */
export type RunOrigin = NonNullable<ToolRunConfig["dispatchOrigin"]>;
