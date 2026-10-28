import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { endHostStream } from "../../chat/streaming/persistent/host";

const SESSION_BATCH = 200;

/**
 * A device was removed: its sessions end, and so does every open host stream on them, in the same mutation as
 * the revoke (`devices/functions.ts#revokeDevice`). The stream ends as an error with `hostState: ended`, so no
 * client keeps a "Working" turn that nothing will finish. The host cannot be told to cancel: its secret is gone.
 */
export const endHostSessionsOfDevice = async (ctx: Pick<MutationCtx, "db">, deviceId: Id<"devices">, now: number): Promise<void> => {
    const { page: sessions } = await ctx.db.acpSessions.findMany({ limit: SESSION_BATCH, where: { deviceId } });

    for (const session of sessions) {
        if (session.status !== "ended") {
            await ctx.db.patch(session._id, { status: "ended", updatedAt: now });
        }

        const { page: live } = await ctx.db.persistentStreams.findMany({
            where: { producer: "host", status: { in: ["pending", "streaming"] }, threadId: session.threadId },
        });

        for (const stream of live) {
            await endHostStream(ctx, stream, { reason: "revoked", status: "error" }, now);
        }
    }
};
