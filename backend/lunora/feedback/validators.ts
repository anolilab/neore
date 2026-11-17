import { v } from "lunorash/server";

/** What a piece of feedback is about. */
export const vFeedbackKind = v.union(v.literal("idea"), v.literal("problem"), v.literal("other"));
