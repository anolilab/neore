import { v } from "lunorash/server";

/** An install's status, shared by the schema and `logic.ts`. */
export const vPluginInstallStatus = v.union(
    v.literal("installing"),
    v.literal("installed"),
    v.literal("updating"),
    v.literal("uninstalling"),
    v.literal("needs-repair"),
);

/** The kind of child an install created. */
export const vPluginItemKind = v.union(v.literal("skill"), v.literal("trigger"), v.literal("group"));

/** A child's link state: intent before its create, created once linked, updating during an in-place update, detached when kept after a removal. */
export const vPluginItemState = v.union(v.literal("intent"), v.literal("created"), v.literal("updating"), v.literal("detached"));
