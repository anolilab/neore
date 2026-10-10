/**
 * The browser module's write surface for OTHER modules (`browser/module.ts`
 * owns `browserSessions`): chat's "terminate session" button. A plain function
 * over `ctx.db`, so the write stays in the caller's mutation — same
 * transaction, shard and RLS-guarded `ctx.db`. `undefined` in the patch means
 * "leave the column unchanged" (`withoutUndefined`).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { withoutUndefined } from "../lib/patch";

/** The `browserSessions` columns other modules set. */
export type BrowserSessionPatch = Partial<Pick<Doc<"browserSessions">, "completedAt" | "lastActivityAt" | "status">>;

export const patchBrowserSession = async (db: MutationCtx["db"], sessionId: Id<"browserSessions">, fields: BrowserSessionPatch): Promise<void> => {
    await db.patch(sessionId, withoutUndefined(fields));
};
