/**
 * Column validators for `subAgentRuns`, shared by `schema.ts` and the
 * procedures. Imported by `schema.ts`, so no runtime imports beyond
 * `lunorash/server`; inline literals, which codegen resolves.
 */
import { v } from "lunorash/server";

/** `awaiting`: a one-shot child paused on an approval its owner has not answered yet (`sub-agents/execute.ts`). */
export const vSubAgentRunStatus = v.union(
    v.literal("queued"),
    v.literal("running"),
    v.literal("awaiting"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("cancelled"),
);

/** `run` is a one-shot sub-agent; `worker` is a thread that outlives its runs and is dispatched to again (`agent-orchestrator.md`). Unset reads as `run`. */
export const vSubAgentRunMode = v.union(v.literal("run"), v.literal("worker"));

/** Where a worker's runs execute. Fixed by the worker's first run; unset reads as the cloud headless runner. */
export const vSubAgentRunner = v.union(v.object({ kind: v.literal("headless") }), v.object({ deviceId: v.id("devices"), kind: v.literal("host") }));

/** Who a dispatch to a worker came from: the lead agent, the user typing, or an unattended run's cause. */
export const vDispatchSource = v.union(v.literal("lead"), v.literal("user"), v.literal("trigger"), v.literal("messenger"), v.literal("outside_agent"));

/**
 * A lead thread's dispatch policy. `hostDispatch` has one value: a dispatch to a host worker always asks a
 * person, whatever else this says. `allowedSources` unset reads as the lead and the user.
 */
export const vWorkerPolicy = v.object({
    allowedSources: v.array(vDispatchSource),
    hostDispatch: v.literal("ask"),
    maxDispatchesPerHour: v.optional(v.number()),
});

/** A new host worker's runner as a caller asks for it: the computer and the (agent, folder) pair it offered. */
export const vHostRunnerRequest = v.object({ agentKey: v.string().max(128), deviceId: v.string().max(128), folderId: v.string().max(128) });

/** The kinds of delegated work a user can give a model of its own (`sub-agents/roles.ts`). */
export const vSubAgentRoleName = v.union(
    v.literal("architecture"),
    v.literal("implementation"),
    v.literal("research"),
    v.literal("review"),
    v.literal("security"),
    v.literal("design"),
    v.literal("test"),
    v.literal("general"),
);

/**
 * One role as a scope stores it. Every field is optional: an absent one inherits from the scope above (a project from
 * the user, the user from the built-in default). `instructions: ""` turns the role's extra instructions off.
 */
export const vSubAgentRoleConfig = v.object({
    instructions: v.optional(v.string().max(4000)),
    mode: v.optional(v.union(v.literal("prefer"), v.literal("always"))),
    model: v.optional(v.string().max(256)),
    reasoningEffort: v.optional(v.number()),
});

/** The roles one scope (the user, or a project) sets; an absent role inherits whole. */
export const vSubAgentRoles = v.object({
    architecture: v.optional(vSubAgentRoleConfig),
    design: v.optional(vSubAgentRoleConfig),
    general: v.optional(vSubAgentRoleConfig),
    implementation: v.optional(vSubAgentRoleConfig),
    research: v.optional(vSubAgentRoleConfig),
    review: v.optional(vSubAgentRoleConfig),
    security: v.optional(vSubAgentRoleConfig),
    test: v.optional(vSubAgentRoleConfig),
});

/** The role a run launched with, resolved at admission and kept on the row: a later settings change never reaches it. */
export const vSubAgentRunRole = v.object({
    instructions: v.optional(v.string()),
    // Unset only on a worker on a computer: it runs on its coding agent and takes just the role's instructions.
    model: v.optional(v.string()),
    name: vSubAgentRoleName,
    reasoningEffort: v.optional(v.number()),
});
