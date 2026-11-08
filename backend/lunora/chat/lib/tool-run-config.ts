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

import { MAX_LENGTH } from "../../lib/validators";
import { vGroupRunSnapshot } from "../group/validators";

export const vToolRunConfig = v.object({
    autoMediaEnrichment: v.boolean(),
    /**
     * A fresh-context headless run's own prompt order (`headless-run.ts`): its continuation reads the thread from there,
     * never the turns before it. Absent = the usual window.
     */
    contextFromOrder: v.optional(v.number()),
    /**
     * What started the run that paused, when it was not the user's own chat (an outside agent, or a trigger's or a messenger
     * reply's sub-agent, `headless-run.ts`): the continuation dispatches to workers as that origin did, not as the lead.
     * Absent means the lead.
     */
    dispatchOrigin: v.optional(v.union(v.literal("outside_agent"), v.literal("trigger"), v.literal("messenger"))),
    /**
     * Set when a group-chat participant paused: the continuation resumes that
     * participant, then the rest of the turn (`chat/group/run.ts`).
     */
    group: v.optional(vGroupRunSnapshot),
    /**
     * The built-ins whose `ask` a sub-agent child inherited an approval for (`sub-agents/execute.ts`): the parent's approved
     * delegation carries into its nested dispatch. The continuation of a paused child keeps them, so an answer does not ask
     * again for a nested dispatch. Absent on a snapshot that predates it, which reads as no inherited approval.
     */
    headlessApproved: v.optional(v.array(v.string())),
    instructions: v.optional(v.string()),
    mcpServerNames: v.array(v.string()),
    /**
     * Runtime name -> fingerprint of each MCP tool the run offered (`mcp-tool-fingerprint.ts`). A continuation does not
     * run an approved call whose tool's fingerprint changed or is gone. Absent on a snapshot that predates it: no check.
     */
    mcpToolFingerprints: v.optional(v.record(v.string(), v.string())),
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
    /**
     * Names the reply this snapshot belongs to (the stream its first run wrote to), carried unchanged through every
     * pause and continuation. A `requestSecret` reference is stamped with it, so a reply that ends drops only its own
     * references and not those of another reply on the same thread. Absent on a snapshot that predates it.
     */
    replyKey: v.optional(v.string().max(MAX_LENGTH.id)),
    researchDepth: v.union(v.literal("speed"), v.literal("balanced"), v.literal("thorough")),
    searchMode: v.string(),
    shouldAutoContinue: v.boolean(),
    /**
     * Who started the turn that paused, when it is not necessarily the thread's owner (a write collaborator's
     * turn). The continuation runs as the owner, so this is what `setMcpServerSecret` checks before it spends
     * the owner's secret. Absent on a snapshot written before it existed, which reads as nobody.
     */
    startedBy: v.optional(v.string().max(MAX_LENGTH.id)),
    /**
     * A headless run's steps left of its budget when it paused (`headless-run.ts`): the continuation runs at most these, and
     * none at all when it is spent, so an answer never buys a fresh budget. Absent (interactive, or older) = a full budget.
     */
    stepsLeft: v.optional(v.number()),
    /**
     * Set when a sub-agent's child run paused (`sub-agents/execute.ts`): the continuation hands the run back to it
     * (`sub_agents.functions.resumeRunForAnswer`, then the run's end), so the result still reaches the parent once.
     */
    subAgentRunId: v.optional(v.id("subAgentRuns")),
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
