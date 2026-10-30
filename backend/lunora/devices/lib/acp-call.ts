/**
 * The coding-agent commands the BACKEND creates (plans/acp-agent-host.md §4.1): `acp_start`, `acp_send`,
 * `acp_cancel` and `acp_permission_answer`. `createDeviceCall` is for device tools: it refuses anything the
 * manifest does not list. These calls are signed like any other (the desktop's Rust core verifies them), but have
 * their own open-call budget and claim window (`lib/constants.ts`), a claim that is a lease, and a prompt that is
 * cleared once the call ends (`acp/lib/calls.ts`).
 *
 * Unlike the others, a cancel is not held back for an offline device: it waits for the claim window and then
 * expires like any unclaimed call, and a host that comes back within it stops the turn.
 */
import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/internal";
import type { MutationCtx } from "../../_generated/server";
import { decryptKey } from "../../lib/encryption";
import {
    ACP_CLAIM_WINDOW_MS,
    DEVICE_CALL_DEADLINE_MS,
    MAX_DEVICE_INPUT_BYTES,
    MAX_OPEN_ACP_CALLS_PER_DEVICE,
    MAX_OPEN_ACP_CANCELS_PER_DEVICE,
} from "./constants";
import { signDevicePayload, utf8Length } from "./signing";
import { countOpenCalls, isAcpTool, isDeviceOnline } from "./state";

export type AcpCallKind = "acp_cancel" | "acp_permission_answer" | "acp_send" | "acp_start";

export type AcpCallResult = { callId: string } | { error: "busy" | "ineligible" | "input_too_large" | "offline" };

/** Slack past a window, so the check that enforces it runs after the window rather than a tick before. */
const CHECK_SLACK_MS = 1000;

export const createAcpCall = async (
    ctx: Pick<MutationCtx, "db" | "scheduler">,
    args: { deviceId: Id<"devices">; input: Record<string, string>; kind: AcpCallKind; threadId: Id<"threads">; userId: string },
    now: number,
): Promise<AcpCallResult> => {
    const { deviceId, kind, threadId, userId } = args;
    const device = await ctx.db.devices.findFirst({ where: { _id: deviceId, userId } });

    if (!device?.encryptedSecret) {
        return { error: "ineligible" };
    }

    // A cancel is the one command that may wait for a host that is not answering right now.
    if (kind !== "acp_cancel" && !isDeviceOnline(device, now)) {
        return { error: "offline" };
    }

    const input = JSON.stringify(args.input);

    if (utf8Length(input) > MAX_DEVICE_INPUT_BYTES) {
        return { error: "input_too_large" };
    }

    // Stop has a budget of its own: three answers waiting to be delivered must not be able to swallow it.
    // A pending call past its claim window can no longer be claimed (it expires on its own): it must not block a cancel.
    const limit = kind === "acp_cancel" ? MAX_OPEN_ACP_CANCELS_PER_DEVICE : MAX_OPEN_ACP_CALLS_PER_DEVICE;
    const open = await countOpenCalls(
        ctx,
        deviceId,
        (call) =>
            isAcpTool(call.toolName) &&
            !(call.status === "pending" && now - call.createdAt > ACP_CLAIM_WINDOW_MS) &&
            (call.toolName === "acp_cancel") === (kind === "acp_cancel"),
        limit,
    );

    if (open >= limit) {
        return { error: "busy" };
    }

    const thread = await ctx.db.threads.findFirst({ where: { _id: threadId } });
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
        toolName: kind,
        userId,
    });
    const envelope = JSON.stringify({
        callId,
        deviceId,
        expiresAt: deadline,
        input: args.input,
        issuedAt: now,
        kind: "call",
        nonce: crypto.randomUUID(),
        taintedBy: [],
        threadId,
        threadTitle: (thread?.title ?? "").slice(0, 200),
        tool: kind,
        v: 1,
    });
    const secret = await decryptKey(device.encryptedSecret, "device-secrets");

    await ctx.db.patch(callId, { envelope, signature: await signDevicePayload(secret, "call", envelope) });
    // A call nobody claims is expired and its turn ended when the window closes (`acp/calls.ts`).
    await ctx.scheduler.runAfter(ACP_CLAIM_WINDOW_MS + CHECK_SLACK_MS, internal.acp.calls.checkAcpCall, { callId });

    return { callId: callId as string };
};

export type AcpCancelResult = { callId: string } | { error: "busy" | "ineligible" };

export const createAcpCancelCall = async (
    ctx: Pick<MutationCtx, "db" | "scheduler">,
    args: { deviceId: Id<"devices">; hostSessionId: string; threadId: Id<"threads">; turnId: string; userId: string },
    now: number,
): Promise<AcpCancelResult> => {
    const result = await createAcpCall(
        ctx,
        {
            deviceId: args.deviceId,
            input: { sessionId: args.hostSessionId, turnId: args.turnId },
            kind: "acp_cancel",
            threadId: args.threadId,
            userId: args.userId,
        },
        now,
    );

    // A cancel never waits on the host being online and its input is two ids: neither can refuse it.
    return "error" in result ? { error: result.error === "busy" ? "busy" : "ineligible" } : result;
};
