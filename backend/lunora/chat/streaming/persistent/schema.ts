/**
 * Non-table exports from the original `chat/streaming/persistent/schema.ts`.
 *
 * The table definitions moved to the generated top-level `lunora/schema.ts`;
 * these types and validators are still referenced by handlers, so they stay here.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

export const streamStatusValidator = v.union(v.literal("pending"), v.literal("streaming"), v.literal("done"), v.literal("error"), v.literal("timeout"));

export type StreamStatus = Infer<typeof streamStatusValidator>;
