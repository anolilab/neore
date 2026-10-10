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
     * Set when a group-chat participant paused: the continuation resumes that
     * participant, then the rest of the turn (`chat/group/run.ts`).
     */
    group: v.optional(vGroupRunSnapshot),
    instructions: v.optional(v.string()),
    mcpServerNames: v.array(v.string()),
    model: v.string(),
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
});

export type ToolRunConfig = Infer<typeof vToolRunConfig>;
