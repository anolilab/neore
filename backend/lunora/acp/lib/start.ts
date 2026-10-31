import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { type AcpCallResult, createAcpCall } from "../../devices/lib/acp-call";
import { type DeviceTaintSource, mergeTaint } from "../../devices/lib/taint";
import { sha256Hex } from "../../lib/crypto";

type Offer = NonNullable<Doc<"devices">["acpOffers"]>[number];

/** The offer of `device` for an (agent, folder) pair, or undefined: the pair the user approved in the desktop's local window. */
export const offerOf = (device: Pick<Doc<"devices">, "acpOffers"> | null, agentKey: string, folderId: string): Offer | undefined =>
    device?.acpOffers?.find((candidate) => candidate.agentKey === agentKey && candidate.folderId === folderId);

/**
 * The session id a start made from the web gets: a retry of the same click is the same session, whatever it became since.
 * A switch is keyed by the thread it was clicked on as well: the client id is client-chosen and only unique per thread
 * (`claimKeyOf`), and two sessions with one id on a computer cannot be told apart.
 */
export const webSessionId = async (userId: string, clientId: string, scope: { kind: "start" } | { kind: "switch"; threadId: string }): Promise<string> =>
    scope.kind === "switch" ? `web-switch-${await sha256Hex(`${userId}:${scope.threadId}:${clientId}`)}` : `web-${await sha256Hex(`${userId}:${clientId}`)}`;

/**
 * Opens a session for `offer` in `threadId` and queues the signed `acp_start` for it. The session is `starting` until the
 * computer's agent has opened it (`session_open`). Throws nothing: the caller turns a refused call into its own error,
 * which rolls the session back with the rest of its transaction.
 */
export const startHostSessionIn = async (
    ctx: MutationCtx,
    args: {
        device: Doc<"devices">;
        hostSessionId: string;
        /** The agent's own session id this one asks the computer to load again (harness switch S4). */
        nativeSessionId?: string;
        offer: Offer;
        /** What the agent is handed when it takes over, kept on the session for every prompt it is sent. */
        taintedBy?: ReadonlyArray<DeviceTaintSource>;
        threadId: Id<"threads">;
        userId: string;
    },
    now: number,
): Promise<AcpCallResult> => {
    const { device, hostSessionId, nativeSessionId, offer, threadId, userId } = args;
    const taintedBy = mergeTaint(args.taintedBy);

    await ctx.db.insert("acpSessions", {
        agentKey: offer.agentKey,
        agentLabel: offer.agentLabel,
        createdAt: now,
        deviceId: device._id,
        folderId: offer.folderId,
        folderLabel: offer.folderLabel,
        hostSessionId,
        // Kept on the row so the agent's `session_open` can be checked against it: a session that opens under another id did
        // not load this one.
        ...(nativeSessionId !== undefined && { nativeSessionId }),
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
            input: {
                agentKey: offer.agentKey,
                folderId: offer.folderId,
                ...(nativeSessionId !== undefined && { nativeSessionId }),
                sessionId: hostSessionId,
                threadId: threadId as string,
            },
            kind: "acp_start",
            threadId,
            userId,
        },
        now,
    );
};

/** What a refused `acp_start` call tells the person who asked. */
export const startFailureMessage = (error: Extract<AcpCallResult, { error: string }>["error"]): string =>
    error === "busy" ? "That computer is busy. Try again in a moment." : "That computer cannot start an agent right now.";
