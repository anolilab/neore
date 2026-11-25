/**
 * Runs the object deletes `agent/files.ts` records (`chatFileObjectDeletes`). Kept apart from that module so the client-side
 * store code (`client/files.ts`, `lib/reference-media-upload.ts`) does not import the server's file procedures.
 */
import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import type { ActionCtx as ActionContext } from "./types";

/**
 * Run recorded object deletes: delete each object, then end its record. Never throws: a failed delete is logged and keeps its
 * record, which the sweep takes up again (`agent_files.retryObjectDeletes`). Each key was named only by rows already gone, and no store
 * writes it again (a store writes a key of its own), so a delete that lands late takes nothing anyone needs.
 */
export const deleteStoredObjects = async (
    ctx: Pick<ActionContext, "runMutation" | "runQuery" | "storage">,
    deleteIds: Id<"chatFileObjectDeletes">[],
): Promise<void> => {
    if (deleteIds.length === 0) {
        return;
    }

    let objects: { deleteId: Id<"chatFileObjectDeletes">; storageId: string }[];

    try {
        objects = await ctx.runQuery(internal.agent.files.objectDeleteKeys, { deleteIds });
    } catch (error) {
        console.error("Failed to read the stored files to delete; the sweep retries them:", error);

        return;
    }

    for (const { deleteId, storageId } of objects) {
        try {
            await ctx.storage.delete(storageId);
            await ctx.runMutation(internal.agent.files.endObjectDelete, { deleteId });
        } catch (error) {
            console.error(`Failed to delete stored file ${storageId}; the sweep retries it:`, error);
        }
    }
};
