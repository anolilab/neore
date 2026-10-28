/**
 * The clock on a coding-agent command (plans/acp-agent-host.md §4.1). Live queries do not re-run as time passes, so
 * every deadline here is a scheduled check on one call: `createAcpCall` schedules the first at the end of the
 * claim window and each claim schedules one at the end of its lease. A check reads the call as it is now and does
 * only what is due, so a check that outlived its reason does nothing.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";
import { ACP_CLAIM_LEASE_MS, ACP_CLAIM_WINDOW_MS } from "../devices/lib/constants";
import { patchDeviceCall } from "../devices/lib/call-writes";
import { isAcpTool, isTerminalCallStatus } from "../devices/lib/state";
import { ACP_CLEARED } from "./lib/constants";
import { endStartingSession, HOST_DID_NOT_ANSWER, onAcpCallEnded } from "./lib/calls";

const CHECK_SLACK_MS = 1000;

export const checkAcpCall = internalMutation
    .input({ callId: v.id("deviceCalls") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const call = await ctx.db.deviceCalls.findFirst({ where: { _id: args.callId } });
        const { now } = ctx;

        if (!call || !isAcpTool(call.toolName) || isTerminalCallStatus(call.status)) {
            return null;
        }

        const neverClaimed = call.status === "pending" && call.claimedAt === undefined;

        // Nobody answered: the claim window closed on a call no host took, or the deadline passed on one it could not finish.
        if (now >= call.deadline || (neverClaimed && now - call.createdAt >= ACP_CLAIM_WINDOW_MS)) {
            await patchDeviceCall(ctx, call._id, { completedAt: now, error: HOST_DID_NOT_ANSWER, status: "expired", ...ACP_CLEARED });
            await onAcpCallEnded(ctx, call, { error: HOST_DID_NOT_ANSWER, status: "expired" }, now);

            return null;
        }

        // The lease lapsed: whoever claimed it never finished (the page or the desktop died in between). The call
        // goes back to the queue; `claimedAt` stays, which is what tells a claim that this is a second look and
        // not subject to the window. The deadline check below the next claim is the one that ends it for good.
        if (call.status === "claimed" && call.claimedAt !== undefined && now - call.claimedAt >= ACP_CLAIM_LEASE_MS) {
            await patchDeviceCall(ctx, call._id, { status: "pending" });
            await ctx.scheduler.runAfter(Math.max(0, call.deadline - now) + CHECK_SLACK_MS, internal.acp.calls.checkAcpCall, { callId: call._id });
        }

        return null;
    });

/** The computer accepted an `acp_start` and its agent never opened the session (`acp/lib/calls.ts`): it ends. */
export const endUnopenedSession = internalMutation
    .input({ deviceId: v.id("devices"), hostSessionId: v.string().max(128) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await endStartingSession(ctx, args.deviceId, args.hostSessionId, ctx.now);

        return null;
    });
