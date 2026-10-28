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
