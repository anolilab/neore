import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { createAcpCall, type AcpCallResult } from "../../devices/lib/acp-call";
import { type DeviceTaintSource, mergeTaint } from "../../devices/lib/taint";

/**
 * Opens a session for a host thread on a computer that offered the (agent, folder) pair: the `starting` session row and
 * the signed `acp_start` (plans/acp-agent-host.md §3, §4.1). The caller has checked the offer; Rust checks it again.
 * Shared by `startHostSession` and the creation of a host worker, so there is one way to start an agent on a host.
 * A refusal leaves the session row written: the caller throws to roll it back, or ends the session itself.
 */
export const openHostSession = async (
    ctx: MutationCtx,
    args: {
        device: Doc<"devices">;
        hostSessionId: string;
        offer: NonNullable<Doc<"devices">["acpOffers"]>[number];
        /** What the agent is handed when it takes over, kept on the session for every prompt it is sent. */
        taintedBy?: ReadonlyArray<DeviceTaintSource>;
        threadId: Id<"threads">;
        userId: string;
    },
    now: number,
): Promise<AcpCallResult> => {
    const { device, hostSessionId, offer, threadId, userId } = args;
    const taintedBy = mergeTaint(args.taintedBy);

    await ctx.db.insert("acpSessions", {
        agentKey: offer.agentKey,
        agentLabel: offer.agentLabel,
        createdAt: now,
        deviceId: device._id,
        folderId: offer.folderId,
        folderLabel: offer.folderLabel,
        hostSessionId,
        status: "starting",
        ...(taintedBy.length > 0 && { taintedBy }),
        threadId,
        updatedAt: now,
        userId,
    });

    return await createAcpCall(
        ctx,
        {
            deviceId: device._id,
            input: { agentKey: offer.agentKey, folderId: offer.folderId, sessionId: hostSessionId, threadId: threadId as string },
            kind: "acp_start",
            threadId,
            userId,
        },
        now,
    );
};
