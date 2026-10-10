/**
 * Column validators for `subAgentRuns`, shared by `schema.ts` and the
 * procedures. Imported by `schema.ts`, so no runtime imports beyond
 * `lunorash/server`; inline literals, which codegen resolves.
 */
import { v } from "lunorash/server";

export const vSubAgentRunStatus = v.union(v.literal("queued"), v.literal("running"), v.literal("succeeded"), v.literal("failed"));
