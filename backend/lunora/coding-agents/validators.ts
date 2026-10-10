/**
 * Column validators for `codingAgentRuns`, declared once and shared by
 * `schema.ts` and the procedures. Inline literals: codegen resolves an inline
 * validator expression, never one built by a call.
 */
import { v } from "lunorash/server";

export const vCodingAgentId = v.union(v.literal("claude_code"), v.literal("codex"));

export const vCodingAgentRunStatus = v.union(v.literal("queued"), v.literal("running"), v.literal("succeeded"), v.literal("failed"), v.literal("cancelled"));

/** A task's "assignee" when a coding agent, not the chat agent, works it. */
export const vCodingAgentAssignment = v.object({
    agent: vCodingAgentId,
    branch: v.optional(v.string()),
    openPr: v.optional(v.boolean()),
    repoUrl: v.string(),
});
