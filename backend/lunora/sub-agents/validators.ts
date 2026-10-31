/**
 * Column validators for `subAgentRuns`, shared by `schema.ts` and the
 * procedures. Imported by `schema.ts`, so no runtime imports beyond
 * `lunorash/server`; inline literals, which codegen resolves.
 */
import { v } from "lunorash/server";

export const vSubAgentRunStatus = v.union(v.literal("queued"), v.literal("running"), v.literal("succeeded"), v.literal("failed"), v.literal("cancelled"));

/** `run` is a one-shot sub-agent; `worker` is a thread that outlives its runs and is dispatched to again (`plans/agent-orchestrator.md`). Unset reads as `run`. */
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
