import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { withoutUndefined } from "../../lib/patch";

type CallFields = Partial<Omit<Doc<"deviceCalls">, "_creationTime" | "_id">>;

/**
 * The one write other modules make to a device call: the coding-agent module ends, withdraws and re-queues the
 * calls it created (`acp/calls.ts`, `acp/lib/calls.ts`). A plain function over `ctx.db`, so the write stays in the
 * caller's transaction and the `cross_module_table_write` rule sees it go through the owner's surface.
 */
export const patchDeviceCall = async (ctx: Pick<MutationCtx, "db">, callId: Id<"deviceCalls">, fields: CallFields): Promise<void> => {
    await ctx.db.patch(callId, withoutUndefined(fields));
};
