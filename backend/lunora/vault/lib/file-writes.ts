/**
 * The vault module's write surface for OTHER modules (`vault/module.ts` owns
 * `files` and `folders`): the chat import dropping the temporary `files` row
 * its upload created. A plain function over `ctx.db`, so the delete stays in
 * the caller's mutation — same transaction, shard and RLS-guarded `ctx.db`.
 * Deletes ONLY the row; the stored object is the caller's to schedule.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

export const deleteFileRow = async (db: MutationCtx["db"], fileId: Id<"files">): Promise<void> => {
    await db.delete(fileId);
};
