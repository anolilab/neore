/**
 * A coding-agent call the BACKEND starts on its own: today only `acp_cancel`, queued when a host turn goes
 * silent (`acp/lib/reap.ts`) or the user presses Stop. `createDeviceCall` is for device tools: it refuses
 * anything the manifest does not list. These calls are signed like any other (the desktop's Rust core verifies
 * them), but have their own open-call budget and claim window (`lib/constants.ts`).
 *
 * Unlike a send, a cancel is not held back for an offline device: it waits for the claim window and then
 * expires like any unclaimed call, and a host that comes back within it stops the turn.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { decryptKey } from "../../lib/encryption";
import { ACP_CLAIM_WINDOW_MS, DEVICE_CALL_DEADLINE_MS, MAX_OPEN_ACP_CALLS_PER_DEVICE } from "./constants";
import { signDevicePayload } from "./signing";
import { isAcpTool, OPEN_CALL_STATUSES } from "./state";

export type AcpCancelResult = { callId: string } | { error: "busy" | "ineligible" };

export const createAcpCancelCall = async (
    ctx: Pick<MutationCtx, "db">,
    args: { deviceId: Id<"devices">; hostSessionId: string; threadId: Id<"threads">; turnId: string; userId: string },
    now: number,
): Promise<AcpCancelResult> => {
    const { deviceId, threadId, userId } = args;
    const device = await ctx.db.devices.findFirst({ where: { _id: deviceId, userId } });

    if (!device?.encryptedSecret) {
        return { error: "ineligible" };
    }

    let open = 0;

    for (const status of OPEN_CALL_STATUSES) {
        const { page } = await ctx.db.deviceCalls.findMany({ limit: 50, where: { deviceId, status } });

        // A pending call past its claim window can no longer be claimed (it expires on its own): it must not block a cancel.
        open += page.filter((call) => isAcpTool(call.toolName) && !(call.status === "pending" && now - call.createdAt > ACP_CLAIM_WINDOW_MS)).length;
    }

    if (open >= MAX_OPEN_ACP_CALLS_PER_DEVICE) {
        return { error: "busy" };
    }

    const thread = await ctx.db.threads.findFirst({ where: { _id: threadId } });
    const input = JSON.stringify({ sessionId: args.hostSessionId, turnId: args.turnId });
    const deadline = now + DEVICE_CALL_DEADLINE_MS;
    const callId = await ctx.db.insert("deviceCalls", {
        createdAt: now,
        deadline,
        deviceId,
        deviceName: device.name,
        envelope: "",
        input,
        signature: "",
        status: "pending",
        taintedBy: [],
        threadId,
        toolName: "acp_cancel",
        userId,
    });
    const envelope = JSON.stringify({
        callId,
        deviceId,
        expiresAt: deadline,
        input: JSON.parse(input) as unknown,
        issuedAt: now,
        kind: "call",
        nonce: crypto.randomUUID(),
        taintedBy: [],
        threadId,
        threadTitle: (thread?.title ?? "").slice(0, 200),
        tool: "acp_cancel",
        v: 1,
    });
    const secret = await decryptKey(device.encryptedSecret, "device-secrets");

    await ctx.db.patch(callId, { envelope, signature: await signDevicePayload(secret, "call", envelope) });

    return { callId: callId as string };
};
