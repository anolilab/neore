import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { endHostTurn } from "./finish";

const SESSION_BATCH = 200;

/**
 * A device was removed: its sessions end, and so does every open host stream on them, in the same mutation as
 * the revoke (`devices/functions.ts#revokeDevice`). The stream ends as an error with `hostState: ended` and what
 * the host wrote is saved as a failed reply, so no client keeps a "Working" turn that nothing will finish. The host cannot be told to cancel: its secret is gone.
 */
export const endHostSessionsOfDevice = async (ctx: MutationCtx, deviceId: Id<"devices">, now: number): Promise<void> => {
    let cursor: string | undefined;

    do {
        const { continueCursor, isDone, page: sessions } = await ctx.db.acpSessions.findMany({ cursor, limit: SESSION_BATCH, where: { deviceId } });

        for (const session of sessions) {
            if (session.status !== "ended") {
                await ctx.db.patch(session._id, { status: "ended", updatedAt: now });
            }

            const { page: live } = await ctx.db.persistentStreams.findMany({
                where: { producer: "host", status: { in: ["pending", "streaming"] }, threadId: session.threadId },
            });

            for (const stream of live) {
                await endHostTurn(ctx, stream, { reason: "revoked" }, now);
            }
        }

        cursor = isDone ? undefined : (continueCursor ?? undefined);
    } while (cursor !== undefined);
};
